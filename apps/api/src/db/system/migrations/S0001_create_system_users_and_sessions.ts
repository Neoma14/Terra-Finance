import type { Knex } from "knex";

/**
 * Fondasi user aplikasi + session -- padanan System DB dari
 * db/master/migrations/0001_create_users_and_sessions.ts (users/sessions),
 * TIDAK mengubah migration historical itu. Nama tabel diberi prefix
 * `system_` (rename disarankan System_DB_Schema.md §2) karena file ini
 * SELALU hanya berisi data System DB -- tidak perlu lagi disambiguasi lewat
 * nama tabel seperti saat shared-DB, tapi prefix dipertahankan utk kejelasan
 * baca lintas file/log sebelum Company DB benar-benar terpisah penuh.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("system_users", (t) => {
    t.string("id").primary();
    t.string("email").notNullable().unique();
    t.string("password_hash").notNullable();
    t.string("full_name").notNullable();
    t.string("role").notNullable().defaultTo("admin"); // 'admin' | 'staff'
    t.text("avatar_url");
    t.boolean("is_active").notNullable().defaultTo(true);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("sessions", (t) => {
    t.string("id").primary();
    t.string("user_id").notNullable().references("id").inTable("system_users").onDelete("CASCADE");
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
  await knex.schema.dropTableIfExists("system_users");
}
