import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "./journal-service.js";
import { validateJournalImportBatch, commitJournalImportBatch } from "./journal-import-service.js";
import { validateOpeningBalanceImportBatch } from "./opening-balance-import-service.js";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { getIncomeStatement } from "./reporting/income-statement-service.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { getDashboardSummary } from "./dashboard-service.js";
import { generateMonthlyPeriods } from "./fiscal-period.js";
import { isValidIsoDate, parseExcelDate } from "../../lib/calendar-date.js";
import { sumCents, totalsEqual } from "../../lib/money.js";
import type { ActorContext } from "./company-audit.js";

/**
 * Regression UAT-002 (jurnal tidak seimbang TIDAK BOLEH diposting, tanpa
 * toleransi) dan UAT-003 (tanggal kalender tidak nyata TIDAK BOLEH
 * dinormalisasi / disimpan). Lihat docs/uat/FULL-UAT-5-YEAR-...-REPORT.md.
 */
const actor: ActorContext = { actorType: "user", actorId: "t", actorLabel: "T" };

describe("UAT-002 / UAT-003", () => {
  let tmp: string;
  let db: Knex;
  let kas: string, modal: string, pend: string, period: string;

  const counts = async () => ({
    j: Number((await db("journal_entries").count<{ c: number }[]>("* as c"))[0].c),
    l: Number((await db("journal_entry_lines").count<{ c: number }[]>("* as c"))[0].c),
    a: Number((await db("company_audit_log").count<{ c: number }[]>("* as c"))[0].c),
  });
  const draft = (ref: string, lines: Array<[string, number, number]>, date = "2026-01-15", extra: Record<string, unknown> = {}) =>
    createDraftJournalEntry(db, { entryDate: date, periodId: period, referenceNo: ref, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })), ...extra }, actor);

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terra-uat-high-"));
    db = knexLib({ ...baseKnexConfig, connection: { filename: path.join(tmp, "company.db") } });
    await db.migrate.latest();
    kas = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modal = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    pend = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    period = crypto.randomUUID();
    await db("periods").insert({ id: period, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
  });
  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("UAT-002 -- keseimbangan jurnal tanpa toleransi", () => {
    it("A) 100.000 / 100.000 diterima dan bisa diposting; laporan tetap normal", async () => {
      const { id } = await draft("A1", [[kas, 100_000, 0], [pend, 0, 100_000]]);
      await postJournalEntry(db, { journalEntryId: id }, actor);
      expect((await db("journal_entries").where({ id }).first()).status).toBe("POSTED");
      expect((await getTrialBalance(db, period)).isBalanced).toBe(true);
    });

    it("B) debit 100.000 vs kredit 99.999 ditolak; tidak ada header/baris/audit tersimpan", async () => {
      const before = await counts();
      await expect(draft("B1", [[kas, 100_000, 0], [pend, 0, 99_999]])).rejects.toMatchObject({ code: "JOURNAL_NOT_BALANCED" });
      expect(await counts()).toEqual(before);
    });

    it("C) debit 99.999 vs kredit 100.000 ditolak", async () => {
      const before = await counts();
      await expect(draft("C1", [[kas, 99_999, 0], [pend, 0, 100_000]])).rejects.toMatchObject({ code: "JOURNAL_NOT_BALANCED" });
      expect(await counts()).toEqual(before);
    });

    it("D) dua baris seimbang + satu baris tambahan yang merusak keseimbangan ditolak", async () => {
      const before = await counts();
      await expect(draft("D1", [[kas, 100_000, 0], [pend, 0, 100_000], [kas, 1, 0]])).rejects.toMatchObject({ code: "JOURNAL_NOT_BALANCED" });
      expect(await counts()).toEqual(before);
    });

    it("E) draf tak seimbang yang menyusup lewat jalur lain (mis. data lama / manipulasi) TIDAK bisa diposting; status tetap DRAFT, tanpa audit POST", async () => {
      const id = crypto.randomUUID();
      await db("journal_entries").insert({ id, entry_date: "2026-01-20", period_id: period, reference_no: "E1", status: "DRAFT", source: "manual" });
      await db("journal_entry_lines").insert([
        { id: crypto.randomUUID(), journal_entry_id: id, account_id: kas, debit: 100_000, credit: 0, line_order: 0 },
        { id: crypto.randomUUID(), journal_entry_id: id, account_id: pend, debit: 0, credit: 99_999, line_order: 1 },
      ]);
      const auditBefore = await db("company_audit_log").where({ action: "journal.post" }).count<{ c: number }[]>("* as c");
      await expect(postJournalEntry(db, { journalEntryId: id }, actor)).rejects.toMatchObject({ code: "JOURNAL_NOT_BALANCED" });
      expect((await db("journal_entries").where({ id }).first()).status).toBe("DRAFT");
      const auditAfter = await db("company_audit_log").where({ action: "journal.post" }).count<{ c: number }[]>("* as c");
      expect(auditAfter[0].c).toBe(auditBefore[0].c);
    });

    it("F) nominal besar: selisih Rp 1 ditolak, sama persis diterima", async () => {
      await expect(draft("F1", [[kas, 9_999_999_999_999, 0], [pend, 0, 9_999_999_999_998]])).rejects.toMatchObject({ code: "JOURNAL_NOT_BALANCED" });
      await expect(draft("F2", [[kas, 9_999_999_999_999, 0], [pend, 0, 9_999_999_999_999]])).resolves.toBeTruthy();
    });

    it("drift floating-point murni (0,1 + 0,2 vs 0,3) tetap dianggap seimbang; selisih Rp 0,01 ditolak", async () => {
      await expect(draft("F3", [[kas, 0.1, 0], [kas, 0.2, 0], [pend, 0, 0.3]])).resolves.toBeTruthy();
      await expect(draft("F4", [[kas, 0.31, 0], [pend, 0, 0.3]])).rejects.toMatchObject({ code: "JOURNAL_NOT_BALANCED" });
      expect(totalsEqual(0.1 + 0.2, 0.3)).toBe(true);
      expect(sumCents([100000, 0.5])).toBe(10000050n);
    });

    it("G) reversal jurnal seimbang tetap seimbang; reversal jurnal lama yang telanjur tak seimbang tetap diperbolehkan (jalur pemulihan)", async () => {
      const { id } = await draft("G1", [[kas, 5_000, 0], [pend, 0, 5_000]]);
      await postJournalEntry(db, { journalEntryId: id }, actor);
      const rev = await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "G1-REV", reason: "uji" }, actor);
      const sums = await db("journal_entry_lines").where({ journal_entry_id: rev.id }).sum({ d: "debit", c: "credit" }).first();
      expect(Number((sums as any).d)).toBe(Number((sums as any).c));
      // jurnal POSTED lama yang telanjur selisih 1 (dari versi sebelum perbaikan): masih bisa direversal untuk memulihkan laporan
      const legacy = crypto.randomUUID();
      await db("journal_entries").insert({ id: legacy, entry_date: "2026-01-21", period_id: period, reference_no: "G-LEGACY", status: "POSTED", source: "manual" });
      await db("journal_entry_lines").insert([
        { id: crypto.randomUUID(), journal_entry_id: legacy, account_id: kas, debit: 1_000, credit: 0, line_order: 0 },
        { id: crypto.randomUUID(), journal_entry_id: legacy, account_id: pend, debit: 0, credit: 999, line_order: 1 },
      ]);
      await expect(reverseJournalEntry(db, { journalEntryId: legacy, reversalReferenceNo: "G-LEGACY-REV", reason: "pemulihan" }, actor)).resolves.toBeTruthy();
    });

    it("H) import: jurnal tak seimbang -> preview ERROR, commit ditolak, database tidak berubah", async () => {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal");
      ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
      ws.addRow(["1000", "2026-01-22", "H1", "Kas", "x", 100_000, null]); ws.addRow(["4000", "2026-01-22", "H1", "Pend", "x", null, 99_999]);
      const buf = Buffer.from(await wb.xlsx.writeBuffer()); const before = await counts();
      const v = await validateJournalImportBatch(db, buf, "t.xlsx");
      expect(v.errorCount).toBe(1); expect(v.canCommit).toBe(false);
      await expect(commitJournalImportBatch(db, v, actor)).rejects.toThrow();
      expect(await counts()).toEqual(before);
    });

    it("saldo awal (import): selisih Rp 1 ditolak sebagai error file", async () => {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Saldo Awal"); ws.getCell("A3").value = "Tanggal Saldo Awal:"; ws.getCell("B3").value = "2026-01-01";
      ws.getRow(5).values = ["Kode Akun", "Nama Akun", "Debet", "Kredit", "Keterangan"]; ws.getRow(6).values = ["1000", "Kas", 100_000, null, ""]; ws.getRow(7).values = ["3000", "Modal", null, 99_999, ""];
      const v = await validateOpeningBalanceImportBatch(db, Buffer.from(await wb.xlsx.writeBuffer()), "ob.xlsx");
      expect(v.fileErrors.join(" ")).toMatch(/not balanced|tidak sama/i); expect(v.canCommit).toBe(false);
    });

    it("pemulihan: Neraca/Dashboard/Trial Balance tidak pernah dirusak karena semua jurnal Posted seimbang", async () => {
      for (let i = 0; i < 5; i++) { const { id } = await draft(`OK-${i}`, [[kas, 1000 + i, 0], [pend, 0, 1000 + i]]); await postJournalEntry(db, { journalEntryId: id }, actor); }
      await expect(draft("BAD", [[kas, 1, 0], [pend, 0, 2]])).rejects.toBeTruthy();
      const bs = await getBalanceSheet(db, "2026-01-01", "2026-12-31"); expect(bs.isBalanced).toBe(true);
      expect((await getDashboardSummary(db, "2026-01-01", "2026-01-31")).kpis.netProfit.value).toBe(5010);
    });
  });

  describe("UAT-003 -- tanggal kalender ketat", () => {
    it("validator: tanggal nyata vs tidak nyata, kabisat", () => {
      for (const d of ["2026-02-28", "2026-12-31", "2024-02-29", "2026-01-31", "2026-04-30"]) expect(isValidIsoDate(d), d).toBe(true);
      for (const d of ["2026-02-29", "2026-02-30", "2025-02-29", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-5", "26-01-01", "2026-01-01x", "", "1/1/2026", "2025", "' OR '1'='1"]) expect(isValidIsoDate(d), d).toBe(false);
      expect(isValidIsoDate(20260101)).toBe(false); expect(isValidIsoDate(null)).toBe(false);
    });

    it("parseExcelDate: tidak pernah menormalisasi; Date, serial, ISO, ISO+jam diterima; sisanya null", () => {
      expect(parseExcelDate("2026-02-30")).toBeNull(); expect(parseExcelDate("2025-02-29")).toBeNull(); expect(parseExcelDate("2026-02-28")).toBe("2026-02-28");
      expect(parseExcelDate(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05"); expect(parseExcelDate(new Date("x"))).toBeNull();
      expect(parseExcelDate(44927)).toBe("2023-01-01"); expect(parseExcelDate("44927")).toBe("2023-01-01"); expect(parseExcelDate(-5)).toBeNull(); expect(parseExcelDate(99999999)).toBeNull();
      expect(parseExcelDate("2026-01-15T00:00:00.000Z")).toBe("2026-01-15"); expect(parseExcelDate("1/2/2026")).toBeNull(); expect(parseExcelDate("Feb 3 2026")).toBeNull(); expect(parseExcelDate("")).toBeNull();
    });

    it("jurnal manual: 2026-02-30 / 2026-04-31 / 2025-02-29 ditolak sebagai tanggal tidak valid; tidak tersimpan", async () => {
      const feb = crypto.randomUUID(); await db("periods").insert({ id: feb, label: "Feb 2026", start_date: "2026-02-01", end_date: "2026-02-28", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      const before = await counts();
      for (const d of ["2026-02-30", "2026-02-29", "2026-04-31"]) {
        await expect(createDraftJournalEntry(db, { entryDate: d, periodId: feb, referenceNo: "X" + d, lines: [{ accountId: kas, debit: 1, credit: 0 }, { accountId: pend, debit: 0, credit: 1 }] }, actor), d).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
      }
      expect(await counts()).toEqual(before);
    });

    it("import jurnal: 2026-02-30 -> ERROR 'bukan tanggal kalender yang valid'; commit ditolak; tidak ada jurnal bergeser ke 2026-03-02", async () => {
      const mar = crypto.randomUUID(); await db("periods").insert({ id: mar, label: "Mar 2026", start_date: "2026-03-01", end_date: "2026-03-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      const feb = crypto.randomUUID(); await db("periods").insert({ id: feb, label: "Feb 2026", start_date: "2026-02-01", end_date: "2026-02-28", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      for (const bad of ["2026-02-30", "2025-02-29", "2026-04-31", "2026-06-31", "1/2/2026", "bukan-tanggal"]) {
        const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal"); ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
        ws.addRow(["1000", bad, "I1", "Kas", "x", 1000, null]); ws.addRow(["4000", bad, "I1", "Pend", "x", null, 1000]);
        const buf = Buffer.from(await wb.xlsx.writeBuffer()); const before = await counts();
        const v = await validateJournalImportBatch(db, buf, "t.xlsx");
        expect(v.errorCount, bad).toBe(1); expect(v.canCommit).toBe(false);
        await expect(commitJournalImportBatch(db, v, actor)).rejects.toThrow();
        expect(await counts(), bad).toEqual(before);
      }
      expect(await db("journal_entries").where({ entry_date: "2026-03-02" }).first()).toBeUndefined();
    });

    it("import jurnal: tanggal nyata (2026-02-28 dan 2024-02-29 kabisat) tetap VALID", async () => {
      await db("periods").insert({ id: crypto.randomUUID(), label: "Feb 2026", start_date: "2026-02-01", end_date: "2026-02-28", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal"); ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
      ws.addRow(["1000", "2026-02-28", "V1", "Kas", "x", 1000, null]); ws.addRow(["4000", "2026-02-28", "V1", "Pend", "x", null, 1000]);
      const v = await validateJournalImportBatch(db, Buffer.from(await wb.xlsx.writeBuffer()), "t.xlsx");
      expect(v.errorCount).toBe(0); expect(v.validCount).toBe(1);
    });

    it("saldo awal (import): tanggal 2026-02-30 -> file ditolak", async () => {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Saldo Awal"); ws.getCell("A3").value = "Tanggal Saldo Awal:"; ws.getCell("B3").value = "2026-02-30";
      ws.getRow(5).values = ["Kode Akun", "Nama Akun", "Debet", "Kredit", "Keterangan"]; ws.getRow(6).values = ["1000", "Kas", 1000, null, ""]; ws.getRow(7).values = ["3000", "Modal", null, 1000, ""];
      const v = await validateOpeningBalanceImportBatch(db, Buffer.from(await wb.xlsx.writeBuffer()), "ob.xlsx");
      expect(v.canCommit).toBe(false); expect(v.openingDate).toBeNull();
    });

    it("laporan/dashboard: tanggal tidak nyata atau non-ISO -> InvalidDateRangeError (bukan 500, bukan alarm palsu 'tidak seimbang')", async () => {
      for (const bad of ["2025-02-30", "2025", "1/1/2025", "' OR '1'='1", "2025-13-01"]) {
        await expect(getBalanceSheet(db, bad, bad), bad).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
        await expect(getIncomeStatement(db, "2026-01-01", bad), bad).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
        await expect(getDashboardSummary(db, bad, "2026-01-31"), bad).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
      }
    });

    it("periode: generate-monthly dan createPeriod menolak tanggal tidak nyata", async () => {
      await expect(generateMonthlyPeriods(db, "abc", "def", actor)).rejects.toMatchObject({ name: "Error" });
      await expect(generateMonthlyPeriods(db, "2027-02-30", "2027-03-31", actor)).rejects.toBeTruthy();
    });

    it("reversal mengikuti tanggal jurnal asli dan tidak menerima tanggal non-kalender", async () => {
      const { id } = await draft("R1", [[kas, 10, 0], [pend, 0, 10]], "2026-01-31");
      await postJournalEntry(db, { journalEntryId: id }, actor);
      await expect(reverseJournalEntry(db, { journalEntryId: id, reversalEntryDate: "2026-02-30", reversalReferenceNo: "R1-REV", reason: "x" }, actor)).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
      const rev = await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "R1-REV", reason: "x" }, actor);
      expect(String((await db("journal_entries").where({ id: rev.id }).first()).entry_date).slice(0, 10)).toBe("2026-01-31");
    });
  });
});
