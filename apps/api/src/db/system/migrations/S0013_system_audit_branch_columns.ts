import type { Knex } from "knex";

/**
 * Multi-Branch Phase 1 -- audit akses cabang: `target_user_id` (user yang
 * diubah aksesnya) dan `branch_id`. Nullable; tabel tetap append-only
 * (trigger hanya memblokir UPDATE/DELETE baris).
 */
export async function up(knex: Knex): Promise<void> {
  const existing = new Set((await knex.raw("PRAGMA table_info(system_audit_log)")).map((r: { name: string }) => r.name));
  if (!existing.has("target_user_id")) await knex.raw("ALTER TABLE system_audit_log ADD COLUMN target_user_id TEXT");
  if (!existing.has("branch_id")) await knex.raw("ALTER TABLE system_audit_log ADD COLUMN branch_id TEXT");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_system_audit_log_branch ON system_audit_log(branch_id)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX IF EXISTS idx_system_audit_log_branch");
  await knex.raw("ALTER TABLE system_audit_log DROP COLUMN branch_id");
  await knex.raw("ALTER TABLE system_audit_log DROP COLUMN target_user_id");
}
