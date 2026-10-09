import crypto from "node:crypto";
import type { Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BranchNotFoundError, BranchNotOperationalError, changeBranchStatus, getHeadOfficeBranch } from "./branch-service.js";
import {
  JournalInterBranchLinkedError,
  JournalInterBranchLinkRequiredError,
  createDraftJournalEntry,
  deleteDraftJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
} from "./journal-service.js";
import { addBranch, freshCompanyDb, nextRef, seedBasics, testActor, type SeededAccounts } from "./__fixtures__/branch-test-helpers.js";
import { claimTransaction, insertInterBranchJournal, proposeTransaction } from "./__fixtures__/inter-branch-test-helpers.js";

describe("Jurnal sadar-cabang (Multi-Branch Phase 2)", () => {
  let db: Knex;
  let seed: SeededAccounts;
  let metro: string;
  let hq: string;

  beforeEach(async () => {
    db = await freshCompanyDb();
    seed = await seedBasics(db);
    metro = await addBranch(db, "METRO", "Cabang Metro");
    hq = (await getHeadOfficeBranch(db)).id;
  });
  afterEach(async () => {
    await db.destroy();
  });

  const draft = (extra: Record<string, unknown> = {}) =>
    createDraftJournalEntry(
      db,
      {
        entryDate: "2026-01-15",
        periodId: seed.periodId,
        referenceNo: nextRef(),
        lines: [
          { accountId: seed.kasId, debit: 7500, credit: 0 },
          { accountId: seed.hutangId, debit: 0, credit: 7500 },
        ],
        ...extra,
      },
      testActor,
    );
  const row = (id: string) => db("journal_entries").where({ id }).first();

  it("jurnal tanpa branchId masuk Kantor Pusat (jalur lama); dengan branchId tercatat di cabang itu dan di audit", async () => {
    const a = await draft();
    expect((await row(a.id)).branch_id).toBe(hq);
    const b = await draft({ branchId: metro });
    const stored = await row(b.id);
    expect(stored).toMatchObject({ branch_id: metro, origin: "manual" });
    const audit = await db("company_audit_log").where({ entity_id: b.id, action: "journal.create" }).first();
    expect(audit.branch_id).toBe(metro);
    expect(JSON.parse(audit.after_json)).toMatchObject({ branchId: metro, origin: "manual" });
  });

  it("origin diturunkan server: import -> import, saldo awal -> opening_balance", async () => {
    expect((await row((await draft({ branchId: metro, source: "import" })).id)).origin).toBe("import");
    expect((await row((await draft({ branchId: metro, isOpeningBalance: true })).id)).origin).toBe("opening_balance");
  });

  it("cabang tidak ada / sudah di-soft-delete / dari perusahaan lain ditolak", async () => {
    await expect(draft({ branchId: "cabang-fiktif" })).rejects.toBeInstanceOf(BranchNotFoundError);
    const gone = await addBranch(db, "HAPUS");
    await db("branches").where({ id: gone }).update({ deleted_at: new Date().toISOString() });
    await expect(draft({ branchId: gone })).rejects.toBeInstanceOf(BranchNotFoundError);

    // cabang perusahaan lain: id valid di company.db B, tidak ada di company.db A (isolasi struktural)
    const other = await freshCompanyDb();
    try {
      const foreign = await addBranch(other, "ASING", "Cabang Perusahaan Lain");
      await expect(draft({ branchId: foreign })).rejects.toBeInstanceOf(BranchNotFoundError);
      expect(await db("journal_entries").where({ branch_id: foreign })).toHaveLength(0);
    } finally {
      await other.destroy();
    }
  });

  it("cabang INACTIVE dan CLOSED menolak jurnal manual, import, dan saldo awal (tidak ada jurnal tersimpan)", async () => {
    const assertRejected = async () => {
      for (const extra of [{}, { source: "import" }, { isOpeningBalance: true }]) {
        await expect(draft({ branchId: metro, ...extra })).rejects.toBeInstanceOf(BranchNotOperationalError);
      }
    };
    await changeBranchStatus(db, metro, { to: "INACTIVE", reason: "alasan uji" }, testActor);
    await assertRejected();
    await changeBranchStatus(db, metro, { to: "CLOSED", reason: "Tutup cabang" }, testActor);
    await assertRejected();
    expect(await db("journal_entries").where({ branch_id: metro })).toHaveLength(0);
  });

  it("jurnal SISTEM tetap sah pada cabang INACTIVE/CLOSED, ditandai dan diaudit sebagai pengecualian", async () => {
    await changeBranchStatus(db, metro, { to: "CLOSED", reason: "Tutup cabang" }, testActor);
    const { id } = await draft({ branchId: metro, origin: "system", systemProcess: "branch_closure_settlement", exceptionReason: "Penyelesaian saldo" });
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    expect(await row(id)).toMatchObject({ status: "POSTED", origin: "system", system_process: "branch_closure_settlement", exception_reason: "Penyelesaian saldo" });
    const audits = await db("company_audit_log").where({ entity_id: id, action: "branch.nonactive_posting" });
    expect(audits.length).toBeGreaterThanOrEqual(2); // saat dibuat dan saat diposting
    expect(JSON.parse(audits[0].after_json)).toMatchObject({ branchStatus: "CLOSED", origin: "system", systemProcess: "branch_closure_settlement" });
  });

  it("asal inter_branch wajib bertaut transaksi antar-cabang; head_office_effect belum didukung", async () => {
    await expect(draft({ branchId: metro, origin: "inter_branch" })).rejects.toBeInstanceOf(JournalInterBranchLinkRequiredError);
    await expect(draft({ branchId: metro, origin: "head_office_effect" })).rejects.toThrow(/belum didukung/);
  });

  it("draft yang dibuat saat cabang ACTIVE tidak bisa diposting setelah cabang INACTIVE (dicek ulang saat posting)", async () => {
    const { id } = await draft({ branchId: metro });
    await changeBranchStatus(db, metro, { to: "INACTIVE" }, testActor);
    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toBeInstanceOf(BranchNotOperationalError);
    expect((await row(id)).status).toBe("DRAFT");
    await changeBranchStatus(db, metro, { to: "ACTIVE" }, testActor);
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    expect((await row(id)).status).toBe("POSTED");
  });

  it("reversal mewarisi cabang jurnal asli; reversal pada cabang non-ACTIVE ditolak", async () => {
    const { id } = await draft({ branchId: metro });
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    const { id: reversalId } = await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: nextRef("REV"), reason: "koreksi" }, testActor);
    expect(await row(reversalId)).toMatchObject({ branch_id: metro, origin: "manual", status: "POSTED" });

    const second = await draft({ branchId: metro });
    await postJournalEntry(db, { journalEntryId: second.id }, testActor);
    await changeBranchStatus(db, metro, { to: "INACTIVE" }, testActor);
    await expect(reverseJournalEntry(db, { journalEntryId: second.id, reversalReferenceNo: nextRef("REV"), reason: "koreksi" }, testActor)).rejects.toBeInstanceOf(BranchNotOperationalError);
    expect((await row(second.id)).status).toBe("POSTED");
  });

  it("cabang jurnal POSTED/REVERSED terkunci; branch_id tidak boleh dikosongkan; data historis cabang CLOSED tetap terbaca", async () => {
    const { id } = await draft({ branchId: metro });
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    await expect(db("journal_entries").where({ id }).update({ branch_id: hq })).rejects.toThrow(/tidak dapat diubah/);
    await expect(db("journal_entries").where({ id }).update({ branch_id: null })).rejects.toThrow(/tidak boleh dikosongkan/);
    await changeBranchStatus(db, metro, { to: "CLOSED", reason: "Tutup cabang" }, testActor);
    expect((await row(id)).branch_id).toBe(metro);
    expect(await db("journal_entry_lines").where({ journal_entry_id: id })).toHaveLength(2);
  });

  it("INSERT mentah tanpa branch_id (jalur lama) otomatis jatuh ke Kantor Pusat; branch_id tidak pernah NULL", async () => {
    const id = crypto.randomUUID();
    await db("journal_entries").insert({ id, entry_date: "2026-01-20", period_id: seed.periodId, reference_no: nextRef("RAW"), status: "DRAFT" });
    expect((await row(id)).branch_id).toBe(hq);
    expect(await db("journal_entries").whereNull("branch_id")).toHaveLength(0);
  });

  it("FK: cabang yang dirujuk jurnal tidak bisa dihapus; branch_id palsu pada insert mentah ditolak", async () => {
    await draft({ branchId: metro });
    await expect(db("branches").where({ id: metro }).del()).rejects.toThrow();
    await expect(
      db("journal_entries").insert({ id: crypto.randomUUID(), entry_date: "2026-01-20", period_id: seed.periodId, reference_no: nextRef("RAW"), status: "DRAFT", branch_id: "palsu" }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("kolom inter_branch_*: tautan hanya lewat INSERT yang sah; UPDATE tidak dapat menempel atau memindah; slot unik; jurnal bertaut tidak bisa di-reverse/dihapus sendiri (K-1)", async () => {
    // jurnal biasa: tautan tidak dapat ditempelkan lewat UPDATE (sebagian maupun lengkap)
    const a = await draft({ branchId: metro });
    await expect(db("journal_entries").where({ id: a.id }).update({ inter_branch_transaction_id: "IBT-1" })).rejects.toThrow(/terisi semua atau kosong semua|IB:/);
    await expect(
      db("journal_entries").where({ id: a.id }).update({ inter_branch_transaction_id: "IBT-1", inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM", origin: "inter_branch" }),
    ).rejects.toThrow(/IB:/);

    // tautan sah: induk COMPLETED, origin inter_branch, cabang sesuai sisi
    const tx = await proposeTransaction(db, { from: metro, to: hq, fromAccountId: seed.kasId, toAccountId: seed.hutangId });
    await claimTransaction(db, tx.id);
    const linkedDraft = crypto.randomUUID();
    await db("journal_entries").insert({
      id: linkedDraft, entry_date: "2026-01-15", period_id: seed.periodId, reference_no: `${tx.no}-F`, status: "DRAFT", branch_id: metro,
      origin: "inter_branch", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM",
    });
    await expect(
      db("journal_entries").insert({
        id: crypto.randomUUID(), entry_date: "2026-01-15", period_id: seed.periodId, reference_no: `${tx.no}-F2`, status: "DRAFT", branch_id: metro,
        origin: "inter_branch", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM",
      }),
    ).rejects.toThrow(/UNIQUE/i);
    await expect(db("journal_entries").where({ id: a.id }).update({ inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "TO", origin: "inter_branch" })).rejects.toThrow(/IB:/);
    await expect(db("journal_entries").where({ id: linkedDraft }).update({ inter_branch_side: "TO" })).rejects.toThrow(/IB:/);

    // jurnal bertaut tidak dapat dihapus atau di-reverse lewat jalur biasa
    await expect(deleteDraftJournalEntry(db, linkedDraft, testActor)).rejects.toBeInstanceOf(JournalInterBranchLinkedError);
    const tx2 = await proposeTransaction(db, { from: metro, to: hq, fromAccountId: seed.kasId, toAccountId: seed.hutangId });
    await claimTransaction(db, tx2.id);
    const posted = await insertInterBranchJournal(db, {
      txId: tx2.id, leg: "ORIGINAL", side: "FROM", periodId: seed.periodId,
      lines: [{ accountId: seed.kasId, debit: 10, credit: 0 }, { accountId: seed.hutangId, debit: 0, credit: 10 }],
    });
    await expect(reverseJournalEntry(db, { journalEntryId: posted, reversalReferenceNo: nextRef("REV"), reason: "uji" }, testActor)).rejects.toBeInstanceOf(JournalInterBranchLinkedError);
    expect((await row(posted)).status).toBe("POSTED");
  });

  it("atomik: jurnal tidak valid pada satu cabang tidak meninggalkan jurnal setengah jadi di cabang lain (satu transaksi luar)", async () => {
    await expect(
      db.transaction(async (trx) => {
        await createDraftJournalEntry(trx, { entryDate: "2026-01-15", periodId: seed.periodId, referenceNo: nextRef(), branchId: hq, lines: [{ accountId: seed.kasId, debit: 10, credit: 0 }, { accountId: seed.hutangId, debit: 0, credit: 10 }] }, testActor);
        await createDraftJournalEntry(trx, { entryDate: "2026-01-15", periodId: seed.periodId, referenceNo: nextRef(), branchId: "cabang-fiktif", lines: [{ accountId: seed.kasId, debit: 10, credit: 0 }, { accountId: seed.hutangId, debit: 0, credit: 10 }] }, testActor);
      }),
    ).rejects.toBeInstanceOf(BranchNotFoundError);
    expect(await db("journal_entries")).toHaveLength(0);
    expect(await db("company_audit_log").where({ action: "journal.create" })).toHaveLength(0);
  });
});
