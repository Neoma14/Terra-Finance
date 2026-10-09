import type { Knex } from "knex";

/**
 * Fondasi user klien MINIMAL (bukan sistem role klien lengkap -- itu di
 * luar cakupan fondasi Administrator ini, lihat plan). `role` cuma
 * `'admin'|'staff'` generik supaya ada "sesuatu" utk diaudit; aplikasi
 * Kasir/Backoffice sesungguhnya akan dibangun terpisah di atas ini.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("users", (t) => {
    t.string("id").primary();
    t.string("email").notNullable().unique();
    t.string("password_hash").notNullable();
    t.string("full_name").notNullable();
    t.string("role").notNullable().defaultTo("admin"); // 'admin' | 'staff'
    t.text("avatar_url"); // data URI base64, lihat lib/image-upload.ts
    t.boolean("is_active").notNullable().defaultTo(true);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("sessions", (t) => {
    t.string("id").primary();
    t.string("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    t.string("token_hash").notNullable().unique();
    t.timestamp("expires_at").notNullable();
    t.string("user_agent");
    t.string("ip");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["user_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("sessions");
  await knex.schema.dropTableIfExists("users");
}
