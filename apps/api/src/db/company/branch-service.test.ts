import type { Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BranchClosureBlockedError,
  BranchCodeExistsError,
  BranchHeadOfficeProtectedError,
  BranchInUseError,
  BranchInvalidInputError,
  BranchInvalidTransitionError,
  BranchNotFoundError,
  BranchNotOperationalError,
  MultiBranchDisabledError,
  assertBranchAcceptsOrigin,
  changeBranchStatus,
  createBranch,
  getHeadOfficeBranch,
  isMultiBranchEnabled,
  listBranches,
  previewBranchClosure,
  setMultiBranchEnabled,
  softDeleteUnusedBranch,
  updateBranch,
} from "./branch-service.js";
import { createDraftJournalEntry, postJournalEntry } from "./journal-service.js";
import { addBranch, freshCompanyDb, nextRef, seedBasics, testActor, type SeededAccounts } from "./__fixtures__/branch-test-helpers.js";

describe("Branch master & lifecycle (Multi-Branch Phase 1)", () => {
  let db: Knex;
  let seed: SeededAccounts;

  beforeEach(async () => {
    db = await freshCompanyDb();
    seed = await seedBasics(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const postSimple = async (branchId: string, amount = 100000) => {
    const { id } = await createDraftJournalEntry(
      db,
      {
        entryDate: "2026-01-15",
        periodId: seed.periodId,
        referenceNo: nextRef(),
        branchId,
        lines: [
          { accountId: seed.kasId, debit: amount, credit: 0 },
          { accountId: seed.hutangId, debit: 0, credit: amount },
        ],
      },
      testActor,
    );
    await postJournalEntry(db, { journalEntryId: id }, testActor);
    return id;
  };

  it("company.db baru/di-upgrade otomatis punya satu Kantor Pusat ACTIVE, dan multi-cabang mati secara default", async () => {
    const branches = await listBranches(db);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ code: "PUSAT", status: "ACTIVE", isHeadOffice: true });
    expect(await isMultiBranchEnabled(db)).toBe(false);
  });

  it("membuat cabang ditolak selama multi-cabang belum diaktifkan; setelah diaktifkan berhasil dan diaudit", async () => {
    await expect(createBranch(db, { code: "METRO", name: "Cabang Metro" }, testActor)).rejects.toBeInstanceOf(MultiBranchDisabledError);
    await setMultiBranchEnabled(db, true, testActor);
    const { id } = await createBranch(db, { code: "metro", name: "Cabang Metro", address: "Jl. A", phone: "0725" }, testActor);
    const row = await db("branches").where({ id }).first();
    expect(row).toMatchObject({ code: "METRO", name: "Cabang Metro", status: "ACTIVE", is_head_office: 0, address: "Jl. A" });
    const audit = await db("company_audit_log").where({ entity_id: id, action: "branch.created" }).first();
    expect(audit.branch_id).toBe(id);
    const flagAudit = await db("company_audit_log").where({ action: "company_setting.multi_branch_enabled" }).first();
    expect(JSON.parse(flagAudit.after_json)).toEqual({ multiBranchEnabled: true });
  });

  it("validasi kode & nama cabang; kode duplikat ditolak (termasuk kode cabang yang sudah di-soft-delete)", async () => {
    await setMultiBranchEnabled(db, true, testActor);
    await expect(createBranch(db, { code: "  ", name: "X" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
    await expect(createBranch(db, { code: "A B", name: "X" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
    await expect(createBranch(db, { code: "OK1", name: "" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
    const { id } = await createBranch(db, { code: "OK1", name: "Satu" }, testActor);
    await expect(createBranch(db, { code: "ok1", name: "Dua" }, testActor)).rejects.toBeInstanceOf(BranchCodeExistsError);
    await softDeleteUnusedBranch(db, id, 0, testActor);
    await expect(createBranch(db, { code: "OK1", name: "Tiga" }, testActor)).rejects.toBeInstanceOf(BranchCodeExistsError);
  });

  it("edit cabang: nama/alamat/telepon berubah, kode tidak dapat diubah (trigger)", async () => {
    const id = await addBranch(db, "METRO", "Metro");
    await updateBranch(db, id, { name: "Cabang Metro Baru", address: "Jl. B", sortOrder: 7 }, testActor);
    expect(await db("branches").where({ id }).first()).toMatchObject({ name: "Cabang Metro Baru", address: "Jl. B", sort_order: 7 });
    await expect(db("branches").where({ id }).update({ code: "LAIN" })).rejects.toThrow(/Kode cabang tidak dapat diubah/);
    await expect(updateBranch(db, id, { name: "" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
  });

  it("lifecycle: ACTIVE -> INACTIVE -> ACTIVE -> CLOSED -> (reopen) ACTIVE, semua diaudit; CLOSED tidak boleh langsung INACTIVE", async () => {
    const id = await addBranch(db, "METRO");
    await changeBranchStatus(db, id, { to: "INACTIVE" }, testActor);
    expect((await db("branches").where({ id }).first()).status).toBe("INACTIVE");
    await changeBranchStatus(db, id, { to: "ACTIVE" }, testActor);
    await expect(changeBranchStatus(db, id, { to: "ACTIVE" }, testActor)).rejects.toBeInstanceOf(BranchInvalidTransitionError);

    await expect(changeBranchStatus(db, id, { to: "CLOSED" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError); // alasan wajib
    await changeBranchStatus(db, id, { to: "CLOSED", reason: "Cabang tutup permanen" }, testActor);
    const closed = await db("branches").where({ id }).first();
    expect(closed).toMatchObject({ status: "CLOSED", close_reason: "Cabang tutup permanen", closed_by: "test-user-1" });
    expect(closed.closed_at).not.toBeNull();
    await expect(changeBranchStatus(db, id, { to: "INACTIVE" }, testActor)).rejects.toBeInstanceOf(BranchInvalidTransitionError);

    await expect(changeBranchStatus(db, id, { to: "ACTIVE" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError); // alasan reopen wajib
    await changeBranchStatus(db, id, { to: "ACTIVE", reason: "Cabang dibuka kembali" }, testActor);
    expect((await db("branches").where({ id }).first()).status).toBe("ACTIVE");

    const actions = (await db("company_audit_log").where({ entity_id: id }).orderBy("created_at")).map((r: any) => r.action);
    expect(actions).toEqual(["branch.created", "branch.deactivated", "branch.activated", "branch.closed", "branch.reopened"]);
  });

  it("Kantor Pusat tidak boleh dinonaktifkan/ditutup/dihapus (service dan trigger database)", async () => {
    const hq = await getHeadOfficeBranch(db);
    await expect(changeBranchStatus(db, hq.id, { to: "INACTIVE" }, testActor)).rejects.toBeInstanceOf(BranchHeadOfficeProtectedError);
    await expect(changeBranchStatus(db, hq.id, { to: "CLOSED", reason: "x y z" }, testActor)).rejects.toBeInstanceOf(BranchHeadOfficeProtectedError);
    await expect(softDeleteUnusedBranch(db, hq.id, 0, testActor)).rejects.toBeInstanceOf(BranchHeadOfficeProtectedError);
    await expect(db("branches").where({ id: hq.id }).update({ status: "INACTIVE" })).rejects.toThrow(/Kantor Pusat/);
    await expect(db("branches").where({ id: hq.id }).update({ deleted_at: new Date().toISOString() })).rejects.toThrow(/Kantor Pusat/);
    await expect(db("branches").where({ id: hq.id }).update({ is_head_office: 0 })).rejects.toThrow();
  });

  it("hanya boleh ada satu Kantor Pusat (unique index)", async () => {
    await expect(
      db("branches").insert({ id: "hq-2", code: "PUSAT2", name: "Pusat Kedua", status: "ACTIVE", is_head_office: 1 }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("tidak ada hard delete: DELETE fisik ditolak trigger, walau cabang belum pernah dipakai", async () => {
    const id = await addBranch(db, "METRO");
    await expect(db("branches").where({ id }).del()).rejects.toThrow(/tidak boleh dihapus secara fisik/);
    expect(await db("branches").where({ id }).first()).toBeTruthy();
  });

  it("soft delete hanya untuk cabang yang belum pernah dipakai; cabang berjurnal/berakses/jadi cabang lawan tidak bisa dihapus", async () => {
    const used = await addBranch(db, "USED");
    await postSimple(used);
    await expect(softDeleteUnusedBranch(db, used, 0, testActor)).rejects.toBeInstanceOf(BranchInUseError);

    const withAccess = await addBranch(db, "AKSES");
    await expect(softDeleteUnusedBranch(db, withAccess, 2, testActor)).rejects.toBeInstanceOf(BranchInUseError);

    const counterpart = await addBranch(db, "LAWAN");
    await db("accounts").insert({
      id: "acc-ib",
      code: "IBP-1",
      name: "Antarkantor",
      account_type_id: (await db("account_types").where({ code: "LIABILITY" }).first()).id,
      normal_balance: "credit",
      branch_policy: "INTER_BRANCH",
      counterpart_branch_id: counterpart,
    });
    await expect(softDeleteUnusedBranch(db, counterpart, 0, testActor)).rejects.toBeInstanceOf(BranchInUseError);

    const unused = await addBranch(db, "KOSONG");
    await softDeleteUnusedBranch(db, unused, 0, testActor);
    expect((await db("branches").where({ id: unused }).first()).deleted_at).not.toBeNull();
    expect((await listBranches(db)).map((b) => b.code)).not.toContain("KOSONG");
    expect((await listBranches(db, { includeDeleted: true })).map((b) => b.code)).toContain("KOSONG");
    await expect(changeBranchStatus(db, unused, { to: "INACTIVE" }, testActor)).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it("penutupan cabang: jurnal DRAFT memblokir; saldo tersisa menjadi peringatan; setelah CLOSED data historis tetap terbaca", async () => {
    const id = await addBranch(db, "METRO");
    const draft = await createDraftJournalEntry(
      db,
      {
        entryDate: "2026-01-10",
        periodId: seed.periodId,
        referenceNo: nextRef(),
        branchId: id,
        lines: [
          { accountId: seed.kasId, debit: 5000, credit: 0 },
          { accountId: seed.hutangId, debit: 0, credit: 5000 },
        ],
      },
      testActor,
    );
    const blocked = await previewBranchClosure(db, id);
    expect(blocked.blockers).toEqual([expect.objectContaining({ code: "DRAFT_JOURNALS", count: 1 })]);
    await expect(changeBranchStatus(db, id, { to: "CLOSED", reason: "Tutup cabang" }, testActor)).rejects.toBeInstanceOf(BranchClosureBlockedError);
    expect((await db("branches").where({ id }).first()).status).toBe("ACTIVE");

    await postJournalEntry(db, { journalEntryId: draft.id }, testActor);
    const ready = await previewBranchClosure(db, id);
    expect(ready.blockers).toHaveLength(0);
    expect(ready.warnings[0]).toMatchObject({ code: "NON_ZERO_BALANCES", count: 2 });
    expect(ready.warnings[0].accounts).toEqual([
      { code: "1000", name: "Kas", balance: 5000 },
      { code: "2000", name: "Hutang Usaha", balance: 5000 },
    ]);

    await changeBranchStatus(db, id, { to: "CLOSED", reason: "Tutup cabang" }, testActor);
    // historis tetap utuh dan dapat dibaca
    const journals = await db("journal_entries").where({ branch_id: id });
    expect(journals).toHaveLength(1);
    expect(journals[0].status).toBe("POSTED");
    expect(await db("journal_entry_lines").where({ journal_entry_id: draft.id })).toHaveLength(2);
  });

  it("matriks status x asal: manual/import/opening_balance hanya ACTIVE; system diizinkan di semua status (non-ACTIVE ditandai exception); inter_branch hanya ACTIVE; head_office_effect belum didukung", async () => {
    const id = await addBranch(db, "METRO");
    for (const origin of ["manual", "import", "opening_balance"] as const) {
      await expect(assertBranchAcceptsOrigin(db, id, origin)).resolves.toMatchObject({ exception: false });
    }
    await changeBranchStatus(db, id, { to: "INACTIVE" }, testActor);
    for (const origin of ["manual", "import", "opening_balance"] as const) {
      await expect(assertBranchAcceptsOrigin(db, id, origin)).rejects.toBeInstanceOf(BranchNotOperationalError);
    }
    await expect(assertBranchAcceptsOrigin(db, id, "system")).resolves.toMatchObject({ exception: true });

    await changeBranchStatus(db, id, { to: "CLOSED", reason: "Ditutup" }, testActor);
    await expect(assertBranchAcceptsOrigin(db, id, "manual")).rejects.toMatchObject({ status: "CLOSED" });
    await expect(assertBranchAcceptsOrigin(db, id, "system")).resolves.toMatchObject({ exception: true });
    await expect(assertBranchAcceptsOrigin(db, id, "inter_branch")).rejects.toBeInstanceOf(BranchNotOperationalError);
    await expect(assertBranchAcceptsOrigin(db, id, "head_office_effect")).rejects.toThrow(/belum didukung/);
    await changeBranchStatus(db, id, { to: "ACTIVE", reason: "Dibuka kembali" }, testActor);
    await expect(assertBranchAcceptsOrigin(db, id, "inter_branch")).resolves.toMatchObject({ exception: false });
    await expect(assertBranchAcceptsOrigin(db, "tidak-ada", "manual")).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});
