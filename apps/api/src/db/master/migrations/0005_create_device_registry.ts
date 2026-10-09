import type { Knex } from "knex";

/** Terminal/perangkat yang pernah connect ke server lokal ini lewat
 * WiFi/LAN -- diisi otomatis saat request pertama dari fingerprint baru
 * masuk (lihat modules/administrator/device-tracker.ts), `approved`
 * default false supaya Admin klien sadar ada perangkat baru & harus
 * menyetujui manual (bukan auto-trust semua yang connect ke jaringan
 * yang sama). */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("device_registry", (t) => {
    t.string("id").primary();
    t.string("device_name").notNullable();
    t.string("fingerprint").notNullable().unique();
    t.boolean("approved").notNullable().defaultTo(false);
    t.timestamp("first_seen_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("last_seen_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("device_registry");
}
