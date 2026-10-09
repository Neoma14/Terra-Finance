import type { Knex } from "knex";

/**
 * Satu instalasi = satu klien = SATU baris di sini (bukan tabel
 * `companies` multi-tenant seperti versi online) -- diisi lewat wizard
 * setup awal (first-run) saat tabel ini masih kosong.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("company_profile", (t) => {
    t.string("id").primary();
    t.string("name").notNullable();
    t.string("industry");
    t.text("logo_data_uri");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("company_profile");
}
