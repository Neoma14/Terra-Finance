import type { Knex } from "knex";

/**
 * Registry perusahaan klien -- HANYA metadata "perusahaan ini ada dan
 * database-nya di mana", TIDAK PERNAH data accounting (Company_DB_Schema.md
 * memegang COA/jurnal/dst, di company.db masing-masing -- BELUM dibangun di
 * task ini, lihat TASK-DB-ARCH-004).
 *
 * `name` adalah cache tampilan saja (System_DB_Schema.md §3) -- sumber
 * kebenaran nama tetap `company_profile.name` di company.db masing-masing
 * perusahaan KLIEN (bukan company_profile System DB di migration S0002, yang
 * identitas firm konsultan sendiri).
 *
 * TIDAK mewarisi langsung dari db/master/migrations/0008_create_companies.ts
 * -- migration itu membuat tabel `companies` berisi field company-owned
 * (industry, industry_template, fiscal_year_start_month, currency,
 * logo_data_uri, journal_number_seq) yang TIDAK tergolong registry, dan
 * dipindah ke `company_profile` company.db saat migrasi data existing
 * (Existing_Data_Migration_Spec.md) -- tidak diimplementasikan di sini.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("companies_registry", (t) => {
    t.string("id").primary();
    t.string("slug").notNullable().unique();
    t.string("name").notNullable();
    t.string("database_path").notNullable();
    t.string("status").notNullable().defaultTo("active"); // 'active' | 'archived'
    t.integer("schema_version").notNullable().defaultTo(0);
    t.string("last_migration_status").notNullable().defaultTo("READY");
    // READY | BACKUP_REQUIRED | MIGRATION_REQUIRED | MIGRATING | COMPLETED | FAILED | RECOVERY_REQUIRED
    t.timestamp("last_migration_at");
    t.timestamp("last_backup_at");
    t.string("created_by").references("id").inTable("system_users");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("companies_registry");
}
