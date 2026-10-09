import type { Knex } from "knex";

/**
 * Multi-Branch Phase 1 -- pengaman rilis. `multi_branch_enabled` default
 * FALSE: selama mati, perusahaan hanya punya Kantor Pusat dan tidak ada
 * cabang kedua yang bisa dibuat, sehingga perilaku aplikasi untuk
 * perusahaan yang ada tidak berubah sama sekali. Hanya OWNER yang dapat
 * menyalakannya (diaudit).
 */
export async function up(knex: Knex): Promise<void> {
  const existing = new Set((await knex.raw("PRAGMA table_info(company_profile)")).map((r: { name: string }) => r.name));
  if (!existing.has("multi_branch_enabled")) {
    await knex.raw("ALTER TABLE company_profile ADD COLUMN multi_branch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (multi_branch_enabled IN (0, 1))");
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE company_profile DROP COLUMN multi_branch_enabled");
}
