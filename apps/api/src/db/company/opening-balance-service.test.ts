import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount, updateAccount } from "./account-service.js";
import {
  getOpeningBalance,
  createOpeningBalanceEntry,
  updateOpeningBalanceDraft,
  deleteOpeningBalanceDraft,
  postOpeningBalance,
  reverseOpeningBalance,
  OpeningBalanceAlreadyExistsError,
  OpeningBalanceNotFoundError,
  OpeningBalanceDuplicateAccountError,
  OpeningBalanceNotEditableError,
} from "./opening-balance-service.js";
import { JournalNotBalancedError, JournalEntryNotFoundError } from "./journal-service.js";
import { FiscalPeriodClosedError } from "./fiscal-period.js";
import { AccountInactiveError } from "./account-service.js";
import type { ActorContext } from "./company-audit.js";

/**
 * Opening Balance (TASK-DB-ARCH-016). Fokus test: reuse accounting engine
 * existing (balance/akun-aktif/periode diwariskan dari
 * `createDraftJournalEntry`, TIDAK diuji ulang di sini -- sudah dicover
 * journal-service.test.ts), aturan SPESIFIK Opening Balance (satu aktif
 * per company, duplicate akun = error, lifecycle DRAFT->POSTED->REVERSED
 * via mekanisme Journal existing), dan integrasi nyata ke ledger/trial
 * balance (§18 instruksi -- DIBUKTIKAN, bukan diasumsikan).
 */

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}
const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

async function seedPeriod(db: Knex, label: string, startDate: string, endDate: string, status: "OPEN" | "LOCKED" | "CLOSED" = "OPEN"): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({ id, label, start_date: startDate, end_date: endDate, period_type: "month", fiscal_year: 2026, status });
  return id;
}

describe("Opening Balance (TASK-DB-ARCH-016)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let bebanId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-opening-balance-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    bebanId = (await createAccount(db, { code: "6000", name: "Beban", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getOpeningBalance -- belum ada, exists=false", async () => {
    const result = await getOpeningBalance(db);
    expect(result.exists).toBe(false);
    expect(result.isBalanced).toBe(true);
  });

  it("createOpeningBalanceEntry -- berhasil, status DRAFT, audit action 'opening_balance.create' (reuse journal-service.ts)", async () => {
    const { id } = await createOpeningBalanceEntry(
      db,
      { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] },
      actor,
    );
    const entry = await db("journal_entries").where({ id }).first();
    expect(entry.status).toBe("DRAFT");
    expect(entry.is_opening_balance).toBeTruthy();

    const audit = await db("company_audit_log").where({ entity_id: id, action: "opening_balance.create" }).first();
    expect(audit).toBeDefined();

    const summary = await getOpeningBalance(db);
    expect(summary.exists).toBe(true);
    expect(summary.status).toBe("DRAFT");
    expect(summary.totalDebit).toBe(1_000_000);
    expect(summary.isBalanced).toBe(true);
  });

  it("createOpeningBalanceEntry -- tidak balance DITOLAK (diwariskan dari createDraftJournalEntry, TIDAK diuji ulang logic-nya di sini)", async () => {
    await expect(
      createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 900_000 }] }, actor),
    ).rejects.toThrow(JournalNotBalancedError);
  });

  it("createOpeningBalanceEntry -- akun nonaktif DITOLAK (diwariskan dari assertAccountUsable)", async () => {
    await updateAccount(db, kasId, { isActive: false }, actor);
    await expect(
      createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor),
    ).rejects.toThrow(AccountInactiveError);
  });

  it("createOpeningBalanceEntry -- periode CLOSED DITOLAK (diwariskan dari assertPeriodIsWritable)", async () => {
    const closedPeriodId = await seedPeriod(db, "Des 2025", "2025-12-01", "2025-12-31", "CLOSED");
    await expect(
      createOpeningBalanceEntry(db, { entryDate: "2025-12-01", periodId: closedPeriodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor),
    ).rejects.toThrow(FiscalPeriodClosedError);
  });

  it("createOpeningBalanceEntry -- duplicate akun DITOLAK (§7: error, bukan digabung)", async () => {
    await expect(
      createOpeningBalanceEntry(
        db,
        { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: kasId, debit: 500_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_500_000 }] },
        actor,
      ),
    ).rejects.toThrow(OpeningBalanceDuplicateAccountError);

    const count = await db("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0); // tidak ada partial insert
  });

  it("createOpeningBalanceEntry -- DITOLAK kalau sudah ada yang aktif (§9: satu per company)", async () => {
    await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);
    await expect(
      createOpeningBalanceEntry(db, { entryDate: "2026-01-02", periodId, lines: [{ accountId: kasId, debit: 500_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 500_000 }] }, actor),
    ).rejects.toThrow(OpeningBalanceAlreadyExistsError);
  });

  it("updateOpeningBalanceDraft -- berhasil edit DRAFT, referenceNo dipertahankan", async () => {
    const { id: oldId } = await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);
    const before = await db("journal_entries").where({ id: oldId }).first();

    const { id: newId } = await updateOpeningBalanceDraft(db, { entryDate: "2026-01-05", periodId, lines: [{ accountId: kasId, debit: 2_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 2_000_000 }] }, actor);
    expect(newId).not.toBe(oldId);

    const oldEntry = await db("journal_entries").where({ id: oldId }).first();
    expect(oldEntry).toBeUndefined();
    const newEntry = await db("journal_entries").where({ id: newId }).first();
    expect(newEntry.reference_no).toBe(before.reference_no);

    const summary = await getOpeningBalance(db);
    expect(summary.totalDebit).toBe(2_000_000);
  });

  it("updateOpeningBalanceDraft -- ATOMIC: validasi baru gagal -> draft LAMA tetap ada", async () => {
    const { id: oldId } = await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);

    await expect(
      updateOpeningBalanceDraft(db, { entryDate: "2026-01-05", periodId, lines: [{ accountId: kasId, debit: 500_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 100_000 }] }, actor),
    ).rejects.toThrow(JournalNotBalancedError);

    const oldEntry = await db("journal_entries").where({ id: oldId }).first();
    expect(oldEntry).toBeDefined();
    expect(oldEntry.status).toBe("DRAFT");
  });

  it("deleteOpeningBalanceDraft -- berhasil hapus DRAFT", async () => {
    await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);
    await deleteOpeningBalanceDraft(db, actor);
    const summary = await getOpeningBalance(db);
    expect(summary.exists).toBe(false);
  });

  it("deleteOpeningBalanceDraft -- DITOLAK kalau sudah POSTED", async () => {
    await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);
    await postOpeningBalance(db, actor);
    await expect(deleteOpeningBalanceDraft(db, actor)).rejects.toThrow(OpeningBalanceNotEditableError);
  });

  it("postOpeningBalance -- tanpa opening balance -> OpeningBalanceNotFoundError", async () => {
    await expect(postOpeningBalance(db, actor)).rejects.toThrow(OpeningBalanceNotFoundError);
  });

  it("reverseOpeningBalance -- berhasil, status jadi REVERSED, bisa buat opening balance BARU setelahnya", async () => {
    await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);
    await postOpeningBalance(db, actor);

    await reverseOpeningBalance(db, { targetPeriodId: periodId, reason: "Koreksi saldo awal" }, actor);
    const afterReverse = await getOpeningBalance(db);
    expect(afterReverse.exists).toBe(false); // REVERSED tidak dianggap "aktif"

    // §9: setelah reversal, BOLEH buat opening balance baru.
    const { id } = await createOpeningBalanceEntry(db, { entryDate: "2026-01-10", periodId, lines: [{ accountId: kasId, debit: 2_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 2_000_000 }] }, actor);
    expect(id).toBeDefined();
  });

  it("reverseOpeningBalance -- DITOLAK kalau belum POSTED (masih DRAFT)", async () => {
    await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }] }, actor);
    await expect(reverseOpeningBalance(db, { targetPeriodId: periodId, reason: "x" }, actor)).rejects.toThrow(OpeningBalanceNotEditableError);
  });

  it("INTEGRASI (§18): opening balance POSTED mengalir ke ledger-service.ts & trial-balance-service.ts TANPA perubahan apa pun di file itu", async () => {
    const { getAccountLedger } = await import("./ledger-service.js");
    const { getTrialBalance } = await import("./trial-balance-service.js");

    await createOpeningBalanceEntry(
      db,
      { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_500_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 1_000_000 }, { accountId: bebanId, debit: 0, credit: 500_000 }] },
      actor,
    );
    await postOpeningBalance(db, actor);

    const kasLedger = await getAccountLedger(db, kasId, periodId);
    expect(kasLedger.endingBalance).toBe(1_500_000);

    const trialBalance = await getTrialBalance(db, periodId);
    expect(trialBalance.isBalanced).toBe(true);
    expect(trialBalance.totalDebit).toBe(trialBalance.totalCredit);
    const kasRow = trialBalance.rows.find((r) => r.accountId === kasId)!;
    expect(kasRow.debit).toBe(1_500_000);
  });
});
