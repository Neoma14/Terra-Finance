import type { Knex } from "knex";

/** Konfigurasi level-instalasi (System_DB_Schema.md §6) -- mis. default
 * backup retention, lokasi folder Data/Backups kalau user ingin mengubahnya
 * dari default. Belum ada consumer kode apa pun saat ini (placeholder
 * sengaja minimal, key/value generik -- jangan tambah kolom spesifik
 * sebelum ada kebutuhan nyata). */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("system_settings", (t) => {
    t.string("id").primary();
    t.string("key").notNullable().unique();
    t.text("value");
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("system_settings");
}
