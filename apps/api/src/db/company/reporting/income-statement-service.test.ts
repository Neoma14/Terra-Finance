import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "../knexfile.js";
import { createAccount } from "../account-service.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "../journal-service.js";
import { getIncomeStatement } from "./income-statement-service.js";
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

describe("Income Statement (TASK-DB-ARCH-012 §7)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let pendapatanId: string;
  let hppId: string;
  let bebanId: string;
  let pendapatanLainId: string;
  let bebanLainId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-income-statement-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    pendapatanId = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    hppId = (await createAccount(db, { code: "5000", name: "HPP", accountTypeCode: "COGS", normalBalance: "debit" }, actor)).id;
    bebanId = (await createAccount(db, { code: "6000", name: "Beban Operasional", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;
    pendapatanLainId = (await createAccount(db, { code: "7000", name: "Pendapatan Lain", accountTypeCode: "OTHER_INCOME", normalBalance: "credit" }, actor)).id;
    bebanLainId = (await createAccount(db, { code: "8000", name: "Beban Lain", accountTypeCode: "OTHER_EXPENSE", normalBalance: "debit" }, actor)).id;

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(entryDate: string, referenceNo: string, lines: Array<{ accountId: string; debit: number; credit: number }>, inPeriodId = periodId) {
    const draft = await createDraftJournalEntry(db, { entryDate, periodId: inPeriodId, referenceNo, lines }, actor);
    await postJournalEntry(db, { journalEntryId: draft.id }, actor);
    return draft.id;
  }

  it("Periode tanpa transaksi -> seluruh section kosong, semua total 0", async () => {
    const report = await getIncomeStatement(db, "2026-01-01", "2026-01-31");
    expect(report.revenue.lines).toHaveLength(0);
    expect(report.grossProfit).toBe(0);
    expect(report.operatingProfit).toBe(0);
    expect(report.netProfit).toBe(0);
  });

  it("Revenue, COGS, Operating Expense, Other Income/Expense -> Gross/Operating/Net Profit benar", async () => {
    await post("2026-01-05", "JRN-REV", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 1_000_000 },
    ]);
    await post("2026-01-06", "JRN-COGS", [
      { accountId: hppId, debit: 400_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 400_000 },
    ]);
    await post("2026-01-07", "JRN-OPEX", [
      { accountId: bebanId, debit: 150_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 150_000 },
    ]);
    await post("2026-01-08", "JRN-OTHER-INC", [
      { accountId: kasId, debit: 50_000, credit: 0 },
      { accountId: pendapatanLainId, debit: 0, credit: 50_000 },
    ]);
    await post("2026-01-09", "JRN-OTHER-EXP", [
      { accountId: bebanLainId, debit: 20_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 20_000 },
    ]);

    const report = await getIncomeStatement(db, "2026-01-01", "2026-01-31");

    expect(report.revenue.total).toBe(1_000_000);
    expect(report.cogs.total).toBe(400_000);
    expect(report.grossProfit).toBe(600_000);
    expect(report.operatingExpenses.total).toBe(150_000);
    expect(report.operatingProfit).toBe(450_000);
    expect(report.otherIncome.total).toBe(50_000);
    expect(report.otherExpense.total).toBe(20_000);
    expect(report.netProfit).toBe(480_000);

    // Presentasi selalu positif, tidak dibalik krn representasi debit/kredit internal.
    expect(report.revenue.lines[0].amount).toBeGreaterThan(0);
    expect(report.cogs.lines[0].amount).toBeGreaterThan(0);
  });

  it("Hanya menghitung movement dalam rentang fromDate..toDate", async () => {
    // Jurnal Desember dicatat di periode Desember (tanggal wajib di dalam periodenya).
    const decPeriodId = await seedPeriod(db, "Des 2025", "2025-12-01", "2025-12-31");
    await post("2025-12-31", "JRN-LUAR-RENTANG", [
      { accountId: kasId, debit: 999_999, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 999_999 },
    ], decPeriodId);
    await post("2026-01-15", "JRN-DALAM-RENTANG", [
      { accountId: kasId, debit: 100_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 100_000 },
    ]);

    const report = await getIncomeStatement(db, "2026-01-01", "2026-01-31");
    expect(report.revenue.total).toBe(100_000);
  });

  it("Jurnal REVERSED tidak dihitung dua kali (konsisten ledger-service.ts)", async () => {
    const saleId = await post("2026-01-10", "JRN-REV", [
      { accountId: kasId, debit: 300_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 300_000 },
    ]);
    await reverseJournalEntry(
      db,
      { journalEntryId: saleId, reversalReferenceNo: "REV-0001", reason: "Test" },
      actor,
    );

    const report = await getIncomeStatement(db, "2026-01-01", "2026-01-31");
    expect(report.revenue.total).toBe(0); // 300.000 (original) - 300.000 (reversal) = 0, bukan -300.000
    expect(report.netProfit).toBe(0);
  });

  it("fromDate > toDate -> InvalidDateRangeError", async () => {
    await expect(getIncomeStatement(db, "2026-02-01", "2026-01-01")).rejects.toThrow(InvalidDateRangeError);
  });

  it("Kontra-revenue (Retur & Potongan Penjualan, tipe REVENUE tapi normal_balance DEBIT) MENGURANGI revenue.total, bukan menambah (BUG NYATA PT MIGAS WARDHANA)", async () => {
    const returId = (await createAccount(db, { code: "4190", name: "Retur & Potongan Penjualan", accountTypeCode: "REVENUE", normalBalance: "debit" }, actor)).id;

    await post("2026-01-05", "JRN-REV", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 1_000_000 },
    ]);
    await post("2026-01-06", "JRN-RETUR", [
      { accountId: returId, debit: 150_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 150_000 },
    ]);

    const report = await getIncomeStatement(db, "2026-01-01", "2026-01-31");
    const returLine = report.revenue.lines.find((l) => l.accountCode === "4190")!;

    expect(returLine.amount).toBe(-150_000); // HARUS negatif -- mengurangi, bukan menambah revenue
    expect(report.revenue.total).toBe(850_000); // 1.000.000 - 150.000, BUKAN 1.150.000
    expect(report.netProfit).toBe(850_000);
  });
});
