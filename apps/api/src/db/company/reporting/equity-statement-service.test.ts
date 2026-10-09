import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "../knexfile.js";
import { createAccount } from "../account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "../journal-service.js";
import { getEquityStatement } from "./equity-statement-service.js";
import { getBalanceSheet } from "./balance-sheet-service.js";
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

describe("Statement of Changes in Equity (TASK-DB-ARCH-012 §8)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let pendapatanId: string;
  let bebanId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-equity-statement-test-");
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

  async function post(entryDate: string, referenceNo: string, lines: Array<{ accountId: string; debit: number; credit: number }>, isOpeningBalance = false) {
    const draft = await createDraftJournalEntry(db, { entryDate, periodId, referenceNo, isOpeningBalance, lines }, actor);
    await postJournalEntry(db, { journalEntryId: draft.id }, actor);
    return draft.id;
  }

  it("Perusahaan tanpa transaksi: opening/closing equity 0", async () => {
    const report = await getEquityStatement(db, "2026-01-01", "2026-01-31");
    expect(report.openingEquity).toBe(0);
    expect(report.netProfit).toBe(0);
    expect(report.additionalCapitalOrDrawings).toBe(0);
    expect(report.closingEquity).toBe(0);
  });

  it("openingEquity + netProfit + additionalCapitalOrDrawings = closingEquity, konsisten dgn Balance Sheet", async () => {
    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ], true);
    await post("2026-01-10", "JRN-0001", [
      { accountId: kasId, debit: 300_000, credit: 0 },
      { accountId: pendapatanId, debit: 0, credit: 300_000 },
    ]);
    // Setoran modal tambahan TERJADI DI DALAM rentang laporan equity:
    await post("2026-01-20", "JRN-0002-CAPITAL", [
      { accountId: kasId, debit: 200_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 200_000 },
    ]);
    await post("2026-01-25", "JRN-0003-EXPENSE", [
      { accountId: bebanId, debit: 50_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 50_000 },
    ]);

    const report = await getEquityStatement(db, "2026-01-15", "2026-01-31");

    expect(report.openingEquity).toBe(1_300_000); // Modal 1.000.000 + laba kumulatif sblm 2026-01-15 (300.000)
    expect(report.netProfit).toBe(-50_000); // hanya beban 50.000 dlm rentang 15-31
    expect(report.additionalCapitalOrDrawings).toBe(200_000); // setoran modal dlm rentang
    expect(report.closingEquity).toBe(1_300_000 - 50_000 + 200_000);

    const balanceSheet = await getBalanceSheet(db, "2026-01-01", "2026-01-31");
    expect(report.closingEquity).toBe(balanceSheet.totalEquity);
  });

  it("Prive/penarikan modal (debit ke akun EQUITY) tampil sbg additionalCapitalOrDrawings negatif", async () => {
    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ], true);
    await post("2026-01-20", "JRN-DRAWING", [
      { accountId: modalId, debit: 100_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 100_000 },
    ]);

    // fromDate SETELAH tanggal OB -- supaya setoran awal (OB) masuk ke
    // `openingEquity` (saldo awal periode), dan hanya prive yg diukur
    // sbg `additionalCapitalOrDrawings` dlm rentang laporan ini.
    const report = await getEquityStatement(db, "2026-01-05", "2026-01-31");
    expect(report.openingEquity).toBe(1_000_000);
    expect(report.additionalCapitalOrDrawings).toBe(-100_000);
    expect(report.closingEquity).toBe(900_000);
  });

  it("fromDate > toDate -> InvalidDateRangeError", async () => {
    await expect(getEquityStatement(db, "2026-02-01", "2026-01-01")).rejects.toThrow(InvalidDateRangeError);
  });

  it("Kontra-equity SEBAGAI AKUN TERPISAH (Dividen Dibagikan, tipe EQUITY tapi normal_balance DEBIT) MENGURANGI equity, bukan menambah -- tetap konsisten dgn Balance Sheet (BUG NYATA PT MIGAS WARDHANA)", async () => {
    const dividenId = (await createAccount(db, { code: "3300", name: "Dividen Dibagikan", accountTypeCode: "EQUITY", normalBalance: "debit" }, actor)).id;

    await post("2026-01-01", "OB-0001", [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ], true);
    await post("2026-01-20", "JRN-DIVIDEN", [
      { accountId: dividenId, debit: 150_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 150_000 },
    ]);

    // fromDate SETELAH tanggal OB (sama pola dgn test "Prive/penarikan
    // modal" di atas) -- supaya setoran awal masuk ke `openingEquity`,
    // bukan ikut terhitung sbg `additionalCapitalOrDrawings`.
    const report = await getEquityStatement(db, "2026-01-05", "2026-01-31");
    expect(report.openingEquity).toBe(1_000_000);
    expect(report.additionalCapitalOrDrawings).toBe(-150_000); // HARUS negatif -- mengurangi equity, bukan menambah
    expect(report.closingEquity).toBe(1_000_000 - 150_000);

    const balanceSheet = await getBalanceSheet(db, "2026-01-01", "2026-01-31");
    const dividenLine = balanceSheet.equity.lines.find((l) => l.accountCode === "3300")!;
    expect(dividenLine.amount).toBe(-150_000);
    expect(report.closingEquity).toBe(balanceSheet.totalEquity); // cross-consistency, §9/§31 instruksi
  });
});
