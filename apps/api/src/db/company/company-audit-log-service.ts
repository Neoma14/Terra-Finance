import type { Knex } from "knex";

/**
 * Audit Log (TASK-023 §14) -- READ-ONLY dari `company_audit_log` (C0012,
 * append-only sejak awal lewat trigger DB, lihat migration). Tidak ada
 * tabel/trigger baru -- fungsi ini cuma SELECT + pagination, tidak pernah
 * INSERT/UPDATE/DELETE (penulisan tetap satu-satunya lewat
 * `appendCompanyAudit`, company-audit.ts, dipanggil dari service lain).
 */

export interface CompanyAuditLogRow {
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
  createdAt: string;
}

export interface ListAuditLogParams {
  page?: number;
  pageSize?: number;
  entityType?: string;
  fromDate?: string;
  toDate?: string;
}

const COLUMNS = [
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
  "created_at as createdAt",
];

export async function listCompanyAuditLog(db: Knex, params: ListAuditLogParams): Promise<{ entries: CompanyAuditLogRow[]; total: number }> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));

  let base = db("company_audit_log");
  if (params.entityType) base = base.andWhere({ entity_type: params.entityType });
  if (params.fromDate) base = base.andWhere("created_at", ">=", params.fromDate);
  if (params.toDate) base = base.andWhere("created_at", "<=", `${params.toDate} 23:59:59`);

  const countRow = await base.clone().count<{ count: string }>({ count: "*" }).first();
  const entries = await base
    .clone()
    .select(COLUMNS)
    .orderBy("created_at", "desc")
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { entries, total: Number(countRow?.count ?? 0) };
}
