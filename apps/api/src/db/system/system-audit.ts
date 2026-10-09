import crypto from "node:crypto";
import type { Knex } from "knex";

/**
 * Audit helper utk `system_audit_log` (skema `S0003`) -- padanan System DB
 * dari `db/company/company-audit.ts` (pola & alasan SAMA PERSIS, lihat
 * komentar lengkap di sana: insert di dalam transaction yang sama dgn
 * perubahan registry, append-only ditegakkan trigger DB, bukan dibangun
 * ulang di sini).
 *
 * Dipakai pertama kali oleh TASK-DB-ARCH-008 (event `company.register`) --
 * bentuknya generik supaya reusable utk event system-level lain di masa
 * depan (migration lifecycle, administrator action, dst) tanpa perlu
 * helper baru lagi.
 */

export type SystemActorType = "user" | "administrator" | "system";

export interface SystemActorContext {
  actorType: SystemActorType;
  actorId?: string | null;
  actorLabel: string;
}

export interface AppendSystemAuditInput {
  actor: SystemActorContext;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  companyId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** User yang menjadi sasaran perubahan (mis. akses cabang diberikan kepadanya). */
  targetUserId?: string | null;
  branchId?: string | null;
}

export async function appendSystemAudit(trx: Knex, input: AppendSystemAuditInput): Promise<void> {
  await trx("system_audit_log").insert({
    id: crypto.randomUUID(),
    actor_type: input.actor.actorType,
    actor_id: input.actor.actorId ?? null,
    actor_label: input.actor.actorLabel,
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    company_id: input.companyId ?? null,
    before_json: input.before !== undefined ? JSON.stringify(input.before) : null,
    after_json: input.after !== undefined ? JSON.stringify(input.after) : null,
    reason: input.reason ?? null,
    target_user_id: input.targetUserId ?? null,
    branch_id: input.branchId ?? null,
    repair_mode: false,
  });
}
