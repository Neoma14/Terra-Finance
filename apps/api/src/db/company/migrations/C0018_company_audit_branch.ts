import type { Knex } from "knex";

/**
 * Multi-Branch Phase 1 -- audit per cabang. Kolom nullable (peristiwa
 * tingkat perusahaan tidak punya cabang). Tabel audit tetap append-only:
 * trigger hanya memblokir UPDATE/DELETE baris, bukan penambahan kolom.
 */
export async function up(knex: Knex): Promise<void> {
  const existing = new Set((await knex.raw("PRAGMA table_info(company_audit_log)")).map((r: { name: string }) => r.name));
  if (!existing.has("branch_id")) {
    await knex.raw("ALTER TABLE company_audit_log ADD COLUMN branch_id TEXT");
  }
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_company_audit_log_branch ON company_audit_log(branch_id)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP INDEX IF EXISTS idx_company_audit_log_branch");
  await knex.raw("ALTER TABLE company_audit_log DROP COLUMN branch_id");
}
