import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry, JOURNAL_AUDIT_ACTIONS } from "./journal-service.js";
import type { PeriodStatus } from "./fiscal-period.js";
import type { ActorContext } from "./company-audit.js";

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openCompanyDbAt(filePath: string): Knex {
  const config: Knex.Config = { ...baseKnexConfig, connection: { filename: filePath } };
  return knexLib(config);
}

async function seedPeriod(db: Knex, status: PeriodStatus, label = "Jan 2026"): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({
    id,
    label,
    start_date: "2026-01-01",
    end_date: "2026-01-31",
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
  await db("accounts").insert({ id: kasId, code: "1000", name: "Kas", account_type_id: assetType.id, normal_balance: "debit" });

  const modalId = crypto.randomUUID();
  await db("accounts").insert({ id: modalId, code: "3000", name: "Modal", account_type_id: equityType.id, normal_balance: "credit" });

  return { kasId, modalId };
}

function balancedLines(kasId: string, modalId: string) {
  return [
    { accountId: kasId, debit: 100_000, credit: 0 },
    { accountId: modalId, debit: 0, credit: 100_000 },
  ];
}

const actorA: ActorContext = { actorType: "user", actorId: "user-a", actorLabel: "Konsultan A" };

describe("Company journal audit trail (TASK-DB-ARCH-006)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-company-audit-test-");
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

  it("Test 1: Create journal -> audit journal.create exists", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A001", lines: balancedLines(kasId, modalId) },
      actorA,
    );

    const audits = await db("company_audit_log").where({ action: JOURNAL_AUDIT_ACTIONS.CREATE, entity_id: id });
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_label).toBe("Konsultan A");
  });

  it("Test 2 & 7: Post journal -> audit journal.post exists, status POSTED", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A002", lines: balancedLines(kasId, modalId) },
      actorA,
    );
    await postJournalEntry(db, { journalEntryId: id }, actorA);

    const entry = await db("journal_entries").where({ id }).first();
    expect(entry.status).toBe("POSTED");

    const audits = await db("company_audit_log").where({ action: JOURNAL_AUDIT_ACTIONS.POST, entity_id: id });
    expect(audits).toHaveLength(1);
    const after = JSON.parse(audits[0].after_json);
    expect(after.status).toBe("POSTED");
  });

  it("Test 3 & 8: Reverse journal -> audit journal.reverse exists, original REVERSED, reversal POSTED", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A003", lines: balancedLines(kasId, modalId) },
      actorA,
    );
    await postJournalEntry(db, { journalEntryId: id }, actorA);
    const { id: reversalId } = await reverseJournalEntry(
      db,
      { journalEntryId: id, reversalReferenceNo: "JRN-A003-REV", reason: "Koreksi" },
      actorA,
    );

    const original = await db("journal_entries").where({ id }).first();
    expect(original.status).toBe("REVERSED");
    const reversal = await db("journal_entries").where({ id: reversalId }).first();
    expect(reversal.status).toBe("POSTED");

    const audits = await db("company_audit_log").where({ action: JOURNAL_AUDIT_ACTIONS.REVERSE, entity_id: id });
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe("Koreksi");
    const after = JSON.parse(audits[0].after_json);
    expect(after.reversalJournalId).toBe(reversalId);
  });

  it("Test 4: Create gagal (tidak balance) -> tidak ada audit SUCCESS", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await expect(
      createDraftJournalEntry(
        db,
        { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A004", lines: [{ accountId: kasId, debit: 100_000, credit: 0 }] },
        actorA,
      ),
    ).rejects.toThrow();

    const audits = await db("company_audit_log").where({ entity_type: "journal_entry" });
    expect(audits.filter((a: any) => a.action === JOURNAL_AUDIT_ACTIONS.CREATE)).toHaveLength(0);
  });

  it("Test 5: Post ke periode CLOSED gagal -> tidak ada audit journal.post", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A005", lines: balancedLines(kasId, modalId) },
      actorA,
    );
    await db("periods").where({ id: periodId }).update({ status: "CLOSED" });

    await expect(postJournalEntry(db, { journalEntryId: id }, actorA)).rejects.toThrow();

    const audits = await db("company_audit_log").where({ action: JOURNAL_AUDIT_ACTIONS.POST, entity_id: id });
    expect(audits).toHaveLength(0);
  });

  it("Test 6: Post ke periode LOCKED gagal -> tidak ada audit journal.post", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A006", lines: balancedLines(kasId, modalId) },
      actorA,
    );
    await db("periods").where({ id: periodId }).update({ status: "LOCKED" });

    await expect(postJournalEntry(db, { journalEntryId: id }, actorA)).rejects.toThrow();

    const audits = await db("company_audit_log").where({ action: JOURNAL_AUDIT_ACTIONS.POST, entity_id: id });
    expect(audits).toHaveLength(0);
  });

  it("Test 9: Audit insert gagal -> seluruh operasi ROLLBACK, tidak ada partial accounting state", async () => {
    const periodId = await seedPeriod(db, "OPEN");

    // Simulasi kegagalan audit: drop tabel company_audit_log SEBELUM
    // operasi dipanggil -- insert audit di dalam transaction pasti gagal
    // ("no such table"), membuktikan atomicity tanpa perlu test hook
    // apa pun di production code.
    await db.schema.dropTable("company_audit_log");

    await expect(
      createDraftJournalEntry(
        db,
        { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A009", lines: balancedLines(kasId, modalId) },
        actorA,
      ),
    ).rejects.toThrow();

    // Rollback harus total: journal_entries & journal_entry_lines juga
    // tidak boleh tersisa, meski insert-nya sendiri sempat "berhasil"
    // sebelum audit insert gagal di baris berikutnya pada transaction yang
    // sama.
    const entries = await db("journal_entries").where({ reference_no: "JRN-A009" });
    expect(entries).toHaveLength(0);
    const lines = await db("journal_entry_lines");
    expect(lines).toHaveLength(0);
  });

  it("Test 10: Actor context -- actor berbeda menghasilkan audit dengan actor yang sesuai", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const actorB: ActorContext = { actorType: "administrator", actorId: "admin-b", actorLabel: "Administrator B" };

    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A010", lines: balancedLines(kasId, modalId) },
      actorB,
    );

    const audit = await db("company_audit_log").where({ entity_id: id, action: JOURNAL_AUDIT_ACTIONS.CREATE }).first();
    expect(audit.actor_type).toBe("administrator");
    expect(audit.actor_id).toBe("admin-b");
    expect(audit.actor_label).toBe("Administrator B");
  });

  it("Test 11: Company isolation -- audit Company A tidak bocor/mempengaruhi Company B", async () => {
    const rootA = freshTmpDir("terra-company-audit-a-");
    const rootB = freshTmpDir("terra-company-audit-b-");
    const dbA = openCompanyDbAt(path.join(rootA, "company.db"));
    const dbB = openCompanyDbAt(path.join(rootB, "company.db"));

    try {
      await dbA.migrate.latest();
      await dbB.migrate.latest();
      const accA = await seedAccounts(dbA);
      const periodA = await seedPeriod(dbA, "OPEN");

      await createDraftJournalEntry(
        dbA,
        { entryDate: "2026-01-05", periodId: periodA, referenceNo: "JRN-COMPANY-A", lines: balancedLines(accA.kasId, accA.modalId) },
        actorA,
      );

      const auditsInA = await dbA("company_audit_log");
      const auditsInB = await dbB("company_audit_log");
      expect(auditsInA).toHaveLength(1);
      expect(auditsInB).toHaveLength(0);
    } finally {
      await dbA.destroy();
      await dbB.destroy();
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("Test 12: Append-only -- company_audit_log menolak UPDATE dan DELETE", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-A012", lines: balancedLines(kasId, modalId) },
      actorA,
    );
    const audit = await db("company_audit_log").where({ entity_id: id }).first();

    await expect(db("company_audit_log").where({ id: audit.id }).update({ reason: "diubah paksa" })).rejects.toThrow();
    await expect(db("company_audit_log").where({ id: audit.id }).del()).rejects.toThrow();
  });
});
