import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "../knexfile.js";
import { createAccount } from "../account-service.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "../journal-service.js";
import { getBalanceSheet } from "./balance-sheet-service.js";
import { BalanceSheetNotBalancedError, InvalidDateRangeError } from "./reporting-types.js";
import type { ActorContext } from "../company-audit.js";

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

describe("Balance Sheet (TASK-DB-ARCH-012 §6)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let pendapatanId: string;
  let bebanId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-balance-sheet-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    pendapatanId = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    bebanId = (await createAccount(db, { code: "6000", name: "Beban", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Perusahaan tanpa transaksi: semua section kosong, totals 0, isBalanced true", async () => {
    const report = await getBalanceSheet(db, "2026-01-01", "2026-01-31");
    expect(report.assets.lines).toHaveLength(0);
    expect(report.liabilities.lines).toHaveLength(0);
    expect(report.equity.lines).toHaveLength(0);
    expect(report.totalAssets).toBe(0);
    expect(report.totalLiabilities).toBe(0);
    expect(report.totalEquity).toBe(0);
    expect(report.isBalanced).toBe(true);
    expect(report.balanceDifference).toBe(0);
  });

  it("Assets = Liabilities + Equity, dgn Current Period Profit/Loss sbg bridge di section Equity", async () => {
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

    const report = await getBalanceSheet(db, "2026-01-01", "2026-01-31");

    expect(report.totalAssets).toBe(1_250_000); // Kas: 1.000.000 + 300.000 - 50.000
    expect(report.totalLiabilities).toBe(0);

    const bridgeLine = report.equity.lines.find((l) => l.accountCode === "RE-BRIDGE")!;
    expect(bridgeLine.amount).toBe(250_000); // 300.000 (revenue) - 50.000 (expense)
    expect(report.totalEquity).toBe(1_000_000 + 250_000);

    expect(report.isBalanced).toBe(true);
    expect(report.balanceDifference).toBe(0);
    expect(report.totalAssets).toBe(report.totalLiabilities + report.totalEquity);
  });

  it("Jurnal REVERSED tetap tercatat sbg historical fact, tidak dihitung dua kali (konsisten ledger-service.ts)", async () => {
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

    await reverseJournalEntry(
      db,
      {
        journalEntryId: sale.id, reversalReferenceNo: "REV-0001",
        reason: "Test pembalikan penjualan",
      },
      actor,
    );

    const report = await getBalanceSheet(db, "2026-01-01", "2026-01-31");
    // Setelah reversal, efek penjualan 300.000 harus balik ke nol -- Kas
    // kembali ke 1.000.000 (hanya opening balance), bukan 700.000 (yang
    // terjadi kalau REVERSED dikecualikan & reversal-nya tetap mengurangi).
    expect(report.totalAssets).toBe(1_000_000);
    const bridgeLine = report.equity.lines.find((l) => l.accountCode === "RE-BRIDGE");
    expect(bridgeLine).toBeUndefined(); // net profit/loss = 0, bridge tidak ditampilkan
    expect(report.totalEquity).toBe(1_000_000);
    expect(report.isBalanced).toBe(true);
  });

  it("Melempar BalanceSheetNotBalancedError dgn diagnostic lengkap kalau data historis dimanipulasi langsung (integrity bug)", async () => {
    const ob = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-01", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
        { accountId: kasId, debit: 1_000_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 1_000_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: ob.id }, actor);

    const line = await db("journal_entry_lines").where("debit", ">", 0).first();
    await db("journal_entry_lines").where({ id: line.id }).update({ debit: Number(line.debit) + 1 });

    await expect(getBalanceSheet(db, "2026-01-01", "2026-01-31")).rejects.toThrow(BalanceSheetNotBalancedError);
    try {
      await getBalanceSheet(db, "2026-01-01", "2026-01-31");
      expect.fail("harus throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BalanceSheetNotBalancedError);
      const typed = err as BalanceSheetNotBalancedError;
      expect(typed.difference).toBe(1);
      expect(typed.totalAssets).toBe(1_000_001);
    }
  });

  it("fromDate > toDate -> InvalidDateRangeError", async () => {
    await expect(getBalanceSheet(db, "2026-02-01", "2026-01-01")).rejects.toThrow(InvalidDateRangeError);
  });

  it("Kontra-asset (Akumulasi Penyusutan, tipe ASSET tapi normal_balance CREDIT) MENGURANGI totalAssets, bukan menambah -- tetap balanced (BUG NYATA PT MIGAS WARDHANA, selisih riil Rp 6.452.507.058)", async () => {
    const asetTetapId = (await createAccount(db, { code: "1600", name: "Aset Tetap", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    const akumPenyusutanId = (await createAccount(db, { code: "1610", name: "Akumulasi Penyusutan", accountTypeCode: "ASSET", normalBalance: "credit" }, actor)).id;
    const dividenId = (await createAccount(db, { code: "3300", name: "Dividen Dibagikan", accountTypeCode: "EQUITY", normalBalance: "debit" }, actor)).id;

    const ob = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-01", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
        { accountId: asetTetapId, debit: 1_000_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 1_000_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: ob.id }, actor);

    const depresiasi = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-15", periodId, referenceNo: "JRN-DEPR", lines: [
        { accountId: bebanId, debit: 100_000, credit: 0 },
        { accountId: akumPenyusutanId, debit: 0, credit: 100_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: depresiasi.id }, actor);

    const dividen = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-20", periodId, referenceNo: "JRN-DIV", lines: [
        { accountId: dividenId, debit: 50_000, credit: 0 },
        { accountId: kasId, debit: 0, credit: 50_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: dividen.id }, actor);

    const report = await getBalanceSheet(db, "2026-01-01", "2026-01-31");

    const akumLine = report.assets.lines.find((l) => l.accountCode === "1610")!;
    expect(akumLine.amount).toBe(-100_000); // HARUS negatif -- mengurangi aset, bukan menambah

    const divLine = report.equity.lines.find((l) => l.accountCode === "3300")!;
    expect(divLine.amount).toBe(-50_000); // HARUS negatif -- mengurangi equity, bukan menambah

    expect(report.totalAssets).toBe(1_000_000 - 100_000 - 50_000); // aset tetap - akum.penyusutan - kas keluar dividen
    expect(report.isBalanced).toBe(true);
    expect(report.balanceDifference).toBe(0);
    expect(report.totalAssets).toBe(report.totalLiabilities + report.totalEquity);
  });
});
