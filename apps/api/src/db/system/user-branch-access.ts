import crypto from "node:crypto";
import type { Knex } from "knex";
import { appendSystemAudit, type SystemActorContext } from "./system-audit.js";

/**
 * Akses user ke cabang (Multi-Branch). Relasi:
 *
 *   user -> company_access (role, branch_scope) -> user_branch_access -> branch
 *
 * Role tetap satu per user per perusahaan; kewenangan cabang = permission
 * role x akses cabang. Fungsi di sini hanya mengelola barisnya di System DB.
 * VALIDASI keberadaan/status cabang (yang hidup di company.db) dilakukan
 * pemanggil sebelum memanggil fungsi tulis -- lihat modules/company-branches.
 * Riwayat utuh: tidak ada DELETE, hanya ACTIVE -> REVOKED.
 */

export const USER_BRANCH_AUDIT_ACTIONS = {
  GRANTED: "user_branch.access_granted",
  REVOKED: "user_branch.access_revoked",
  TRANSFERRED: "user_branch.transferred",
  SCOPE_CHANGED: "user_branch.scope_changed",
  ACTIVE_BRANCH_CHANGED: "user_branch.active_branch_changed",
} as const;

export class BranchAccessAlreadyGrantedError extends Error {
  readonly code = "BRANCH_ACCESS_ALREADY_GRANTED" as const;
}
export class BranchAccessNotFoundError extends Error {
  readonly code = "BRANCH_ACCESS_NOT_FOUND" as const;
}

export interface UserBranchAccessRow {
  id: string;
  companyId: string;
  accessId: string;
  branchId: string;
  status: "ACTIVE" | "REVOKED";
  grantedBy: string | null;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

const COLUMNS = [
  "id",
  "company_id as companyId",
  "access_id as accessId",
  "branch_id as branchId",
  "status",
  "granted_by as grantedBy",
  "granted_at as grantedAt",
  "revoked_by as revokedBy",
  "revoked_at as revokedAt",
  "revoke_reason as revokeReason",
];

export async function listActiveBranchIds(systemDb: Knex, accessId: string): Promise<string[]> {
  const rows = await systemDb("user_branch_access").where({ access_id: accessId, status: "ACTIVE" }).select("branch_id");
  return rows.map((r: { branch_id: string }) => r.branch_id);
}

export async function listBranchAccess(systemDb: Knex, accessId: string, opts: { includeRevoked?: boolean } = {}): Promise<UserBranchAccessRow[]> {
  let q = systemDb("user_branch_access").select(COLUMNS).where({ access_id: accessId }).orderBy("granted_at", "asc");
  if (!opts.includeRevoked) q = q.where({ status: "ACTIVE" });
  return q;
}

export async function countActiveAccessForBranch(systemDb: Knex, companyId: string, branchId: string): Promise<number> {
  const row = await systemDb("user_branch_access").where({ company_id: companyId, branch_id: branchId, status: "ACTIVE" }).count({ c: "*" }).first();
  return Number((row as any)?.c ?? 0);
}

export interface BranchAccessTarget {
  companyId: string;
  accessId: string;
  targetUserId: string;
}

async function insertActive(trx: Knex, target: BranchAccessTarget, branchId: string, grantedBy: string | null): Promise<string> {
  const id = crypto.randomUUID();
  try {
    await trx("user_branch_access").insert({
      id,
      company_id: target.companyId,
      access_id: target.accessId,
      branch_id: branchId,
      status: "ACTIVE",
      granted_by: grantedBy,
    });
  } catch (err) {
    if (String((err as Error).message).includes("UNIQUE")) {
      throw new BranchAccessAlreadyGrantedError("User sudah memiliki akses ke cabang ini.");
    }
    throw err;
  }
  return id;
}

async function revokeActive(trx: Knex, target: BranchAccessTarget, branchId: string, revokedBy: string | null, reason: string | null): Promise<void> {
  const updated = await trx("user_branch_access")
    .where({ access_id: target.accessId, branch_id: branchId, status: "ACTIVE" })
    .update({ status: "REVOKED", revoked_by: revokedBy, revoked_at: new Date().toISOString(), revoke_reason: reason });
  if (updated === 0) throw new BranchAccessNotFoundError("User tidak memiliki akses aktif ke cabang ini.");
}

export async function grantBranchAccess(
  systemDb: Knex,
  target: BranchAccessTarget,
  branchId: string,
  actor: SystemActorContext,
): Promise<void> {
  await systemDb.transaction(async (trx) => {
    await insertActive(trx, target, branchId, actor.actorId ?? null);
    await appendSystemAudit(trx, {
      actor,
      action: USER_BRANCH_AUDIT_ACTIONS.GRANTED,
      entityType: "user_branch_access",
      entityId: target.accessId,
      companyId: target.companyId,
      targetUserId: target.targetUserId,
      branchId,
      after: { branchId, status: "ACTIVE" },
    });
  });
}

export async function revokeBranchAccess(
  systemDb: Knex,
  target: BranchAccessTarget,
  branchId: string,
  actor: SystemActorContext,
  reason: string | null,
): Promise<void> {
  await systemDb.transaction(async (trx) => {
    await revokeActive(trx, target, branchId, actor.actorId ?? null, reason);
    await appendSystemAudit(trx, {
      actor,
      action: USER_BRANCH_AUDIT_ACTIONS.REVOKED,
      entityType: "user_branch_access",
      entityId: target.accessId,
      companyId: target.companyId,
      targetUserId: target.targetUserId,
      branchId,
      before: { branchId, status: "ACTIVE" },
      after: { branchId, status: "REVOKED" },
      reason,
    });
    // Preferensi konteks yang menunjuk cabang yang baru dicabut direset.
    await trx("company_access").where({ id: target.accessId, default_branch_id: branchId }).update({ default_branch_id: null });
  });
}

/** Transfer = cabut dari X + beri Y dalam SATU transaksi dan SATU event audit. */
export async function transferBranchAccess(
  systemDb: Knex,
  target: BranchAccessTarget,
  fromBranchId: string,
  toBranchId: string,
  actor: SystemActorContext,
  reason: string | null,
): Promise<void> {
  if (fromBranchId === toBranchId) throw new BranchAccessAlreadyGrantedError("Cabang asal dan tujuan sama.");
  await systemDb.transaction(async (trx) => {
    await revokeActive(trx, target, fromBranchId, actor.actorId ?? null, reason ?? "transfer");
    await insertActive(trx, target, toBranchId, actor.actorId ?? null);
    await trx("company_access").where({ id: target.accessId, default_branch_id: fromBranchId }).update({ default_branch_id: null });
    await appendSystemAudit(trx, {
      actor,
      action: USER_BRANCH_AUDIT_ACTIONS.TRANSFERRED,
      entityType: "user_branch_access",
      entityId: target.accessId,
      companyId: target.companyId,
      targetUserId: target.targetUserId,
      branchId: toBranchId,
      before: { branchId: fromBranchId },
      after: { branchId: toBranchId },
      reason,
    });
  });
}

export async function setBranchScope(
  systemDb: Knex,
  target: BranchAccessTarget,
  scope: "ALL" | "LIMITED",
  actor: SystemActorContext,
): Promise<void> {
  await systemDb.transaction(async (trx) => {
    const current = await trx("company_access").where({ id: target.accessId }).select("branch_scope").first();
    if (!current) throw new BranchAccessNotFoundError("Akses perusahaan tidak ditemukan.");
    if (current.branch_scope === scope) return;
    await trx("company_access").where({ id: target.accessId }).update({ branch_scope: scope, updated_at: new Date().toISOString() });
    await appendSystemAudit(trx, {
      actor,
      action: USER_BRANCH_AUDIT_ACTIONS.SCOPE_CHANGED,
      entityType: "company_access",
      entityId: target.accessId,
      companyId: target.companyId,
      targetUserId: target.targetUserId,
      before: { branchScope: current.branch_scope },
      after: { branchScope: scope },
    });
  });
}

/** Mengubah konteks cabang kerja (preferensi). Audit hanya bila benar-benar berubah. Bukan perubahan permission. */
export async function setDefaultBranch(
  systemDb: Knex,
  target: BranchAccessTarget,
  branchId: string | null,
  actor: SystemActorContext,
): Promise<boolean> {
  return systemDb.transaction(async (trx) => {
    const current = await trx("company_access").where({ id: target.accessId }).select("default_branch_id").first();
    if (!current) throw new BranchAccessNotFoundError("Akses perusahaan tidak ditemukan.");
    if ((current.default_branch_id ?? null) === branchId) return false;
    await trx("company_access").where({ id: target.accessId }).update({ default_branch_id: branchId });
    await appendSystemAudit(trx, {
      actor,
      action: USER_BRANCH_AUDIT_ACTIONS.ACTIVE_BRANCH_CHANGED,
      entityType: "company_access",
      entityId: target.accessId,
      companyId: target.companyId,
      targetUserId: target.targetUserId,
      branchId,
      before: { branchId: current.default_branch_id ?? null },
      after: { branchId },
    });
    return true;
  });
}
