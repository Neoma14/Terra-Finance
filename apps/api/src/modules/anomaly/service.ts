import crypto from "node:crypto";
import type { Knex } from "knex";
import type { AnomalyCandidate } from "./rules.js";

export async function recordAnomaly(
  db: Knex,
  candidate: AnomalyCandidate,
  entity?: { type: string; id: string },
): Promise<void> {
  await db("anomaly_flags").insert({
    id: crypto.randomUUID(),
    rule_code: candidate.ruleCode,
    severity: candidate.severity,
    description: candidate.description,
    entity_type: entity?.type ?? null,
    entity_id: entity?.id ?? null,
  });
}

export interface AnomalyRow {
  id: string;
  ruleCode: string;
  severity: string;
  description: string;
  entityType: string | null;
  entityId: string | null;
  detectedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export async function listAnomalies(db: Knex, onlyUnreviewed = false): Promise<AnomalyRow[]> {
  let query = db("anomaly_flags")
    .select(
      "id",
      "rule_code as ruleCode",
      "severity",
      "description",
      "entity_type as entityType",
      "entity_id as entityId",
      "detected_at as detectedAt",
      "reviewed_at as reviewedAt",
      "reviewed_by as reviewedBy",
    )
    .orderBy("detected_at", "desc");
  if (onlyUnreviewed) query = query.whereNull("reviewed_at");
  return query;
}

export async function reviewAnomaly(db: Knex, id: string, reviewedBy: string): Promise<void> {
  await db("anomaly_flags").where({ id }).update({ reviewed_at: db.fn.now(), reviewed_by: reviewedBy });
}
