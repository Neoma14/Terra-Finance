import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "./journal-service.js";
import {
  validatePeriodForClosing,
  lockPeriod,
  closePeriod,
  InvalidPeriodTransitionError,
  PeriodNotReadyToCloseError,
} from "./period-closing-service.js";
import type { ActorContext } from "./company-audit.js";

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}
const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

async function seedPeriod(db: Knex, status: "OPEN" | "LOCKED" | "CLOSED" = "OPEN"): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({ id, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status });
  return id;
}

describe("Period Closing (TASK-DB-ARCH-011 Part B §34-35)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-period-closing-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();
    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("OPEN -> LOCKED berhasil, audit 'period.lock' tercatat", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await lockPeriod(db, periodId, actor);

    const period = await db("periods").where({ id: periodId }).first();
    expect(period.status).toBe("LOCKED");
    const audit = await db("company_audit_log").where({ action: "period.lock", entity_id: periodId }).first();
    expect(audit).toBeDefined();
  });

  it("LOCKED -> CLOSED langsung dari OPEN (skip LOCKED) ditolak", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await expect(closePeriod(db, periodId, actor)).rejects.toThrow(InvalidPeriodTransitionError);
  });

  it("CLOSED -> apa pun ditolak (sudah di ujung)", async () => {
    const periodId = await seedPeriod(db, "CLOSED");
    await expect(lockPeriod(db, periodId, actor)).rejects.toThrow(InvalidPeriodTransitionError);
  });

  it("validatePeriodForClosing -- gagal kalau ada DRAFT journal tersisa", async () => {
    // Dibuat SELAGI periode masih OPEN (createDraftJournalEntry menolak
    // LOCKED/CLOSED, TASK-005) -- baru dikunci SETELAH draft ada, mensimulasikan
    // "straggler" draft yang belum diurus sebelum period dikunci.
    const periodId = await seedPeriod(db, "OPEN");
    await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-DRAFT", lines: [
        { accountId: kasId, debit: 100_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 100_000 },
      ] },
      actor,
    );
    await lockPeriod(db, periodId, actor);

    const validation = await validatePeriodForClosing(db, periodId);
    expect(validation.canClose).toBe(false);
    expect(validation.issues.some((i) => i.includes("DRAFT"))).toBe(true);
  });

  it("closePeriod -- REJECT kalau masih ada DRAFT, status TIDAK berubah", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-DRAFT2", lines: [
        { accountId: kasId, debit: 100_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 100_000 },
      ] },
      actor,
    );
    await lockPeriod(db, periodId, actor);

    await expect(closePeriod(db, periodId, actor)).rejects.toThrow(PeriodNotReadyToCloseError);
    const period = await db("periods").where({ id: periodId }).first();
    expect(period.status).toBe("LOCKED"); // tidak berubah
  });

  it("closePeriod -- berhasil kalau semua jurnal POSTED & balance, audit 'period.close' tercatat", async () => {
    const periodId = await seedPeriod(db, "OPEN");
    const entry = await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-OK", lines: [
        { accountId: kasId, debit: 100_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 100_000 },
      ] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: entry.id }, actor);
    await lockPeriod(db, periodId, actor);

    const validation = await validatePeriodForClosing(db, periodId);
    expect(validation.canClose).toBe(true);

    await closePeriod(db, periodId, actor);
    const period = await db("periods").where({ id: periodId }).first();
    expect(period.status).toBe("CLOSED");
    expect(period.closed_at).not.toBeNull();

    const audit = await db("company_audit_log").where({ action: "period.close", entity_id: periodId }).first();
    expect(audit).toBeDefined();
  });

  it("Setelah CLOSED, createDraftJournalEntry ditolak (fiscal-period enforcement TASK-005 tetap berjalan)", async () => {
    const periodId = await seedPeriod(db, "LOCKED");
    await closePeriod(db, periodId, actor); // tidak ada jurnal -> trial balance kosong = balanced (0=0)

    await expect(
      createDraftJournalEntry(
        db,
        { entryDate: "2026-01-05", periodId, referenceNo: "JRN-AFTER-CLOSE", lines: [
          { accountId: kasId, debit: 100_000, credit: 0 },
          { accountId: modalId, debit: 0, credit: 100_000 },
        ] },
        actor,
      ),
    ).rejects.toThrow();
  });
});
