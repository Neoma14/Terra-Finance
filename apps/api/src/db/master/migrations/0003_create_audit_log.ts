import type { Knex } from "knex";

/**
 * Audit trail APPEND-ONLY -- catatan tiap perubahan data (siapa, apa,
 * kapan, nilai sebelum/sesudah) DAN tiap aksi Administrator (termasuk
 * login-nya sendiri). "Tidak boleh dihapus/diubah siapa pun termasuk
 * Admin" DIPAKSA di level database lewat TRIGGER di bawah -- bukan cuma
 * dijaga di kode aplikasi (yang bisa saja ada bug atau di-bypass lewat
 * akses DB langsung), supaya benar-benar accountable.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("audit_log", (t) => {
    t.string("id").primary();
    t.string("actor_type").notNullable(); // 'user' | 'administrator'
    t.string("actor_id"); // nullable -- boleh kosong utk aksi sistem otomatis
    t.string("actor_label").notNullable(); // snapshot nama/email actor saat itu (survive user dihapus)
    t.string("action").notNullable(); // mis. 'transaction.create', 'transaction.void', 'administrator.login'
    t.string("entity_type"); // mis. 'transaction', 'user', nullable utk aksi non-entity (login dsb)
    t.string("entity_id");
    t.text("before_json"); // snapshot data SEBELUM perubahan (JSON string), null utk create
    t.text("after_json"); // snapshot data SESUDAH perubahan (JSON string), null utk delete
    t.text("reason"); // catatan alasan, WAJIB diisi utk aksi mode-perbaikan Administrator
    t.boolean("repair_mode").notNullable().defaultTo(false);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["entity_type", "entity_id"]);
    t.index(["actor_type", "created_at"]);
  });

  await knex.raw(`
    CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log bersifat append-only: baris yang sudah tercatat tidak boleh diubah');
    END;
  `);

  await knex.raw(`
    CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log bersifat append-only: baris yang sudah tercatat tidak boleh dihapus');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS audit_log_no_delete");
  await knex.raw("DROP TRIGGER IF EXISTS audit_log_no_update");
  await knex.schema.dropTableIfExists("audit_log");
}
