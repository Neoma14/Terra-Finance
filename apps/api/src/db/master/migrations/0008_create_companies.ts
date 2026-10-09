import type { Knex } from "knex";

/**
 * Perusahaan KLIEN yang dikelola konsultan lewat instalasi offline ini --
 * BEDA dari `company_profile` (identitas firm konsultan itu sendiri, dibuat
 * di wizard setup). Satu instalasi = satu konsultan/firm, TAPI bisa kelola
 * BANYAK perusahaan klien (mirror model "multi-perusahaan" versi online,
 * cuma di sini semua data ada di SATU file SQLite dibedakan `company_id`,
 * bukan schema Postgres terpisah per klien -- SQLite tidak punya konsep
 * schema-per-tenant). Tidak ada tabel akses per-user spt versi online
 * (`user_company_access`) -- semua user di instalasi ini (admin & staff)
 * bisa lihat semua perusahaan, krn ini alat kerja internal SATU firm,
 * bukan platform multi-firm.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("companies", (t) => {
    t.string("id").primary();
    t.string("slug").notNullable().unique();
    t.string("name").notNullable();
    t.string("industry");
    t.string("industry_template").notNullable().defaultTo("general");
    t.integer("fiscal_year_start_month").notNullable().defaultTo(1);
    t.string("currency", 3).notNullable().defaultTo("IDR");
    t.text("logo_data_uri");
    t.string("status").notNullable().defaultTo("active"); // 'active' | 'archived'
    t.string("created_by").references("id").inTable("users");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("companies");
}
