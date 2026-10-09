import type { Knex } from "knex";

/**
 * Multi-Branch Phase 1 -- cakupan cabang per akses perusahaan.
 *
 * `branch_scope`: 'ALL' (default -> user lama TIDAK berubah) atau 'LIMITED'
 * (hanya cabang di `user_branch_access`; LIMITED tanpa baris = tidak
 * melihat cabang apa pun, fail-closed). `default_branch_id` hanyalah
 * preferensi konteks kerja terakhir, divalidasi ulang di server tiap request.
 */
export async function up(knex: Knex): Promise<void> {
  const existing = new Set((await knex.raw("PRAGMA table_info(company_access)")).map((r: { name: string }) => r.name));
  if (!existing.has("branch_scope")) {
    await knex.raw("ALTER TABLE company_access ADD COLUMN branch_scope TEXT NOT NULL DEFAULT 'ALL' CHECK (branch_scope IN ('ALL','LIMITED'))");
  }
  if (!existing.has("default_branch_id")) {
    await knex.raw("ALTER TABLE company_access ADD COLUMN default_branch_id TEXT");
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE company_access DROP COLUMN default_branch_id");
  await knex.raw("ALTER TABLE company_access DROP COLUMN branch_scope");
}
