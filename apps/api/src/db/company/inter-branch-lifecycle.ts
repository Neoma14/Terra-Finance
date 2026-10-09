import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { INTER_BRANCH_AUDIT_ACTIONS, INTER_BRANCH_AUDIT_ENTITY } from "./inter-branch-domain.js";

/**
 * Siklus hidup Inter-Branch yang disentuh modul LAIN (kedaluwarsa malas, flag multi-cabang, pembatalan otomatis saat
 * cabang non-aktif, blocker penutupan periode). Dipisah dari `inter-branch-service.ts` supaya `branch-service.ts` dan
 * `period-closing-service.ts` dapat memakainya tanpa impor melingkar. Semua fungsi menerima `trx`/`db` milik pemanggil
 * dan tidak membuka transaksi sendiri -- atomik bersama perubahan pemanggil.
 */

export const INTER_BRANCH_SYSTEM_ACTOR: ActorContext = { actorType: "system", actorId: null, actorLabel: "Sistem Antar Cabang" };

/** OWNER tidak dapat mematikan multi-cabang selama ada transaksi antar-cabang yang menunggu (K-3). */
export class MultiBranchHasPendingInterBranchError extends Error {
  readonly code = "MULTI_BRANCH_HAS_PENDING_INTER_BRANCH" as const;
  constructor(
    public readonly waiting: number,
    public readonly reversalWaiting: number,
  ) {
    super(
      `Multi-cabang tidak dapat dimatikan: masih ada ${waiting} transaksi antar-cabang yang menunggu persetujuan` +
        (reversalWaiting > 0 ? ` dan ${reversalWaiting} permintaan pembalikan yang menunggu` : "") +
        ". Selesaikan, tolak, atau batalkan terlebih dahulu.",
    );
  }
}

interface WaitingRow {
  approval_id: string;
  transaction_id: string;
  transaction_no: string;
  from_branch_id: string;
  to_branch_id: string;
  expires_at: string;
}

async function waitingApprovals(db: Knex, kind: "POST" | "REVERSE"): Promise<WaitingRow[]> {
  return db("inter_branch_approvals as a")
    .join("inter_branch_transactions as t", "t.id", "a.transaction_id")
    .where({ "a.kind": kind, "a.status": "WAITING" })
    .select("a.id as approval_id", "t.id as transaction_id", "t.transaction_no", "t.from_branch_id", "t.to_branch_id", "a.expires_at");
}

async function auditEvent(trx: Knex, actor: ActorContext, action: string, row: Pick<WaitingRow, "transaction_id" | "transaction_no" | "from_branch_id" | "to_branch_id">, branchId: string, after: Record<string, unknown>, reason: string | null = null): Promise<void> {
  await appendCompanyAudit(trx, {
    actor,
    action,
    entityType: INTER_BRANCH_AUDIT_ENTITY,
    entityId: row.transaction_id,
    branchId,
    after: { transactionNo: row.transaction_no, fromBranchId: row.from_branch_id, toBranchId: row.to_branch_id, ...after },
    reason,
  });
}

/**
 * Menulis EXPIRED untuk pengajuan / permintaan reversal yang sudah lewat `expires_at` (dievaluasi malas, tanpa cron).
 * Dipanggil di dalam transaksi pemanggil sebelum keputusan atau penghitungan. Mengembalikan jumlah yang ditandai.
 */
export async function expireOverdueInterBranch(trx: Knex, now: Date = new Date()): Promise<number> {
  const cutoff = now.toISOString();
  let expired = 0;
  for (const row of (await waitingApprovals(trx, "POST")).filter((r) => r.expires_at < cutoff)) {
    const claimed = await trx("inter_branch_transactions").where({ id: row.transaction_id, status: "WAITING_APPROVAL" }).update({ status: "EXPIRED", updated_at: cutoff });
    if (claimed === 0) continue;
    await trx("inter_branch_approvals").where({ id: row.approval_id, status: "WAITING" }).update({ status: "EXPIRED" });
    await auditEvent(trx, INTER_BRANCH_SYSTEM_ACTOR, INTER_BRANCH_AUDIT_ACTIONS.EXPIRED, row, row.from_branch_id, { expiresAt: row.expires_at, from: "WAITING_APPROVAL", to: "EXPIRED" });
    expired += 1;
  }
  for (const row of (await waitingApprovals(trx, "REVERSE")).filter((r) => r.expires_at < cutoff)) {
    const claimed = await trx("inter_branch_transactions").where({ id: row.transaction_id, reversal_state: "REVERSAL_WAITING" }).update({ reversal_state: "NOT_REVERSED", updated_at: cutoff });
    if (claimed === 0) continue;
    await trx("inter_branch_approvals").where({ id: row.approval_id, status: "WAITING" }).update({ status: "EXPIRED" });
    await auditEvent(trx, INTER_BRANCH_SYSTEM_ACTOR, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_EXPIRED, row, row.from_branch_id, { expiresAt: row.expires_at, from: "REVERSAL_WAITING", to: "NOT_REVERSED" });
    expired += 1;
  }
  return expired;
}

/** K-3: menandai yang kedaluwarsa lebih dulu, lalu menolak bila masih ada yang menunggu. */
export async function assertNoPendingInterBranch(trx: Knex, now: Date = new Date()): Promise<void> {
  await expireOverdueInterBranch(trx, now);
  const waiting = Number((await trx("inter_branch_transactions").where({ status: "WAITING_APPROVAL" }).count({ c: "*" }).first())?.c ?? 0);
  const reversalWaiting = Number((await trx("inter_branch_transactions").where({ reversal_state: "REVERSAL_WAITING" }).count({ c: "*" }).first())?.c ?? 0);
  if (waiting + reversalWaiting > 0) throw new MultiBranchHasPendingInterBranchError(waiting, reversalWaiting);
}

/**
 * Cabang menjadi INACTIVE/CLOSED: pengajuan menunggu yang melibatkan cabang itu dibatalkan, permintaan reversal yang
 * menunggu dikembalikan ke NOT_REVERSED. Tidak ada jurnal yang dibuat atau diubah. Mengembalikan jumlah yang dibatalkan.
 */
export async function cancelPendingInterBranchForBranch(trx: Knex, branchId: string, actor: ActorContext, reason: string): Promise<number> {
  const involved = (r: WaitingRow) => r.from_branch_id === branchId || r.to_branch_id === branchId;
  const now = new Date().toISOString();
  let cancelled = 0;
  for (const row of (await waitingApprovals(trx, "POST")).filter(involved)) {
    const claimed = await trx("inter_branch_transactions").where({ id: row.transaction_id, status: "WAITING_APPROVAL" }).update({ status: "CANCELLED", updated_at: now });
    if (claimed === 0) continue;
    await trx("inter_branch_approvals").where({ id: row.approval_id, status: "WAITING" }).update({ status: "CANCELLED" });
    await auditEvent(trx, actor, INTER_BRANCH_AUDIT_ACTIONS.CANCELLED, row, branchId, { from: "WAITING_APPROVAL", to: "CANCELLED", automatic: true }, reason);
    cancelled += 1;
  }
  for (const row of (await waitingApprovals(trx, "REVERSE")).filter(involved)) {
    const claimed = await trx("inter_branch_transactions").where({ id: row.transaction_id, reversal_state: "REVERSAL_WAITING" }).update({ reversal_state: "NOT_REVERSED", updated_at: now });
    if (claimed === 0) continue;
    await trx("inter_branch_approvals").where({ id: row.approval_id, status: "WAITING" }).update({ status: "CANCELLED" });
    await auditEvent(trx, actor, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_CANCELLED, row, branchId, { from: "REVERSAL_WAITING", to: "NOT_REVERSED", automatic: true }, reason);
    cancelled += 1;
  }
  return cancelled;
}

/** Jumlah pengajuan/permintaan reversal menunggu (belum kedaluwarsa) yang melibatkan cabang -- untuk pratinjau penutupan cabang. */
export async function countPendingInterBranchForBranch(db: Knex, branchId: string, now: Date = new Date()): Promise<number> {
  const cutoff = now.toISOString();
  const rows = [...(await waitingApprovals(db, "POST")), ...(await waitingApprovals(db, "REVERSE"))];
  return rows.filter((r) => r.expires_at >= cutoff && (r.from_branch_id === branchId || r.to_branch_id === branchId)).length;
}

/**
 * Pengajuan (atau permintaan reversal) menunggu yang akan menulis jurnal ke rentang periode ini. Penutupan periode
 * diblokir selama ada; penguncian tidak (persetujuan akan ditolak jelas).
 */
export async function countPendingInterBranchInRange(db: Knex, startDate: string, endDate: string, now: Date = new Date()): Promise<number> {
  const cutoff = now.toISOString();
  const rows = await db("inter_branch_approvals as a")
    .join("inter_branch_transactions as t", "t.id", "a.transaction_id")
    .where("a.status", "WAITING")
    .where("a.expires_at", ">=", cutoff)
    .whereBetween("t.transaction_date", [startDate.slice(0, 10), endDate.slice(0, 10)])
    .count({ c: "*" })
    .first();
  return Number(rows?.c ?? 0);
}
