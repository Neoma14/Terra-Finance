import crypto from "node:crypto";
import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";

/**
 * Chart of Accounts service (TASK-DB-ARCH-011 Part B §21-22). Skema
 * existing (`C0002` account_types, `C0003` accounts) TIDAK diubah.
 * `accounts.normal_balance` adalah AUTHORITATIVE (§21 instruksi) -- fungsi
 * di sini TIDAK PERNAH menurunkan/override normal_balance dari
 * `account_types.normal_balance` (yang hanya DEFAULT tingkat-tipe, lihat
 * Company_DB_Schema.md §6.2) -- caller WAJIB menyediakan `normalBalance`
 * eksplisit.
 */

export class AccountCodeRequiredError extends Error {
  readonly code = "ACCOUNT_CODE_REQUIRED" as const;
}
export class AccountNameRequiredError extends Error {
  readonly code = "ACCOUNT_NAME_REQUIRED" as const;
}
export class AccountCodeAlreadyExistsError extends Error {
  readonly code = "ACCOUNT_CODE_ALREADY_EXISTS" as const;
}
export class AccountNotFoundError extends Error {
  readonly code = "ACCOUNT_NOT_FOUND" as const;
}
export class AccountTypeNotFoundError extends Error {
  readonly code = "ACCOUNT_TYPE_NOT_FOUND" as const;
}
export class AccountInactiveError extends Error {
  readonly code = "ACCOUNT_INACTIVE" as const;
}
/** Akun terkunci (Lock Account) tidak boleh dipakai jurnal baru -- dicek di
 * service (assertAccountUsable), jadi berlaku untuk UI, API langsung,
 * import jurnal, saldo awal, dan reversal. */
export class AccountLockedError extends Error {
  readonly code = "ACCOUNT_LOCKED" as const;
}
export class AccountLockStateError extends Error {
  readonly code = "ACCOUNT_LOCK_STATE" as const;
}
export class AccountParentNotFoundError extends Error {
  readonly code = "ACCOUNT_PARENT_NOT_FOUND" as const;
}
export class AccountParentCycleError extends Error {
  readonly code = "ACCOUNT_PARENT_CYCLE" as const;
}
/** TASK-DB-ARCH-015 §6: `normal_balance` adalah identitas akuntansi yang
 * ikut menentukan ARAH seluruh ledger/trial-balance/report historis akun
 * ini (lihat ledger-service.ts `signedMovement`) -- mengubahnya SETELAH
 * akun pernah dipakai di journal_entry_lines akan diam-diam membalik arah
 * SEMUA histori yang sudah tercatat, bukan sekadar relabel. Berbeda dari
 * field lain (cashFlowActivity/subledgerType/parentAccountId/dll) yang
 * murni metadata klasifikasi & aman direvisi kapan pun. */
export class AccountNormalBalanceLockedError extends Error {
  readonly code = "ACCOUNT_NORMAL_BALANCE_LOCKED" as const;
}
/** Akun antar-cabang (INTER_BRANCH) bukan akun kas dan tidak berklasifikasi arus kas (IB-1, F-7). Trigger C0019 adalah penjaga akhir; ini pesan ramah. */
export class AccountInterBranchClassificationError extends Error {
  readonly code = "ACCOUNT_INTER_BRANCH_CLASSIFICATION" as const;
}
/** TASK-021 -- enforcement `is_system_account` (kolom sudah ada sejak
 * C0003, "belum ada enforcement-nya" -- lihat komentar migration itu).
 * Akun sistem (mis. akun penyeimbang saldo awal) tidak boleh dinonaktifkan
 * atau di-rename sembarangan krn dipakai invariant akuntansi otomatis;
 * field klasifikasi lain (parent/cashFlowActivity/isCash/subledgerType)
 * tetap bebas diubah. */
export class SystemAccountProtectedError extends Error {
  readonly code = "SYSTEM_ACCOUNT_PROTECTED" as const;
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  accountTypeId: string;
  accountSubtype: string | null;
  normalBalance: "debit" | "credit";
  parentAccountId: string | null;
  isActive: boolean;
  isSystemAccount: boolean;
  cashFlowActivity: string | null;
  isCash: boolean;
  subledgerType: string | null;
  isLocked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  /** Kebijakan cabang (Multi-Branch) -- atribut eksplisit per akun, lihat account-branch-policy.ts. */
  branchPolicy: "ALL_BRANCH" | "CENTRAL_ONLY" | "SYSTEM_ONLY" | "INTER_BRANCH";
  counterpartBranchId: string | null;
}

const COLUMNS = [
  "id",
  "code",
  "name",
  "account_type_id as accountTypeId",
  "account_subtype as accountSubtype",
  "normal_balance as normalBalance",
  "parent_account_id as parentAccountId",
  "is_active as isActive",
  "is_system_account as isSystemAccount",
  "cash_flow_activity as cashFlowActivity",
  "is_cash as isCash",
  "subledger_type as subledgerType",
  "is_locked as isLocked",
  "locked_at as lockedAt",
  "locked_by as lockedBy",
  "branch_policy as branchPolicy",
  "counterpart_branch_id as counterpartBranchId",
];

export async function getAccount(db: Knex, id: string): Promise<AccountRow | undefined> {
  return db("accounts").select(COLUMNS).where({ id }).first();
}

export async function listAccounts(db: Knex, filter?: { isActive?: boolean }): Promise<AccountRow[]> {
  let query = db("accounts").select(COLUMNS).orderBy("code");
  if (filter?.isActive !== undefined) query = query.where({ is_active: filter.isActive });
  return query;
}

export interface ListAccountsPaginatedParams {
  search?: string;
  accountTypeId?: string;
  isActive?: boolean;
  parentAccountId?: string | null;
  page?: number;
  pageSize?: number;
}

/** Versi paginated+filter `listAccounts` utk COA List UI (TASK-DB-ARCH-015
 * §3) -- fungsi TERPISAH (bukan mengubah signature `listAccounts` existing)
 * supaya caller lama (reporting-utils.ts, trial-balance-service.ts, dkk --
 * semuanya panggil `listAccounts(db)` tanpa filter, mengharapkan array
 * polos) TIDAK terdampak sama sekali. */
export async function listAccountsPaginated(
  db: Knex,
  params: ListAccountsPaginatedParams,
): Promise<{ accounts: AccountRow[]; total: number }> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(1000, Math.max(1, params.pageSize ?? 50));

  let base = db("accounts");
  if (params.isActive !== undefined) base = base.andWhere({ is_active: params.isActive });
  if (params.accountTypeId) base = base.andWhere({ account_type_id: params.accountTypeId });
  if (params.parentAccountId !== undefined) base = base.andWhere({ parent_account_id: params.parentAccountId });
  if (params.search) {
    const term = `%${params.search.toLowerCase()}%`;
    base = base.andWhere((builder) => {
      builder.whereRaw("lower(code) like ?", [term]).orWhereRaw("lower(name) like ?", [term]);
    });
  }

  const countRow = await base.clone().count<{ count: string }>({ count: "*" }).first();
  const accounts = await base
    .clone()
    .select(COLUMNS)
    .orderBy("code")
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { accounts, total: Number(countRow?.count ?? 0) };
}

/** Jalan dari `parentAccountId` naik ke leluhurnya, cari apakah `accountId`
 * ada di jalur tsb (akan jadi cycle kalau diizinkan) -- dipakai update
 * SAJA (`accountId` param null berarti create, akun belum ada, cycle scr
 * definisi tidak mungkin selain self-reference yg sudah dicek terpisah). */
async function assertParentIsValid(db: Knex, accountId: string | null, parentAccountId: string): Promise<void> {
  if (accountId && parentAccountId === accountId) {
    throw new AccountParentCycleError("Akun tidak boleh menjadi induk (parent) bagi dirinya sendiri.");
  }
  const parent = await db("accounts").where({ id: parentAccountId }).first();
  if (!parent) {
    throw new AccountParentNotFoundError(`Akun induk dengan id "${parentAccountId}" tidak ditemukan.`);
  }
  if (!accountId) return;

  const visited = new Set<string>([parentAccountId]);
  let current = parent;
  while (current.parent_account_id) {
    if (current.parent_account_id === accountId) {
      throw new AccountParentCycleError("Perubahan ini akan membuat struktur parent-child melingkar (cycle).");
    }
    if (visited.has(current.parent_account_id)) break; // cycle lama yg sudah ada -- berhenti defensif, bukan infinite loop
    visited.add(current.parent_account_id);
    current = await db("accounts").where({ id: current.parent_account_id }).first();
    if (!current) break;
  }
}

/** Dipakai modules/company-accounts/routes.ts (dropdown Account Type di
 * form Create/Edit + filter COA List). */
export async function listAccountTypes(db: Knex): Promise<Array<{ id: string; code: string; name: string; normalBalance: string }>> {
  return db("account_types").select("id", "code", "name", "normal_balance as normalBalance").orderBy("sort_order");
}

/** Dipakai journal-service.ts (§22 "inactive account tidak boleh
 * digunakan utk journal baru") -- fungsi reusable, bukan duplikasi query. */
export async function assertAccountUsable(db: Knex, accountId: string): Promise<AccountRow> {
  const account = await getAccount(db, accountId);
  if (!account) {
    throw new AccountNotFoundError(`Akun dengan id "${accountId}" tidak ditemukan.`);
  }
  if (!account.isActive) {
    throw new AccountInactiveError(`Akun "${account.code} - ${account.name}" tidak aktif dan tidak dapat dipakai pada jurnal baru.`);
  }
  if (account.isLocked) {
    throw new AccountLockedError(`Akun "${account.code} - ${account.name}" sedang dikunci (locked) dan tidak dapat dipakai pada jurnal baru.`);
  }
  return account;
}

/** Lock / Unlock akun. Idempotensi sengaja ditolak (409 di route) supaya
 * audit log hanya berisi perubahan nyata. Selalu menulis audit dalam
 * transaction yang sama. */
export async function setAccountLocked(db: Knex, id: string, locked: boolean, actor: ActorContext): Promise<void> {
  await db.transaction(async (trx) => {
    const existing = await getAccount(trx, id);
    if (!existing) throw new AccountNotFoundError(`Akun dengan id "${id}" tidak ditemukan.`);
    if (Boolean(existing.isLocked) === locked) {
      throw new AccountLockStateError(`Akun "${existing.code} - ${existing.name}" sudah ${locked ? "terkunci" : "tidak terkunci"}.`);
    }
    const now = new Date().toISOString();
    await trx("accounts")
      .where({ id })
      .update(
        locked
          ? { is_locked: true, locked_at: now, locked_by: actor.actorId ?? null, updated_at: now }
          : { is_locked: false, locked_at: null, locked_by: null, updated_at: now },
      );
    await appendCompanyAudit(trx, {
      actor,
      action: locked ? "account.lock" : "account.unlock",
      entityType: "account",
      entityId: id,
      before: { isLocked: Boolean(existing.isLocked) },
      after: { isLocked: locked, code: existing.code },
    });
  });
}

export interface CreateAccountInput {
  code: string;
  name: string;
  accountTypeCode: string; // 'ASSET'|'LIABILITY'|... -- resolve ke account_types.id
  normalBalance: "debit" | "credit"; // AUTHORITATIVE, tidak diturunkan dari account_types
  accountSubtype?: string | null;
  parentAccountId?: string | null;
  cashFlowActivity?: string | null;
  isCash?: boolean;
  subledgerType?: string | null;
}

export async function createAccount(db: Knex, input: CreateAccountInput, actor: ActorContext): Promise<{ id: string }> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new AccountCodeRequiredError("Kode akun tidak boleh kosong.");
  if (!name) throw new AccountNameRequiredError("Nama akun tidak boleh kosong.");

  const id = crypto.randomUUID();
  await db.transaction(async (trx) => {
    const existing = await trx("accounts").where({ code }).first();
    if (existing) {
      throw new AccountCodeAlreadyExistsError(`Kode akun "${code}" sudah dipakai.`);
    }

    const accountType = await trx("account_types").where({ code: input.accountTypeCode }).first();
    if (!accountType) {
      throw new AccountTypeNotFoundError(`Tipe akun "${input.accountTypeCode}" tidak ditemukan.`);
    }

    if (input.parentAccountId) {
      await assertParentIsValid(trx, null, input.parentAccountId);
    }

    await trx("accounts").insert({
      id,
      code,
      name,
      account_type_id: accountType.id,
      account_subtype: input.accountSubtype ?? null,
      normal_balance: input.normalBalance,
      parent_account_id: input.parentAccountId ?? null,
      cash_flow_activity: input.cashFlowActivity ?? null,
      is_cash: input.isCash ?? false,
      subledger_type: input.subledgerType ?? null,
    });

    await appendCompanyAudit(trx, {
      actor,
      action: "account.create",
      entityType: "account",
      entityId: id,
      after: { code, name, accountTypeCode: input.accountTypeCode, normalBalance: input.normalBalance },
    });
  });

  return { id };
}

export interface UpdateAccountInput {
  name?: string;
  normalBalance?: "debit" | "credit";
  isActive?: boolean;
  accountSubtype?: string | null;
  parentAccountId?: string | null;
  cashFlowActivity?: string | null;
  isCash?: boolean;
  subledgerType?: string | null;
}

/** TIDAK ADA deleteAccount -- akun yang sudah dipakai posted journal tidak
 * boleh dihapus destructive (§22). Nonaktifkan via `isActive: false`. */
export async function updateAccount(db: Knex, id: string, input: UpdateAccountInput, actor: ActorContext): Promise<void> {
  const existing = await getAccount(db, id);
  if (!existing) throw new AccountNotFoundError(`Akun dengan id "${id}" tidak ditemukan.`);

  if (input.name !== undefined && !input.name.trim()) {
    throw new AccountNameRequiredError("Nama akun tidak boleh kosong.");
  }

  if (existing.isSystemAccount) {
    if (input.isActive === false) {
      throw new SystemAccountProtectedError(
        `Akun "${existing.code} - ${existing.name}" adalah akun sistem dan tidak dapat dinonaktifkan.`,
      );
    }
    if (input.name !== undefined && input.name.trim() !== existing.name) {
      throw new SystemAccountProtectedError(`Akun "${existing.code} - ${existing.name}" adalah akun sistem dan namanya tidak dapat diubah.`);
    }
  }

  if (existing.branchPolicy === "INTER_BRANCH" && (input.isCash === true || (input.cashFlowActivity !== undefined && input.cashFlowActivity !== null))) {
    throw new AccountInterBranchClassificationError(
      `Akun antar-cabang "${existing.code} - ${existing.name}" tidak boleh ditandai sebagai akun kas atau diberi klasifikasi arus kas.`,
    );
  }

  // §6: normal_balance adalah identitas akuntansi -- TIDAK boleh diubah
  // lagi setelah akun pernah dipakai di journal_entry_lines APAPUN
  // status-nya (DRAFT sekalipun -- draft bisa diposting kapan saja).
  if (input.normalBalance !== undefined && input.normalBalance !== existing.normalBalance) {
    const usage = await db("journal_entry_lines").where({ account_id: id }).first();
    if (usage) {
      throw new AccountNormalBalanceLockedError(
        `Saldo normal akun "${existing.code} - ${existing.name}" tidak dapat diubah karena akun ini sudah dipakai pada jurnal. Nonaktifkan akun ini dan buat akun baru jika diperlukan.`,
      );
    }
  }

  if (input.parentAccountId) {
    await assertParentIsValid(db, id, input.parentAccountId);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.normalBalance !== undefined) patch.normal_balance = input.normalBalance;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (input.accountSubtype !== undefined) patch.account_subtype = input.accountSubtype;
  if (input.parentAccountId !== undefined) patch.parent_account_id = input.parentAccountId;
  if (input.cashFlowActivity !== undefined) patch.cash_flow_activity = input.cashFlowActivity;
  if (input.isCash !== undefined) patch.is_cash = input.isCash;
  if (input.subledgerType !== undefined) patch.subledger_type = input.subledgerType;

  // §9: action teridentifikasi jelas di audit trail saat perubahan ini
  // SEMATA-MATA activate/deactivate (pola sama dgn JOURNAL_AUDIT_ACTIONS
  // yg membedakan CREATE vs OPENING_BALANCE_CREATE) -- selain itu tetap
  // "account.update" generik spt sebelumnya.
  let action = "account.update";
  if (input.isActive !== undefined && input.isActive !== existing.isActive) {
    action = input.isActive ? "account.activate" : "account.deactivate";
  }

  await db.transaction(async (trx) => {
    await trx("accounts").where({ id }).update(patch);
    await appendCompanyAudit(trx, {
      actor,
      action,
      entityType: "account",
      entityId: id,
      before: { name: existing.name, normalBalance: existing.normalBalance, isActive: existing.isActive },
      after: input,
    });
  });
}
