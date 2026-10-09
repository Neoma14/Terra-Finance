import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import * as accountServiceModule from "./account-service.js";
import {
  createAccount,
  updateAccount,
  getAccount,
  listAccounts,
  listAccountsPaginated,
  listAccountTypes,
  assertAccountUsable,
  AccountCodeAlreadyExistsError,
  AccountCodeRequiredError,
  AccountNameRequiredError,
  AccountTypeNotFoundError,
  AccountNotFoundError,
  AccountInactiveError,
  AccountParentNotFoundError,
  AccountParentCycleError,
  AccountNormalBalanceLockedError,
  SystemAccountProtectedError,
} from "./account-service.js";
import { createDraftJournalEntry } from "./journal-service.js";
import type { ActorContext } from "./company-audit.js";

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}

const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

describe("Chart of Accounts service (TASK-DB-ARCH-011 Part B)", () => {
  let tmpDir: string;
  let db: Knex;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-account-service-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createAccount -- berhasil, normal_balance AUTHORITATIVE (tidak diturunkan dari account_types)", async () => {
    const { id } = await createAccount(
      db,
      { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
      actor,
    );
    const account = await getAccount(db, id);
    expect(account!.code).toBe("1000");
    expect(account!.normalBalance).toBe("debit");
    expect(account!.isActive).toBeTruthy(); // SQLite: boolean tersimpan sbg 0/1

    const audit = await db("company_audit_log").where({ action: "account.create", entity_id: id }).first();
    expect(audit).toBeDefined();
  });

  it("createAccount -- override normal_balance berbeda dari default tipe (EQUITY biasanya credit) tetap dihormati", async () => {
    const { id } = await createAccount(
      db,
      { code: "3999", name: "Kontra Ekuitas", accountTypeCode: "EQUITY", normalBalance: "debit" },
      actor,
    );
    const account = await getAccount(db, id);
    expect(account!.normalBalance).toBe("debit"); // BUKAN "credit" (default EQUITY)
  });

  it("createAccount -- code kosong ditolak", async () => {
    await expect(createAccount(db, { code: "  ", name: "X", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).rejects.toThrow(
      AccountCodeRequiredError,
    );
  });

  it("createAccount -- name kosong ditolak", async () => {
    await expect(createAccount(db, { code: "1001", name: "", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).rejects.toThrow(
      AccountNameRequiredError,
    );
  });

  it("createAccount -- duplicate code ditolak", async () => {
    await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await expect(
      createAccount(db, { code: "1000", name: "Kas Lain", accountTypeCode: "ASSET", normalBalance: "debit" }, actor),
    ).rejects.toThrow(AccountCodeAlreadyExistsError);
  });

  it("createAccount -- account type tidak ditemukan ditolak", async () => {
    await expect(
      createAccount(db, { code: "1002", name: "X", accountTypeCode: "TIDAK_ADA", normalBalance: "debit" }, actor),
    ).rejects.toThrow(AccountTypeNotFoundError);
  });

  it("listAccounts -- filter isActive", async () => {
    const { id: activeId } = await createAccount(db, { code: "1000", name: "Aktif", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const { id: inactiveId } = await createAccount(db, { code: "1001", name: "Nonaktif", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await updateAccount(db, inactiveId, { isActive: false }, actor);

    const activeOnly = await listAccounts(db, { isActive: true });
    expect(activeOnly.map((a) => a.id)).toContain(activeId);
    expect(activeOnly.map((a) => a.id)).not.toContain(inactiveId);
  });

  it("updateAccount -- menonaktifkan akun, audit action 'account.deactivate' (TASK-DB-ARCH-015 §9, before/after tercatat)", async () => {
    const { id } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await updateAccount(db, id, { isActive: false }, actor);

    const account = await getAccount(db, id);
    expect(account!.isActive).toBeFalsy();

    const audit = await db("company_audit_log").where({ action: "account.deactivate", entity_id: id }).first();
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.before_json).isActive).toBeTruthy();
  });

  it("updateAccount -- mengaktifkan kembali akun, audit action 'account.activate'", async () => {
    const { id } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await updateAccount(db, id, { isActive: false }, actor);
    await updateAccount(db, id, { isActive: true }, actor);

    const audit = await db("company_audit_log").where({ action: "account.activate", entity_id: id }).first();
    expect(audit).toBeDefined();
  });

  it("updateAccount -- edit biasa (bukan isActive) tetap pakai action 'account.update'", async () => {
    const { id } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await updateAccount(db, id, { name: "Kas Besar" }, actor);

    const audit = await db("company_audit_log").where({ action: "account.update", entity_id: id }).first();
    expect(audit).toBeDefined();
  });

  it("updateAccount -- normal_balance BOLEH diubah selama akun belum pernah dipakai di jurnal", async () => {
    const { id } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await updateAccount(db, id, { normalBalance: "credit" }, actor);
    const account = await getAccount(db, id);
    expect(account!.normalBalance).toBe("credit");
  });

  it("updateAccount -- normal_balance DITOLAK kalau akun sudah dipakai di journal_entry_lines (§6, walau masih DRAFT)", async () => {
    const { id: kasId } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const { id: modalId } = await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor);
    const periodId = crypto.randomUUID();
    await db("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
    await createDraftJournalEntry(
      db,
      { entryDate: "2026-01-05", periodId, referenceNo: "JRN-0001", lines: [{ accountId: kasId, debit: 100_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 100_000 }] },
      actor,
    );

    await expect(updateAccount(db, kasId, { normalBalance: "credit" }, actor)).rejects.toThrow(AccountNormalBalanceLockedError);
    const account = await getAccount(db, kasId);
    expect(account!.normalBalance).toBe("debit"); // tidak berubah
  });

  it("createAccount -- parentAccountId harus akun yang sudah ada", async () => {
    await expect(
      createAccount(db, { code: "1100", name: "Kas Kecil", accountTypeCode: "ASSET", normalBalance: "debit", parentAccountId: "tidak-ada" }, actor),
    ).rejects.toThrow(AccountParentNotFoundError);
  });

  it("createAccount -- parentAccountId valid tersimpan benar", async () => {
    const { id: parentId } = await createAccount(db, { code: "1000", name: "Kas & Setara Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const { id: childId } = await createAccount(db, { code: "1100", name: "Kas Kecil", accountTypeCode: "ASSET", normalBalance: "debit", parentAccountId: parentId }, actor);
    const child = await getAccount(db, childId);
    expect(child!.parentAccountId).toBe(parentId);
  });

  it("updateAccount -- parentAccountId tidak boleh dirinya sendiri", async () => {
    const { id } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await expect(updateAccount(db, id, { parentAccountId: id }, actor)).rejects.toThrow(AccountParentCycleError);
  });

  it("updateAccount -- parentAccountId tidak boleh membuat cycle (A->B, lalu B diubah jadi parent A)", async () => {
    const { id: a } = await createAccount(db, { code: "1000", name: "A", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const { id: b } = await createAccount(db, { code: "1100", name: "B", accountTypeCode: "ASSET", normalBalance: "debit", parentAccountId: a }, actor);

    await expect(updateAccount(db, a, { parentAccountId: b }, actor)).rejects.toThrow(AccountParentCycleError);
  });

  it("listAccountsPaginated -- search by code/name + pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await createAccount(db, { code: `100${i}`, name: `Akun ${i}`, accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    }
    const page1 = await listAccountsPaginated(db, { page: 1, pageSize: 2 });
    expect(page1.accounts).toHaveLength(2);
    expect(page1.total).toBe(5);

    const searched = await listAccountsPaginated(db, { search: "akun 3" });
    expect(searched.accounts).toHaveLength(1);
    expect(searched.accounts[0].code).toBe("1003");
  });

  it("listAccountsPaginated -- pageSize 500 (dipakai dropdown UI) mengembalikan >200 akun, tidak terpotong", async () => {
    for (let i = 0; i < 230; i++) {
      await createAccount(db, { code: `7${String(i).padStart(3, "0")}`, name: `Akun ${i}`, accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    }
    const all = await listAccountsPaginated(db, { page: 1, pageSize: 500 });
    expect(all.accounts).toHaveLength(230);
    expect(all.total).toBe(230);
  });

  it("listAccountTypes -- mengembalikan 9 tipe terurut sort_order", async () => {
    const types = await listAccountTypes(db);
    expect(types.length).toBe(9);
    expect(types[0].code).toBe("ASSET");
  });

  it("updateAccount -- akun tidak ditemukan ditolak", async () => {
    await expect(updateAccount(db, "tidak-ada", { isActive: false }, actor)).rejects.toThrow(AccountNotFoundError);
  });

  it("updateAccount -- akun sistem (is_system_account=true) TIDAK BOLEH dinonaktifkan (TASK-021, kolom sejak C0003 blm pernah ditegakkan)", async () => {
    const { id } = await createAccount(db, { code: "9000", name: "Penyeimbang Saldo Awal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor);
    await db("accounts").where({ id }).update({ is_system_account: true });

    await expect(updateAccount(db, id, { isActive: false }, actor)).rejects.toThrow(SystemAccountProtectedError);
    const account = await getAccount(db, id);
    expect(account!.isActive).toBeTruthy(); // tetap aktif -- update ditolak, bukan diam-diam diterapkan
  });

  it("updateAccount -- akun sistem TIDAK BOLEH di-rename, tapi field klasifikasi lain (cashFlowActivity) tetap boleh diubah", async () => {
    const { id } = await createAccount(db, { code: "9000", name: "Penyeimbang Saldo Awal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor);
    await db("accounts").where({ id }).update({ is_system_account: true });

    await expect(updateAccount(db, id, { name: "Nama Baru" }, actor)).rejects.toThrow(SystemAccountProtectedError);

    await updateAccount(db, id, { cashFlowActivity: "financing" }, actor);
    const account = await getAccount(db, id);
    expect(account!.name).toBe("Penyeimbang Saldo Awal");
    expect(account!.cashFlowActivity).toBe("financing");
  });

  it("TIDAK ADA fungsi deleteAccount -- hanya deaktivasi (§22: jangan destructive)", () => {
    expect((accountServiceModule as any).deleteAccount).toBeUndefined();
  });

  it("assertAccountUsable -- menolak akun non-aktif (dipakai journal-service.ts)", async () => {
    const { id } = await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await updateAccount(db, id, { isActive: false }, actor);

    await expect(assertAccountUsable(db, id)).rejects.toThrow(AccountInactiveError);
  });

  it("assertAccountUsable -- menolak akun yang tidak ada", async () => {
    await expect(assertAccountUsable(db, "tidak-ada")).rejects.toThrow(AccountNotFoundError);
  });
});
