import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { createAccount, getAccount, AccountNotFoundError, AccountCodeAlreadyExistsError, AccountInterBranchClassificationError } from "./account-service.js";
import { BRANCH_POLICIES, type BranchPolicy } from "./account-branch-policy.js";
import { BranchInvalidInputError, getBranch, type BranchRow } from "./branch-service.js";

/**
 * Pengelolaan kebijakan cabang per akun + pembuatan terpandu akun antar-cabang
 * (Multi-Branch Phase 2). Hanya OWNER (permission `account.policy`) yang boleh
 * memanggil dari route. Kebijakan TIDAK PERNAH diturunkan dari tipe/nama akun;
 * cabang lawan hanya dari `counterpart_branch_id`.
 */

export const ACCOUNT_POLICY_AUDIT_ACTIONS = {
  POLICY_CHANGED: "account.policy_changed",
  INTER_BRANCH_CREATED: "account.inter_branch_created",
} as const;

export class AccountPolicyChangeBlockedError extends Error {
  readonly code = "ACCOUNT_POLICY_CHANGE_BLOCKED" as const;
}
export class InterBranchAccountPlanInvalidError extends Error {
  readonly code = "INTER_BRANCH_ACCOUNT_PLAN_INVALID" as const;
  constructor(
    message: string,
    public readonly plan: InterBranchAccountPlan,
  ) {
    super(message);
  }
}

async function countPostedLines(db: Knex, accountId: string): Promise<number> {
  const row = await db("journal_entry_lines").where({ account_id: accountId }).count({ c: "*" }).first();
  return Number((row as any)?.c ?? 0);
}

export interface PolicyImpact {
  totalLines: number;
  /** Baris di cabang selain Kantor Pusat -- akan "melanggar" bila kebijakan menjadi CENTRAL_ONLY. */
  nonHeadOfficeLines: number;
  /** Baris dari jurnal non-sistem -- akan "melanggar" bila kebijakan menjadi SYSTEM_ONLY. */
  nonSystemLines: number;
}

export async function getAccountPolicyImpact(db: Knex, accountId: string): Promise<PolicyImpact> {
  const base = () => db("journal_entry_lines as jel").join("journal_entries as je", "je.id", "jel.journal_entry_id").where("jel.account_id", accountId);
  const total = await base().count({ c: "*" }).first();
  const nonHq = await base().join("branches as b", "b.id", "je.branch_id").where("b.is_head_office", 0).count({ c: "*" }).first();
  const nonSystem = await base().whereNot("je.origin", "system").count({ c: "*" }).first();
  return { totalLines: Number((total as any)?.c ?? 0), nonHeadOfficeLines: Number((nonHq as any)?.c ?? 0), nonSystemLines: Number((nonSystem as any)?.c ?? 0) };
}

export interface SetAccountBranchPolicyInput {
  policy: BranchPolicy;
  counterpartBranchId?: string | null;
  reason: string;
}

export async function setAccountBranchPolicy(db: Knex, accountId: string, input: SetAccountBranchPolicyInput, actor: ActorContext): Promise<PolicyImpact> {
  if (!BRANCH_POLICIES.includes(input.policy)) throw new BranchInvalidInputError("Kebijakan cabang akun tidak valid.");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) throw new BranchInvalidInputError("Alasan perubahan kebijakan akun wajib diisi.");

  const account = await getAccount(db, accountId);
  if (!account) throw new AccountNotFoundError(`Akun dengan id "${accountId}" tidak ditemukan.`);

  const counterpartId = input.counterpartBranchId ?? null;
  if (input.policy === "INTER_BRANCH") {
    if (!counterpartId) throw new BranchInvalidInputError("Akun antar-cabang wajib menentukan cabang lawan.");
    const counterpart = await getBranch(db, counterpartId);
    if (!counterpart) throw new BranchInvalidInputError("Cabang lawan tidak ditemukan pada perusahaan ini.");
    if (counterpart.status === "CLOSED") throw new BranchInvalidInputError("Cabang lawan sudah ditutup.");
  } else if (counterpartId) {
    throw new BranchInvalidInputError("Cabang lawan hanya boleh diisi untuk kebijakan INTER_BRANCH.");
  }

  if (input.policy === "INTER_BRANCH") {
    if (account.isCash || account.cashFlowActivity !== null) {
      throw new AccountInterBranchClassificationError(
        `Akun "${account.code} - ${account.name}" ditandai akun kas atau berklasifikasi arus kas sehingga tidak dapat dijadikan akun antar-cabang.`,
      );
    }
    const duplicate = await db("accounts")
      .where({ branch_policy: "INTER_BRANCH", counterpart_branch_id: counterpartId, account_type_id: account.accountTypeId })
      .whereNot({ id: accountId })
      .first("code");
    if (duplicate) {
      throw new AccountPolicyChangeBlockedError(`Sudah ada akun antar-cabang "${duplicate.code}" dengan cabang lawan dan tipe yang sama. Satu pasangan hanya boleh punya satu akun per tipe.`);
    }
  }

  const impact = await getAccountPolicyImpact(db, accountId);
  const touchesInterBranch = account.branchPolicy === "INTER_BRANCH" || input.policy === "INTER_BRANCH";
  const interBranchIdentityChanged = account.branchPolicy !== input.policy || (account.counterpartBranchId ?? null) !== counterpartId;
  if (touchesInterBranch && interBranchIdentityChanged && impact.totalLines > 0) {
    throw new AccountPolicyChangeBlockedError(
      "Akun ini sudah dipakai pada jurnal, sehingga status antar-cabang atau cabang lawannya tidak dapat diubah. Buat akun baru.",
    );
  }

  await db.transaction(async (trx) => {
    await trx("accounts")
      .where({ id: accountId })
      .update({ branch_policy: input.policy, counterpart_branch_id: counterpartId, updated_at: new Date().toISOString() });
    await appendCompanyAudit(trx, {
      actor,
      action: ACCOUNT_POLICY_AUDIT_ACTIONS.POLICY_CHANGED,
      entityType: "account",
      entityId: accountId,
      before: { branchPolicy: account.branchPolicy, counterpartBranchId: account.counterpartBranchId },
      after: { branchPolicy: input.policy, counterpartBranchId: counterpartId, existingLinesAffected: impact },
      reason,
    });
  });
  return impact;
}

// --------------------------------------------------------------------------
// Pembuatan terpandu pasangan akun antar-cabang (preview + konfirmasi)
// --------------------------------------------------------------------------

export type InterBranchAccountKind = "LIABILITY" | "ASSET";

export interface InterBranchAccountPairInput {
  branchAId: string;
  branchBId: string;
  /** LIABILITY = "Antarkantor Passiva" (saldo kredit), ASSET = "Antarkantor Aktiva" (saldo debit). */
  accountTypeCode: InterBranchAccountKind;
  /** Kode akun yang menunjuk B sebagai cabang lawan (dipakai A dan cabang lain). Kosong -> diusulkan sistem. */
  codeCounterpartB?: string;
  codeCounterpartA?: string;
}

export interface PlannedInterBranchAccount {
  counterpartBranchId: string;
  counterpartBranchName: string;
  action: "create" | "exists" | "conflict";
  existingAccountId?: string;
  proposed: { code: string; name: string; accountTypeCode: InterBranchAccountKind; normalBalance: "debit" | "credit" };
  issues: string[];
}

export interface InterBranchAccountPlan {
  items: PlannedInterBranchAccount[];
  canConfirm: boolean;
  issues: string[];
}

function suggestCode(kind: InterBranchAccountKind, branch: BranchRow): string {
  return `IB${kind === "LIABILITY" ? "P" : "A"}-${branch.code}`;
}

async function planOne(db: Knex, kind: InterBranchAccountKind, counterpart: BranchRow, requestedCode: string | undefined): Promise<PlannedInterBranchAccount> {
  const normalBalance = kind === "LIABILITY" ? "credit" : "debit";
  const code = (requestedCode ?? "").trim() || suggestCode(kind, counterpart);
  const name = `Antarkantor ${kind === "LIABILITY" ? "Passiva" : "Aktiva"} - ${counterpart.name}`;
  const proposed = { code, name, accountTypeCode: kind, normalBalance } as const;
  const issues: string[] = [];

  const type = await db("account_types").where({ code: kind }).first();
  const existing = type
    ? await db("accounts").where({ branch_policy: "INTER_BRANCH", counterpart_branch_id: counterpart.id, account_type_id: type.id }).first()
    : undefined;
  if (existing) {
    return { counterpartBranchId: counterpart.id, counterpartBranchName: counterpart.name, action: "exists", existingAccountId: existing.id, proposed: { ...proposed }, issues };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(code)) issues.push(`Kode akun "${code}" tidak valid (1-30 karakter huruf/angka/titik/garis).`);
  const codeTaken = await db("accounts").where({ code }).first();
  if (codeTaken) issues.push(`Kode akun "${code}" sudah dipakai akun lain.`);
  return {
    counterpartBranchId: counterpart.id,
    counterpartBranchName: counterpart.name,
    action: issues.length > 0 ? "conflict" : "create",
    proposed: { ...proposed },
    issues,
  };
}

export async function previewInterBranchAccountPair(db: Knex, input: InterBranchAccountPairInput): Promise<InterBranchAccountPlan> {
  const issues: string[] = [];
  if (input.accountTypeCode !== "LIABILITY" && input.accountTypeCode !== "ASSET") {
    throw new BranchInvalidInputError("Tipe akun antar-cabang harus LIABILITY (Passiva) atau ASSET (Aktiva).");
  }
  if (input.branchAId === input.branchBId) throw new BranchInvalidInputError("Cabang pertama dan kedua harus berbeda.");
  const a = await getBranch(db, input.branchAId);
  const b = await getBranch(db, input.branchBId);
  if (!a || !b) throw new BranchInvalidInputError("Salah satu cabang tidak ditemukan pada perusahaan ini.");
  for (const br of [a, b]) {
    if (br.status === "CLOSED") issues.push(`Cabang "${br.name}" sudah ditutup; akun antar-cabang baru tidak dapat dibuat.`);
  }
  const items = [
    await planOne(db, input.accountTypeCode, b, input.codeCounterpartB),
    await planOne(db, input.accountTypeCode, a, input.codeCounterpartA),
  ];
  if (items[0].proposed.code === items[1].proposed.code) issues.push("Kedua akun tidak boleh memakai kode yang sama.");
  const canConfirm = issues.length === 0 && items.every((i) => i.action !== "conflict") && items.some((i) => i.action === "create");
  return { items, canConfirm, issues };
}

/** Membuat akun yang belum ada, dalam satu transaksi. Wajib `confirm === true` (preview sudah dilihat user). */
export async function createInterBranchAccountPair(
  db: Knex,
  input: InterBranchAccountPairInput & { confirm: boolean },
  actor: ActorContext,
): Promise<{ created: Array<{ id: string; code: string; counterpartBranchId: string }>; skipped: number }> {
  if (input.confirm !== true) throw new BranchInvalidInputError("Pembuatan akun antar-cabang memerlukan konfirmasi setelah melihat preview.");
  const created: Array<{ id: string; code: string; counterpartBranchId: string }> = [];
  let skipped = 0;

  await db.transaction(async (trx) => {
    const plan = await previewInterBranchAccountPair(trx, input);
    if (!plan.canConfirm) {
      throw new InterBranchAccountPlanInvalidError(
        plan.issues.concat(plan.items.flatMap((i) => i.issues)).join(" ") || "Tidak ada akun baru yang perlu dibuat.",
        plan,
      );
    }
    for (const item of plan.items) {
      if (item.action === "exists") {
        skipped += 1;
        continue;
      }
      let id: string;
      try {
        ({ id } = await createAccount(
          trx,
          {
            code: item.proposed.code,
            name: item.proposed.name,
            accountTypeCode: item.proposed.accountTypeCode,
            normalBalance: item.proposed.normalBalance,
          },
          actor,
        ));
      } catch (err) {
        if (err instanceof AccountCodeAlreadyExistsError) throw new BranchInvalidInputError(err.message);
        throw err;
      }
      await trx("accounts").where({ id }).update({ branch_policy: "INTER_BRANCH", counterpart_branch_id: item.counterpartBranchId });
      await appendCompanyAudit(trx, {
        actor,
        action: ACCOUNT_POLICY_AUDIT_ACTIONS.INTER_BRANCH_CREATED,
        entityType: "account",
        entityId: id,
        branchId: item.counterpartBranchId,
        after: { code: item.proposed.code, counterpartBranchId: item.counterpartBranchId, branchPolicy: "INTER_BRANCH" },
      });
      created.push({ id, code: item.proposed.code, counterpartBranchId: item.counterpartBranchId });
    }
  });
  return { created, skipped };
}
