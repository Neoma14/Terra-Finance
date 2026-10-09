import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "../knexfile.js";
import { createAccount } from "../account-service.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "../journal-service.js";
import { getCashFlowStatement } from "./cash-flow-service.js";
import { InvalidDateRangeError } from "./reporting-types.js";
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

describe("Cash Flow Statement (TASK-DB-ARCH-012 §9) -- sumber: accounts.is_cash + accounts.cash_flow_activity, bukan hardcode nama", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let bankId: string;
  let modalId: string;
  let peralatanId: string;
  let pendapatanId: string;
  let bebanId: string;
  let bebanBungaId: string;
  let utangId: string;
  let piutangLainId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-cash-flow-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit", isCash: true }, actor)).id;
    bankId = (await createAccount(db, { code: "1100", name: "Bank", accountTypeCode: "ASSET", normalBalance: "debit", isCash: true }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit", cashFlowActivity: "financing" }, actor)).id;
    peralatanId = (await createAccount(db, { code: "1500", name: "Peralatan", accountTypeCode: "ASSET", normalBalance: "debit", cashFlowActivity: "investing" }, actor)).id;
    pendapatanId = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit", cashFlowActivity: "operating" }, actor)).id;
    bebanId = (await createAccount(db, { code: "6000", name: "Beban Operasional", accountTypeCode: "EXPENSE", normalBalance: "debit", cashFlowActivity: "operating" }, actor)).id;
    bebanBungaId = (await createAccount(db, { code: "6100", name: "Beban Bunga", accountTypeCode: "EXPENSE", normalBalance: "debit", cashFlowActivity: "operating" }, actor)).id;
    utangId = (await createAccount(db, { code: "2000", name: "Utang Bank", accountTypeCode: "LIABILITY", normalBalance: "credit", cashFlowActivity: "financing" }, actor)).id;
    piutangLainId = (await createAccount(db, { code: "1600", name: "Piutang Lain-lain", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id; // cashFlowActivity sengaja TIDAK diisi (null)

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(entryDate: string, referenceNo: string, lines: Array<{ accountId: string; debit: number; credit: number }>) {
    const draft = await createDraftJournalEntry(db, { entryDate, periodId, referenceNo, lines }, actor);
    await postJournalEntry(db, { journalEntryId: draft.id }, actor);
    return draft.id;
  }

  it("Periode tanpa transaksi: beginningCash = endingCash = 0, semua kategori 0", async () => {
    const report = await getCashFlowStatement(db, "2026-01-01", "2026-01-31");
    expect(report.beginningCash).toBe(0);
    expect(report.endingCash).toBe(0);
    expect(report.netChangeInCash).toBe(0);
    expect(report.operating.amount).toBe(0);
    expect(report.investing.amount).toBe(0);
    expect(report.financing.amount).toBe(0);
    expect(report.unclassifiedAmount).toBe(0);
  });

  it("Transfer kas<->kas (Kas->Bank) TIDAK dihitung sbg cash flow eksternal (operating/investing/financing tetap 0)", async () => {
    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ]);
    await post("2026-01-05", "JRN-TRANSFER", [
      { accountId: bankId, debit: 400_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 400_000 },
    ]);

    const report = await getCashFlowStatement(db, "2026-01-02", "2026-01-31");
    expect(report.operating.amount).toBe(0);
    expect(report.investing.amount).toBe(0);
    expect(report.financing.amount).toBe(0);
    expect(report.unclassifiedAmount).toBe(0);
    expect(report.netChangeInCash).toBe(0); // total kas (Kas+Bank) tidak berubah, hanya pindah antar akun kas
  });

  it("Operating (penjualan tunai & beban tunai), Investing (beli peralatan tunai), Financing (setoran modal tunai) terklasifikasi benar", async () => {
    await post("2026-01-01", "JRN-CAPITAL", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ]);
    await post("2026-01-05", "JRN-SALE", [
      { accountId: kasId, debit: 300_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 300_000 },
    ]);
    await post("2026-01-06", "JRN-EXPENSE", [
      { accountId: bebanId, debit: 50_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 50_000 },
    ]);
    await post("2026-01-07", "JRN-BUY-EQUIPMENT", [
      { accountId: peralatanId, debit: 200_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 200_000 },
    ]);

    const report = await getCashFlowStatement(db, "2026-01-01", "2026-01-31");
    expect(report.financing.amount).toBe(1_000_000);
    expect(report.operating.amount).toBe(300_000 - 50_000);
    expect(report.investing.amount).toBe(-200_000);
    expect(report.unclassifiedAmount).toBe(0);
    expect(report.beginningCash).toBe(0);
    expect(report.endingCash).toBe(1_000_000 + 300_000 - 50_000 - 200_000);
    expect(report.netChangeInCash).toBe(report.endingCash - report.beginningCash);
    expect(report.operating.amount + report.investing.amount + report.financing.amount + report.unclassifiedAmount).toBe(report.netChangeInCash);
  });

  it("Counterpart tanpa cash_flow_activity (null) -> masuk unclassifiedAmount, tidak ditebak", async () => {
    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ]);
    await post("2026-01-05", "JRN-UNCLASSIFIED", [
      { accountId: piutangLainId, debit: 150_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 150_000 },
    ]);

    const report = await getCashFlowStatement(db, "2026-01-02", "2026-01-31");
    expect(report.unclassifiedAmount).toBe(-150_000);
    expect(report.operating.amount).toBe(0);
    expect(report.investing.amount).toBe(0);
    expect(report.financing.amount).toBe(0);
  });

  it("Entry bercampur (satu baris kas, dua akun lawan beda kategori) dialokasikan proporsional", async () => {
    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ]);
    // Bayar cicilan: pokok utang (financing) 100.000 + bunga (operating) 50.000, satu entry kas keluar 150.000.
    await post("2026-01-10", "JRN-MIXED", [
      { accountId: utangId, debit: 100_000, credit: 0 },
      { accountId: bebanBungaId, debit: 50_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 150_000 },
    ]);

    const report = await getCashFlowStatement(db, "2026-01-02", "2026-01-31");
    expect(report.financing.amount).toBe(-100_000);
    expect(report.operating.amount).toBe(-50_000);
    expect(report.unclassifiedAmount).toBe(0);
  });

  it("Jurnal REVERSED tidak dihitung dua kali (konsisten ledger-service.ts)", async () => {
    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ]);
    const saleId = await post("2026-01-05", "JRN-SALE", [
      { accountId: kasId, debit: 300_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 300_000 },
    ]);
    await reverseJournalEntry(
      db,
      { journalEntryId: saleId, reversalReferenceNo: "REV-0001", reason: "Test" },
      actor,
    );

    const report = await getCashFlowStatement(db, "2026-01-02", "2026-01-31");
    expect(report.operating.amount).toBe(0); // +300.000 (original) - 300.000 (reversal) = 0
    expect(report.endingCash).toBe(1_000_000); // kembali ke saldo sblm penjualan
  });

  it("fromDate > toDate -> InvalidDateRangeError", async () => {
    await expect(getCashFlowStatement(db, "2026-02-01", "2026-01-01")).rejects.toThrow(InvalidDateRangeError);
  });
});
