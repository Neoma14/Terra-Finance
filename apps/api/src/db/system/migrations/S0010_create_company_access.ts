import type { Knex } from "knex";

/**
 * Company Access -- TASK-DB-ARCH-010, menutup vulnerability "NO COMPANY
 * ACCESS CONTROL" yang dibuktikan TASK-DB-ARCH-009
 * (`security-audit.test.ts`). Relasi many-to-many `system_users` <->
 * `companies_registry` (satu consultant bisa pegang banyak company, satu
 * company bisa diakses banyak user) -- metadata SISTEM, bukan data
 * finansial, jadi wajar di System DB (bukan di company.db manapun,
 * Identity_Architecture_Proposal.md §14).
 *
 * `system_user_id` MERUJUK `system_users.id` yang SAMA PERSIS dgn
 * `masterDb.users.id` (mapping deterministik via identity-bridge.ts,
 * BUKAN tabel mapping terpisah -- lihat Identity_Architecture_Proposal.md
 * Option A/C gabungan: legacy tetap canonical utk AUTHENTICATION,
 * `system_users` row di-provision lazy dgn id yang SAMA utk kebutuhan FK
 * level-sistem seperti tabel ini).
 *
 * `role` company-scoped (OWNER/ADMIN/ACCOUNTANT/STAFF/VIEWER,
 * `db/system/rbac.ts`) -- role di satu company TIDAK berlaku di company
 * lain (satu baris per (user, company)).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("company_access", (t) => {
    t.string("id").primary();
    t.string("system_user_id").notNullable().references("id").inTable("system_users").onDelete("RESTRICT");
    t.string("company_id").notNullable().references("id").inTable("companies_registry").onDelete("RESTRICT");
    t.string("role").notNullable().checkIn(["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"]);
    t.string("status").notNullable().defaultTo("ACTIVE").checkIn(["ACTIVE", "SUSPENDED"]);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["system_user_id", "company_id"]);
    t.index(["company_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("company_access");
}
