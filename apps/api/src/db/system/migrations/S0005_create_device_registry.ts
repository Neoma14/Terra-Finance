import type { Knex } from "knex";

/** Device/terminal yang pernah connect ke server lokal -- padanan System DB
 * dari db/master/migrations/0005_create_device_registry.ts, tidak ada
 * perubahan kolom. */
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
