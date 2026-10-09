import type { Knex } from "knex";

/**
 * Audit trail level-PERUSAHAAN -- Company_DB_Schema.md §2 "Company-Level
 * Audit Log". TERPISAH TEGAS dari `system_audit_log` (db/system):
 *
 *   system_audit_log : login, device registration, license, maintenance,
 *                       system configuration -- event level-instalasi.
 *   company_audit_log: journal created/posted/reversed, period closed,
 *                       account changed, tax setting changed, company
 *                       accounting configuration changed -- event level
 *                       data finansial SATU perusahaan ini.
 *
 * Tidak perlu kolom `company_id` -- file ini sendiri SATU perusahaan
 * (ADR-001 §8). Trigger append-only (BEFORE UPDATE/DELETE RAISE ABORT)
 * sama persis pola `audit_log`/`system_audit_log` yang sudah terbukti aman
 * di produksi (lihat migration 0003 lama & S0003 System DB).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("company_audit_log", (t) => {
    t.string("id").primary();
    t.string("actor_type").notNullable(); // 'user' | 'administrator'
    t.string("actor_id");
    t.string("actor_label").notNullable();
    t.string("action").notNullable(); // mis. 'journal.create', 'journal.post', 'journal.reverse',
    // 'period.close', 'account.change', 'tax_setting.change', 'company_profile.change'
    t.string("entity_type");
    t.string("entity_id");
    t.text("before_json");
    t.text("after_json");
    t.text("reason");
    t.boolean("repair_mode").notNullable().defaultTo(false);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["entity_type", "entity_id"]);
    t.index(["actor_type", "created_at"]);
  });

  await knex.raw(`
    CREATE TRIGGER company_audit_log_no_update
    BEFORE UPDATE ON company_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'company_audit_log bersifat append-only: baris yang sudah tercatat tidak boleh diubah');
    END;
  `);

  await knex.raw(`
    CREATE TRIGGER company_audit_log_no_delete
    BEFORE DELETE ON company_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'company_audit_log bersifat append-only: baris yang sudah tercatat tidak boleh dihapus');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS company_audit_log_no_delete");
  await knex.raw("DROP TRIGGER IF EXISTS company_audit_log_no_update");
  await knex.schema.dropTableIfExists("company_audit_log");
}
