import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "./journal-service.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { validatePeriodForClosing } from "./period-closing-service.js";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { getIncomeStatement } from "./reporting/income-statement-service.js";
import { getEquityStatement } from "./reporting/equity-statement-service.js";
import type { ActorContext } from "./company-audit.js";

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}
const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

async function seedPeriod(db: Knex, label: string, startDate: string, endDate: string): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({ id, label, start_date: startDate, end_date: endDate, period_type: "month", fiscal_year: 2026, status: "OPEN" });
  return id;
}

describe("Trial Balance (TASK-DB-ARCH-011 Part B §33)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let pendapatanId: string;
  let bebanId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-trial-balance-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    pendapatanId = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    bebanId = (await createAccount(db, { code: "6000", name: "Beban", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");

    const ob = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-01", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
        { accountId: kasId, debit: 1_000_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 1_000_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: ob.id }, actor);

    const sale = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-10", periodId, referenceNo: "JRN-0001", lines: [
        { accountId: kasId, debit: 300_000, credit: 0 },
        { accountId: pendapatanId, debit: 0, credit: 300_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: sale.id }, actor);

    const expense = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-15", periodId, referenceNo: "JRN-0002", lines: [
        { accountId: bebanId, debit: 50_000, credit: 0 },
        { accountId: kasId, debit: 0, credit: 50_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: expense.id }, actor);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Total Debit = Total Credit (isBalanced true, difference 0)", async () => {
    const tb = await getTrialBalance(db, periodId);
    expect(tb.isBalanced).toBe(true);
    expect(tb.difference).toBe(0);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it("Setiap akun muncul di kolom yang benar sesuai arah saldo", async () => {
    const tb = await getTrialBalance(db, periodId);
    const kasRow = tb.rows.find((r) => r.accountId === kasId)!;
    const modalRow = tb.rows.find((r) => r.accountId === modalId)!;
    const pendapatanRow = tb.rows.find((r) => r.accountId === pendapatanId)!;
    const bebanRow = tb.rows.find((r) => r.accountId === bebanId)!;

    expect(kasRow.debit).toBe(1_250_000); // 1.000.000 + 300.000 - 50.000
    expect(kasRow.credit).toBe(0);
    expect(modalRow.credit).toBe(1_000_000);
    expect(modalRow.debit).toBe(0);
    expect(pendapatanRow.credit).toBe(300_000);
    expect(bebanRow.debit).toBe(50_000);
  });

  it("Akun tanpa saldo & tanpa aktivitas periode ini tidak ditampilkan", async () => {
    const unusedId = (await createAccount(db, { code: "9999", name: "Tidak Terpakai", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    const tb = await getTrialBalance(db, periodId);
    expect(tb.rows.map((r) => r.accountId)).not.toContain(unusedId);
  });

  it("Mendeteksi TIDAK balance kalau ada manipulasi data langsung (tanpa menyembunyikan selisih)", async () => {
    // Simulasi data rusak langsung di DB (bypass service, utk menguji
    // bahwa getTrialBalance MELAPORKAN selisih apa adanya, tidak pernah
    // membulatkan/menyembunyikannya -- Accounting_Rules.md §19/§34).
    const line = await db("journal_entry_lines").where("debit", ">", 0).first();
    await db("journal_entry_lines").where({ id: line.id }).update({ debit: Number(line.debit) + 1 });

    const tb = await getTrialBalance(db, periodId);
    expect(tb.isBalanced).toBe(false);
    expect(tb.difference).not.toBe(0);
  });
  describe("BUG-005: Laba (Rugi) Belum Ditutup dari periode sebelumnya", () => {
    // Januari (dari beforeEach): pendapatan 300.000, beban 50.000 -> laba 250.000.
    let febId: string;
    async function post(entryDate: string, inPeriod: string, referenceNo: string, lines: Array<{ accountId: string; debit: number; credit: number }>) {
      const draft = await createDraftJournalEntry(db, { entryDate, periodId: inPeriod, referenceNo, lines }, actor);
      await postJournalEntry(db, { journalEntryId: draft.id }, actor);
    }
    beforeEach(async () => {
      febId = await seedPeriod(db, "Feb 2026", "2026-02-01", "2026-02-28");
      await post("2026-02-10", febId, "JRN-FEB-1", [
        { accountId: kasId, debit: 120_000, credit: 0 },
        { accountId: pendapatanId, debit: 0, credit: 120_000 },
      ]);
    });

    it("periode pertama: TIDAK ada baris bridge (belum ada laba periode sebelumnya)", async () => {
      const tb = await getTrialBalance(db, periodId);
      expect(tb.rows.some((r) => r.isBridge)).toBe(false);
      expect(tb.isBalanced).toBe(true);
    });

    it("periode kedua: balance, dgn satu baris bridge di kolom Kredit sebesar laba Januari", async () => {
      const tb = await getTrialBalance(db, febId);
      const bridge = tb.rows.filter((r) => r.isBridge);
      expect(bridge).toHaveLength(1);
      expect(bridge[0]).toMatchObject({ code: "RE-BRIDGE", debit: 0, credit: 250_000 });
      expect(tb.isBalanced).toBe(true);
      expect(tb.totalDebit).toBe(tb.totalCredit);
      expect(tb.difference).toBe(0);
    });

    it("nilai bridge = baris yang sama di Neraca per hari sebelum periode, dan = Net Profit Laba Rugi kumulatif (sumber sama)", async () => {
      const tb = await getTrialBalance(db, febId);
      const bridge = tb.rows.find((r) => r.isBridge)!;
      const bs = await getBalanceSheet(db, "2026-01-01", "2026-01-31");
      const bsBridge = bs.equity.lines.find((l) => l.accountCode === "RE-BRIDGE")!;
      expect(bridge.credit - bridge.debit).toBe(bsBridge.amount);
      const is = await getIncomeStatement(db, "2026-01-01", "2026-01-31");
      expect(bridge.credit - bridge.debit).toBe(is.netProfit);
    });

    it("tidak double counting: pendapatan Februari tetap hanya di baris akunnya, bridge tidak memuatnya", async () => {
      const tb = await getTrialBalance(db, febId);
      expect(tb.rows.find((r) => r.code === "4000")).toMatchObject({ debit: 0, credit: 120_000 });
      expect(tb.rows.find((r) => r.isBridge)!.credit).toBe(250_000);
      // Total kredit = Modal 1.000.000 + Pendapatan Feb 120.000 + bridge 250.000
      expect(tb.totalCredit).toBe(1_370_000);
      expect(tb.rows.find((r) => r.code === "1000")).toMatchObject({ debit: 1_370_000, credit: 0 });
    });

    it("rugi kumulatif ditempatkan di kolom Debit", async () => {
      await post("2026-02-20", febId, "JRN-FEB-RUGI", [
        { accountId: bebanId, debit: 900_000, credit: 0 },
        { accountId: kasId, debit: 0, credit: 900_000 },
      ]);
      const marId = await seedPeriod(db, "Mar 2026", "2026-03-01", "2026-03-31");
      const tb = await getTrialBalance(db, marId);
      // Jan +250.000, Feb +120.000 - 900.000 => rugi kumulatif 530.000
      expect(tb.rows.find((r) => r.isBridge)).toMatchObject({ debit: 530_000, credit: 0 });
      expect(tb.isBalanced).toBe(true);
    });

    it("periode kedua sekarang lolos pemeriksaan tutup periode", async () => {
      const check = await validatePeriodForClosing(db, febId);
      expect(check.issues).toEqual([]);
      expect(check.canClose).toBe(true);
    });

    it("read-only: tidak menulis jurnal, dan Neraca/Laba Rugi/Ekuitas tidak berubah", async () => {
      const snapshot = async () => ({
        entries: (await db("journal_entries").count<{ c: number }[]>("* as c"))[0].c,
        lines: (await db("journal_entry_lines").count<{ c: number }[]>("* as c"))[0].c,
        bs: await getBalanceSheet(db, "2026-01-01", "2026-02-28"),
        is: await getIncomeStatement(db, "2026-01-01", "2026-02-28"),
        eq: await getEquityStatement(db, "2026-02-01", "2026-02-28"),
      });
      const before = await snapshot();
      await getTrialBalance(db, febId);
      await getTrialBalance(db, periodId);
      expect(await snapshot()).toEqual(before);
      expect(before.bs.totalAssets).toBe(1_370_000);
      expect(before.bs.totalEquity).toBe(1_370_000);
      expect(before.is.netProfit).toBe(370_000);
    });

    it("selisih karena data rusak TETAP terdeteksi (bridge tidak menutupi selisih)", async () => {
      const feb = await db("journal_entries").where({ reference_no: "JRN-FEB-1" }).first();
      await db("journal_entry_lines").where({ journal_entry_id: feb.id, account_id: kasId }).update({ debit: 120_999 });
      const tb = await getTrialBalance(db, febId);
      expect(tb.isBalanced).toBe(false);
    });
  });
});
