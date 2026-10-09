import type { Knex } from "knex";

/** Log teknis/error level-aplikasi -- padanan System DB dari
 * db/master/migrations/0004_create_error_log.ts, tidak ada perubahan kolom. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("error_log", (t) => {
    t.string("id").primary();
    t.string("level").notNullable(); // 'error' | 'warning' | 'fatal'
    t.string("module").notNullable();
    t.string("message").notNullable();
    t.text("stack_trace");
    t.string("app_version").notNullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("error_log");
}
