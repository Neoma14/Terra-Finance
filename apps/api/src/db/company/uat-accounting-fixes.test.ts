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
import { getCashFlowStatement } from "./reporting/cash-flow-service.js";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { getAccountLedgerByRange } from "./ledger-service.js";
import { allocateProRata, fromCents, toCents } from "../../lib/money.js";
import type { ActorContext } from "./company-audit.js";

/**
 * Regression UAT-005 (Cash Flow: aritmetika uang bilangan bulat, alokasi
 * pro-rata tanpa pecahan liar, jumlah alokasi == kas entri) dan UAT-011
 * (baris jurnal harus tepat SATU sisi: ditolak terkontrol, bukan 500).
 */
const actor: ActorContext = { actorType: "user", actorId: "t", actorLabel: "T" };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("UAT-005 / UAT-011", () => {
  let tmp: string;
  let db: Knex;
  const acc: Record<string, string> = {};
  const periods = new Map<string, string>();

  const counts = async () => ({
    j: Number((await db("journal_entries").count<{ c: number }[]>("* as c"))[0].c),
    l: Number((await db("journal_entry_lines").count<{ c: number }[]>("* as c"))[0].c),
    a: Number((await db("company_audit_log").count<{ c: number }[]>("* as c"))[0].c),
  });

  async function ensurePeriod(ym: string): Promise<string> {
    const have = periods.get(ym);
    if (have) return have;
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const id = crypto.randomUUID();
    await db("periods").insert({ id, label: ym, start_date: `${ym}-01`, end_date: `${ym}-${String(last).padStart(2, "0")}`, period_type: "month", fiscal_year: y, status: "OPEN" });
    periods.set(ym, id);
    return id;
  }
  async function jr(ref: string, date: string, lines: Array<[string, number, number]>, post = true) {
    const periodId = await ensurePeriod(date.slice(0, 7));
    const { id } = await createDraftJournalEntry(db, { entryDate: date, periodId, referenceNo: ref, lines: lines.map(([k, debit, credit]) => ({ accountId: acc[k], debit, credit })) }, actor);
    if (post) await postJournalEntry(db, { journalEntryId: id }, actor);
    return id;
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terra-uat-acc-"));
    db = knexLib({ ...baseKnexConfig, connection: { filename: path.join(tmp, "company.db") } });
    await db.migrate.latest();
    periods.clear();
    const mk = async (key: string, code: string, type: string, nb: "debit" | "credit", extra: Record<string, unknown> = {}) => {
      acc[key] = (await createAccount(db, { code, name: key, accountTypeCode: type, normalBalance: nb, ...extra } as any, actor)).id;
    };
    await mk("kas", "1000", "ASSET", "debit", { isCash: true, cashFlowActivity: null });
    await mk("kas2", "1010", "ASSET", "debit", { isCash: true, cashFlowActivity: null });
    await mk("aset", "1500", "ASSET", "debit", { cashFlowActivity: "investing" });
    await mk("utang", "2000", "LIABILITY", "credit", { cashFlowActivity: "financing" });
    await mk("modal", "3000", "EQUITY", "credit", { cashFlowActivity: "financing" });
    await mk("pend", "4000", "REVENUE", "credit", { cashFlowActivity: "operating" });
    await mk("beban", "5000", "EXPENSE", "debit", { cashFlowActivity: "operating" });
    await mk("lain", "5900", "EXPENSE", "debit", {}); // tanpa klasifikasi arus kas
  });
  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- UAT-005
  describe("UAT-005 -- Cash Flow", () => {
    /** Invarian yang HARUS berlaku untuk setiap rentang tanggal. */
    async function assertInvariants(from: string, to: string) {
      const cf = await getCashFlowStatement(db, from, to);
      const sumC = toCents(cf.operating.amount) + toCents(cf.investing.amount) + toCents(cf.financing.amount) + toCents(cf.unclassifiedAmount);
      // Net = Operating + Investing + Financing (+ tak terklasifikasi, dilaporkan terpisah)
      expect(sumC, `net ${from}..${to}`).toBe(toCents(cf.netChangeInCash));
      // Closing = Opening + Net
      expect(toCents(cf.beginningCash) + toCents(cf.netChangeInCash), `closing ${from}..${to}`).toBe(toCents(cf.endingCash));
      // Pergerakan kas == Ledger (jumlah seluruh akun kas)
      let ledgerNet = 0n;
      for (const k of ["kas", "kas2"]) {
        const l = await getAccountLedgerByRange(db, acc[k], from, to);
        ledgerNet += toCents(l.endingBalance) - toCents(l.openingBalance);
      }
      expect(ledgerNet, `ledger ${from}..${to}`).toBe(toCents(cf.netChangeInCash));
      // Closing cash == kas di Neraca pada tanggal yang sama
      const bs = await getBalanceSheet(db, from, to);
      const bsCash = bs.assets.lines.filter((x) => x.accountId === acc.kas || x.accountId === acc.kas2).reduce((s, x) => s + toCents(x.amount), 0n);
      expect(bsCash, `neraca ${from}..${to}`).toBe(toCents(cf.endingCash));
      return cf;
    }

    it("aritmetika sen: 0,1 + 0,2 = 0,3 persis (tanpa noise 0.30000000000000004)", async () => {
      await jr("F1", "2026-01-05", [["kas", 0.1, 0], ["pend", 0, 0.1]]);
      await jr("F2", "2026-01-06", [["kas", 0.2, 0], ["pend", 0, 0.2]]);
      const cf = await assertInvariants("2026-01-01", "2026-01-31");
      expect(cf.operating.amount).toBe(0.3);
      expect(cf.endingCash).toBe(0.3);
    });

    it("transaksi bulat: Operating persis, tidak ada pecahan", async () => {
      await jr("T1", "2026-01-05", [["kas", 1_000_000, 0], ["pend", 0, 1_000_000]]);
      await jr("T2", "2026-01-06", [["beban", 250_000, 0], ["kas", 0, 250_000]]);
      const cf = await assertInvariants("2026-01-01", "2026-01-31");
      expect(cf.operating.amount).toBe(750_000);
      expect(cf.investing.amount).toBe(0);
      expect(cf.financing.amount).toBe(0);
      expect(cf.unclassifiedAmount).toBe(0);
    });

    it("pro-rata: entri campuran 3 aktivitas -> alokasi Rupiah utuh, jumlah == kas entri", async () => {
      // Kas keluar Rp 1 saja, dibagi ke 4 baris lawan berbobot tidak habis dibagi.
      await jr("M1", "2026-02-10", [["beban", 100_000, 0], ["aset", 100_000, 0], ["utang", 100_000, 0], ["pend", 0, 299_999], ["kas", 0, 1]]);
      const cf = await assertInvariants("2026-02-01", "2026-02-28");
      for (const v of [cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.unclassifiedAmount]) expect(Number.isInteger(v)).toBe(true);
      expect(cf.netChangeInCash).toBe(-1);
      // deterministik: dihitung ulang -> identik
      expect(await getCashFlowStatement(db, "2026-02-01", "2026-02-28")).toEqual(cf);
    });

    it("pro-rata: kas 100.000 dibagi tiga bobot sama -> 33.334 + 33.333 + 33.333 (total tetap 100.000)", () => {
      const parts = allocateProRata(10_000_000n, [1n, 1n, 1n], 100n);
      expect(parts.map(fromCents)).toEqual([33_334, 33_333, 33_333]);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(10_000_000n);
      // negatif (kas keluar) -> simetris, total tetap
      const neg = allocateProRata(-10_000_000n, [1n, 1n, 1n], 100n);
      expect(neg.reduce((a, b) => a + b, 0n)).toBe(-10_000_000n);
      // bobot tidak sama, jumlah selalu persis untuk banyak kombinasi
      const r = rng(7);
      for (let i = 0; i < 500; i++) {
        const n = 2 + Math.floor(r() * 5);
        const w = Array.from({ length: n }, () => BigInt(1 + Math.floor(r() * 5_000_000)));
        const total = BigInt(Math.floor((r() - 0.5) * 2_000_000_000)) * 100n;
        expect(allocateProRata(total, w, 100n).reduce((a, b) => a + b, 0n)).toBe(total);
        const unit1 = BigInt(Math.floor((r() - 0.5) * 200_000));
        expect(allocateProRata(unit1, w, 1n).reduce((a, b) => a + b, 0n)).toBe(unit1);
      }
    });

    it("nominal berpecahan sen tetap persis (1000,50 + 2000,25) dan hasil <= 2 desimal", async () => {
      await jr("C1", "2026-03-02", [["kas", 1000.5, 0], ["pend", 0, 1000.5]]);
      await jr("C2", "2026-03-03", [["kas", 2000.25, 0], ["utang", 0, 2000.25]]);
      const cf = await assertInvariants("2026-03-01", "2026-03-31");
      expect(cf.operating.amount).toBe(1000.5);
      expect(cf.financing.amount).toBe(2000.25);
    });

    it("transfer kas<->kas tidak dihitung; baris non-kas tanpa klasifikasi -> unclassified", async () => {
      await jr("X1", "2026-04-01", [["kas", 500_000, 0], ["modal", 0, 500_000]]);
      await jr("X2", "2026-04-02", [["kas2", 200_000, 0], ["kas", 0, 200_000]]);
      await jr("X3", "2026-04-03", [["kas", 0, 60_000], ["lain", 60_000, 0]]);
      const cf = await assertInvariants("2026-04-01", "2026-04-30");
      expect(cf.financing.amount).toBe(500_000);
      expect(cf.unclassifiedAmount).toBe(-60_000);
      expect(cf.netChangeInCash).toBe(440_000);
    });

    it("periode tanpa transaksi kas: semua nol, kas awal == kas akhir", async () => {
      await jr("E1", "2026-01-10", [["kas", 100_000, 0], ["pend", 0, 100_000]]);
      const cf = await assertInvariants("2026-05-01", "2026-05-31");
      expect([cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.unclassifiedAmount, cf.netChangeInCash]).toEqual([0, 0, 0, 0, 0]);
      expect(cf.beginningCash).toBe(100_000);
      expect(cf.endingCash).toBe(100_000);
    });

    it("reversal: jurnal asli + reversal -> dampak kas nol, invarian tetap berlaku", async () => {
      const id = await jr("R1", "2026-06-10", [["beban", 100_000, 0], ["aset", 100_000, 0], ["utang", 100_000, 0], ["pend", 0, 299_999], ["kas", 0, 1]]);
      const before = await getCashFlowStatement(db, "2026-06-01", "2026-06-30");
      expect(before.netChangeInCash).toBe(-1);
      await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "R1-REV", reason: "koreksi" }, actor);
      const cf = await assertInvariants("2026-06-01", "2026-06-30");
      expect(cf.netChangeInCash).toBe(0);
      expect([cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.unclassifiedAmount]).toEqual([0, 0, 0, 0]);
      // reversal tidak pernah menghasilkan baris dengan debit DAN kredit
      const bad = await db("journal_entry_lines").whereRaw("debit > 0 and credit > 0");
      expect(bad).toHaveLength(0);
    });

    it("rekonsiliasi lintas rentang: 1 hari, 1 minggu, 1 bulan, 1 tahun, 5 tahun (data acak 2021-2025, termasuk reversal)", async () => {
      const r = rng(20260501);
      const amt = () => 1000 + Math.floor(r() * 9_999_000);
      const ids: string[] = [];
      for (let i = 0; i < 260; i++) {
        const y = 2021 + (i % 5), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
        if (y === 2026) continue;
        const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const a = amt(), b = amt(), c = amt();
        const kind = Math.floor(r() * 9);
        let lines: Array<[string, number, number]>;
        switch (kind) {
          case 0: lines = [["kas", a, 0], ["pend", 0, a]]; break;
          case 1: lines = [["beban", a, 0], ["kas", 0, a]]; break;
          case 2: lines = [["aset", a, 0], ["kas", 0, a]]; break;
          case 3: lines = [["kas", a, 0], ["utang", 0, a]]; break;
          case 4: lines = [["beban", a, 0], ["utang", b, 0], ["aset", c, 0], ["kas", 0, a + b + c]]; break;
          case 5: lines = [["kas", a + b, 0], ["pend", 0, a], ["utang", 0, b]]; break;
          case 6: lines = [["kas2", a, 0], ["kas", 0, a]]; break; // transfer kas<->kas
          case 7: lines = [["beban", a, 0], ["utang", 0, a]]; break;
          default: lines = a % 3 === 0 ? [["kas", a, 0], ["pend", 0, a]] : [["kas", a, 0], ["pend", 0, a - (a % 3)], ["lain", 0, a % 3]]; break; // sebagian tanpa klasifikasi
        }
        ids.push(await jr(`RND-${i}`, date, lines));
      }
      for (let i = 0; i < ids.length; i += 11) await reverseJournalEntry(db, { journalEntryId: ids[i], reversalReferenceNo: `REV-${i}`, reason: "uji" }, actor);

      for (const [f, t] of [
        ["2023-03-10", "2023-03-10"], // 1 hari
        ["2023-03-06", "2023-03-12"], // 1 minggu
        ["2023-03-01", "2023-03-31"], // 1 bulan
        ["2022-01-01", "2022-12-31"], // 1 tahun
        ["2021-01-01", "2025-12-31"], // 5 tahun
      ] as const) {
        const cf = await assertInvariants(f, t);
        for (const v of [cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.unclassifiedAmount, cf.netChangeInCash, cf.beginningCash, cf.endingCash]) {
          expect(Number.isInteger(v), `${f}..${t} nilai ${v} harus Rupiah utuh`).toBe(true);
        }
      }
      for (const y of [2021, 2022, 2023, 2024, 2025]) await assertInvariants(`${y}-01-01`, `${y}-12-31`);
      // integritas: seluruh jurnal POSTED seimbang & Trial Balance seimbang
      const unb = await db("journal_entry_lines as l").join("journal_entries as e", "e.id", "l.journal_entry_id").whereIn("e.status", ["POSTED", "REVERSED"]).groupBy("e.id").havingRaw("SUM(CAST(ROUND(l.debit*100) AS INTEGER)) != SUM(CAST(ROUND(l.credit*100) AS INTEGER))").select("e.id");
      expect(unb).toHaveLength(0);
      expect((await getTrialBalance(db, await ensurePeriod("2023-03"))).isBalanced).toBe(true);
    });
  });

  // ---------------------------------------------------------------- UAT-011
  describe("UAT-011 -- satu baris tepat satu sisi", () => {
    const tryCreate = (ref: string, lines: Array<[string, number, number]>) => jr(ref, "2026-01-15", lines, false);

    it("debit saja / kredit saja diterima dan bisa diposting", async () => {
      const id = await jr("OK1", "2026-01-15", [["kas", 100_000, 0], ["pend", 0, 100_000]]);
      expect((await db("journal_entries").where({ id }).first()).status).toBe("POSTED");
    });

    for (const [name, lines] of [
      ["debit + kredit satu baris (seimbang secara total)", [["kas", 100_000, 50_000], ["pend", 0, 50_000]]],
      ["debit + kredit satu baris (identik)", [["kas", 100_000, 100_000], ["pend", 0, 0]]],
      ["debit 0 + kredit 0 (baris tambahan)", [["kas", 100_000, 0], ["pend", 0, 100_000], ["beban", 0, 0]]],
      ["debit negatif", [["kas", -100_000, 0], ["pend", 0, -100_000]]],
      ["kredit negatif", [["kas", 200_000, 0], ["pend", 0, 100_000], ["utang", 0, -0.0000001 - 100_000]]],
      ["nilai di bawah 1 sen dianggap nol", [["kas", 100_000, 0], ["pend", 0, 100_000], ["beban", 0.004, 0]]],
    ] as Array<[string, Array<[string, number, number]>]>) {
      it(`ditolak terkontrol (JOURNAL_INVALID_LINE) & atomik: ${name}`, async () => {
        const before = await counts();
        await expect(tryCreate("BAD", lines)).rejects.toMatchObject({ code: "JOURNAL_INVALID_LINE" });
        expect(await counts()).toEqual(before);
      });
    }

    it("NaN / Infinity / bukan angka ditolak sebagai baris tidak valid", async () => {
      const before = await counts();
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number]) {
        await expect(tryCreate("BAD", [["kas", bad, 0], ["pend", 0, 100]])).rejects.toMatchObject({ code: "JOURNAL_INVALID_LINE" });
      }
      expect(await counts()).toEqual(before);
    });

    it("pesan error jelas (tanpa SQL / nama constraint)", async () => {
      await expect(tryCreate("BAD", [["kas", 10, 5], ["pend", 0, 5]])).rejects.toThrow(/Baris 1: satu baris tidak boleh berisi debit dan kredit sekaligus/);
    });

    it("lapisan terakhir: CHECK database tetap menolak insert langsung debit+kredit", async () => {
      const id = await jr("D1", "2026-01-15", [["kas", 100, 0], ["pend", 0, 100]], false);
      await expect(db("journal_entry_lines").insert({ id: crypto.randomUUID(), journal_entry_id: id, account_id: acc.kas, debit: 5, credit: 5, line_order: 9 })).rejects.toThrow();
    });

    it("draft lama berisi baris nol-nol tidak bisa DIPOSTING (status tetap DRAFT, tanpa audit POST)", async () => {
      const id = await jr("LEG", "2026-01-15", [["kas", 100, 0], ["pend", 0, 100]], false);
      await db("journal_entry_lines").insert({ id: crypto.randomUUID(), journal_entry_id: id, account_id: acc.beban, debit: 0, credit: 0, line_order: 9 });
      const before = await counts();
      await expect(postJournalEntry(db, { journalEntryId: id }, actor)).rejects.toMatchObject({ code: "JOURNAL_INVALID_LINE" });
      expect((await db("journal_entries").where({ id }).first()).status).toBe("DRAFT");
      expect(await db("company_audit_log").where({ action: "journal.post", entity_id: id })).toHaveLength(0);
      expect(await counts()).toEqual(before);
    });

    it("import: baris Debit+Kredit sekaligus -> ERROR di preview, commit ditolak, DB tidak berubah", async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Jurnal");
      ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
      ws.addRow(["1000", "2026-01-20", "IMP1", "Kas", "x", 100_000, 50_000]);
      ws.addRow(["4000", "2026-01-20", "IMP1", "Pend", "x", null, 50_000]);
      await ensurePeriod("2026-01");
      const before = await counts();
      const v = await validateJournalImportBatch(db, Buffer.from(await wb.xlsx.writeBuffer()), "t.xlsx");
      expect(v.errorCount).toBe(1);
      expect(v.canCommit).toBe(false);
      expect(JSON.stringify(v)).toMatch(/Debit dan Kredit sekaligus/);
      await expect(commitJournalImportBatch(db, v, actor)).rejects.toThrow();
      expect(await counts()).toEqual(before);
    });

    it("import: nilai negatif -> ERROR di preview", async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Jurnal");
      ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
      ws.addRow(["1000", "2026-01-20", "IMP2", "Kas", "x", -100_000, null]);
      ws.addRow(["4000", "2026-01-20", "IMP2", "Pend", "x", null, -100_000]);
      await ensurePeriod("2026-01");
      const v = await validateJournalImportBatch(db, Buffer.from(await wb.xlsx.writeBuffer()), "t.xlsx");
      expect(v.canCommit).toBe(false);
      expect(v.errorCount).toBeGreaterThan(0);
    });

    it("import valid tetap lolos dan jurnal seimbang tetap bisa diposting", async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Jurnal");
      ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
      ws.addRow(["1000", "2026-01-20", "IMP3", "Kas", "x", 100_000, null]);
      ws.addRow(["4000", "2026-01-20", "IMP3", "Pend", "x", null, 100_000]);
      await ensurePeriod("2026-01");
      const v = await validateJournalImportBatch(db, Buffer.from(await wb.xlsx.writeBuffer()), "t.xlsx");
      expect(v.errorCount).toBe(0);
      await commitJournalImportBatch(db, v, actor);
      expect(await db("journal_entries").where({ reference_no: "IMP3", status: "POSTED" })).toHaveLength(1);
    });

    it("reversal tidak pernah menghasilkan baris debit+kredit; 0 jurnal POSTED tak seimbang", async () => {
      const id = await jr("RV", "2026-01-15", [["kas", 100_000, 0], ["pend", 0, 60_000], ["utang", 0, 40_000]]);
      await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "RV-REV", reason: "uji" }, actor);
      expect(await db("journal_entry_lines").whereRaw("(debit > 0 and credit > 0) or (debit = 0 and credit = 0)")).toHaveLength(0);
    });
  });
});
