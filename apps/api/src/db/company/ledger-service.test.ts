import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "./journal-service.js";
import { getAccountLedger, getAccountBalanceBeforeDate } from "./ledger-service.js";
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

describe("General Ledger (TASK-DB-ARCH-011 Part B)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let pendapatanId: string;
  let periodJan: string;
  let periodFeb: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-ledger-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    pendapatanId = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;

    periodJan = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
    periodFeb = await seedPeriod(db, "Feb 2026", "2026-02-01", "2026-02-28");

    // Opening balance Januari: Kas (D) 1.000.000 / Modal (K) 1.000.000
    const ob = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-01", periodId: periodJan, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
        { accountId: kasId, debit: 1_000_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 1_000_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: ob.id }, actor);

    // Transaksi Februari: Kas (D) 500.000 / Pendapatan (K) 500.000
    const feb = await createDraftJournalEntry(
      db,
      { entryDate: "2026-02-10", periodId: periodFeb, referenceNo: "JRN-0002", lines: [
        { accountId: kasId, debit: 500_000, credit: 0 },
        { accountId: pendapatanId, debit: 0, credit: 500_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: feb.id }, actor);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opening balance Januari tercermin di ledger Kas periode Januari (opening 0, ending 1.000.000)", async () => {
    const ledger = await getAccountLedger(db, kasId, periodJan);
    expect(ledger.openingBalance).toBe(0); // belum ada histori sebelum Jan
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.endingBalance).toBe(1_000_000);
  });

  it("Kas periode Februari: opening balance CARRY FORWARD dari Januari (balance-sheet account)", async () => {
    const ledger = await getAccountLedger(db, kasId, periodFeb);
    expect(ledger.openingBalance).toBe(1_000_000); // carry forward dari Jan
    expect(ledger.endingBalance).toBe(1_500_000); // + 500.000 Feb
  });

  it("Pendapatan (REVENUE, flow account): opening balance SELALU 0 tiap periode, tidak carry-forward", async () => {
    const ledgerFeb = await getAccountLedger(db, pendapatanId, periodFeb);
    expect(ledgerFeb.openingBalance).toBe(0);
    expect(ledgerFeb.endingBalance).toBe(500_000);
  });

  it("DRAFT journal TIDAK masuk ledger", async () => {
    await createDraftJournalEntry(
      db,
      { entryDate: "2026-02-15", periodId: periodFeb, referenceNo: "JRN-DRAFT", lines: [
        { accountId: kasId, debit: 999_999, credit: 0 },
        { accountId: modalId, debit: 0, credit: 999_999 },
      ] },
      actor,
    );

    const ledger = await getAccountLedger(db, kasId, periodFeb);
    expect(ledger.lines.map((l) => l.referenceNo)).not.toContain("JRN-DRAFT");
    expect(ledger.endingBalance).toBe(1_500_000); // tidak ikut 999.999
  });

  it("Entry yang di-REVERSED: original TETAP tercatat historis di ledger, reversal menambah baris offset -- efek bersih nol", async () => {
    const extra = await createDraftJournalEntry(
      db,
      { entryDate: "2026-02-20", periodId: periodFeb, referenceNo: "JRN-TOREV", lines: [
        { accountId: kasId, debit: 200_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 200_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: extra.id }, actor);

    const beforeReversal = await getAccountLedger(db, kasId, periodFeb);
    expect(beforeReversal.endingBalance).toBe(1_700_000);

    const { reverseJournalEntry } = await import("./journal-service.js");
    await reverseJournalEntry(
      db,
      { journalEntryId: extra.id, reversalReferenceNo: "JRN-TOREV-REV", reason: "Koreksi" },
      actor,
    );

    const afterReversal = await getAccountLedger(db, kasId, periodFeb);
    // Original (status REVERSED) TETAP muncul (historis, benar-benar
    // terjadi) + reversal (POSTED) menambah baris offset -- efek bersih
    // balik ke saldo sebelum JRN-TOREV, BUKAN krn original "dihapus".
    expect(afterReversal.endingBalance).toBe(1_500_000);
    expect(afterReversal.lines.map((l) => l.referenceNo)).toContain("JRN-TOREV");
    expect(afterReversal.lines.map((l) => l.referenceNo)).toContain("JRN-TOREV-REV");
    expect(afterReversal.lines).toHaveLength(3); // JRN-0002 + JRN-TOREV + JRN-TOREV-REV
  });

  it("getAccountBalanceBeforeDate -- akun flow selalu 0 berapa pun tanggalnya", async () => {
    const balance = await getAccountBalanceBeforeDate(db, pendapatanId, "2026-12-31");
    expect(balance).toBe(0);
  });
});
