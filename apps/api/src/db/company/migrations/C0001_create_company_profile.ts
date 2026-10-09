import type { Knex } from "knex";

/**
 * Identitas & konfigurasi perusahaan KLIEN yang memiliki file company.db ini
 * -- satu baris per file (Company_DB_Schema.md §2 "Company Profile"). BUKAN
 * company_profile System DB (db/system/migrations/S0002, identitas firm
 * konsultan sendiri) -- dua konsep berbeda, lihat Architecture.md
 * "COMPANY PROFILE" (TASK-DB-ARCH-002/003).
 *
 * Field set mengikuti Database_Schema.md §5 (company_profile, APPROVED
 * MASTER doc) secara penuh -- menutup gap yang sebelumnya ditemukan saat
 * audit TASK-DB-ARCH-001 (migration 0008_create_companies.ts lama hanya
 * punya `name`/`industry`, field legal/alamat lengkap belum pernah
 * diimplementasikan). Field operasional tambahan (`industry_template`,
 * `journal_number_seq`) dipertahankan dari implementasi existing -- bukan
 * di Database_Schema.md generik, tapi company-scoped & sudah dipakai nyata
 * (seed-chart-of-accounts.ts memilih template dari industry_template;
 * posting.ts increment journal_number_seq utk nomor jurnal otomatis).
 *
 * TIDAK ADA kolom `company_id` -- file ini SENDIRI adalah satu perusahaan
 * (ADR-001 §8: isolasi diberikan oleh file database, bukan kolom).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("company_profile", (t) => {
    t.string("id").primary();
    t.string("name").notNullable();
    t.string("trade_name");
    t.string("legal_entity_type");
    t.string("industry");
    t.string("industry_template").notNullable().defaultTo("general");
    t.string("npwp");
    t.string("nib");
    t.string("address");
    t.string("city");
    t.string("province");
    t.string("postal_code");
    t.string("phone");
    t.string("email");
    t.string("website");
    t.string("currency", 3).notNullable().defaultTo("IDR");
    t.integer("fiscal_year_start_month").notNullable().defaultTo(1);
    t.text("logo_data_uri");
    t.integer("journal_number_seq").notNullable().defaultTo(0);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("company_profile");
}
