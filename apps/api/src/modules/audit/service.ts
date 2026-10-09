import crypto from "node:crypto";
import type { Knex } from "knex";

export interface RecordAuditInput {
  actorType: "user" | "administrator";
  actorId?: string | null;
  actorLabel: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  repairMode?: boolean;
}

/**
 * Satu-satunya cara menulis ke `audit_log` -- dipanggil LANGSUNG dari tiap
 * route yang mengubah data (bukan lewat middleware generik), supaya
 * `before`/`after` akurat per-entity, bukan tebakan generik dari body
 * request mentah. Baris yang ditulis di sini TIDAK BISA diubah/dihapus
 * lagi oleh siapa pun (lihat trigger `audit_log_no_update`/`_no_delete`
 * di migrasi 0003) -- fungsi ini cuma boleh INSERT, jangan pernah dipakai
 * utk update/delete baris audit_log yang sudah ada.
 */
export async function recordAudit(db: Knex, input: RecordAuditInput): Promise<void> {
  await db("audit_log").insert({
    id: crypto.randomUUID(),
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    actor_label: input.actorLabel,
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    before_json: input.before !== undefined ? JSON.stringify(input.before) : null,
    after_json: input.after !== undefined ? JSON.stringify(input.after) : null,
    reason: input.reason ?? null,
    repair_mode: input.repairMode ?? false,
  });
}

export interface AuditLogRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
  repairMode: boolean;
  createdAt: string;
}

export async function listAuditLog(
  db: Knex,
  filters: { actorType?: string; entityType?: string; from?: string; to?: string; limit?: number },
): Promise<AuditLogRow[]> {
  let query = db("audit_log")
    .select(
      "id",
      "actor_type as actorType",
      "actor_id as actorId",
      "actor_label as actorLabel",
      "action",
      "entity_type as entityType",
      "entity_id as entityId",
      "before_json as beforeJson",
      "after_json as afterJson",
      "reason",
      "repair_mode as repairMode",
      "created_at as createdAt",
    )
    .orderBy("created_at", "desc")
    .limit(filters.limit ?? 200);

  if (filters.actorType) query = query.andWhere("actor_type", filters.actorType);
  if (filters.entityType) query = query.andWhere("entity_type", filters.entityType);
  if (filters.from) query = query.andWhere("created_at", ">=", filters.from);
  if (filters.to) query = query.andWhere("created_at", "<=", filters.to);

  return query;
}
