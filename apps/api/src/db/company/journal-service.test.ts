import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import {
  createDraftJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  deleteDraftJournalEntry,
  JournalAlreadyPostedError,
  JournalNotPostableError,
  JournalNotBalancedError,
  JournalNotDraftError,
  JournalEntryNotFoundError,
  JournalZeroAmountError,
} from "./journal-service.js";
import { updateAccount, AccountInactiveError } from "./account-service.js";
import {
  FiscalPeriodClosedError,
  FiscalPeriodLockedError,
  type PeriodStatus,
} from "./fiscal-period.js";
import type { ActorContext } from "./company-audit.js";

// Pola sama dgn company-db.test.ts / system-db.test.ts (static import +
// override connection.filename per test -- lihat catatan di sana ttg
// kenapa dynamic import dihindari di bawah vite-node).

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openCompanyDbAt(filePath: string): Knex {
  const config: Knex.Config = { ...baseKnexConfig, connection: { filename: filePath } };
  return knexLib(config);
}

async function seedPeriod(db: Knex, status: PeriodStatus, label = "Jan 2026", startDate = "2026-01-01", endDate = "2026-01-31"): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({
    id,
    label,
    start_date: startDate,
    end_date: endDate,
    period_type: "month",
    fiscal_year: 2026,
    status,
  });
  return id;
}

async function seedAccounts(db: Knex): Promise<{ kasId: string; modalId: string }> {
  const assetType = await db("account_types").where({ code: "ASSET" }).first();
  const equityType = await db("account_types").where({ code: "EQUITY" }).first();

  const kasId = crypto.randomUUID();
  await db("accounts").insert({
    id: kasId,
    code: "1000",
    name: "Kas",
    account_type_id: assetType.id,
    normal_balance: "debit",
  });

  const modalId = crypto.randomUUID();
  await db("accounts").insert({
    id: modalId,
    code: "3000",
    name: "Modal",
    account_type_id: equityType.id,
    normal_balance: "credit",
  });

  return { kasId, modalId };
}

// Actor tetap utk test fiscal-period (bukan fokus pengujian audit --
// pengujian audit trail sendiri ada di company-audit.test.ts, TASK-DB-ARCH-006).
const testActor: ActorContext = { actorType: "user", actorId: "test-user-1", actorLabel: "Test User" };

describe("Fiscal period enforcement (TASK-DB-ARCH-005)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-journal-service-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();
    const accounts = await seedAccounts(db);
    kasId = accounts.kasId;
    modalId = accounts.modalId;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function balancedLines() {
    return [
      { accountId: kasId, debit: 100_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 100_000 },
    ];
  }

  it("Test 1: OPEN period + valid DRAFT journal = POST SUCCESS", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0001", lines: balancedLines() },
      testActor,
    );

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).resolves.toBeUndefined();

    const posted = await db("journal_entries").where({ id }).first();
    expect(posted.status).toBe("POSTED");
    expect(posted.posted_at).not.toBeNull();
  });

  it("TASK-020 §4 FIX: jurnal dgn baris debit=0/kredit=0 (nol tapi 'balance') ditolak -- bukan diterima diam-diam", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await expect(
      createDraftJournalEntry(
        db,
        { entryDate: "2026-01-05", periodId, referenceNo: "JRN-ZERO", lines: [
          { accountId: kasId, debit: 0, credit: 0 },
          { accountId: modalId, debit: 0, credit: 0 },
        ] },
        testActor,
      ),
    ).rejects.toThrow(JournalZeroAmountError);

    const count = await db("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("Test 2: CLOSED period + valid DRAFT journal = POST BLOCKED", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0002", lines: balancedLines() },
      testActor,
    );

    await db("periods").where({ id: periodId }).update({ status: "CLOSED" });

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toThrow(FiscalPeriodClosedError);

    const stillDraft = await db("journal_entries").where({ id }).first();
    expect(stillDraft.status).toBe("DRAFT");
  });

  it("Test 3: LOCKED period + valid DRAFT journal = POST BLOCKED", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0003", lines: balancedLines() },
      testActor,
    );

    await db("periods").where({ id: periodId }).update({ status: "LOCKED" });

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toThrow(FiscalPeriodLockedError);

    const stillDraft = await db("journal_entries").where({ id }).first();
    expect(stillDraft.status).toBe("DRAFT");
  });

  it("Test 4: CLOSED period + invalid journal (tidak balance) = BLOCKED, tidak ada partial posting", async () => {
    const periodId = await seedPeriod(db, "CLOSED");

    await expect(
      createDraftJournalEntry(
        db,
        { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0004", lines: [{ accountId: kasId, debit: 100_000, credit: 0 }] },
        testActor,
      ),
    ).rejects.toThrow(JournalNotBalancedError);

    const rows = await db("journal_entries").where({ reference_no: "JRN-0004" });
    expect(rows).toHaveLength(0);
    const lineRows = await db("journal_entry_lines");
    expect(lineRows).toHaveLength(0);
  });

  it("Test 5: POSTED journal = cannot post again", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0005", lines: balancedLines() },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toThrow(JournalAlreadyPostedError);
  });

  it("Test 6: REVERSED journal = cannot post again", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0006", lines: balancedLines() },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    await reverseJournalEntry(
      db,
      { journalEntryId: id, reversalReferenceNo: "JRN-0006-REV", reason: "Koreksi nominal" },
      testActor,
    );

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toThrow(JournalNotPostableError);
  });

  it("Test 7: VOID journal = cannot post", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const voidId = crypto.randomUUID();
    await db("journal_entries").insert({
      id: voidId,
      entry_date: "2026-01-05",
      period_id: periodId,
      reference_no: "JRN-0007",
      status: "VOID",
    });

    await expect(postJournalEntry(db, { journalEntryId: voidId }, testActor)).rejects.toThrow(JournalNotPostableError);
  });

  it("jurnal dengan ribuan baris tersimpan, diposting, dan dibalik (bug 'too many SQL variables' saat import besar)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { kasId, modalId } = await (async () => {
      const rows = await db("accounts").select("id", "code");
      return { kasId: rows.find((r: any) => r.code === "1000")?.id ?? rows[0].id, modalId: rows.find((r: any) => r.code === "3000")?.id ?? rows[1].id };
    })();
    const lines = Array.from({ length: 6000 }, (_, i) => (i % 2 === 0 ? { accountId: kasId, debit: 1_000, credit: 0 } : { accountId: modalId, debit: 0, credit: 1_000 }));
    const { id } = await createDraftJournalEntry(db, { entryDate: "2026-01-05", periodId, referenceNo: "JRN-BESAR", lines }, testActor);
    expect((await db("journal_entry_lines").where({ journal_entry_id: id }).count<{ c: number }[]>("* as c"))[0].c).toBe(6000);
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    const rev = await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "JRN-BESAR-REV", reason: "uji" }, testActor);
    expect((await db("journal_entry_lines").where({ journal_entry_id: rev.id }).count<{ c: number }[]>("* as c"))[0].c).toBe(6000);
    const order = await db("journal_entry_lines").where({ journal_entry_id: id }).orderBy("line_order").select("line_order");
    expect(order[0].line_order).toBe(0);
    expect(order[5999].line_order).toBe(5999);
  });

  it("Final UAT: tanggal jurnal tidak valid (2026-13-45) ditolak, tidak ada draft tersimpan", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await expect(
      createDraftJournalEntry(db, { entryDate: "2026-13-45", periodId, referenceNo: "JRN-BAD-DATE", lines: balancedLines() }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
    await expect(
      createDraftJournalEntry(db, { entryDate: "2026-02-30", periodId, referenceNo: "JRN-BAD-DATE2", lines: balancedLines() }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
    expect(await db("journal_entries").whereIn("reference_no", ["JRN-BAD-DATE", "JRN-BAD-DATE2"])).toHaveLength(0);
  });

  it("Final UAT: tanggal di luar rentang periode ditolak (create dan reversal)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await expect(
      createDraftJournalEntry(db, { entryDate: "2026-03-15", periodId, referenceNo: "JRN-OUT", lines: balancedLines() }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });

    const { id } = await createDraftJournalEntry(db, { entryDate: "2026-01-31", periodId, referenceNo: "JRN-EDGE", lines: balancedLines() }, testActor);
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    await expect(
      reverseJournalEntry(db, { journalEntryId: id, reversalEntryDate: "2026-02-01", reversalReferenceNo: "JRN-EDGE-REV", reason: "x" }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
    expect((await db("journal_entries").where({ id }).first()).status).toBe("POSTED");
  });

  it("Final UAT: nomor referensi duplikat ditolak dgn error domain (bukan error SQL mentah)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await createDraftJournalEntry(db, { entryDate: "2026-01-05", periodId, referenceNo: "JRN-DUP", lines: balancedLines() }, testActor);
    await expect(
      createDraftJournalEntry(db, { entryDate: "2026-01-06", periodId, referenceNo: "JRN-DUP", lines: balancedLines() }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_REFERENCE_EXISTS" });
  });

  it("Test 8: Reversal bertanggal & berperiode SAMA dengan jurnal asli, jurnal asli tetap ada", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0008", lines: balancedLines() },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);

    const { id: reversalId } = await reverseJournalEntry(
      db,
      { journalEntryId: id, reversalReferenceNo: "JRN-0008-REV", reason: "Koreksi" },
      testActor,
    );

    const reversalRow = await db("journal_entries").where({ id: reversalId }).first();
    expect(reversalRow.status).toBe("POSTED");
    expect(reversalRow.reversal_of_journal_id).toBe(id);
    expect(String(reversalRow.entry_date).slice(0, 10)).toBe("2026-01-05");
    expect(reversalRow.period_id).toBe(periodId);
    expect(reversalRow.reversal_reason).toBe("Koreksi");

    const originalRow = await db("journal_entries").where({ id }).first();
    expect(originalRow.status).toBe("REVERSED");
    expect(originalRow.is_reversed).toBeTruthy();

    // debit/kredit dibalik persis
    const orig = await db("journal_entry_lines").where({ journal_entry_id: id }).orderBy("line_order");
    const rev = await db("journal_entry_lines").where({ journal_entry_id: reversalId }).orderBy("line_order");
    expect(rev.map((l: any) => [Number(l.debit), Number(l.credit)])).toEqual(orig.map((l: any) => [Number(l.credit), Number(l.debit)]));

    // tidak bisa direversal dua kali
    await expect(
      reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "JRN-0008-REV2", reason: "lagi" }, testActor),
    ).rejects.toThrow(JournalNotPostableError);
  });

  it("Reversal dengan tanggal / periode berbeda dari jurnal asli DITOLAK (tidak diam-diam diganti)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const febId = await seedPeriod(db, "OPEN", "Feb 2026", "2026-02-01", "2026-02-28");
    const { id } = await createDraftJournalEntry(db, { entryDate: "2026-01-05", periodId, referenceNo: "JRN-DIFF", lines: balancedLines() }, testActor);
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    await expect(
      reverseJournalEntry(db, { journalEntryId: id, reversalEntryDate: "2026-01-06", reversalReferenceNo: "JRN-DIFF-REV", reason: "x" }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
    await expect(
      reverseJournalEntry(db, { journalEntryId: id, reversalPeriodId: febId, reversalReferenceNo: "JRN-DIFF-REV", reason: "x" }, testActor),
    ).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
    expect((await db("journal_entries").where({ id }).first()).status).toBe("POSTED");
  });

  it("Test 9: Reversal saat periode jurnal asli sudah CLOSED = BLOCKED", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0009", lines: balancedLines() },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    await db("periods").where({ id: periodId }).update({ status: "CLOSED" });

    await expect(
      reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "JRN-0009-REV", reason: "Percobaan reversal ke periode tertutup" }, testActor),
    ).rejects.toThrow(FiscalPeriodClosedError);

    const originalRow = await db("journal_entries").where({ id }).first();
    expect(originalRow.status).toBe("POSTED");
    expect(originalRow.is_reversed).toBeFalsy();
  });

  it("Test 10: Period status berubah OPEN -> CLOSED, lalu posting = BLOCKED", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0010", lines: balancedLines() },
      testActor,
    );

    const afterCreate = await db("journal_entries").where({ id }).first();
    expect(afterCreate.status).toBe("DRAFT");

    await db("periods").where({ id: periodId }).update({ status: "CLOSED" });

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toThrow(FiscalPeriodClosedError);
  });

  it("TASK-020 HIGH FIX: akun dinonaktifkan SETELAH draft dibuat, SEBELUM diposting -> POST ditolak (bukan lolos diam-diam)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0010B", lines: balancedLines() },
      testActor,
    );

    await updateAccount(db, kasId, { isActive: false }, testActor);

    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toThrow(AccountInactiveError);
    const afterFailedPost = await db("journal_entries").where({ id }).first();
    expect(afterFailedPost.status).toBe("DRAFT"); // tidak ikut ter-posting walopun gagal di tengah
  });

  it("TASK-020 HIGH FIX: akun dinonaktifkan SETELAH posting -> REVERSAL thd jurnal itu juga ditolak", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0010C", lines: balancedLines() },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);

    await updateAccount(db, kasId, { isActive: false }, testActor);

    await expect(
      reverseJournalEntry(
        db,
        { journalEntryId: id, reversalReferenceNo: "JRN-0010C-REV", reason: "test" },
        testActor,
      ),
    ).rejects.toThrow(AccountInactiveError);
    const afterFailedReversal = await db("journal_entries").where({ id }).first();
    expect(afterFailedReversal.status).toBe("POSTED"); // status asli TIDAK berubah jadi REVERSED
  });

  it("Test 11 (tambahan): CREATE ditolak pada periode CLOSED (Accounting_Rules.md §14)", async () => {
    const periodId = await seedPeriod(db, "CLOSED");
    await expect(
      createDraftJournalEntry(db, { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0011", lines: balancedLines() }, testActor),
    ).rejects.toThrow(FiscalPeriodClosedError);
  });

  it("Test 12 (tambahan): CREATE ditolak pada periode LOCKED (Accounting_Rules.md §13)", async () => {
    const periodId = await seedPeriod(db, "LOCKED");
    await expect(
      createDraftJournalEntry(db, { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0012", lines: balancedLines() }, testActor),
    ).rejects.toThrow(FiscalPeriodLockedError);
  });

  it("Test 13 (TASK-DB-ARCH-014): deleteDraftJournalEntry berhasil hapus DRAFT (entry+lines+audit)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0013", lines: balancedLines() },
      testActor,
    );

    await deleteDraftJournalEntry(db, id, testActor);

    const entryRow = await db("journal_entries").where({ id }).first();
    expect(entryRow).toBeUndefined();
    const lineRows = await db("journal_entry_lines").where({ journal_entry_id: id });
    expect(lineRows).toHaveLength(0);
    const auditRow = await db("company_audit_log").where({ entity_id: id, action: "journal.delete_draft" }).first();
    expect(auditRow).toBeDefined();
  });

  it("Test 14 (TASK-DB-ARCH-014): deleteDraftJournalEntry DITOLAK kalau status bukan DRAFT (sudah POSTED)", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0014", lines: balancedLines() },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);

    await expect(deleteDraftJournalEntry(db, id, testActor)).rejects.toThrow(JournalNotDraftError);

    const entryRow = await db("journal_entries").where({ id }).first();
    expect(entryRow.status).toBe("POSTED"); // tidak terhapus
  });

  it("Test 15 (TASK-DB-ARCH-014): deleteDraftJournalEntry pada id tidak ada -> JournalEntryNotFoundError", async () => {
    await expect(deleteDraftJournalEntry(db, "id-tidak-ada", testActor)).rejects.toThrow(JournalEntryNotFoundError);
  });
});
