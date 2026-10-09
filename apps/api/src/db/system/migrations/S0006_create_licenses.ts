import type { Knex } from "knex";

/** Lisensi instalasi -- padanan System DB dari
 * db/master/migrations/0006_create_license.ts. Nama tabel diubah ke bentuk
 * jamak (`licenses`, System_DB_Schema.md §2) untuk konsistensi penamaan;
 * kolom tidak berubah. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("licenses", (t) => {
    t.string("id").primary();
    t.string("license_key").notNullable().unique();
    t.string("client_name").notNullable();
    t.string("instance_fingerprint").notNullable();
    t.timestamp("activated_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("expires_at");
    t.string("status").notNullable().defaultTo("active"); // 'active' | 'expired' | 'locked'
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("licenses");
}
