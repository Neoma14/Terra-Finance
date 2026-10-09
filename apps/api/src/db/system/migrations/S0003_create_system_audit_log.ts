import type { Knex } from "knex";

/**
 * Audit trail append-only utk event SYSTEM-LEVEL saja (login, administrator
 * action, device, license, company registry, migration lifecycle) --
 * padanan System DB dari db/master/migrations/0003_create_audit_log.ts,
 * DITAMBAH kolom `company_id` (nullable, System_DB_Schema.md §4) utk event
 * yang terkait SATU company registry tertentu (mis. 'company.register',
 * 'migration.failed') tanpa menjadikan tabel ini tempat audit trail
 * aktivitas finansial perusahaan (itu tinggal di `company_audit_log` milik
 * company.db masing-masing, Company_DB_Schema.md -- BELUM dibangun di task
 * ini).
 *
 * Trigger append-only (BEFORE UPDATE/DELETE RAISE ABORT) dipertahankan
 * persis seperti migration 0003 historical -- pola ini sudah terbukti aman
 * di produksi (dikonfirmasi lewat audit read-only: 2 baris existing,
 * integrity check OK).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("system_audit_log", (t) => {
    t.string("id").primary();
    t.string("actor_type").notNullable(); // 'user' | 'administrator' | 'system'
    t.string("actor_id");
    t.string("actor_label").notNullable();
    t.string("action").notNullable();
    t.string("entity_type");
    t.string("entity_id");
    t.string("company_id"); // nullable -- hanya diisi utk event terkait satu company registry
    t.text("before_json");
    t.text("after_json");
    t.text("reason");
    t.boolean("repair_mode").notNullable().defaultTo(false);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["entity_type", "entity_id"]);
    t.index(["actor_type", "created_at"]);
    t.index(["company_id"]);
  });

  await knex.raw(`
    CREATE TRIGGER system_audit_log_no_update
    BEFORE UPDATE ON system_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'system_audit_log bersifat append-only: baris yang sudah tercatat tidak boleh diubah');
    END;
  `);

  await knex.raw(`
    CREATE TRIGGER system_audit_log_no_delete
    BEFORE DELETE ON system_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'system_audit_log bersifat append-only: baris yang sudah tercatat tidak boleh dihapus');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS system_audit_log_no_delete");
  await knex.raw("DROP TRIGGER IF EXISTS system_audit_log_no_update");
  await knex.schema.dropTableIfExists("system_audit_log");
}
