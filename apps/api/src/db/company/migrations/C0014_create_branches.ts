import crypto from "node:crypto";
import type { Knex } from "knex";

/**
 * Multi-Branch Phase 1 -- master cabang.
 *
 * Satu company.db = satu perusahaan (ADR-001), jadi tabel ini TIDAK punya
 * `company_id`: isolasi antar-perusahaan bersifat struktural (id cabang
 * perusahaan B tidak ada di file perusahaan A). COA tetap SATU per
 * perusahaan -- cabang hanya dimensi di header jurnal (lihat C0015).
 *
 * Lifecycle: ACTIVE / INACTIVE / CLOSED. Tidak ada hard delete: trigger
 * menolak DELETE; cabang yang belum pernah dipakai boleh di-soft-delete
 * (`deleted_at`) oleh service. Kode cabang tidak dapat diubah dan tetap
 * dicadangkan walau cabang di-soft-delete (UNIQUE mencakup semua baris).
 *
 * Kantor Pusat (`is_head_office`) dibuat otomatis dan idempotent; hanya
 * boleh ada satu (unique index parsial), tidak boleh nonaktif/tutup/hapus.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("branches", (t) => {
    t.string("id").primary();
    t.string("code").notNullable();
    t.string("name").notNullable();
    t.string("status").notNullable().defaultTo("ACTIVE").checkIn(["ACTIVE", "INACTIVE", "CLOSED"]);
    t.boolean("is_head_office").notNullable().defaultTo(false);
    t.string("address");
    t.string("phone");
    t.integer("sort_order").notNullable().defaultTo(0);
    t.date("opened_at");
    t.timestamp("closed_at");
    t.string("closed_by");
    t.text("close_reason");
    t.timestamp("reopened_at");
    t.string("reopened_by");
    t.string("created_by");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("deleted_at");
    t.string("deleted_by");
    t.unique(["code"]);
    t.index(["status"]);
    t.index(["sort_order"]);
    t.check("status <> 'CLOSED' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL)", {}, "chk_branches_closed_fields");
  });

  await knex.raw("CREATE UNIQUE INDEX branches_single_head_office ON branches(is_head_office) WHERE is_head_office = 1");

  await knex.raw(`
    CREATE TRIGGER branches_no_delete
    BEFORE DELETE ON branches
    BEGIN
      SELECT RAISE(ABORT, 'Cabang tidak boleh dihapus secara fisik: gunakan status (INACTIVE/CLOSED) atau soft delete untuk cabang yang belum pernah dipakai');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER branches_code_immutable
    BEFORE UPDATE OF code ON branches
    WHEN NEW.code <> OLD.code
    BEGIN
      SELECT RAISE(ABORT, 'Kode cabang tidak dapat diubah');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER branches_head_office_flag_immutable
    BEFORE UPDATE OF is_head_office ON branches
    WHEN NEW.is_head_office <> OLD.is_head_office
    BEGIN
      SELECT RAISE(ABORT, 'Penanda Kantor Pusat tidak dapat diubah');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER branches_head_office_protect
    BEFORE UPDATE ON branches
    WHEN OLD.is_head_office = 1 AND (NEW.status <> 'ACTIVE' OR NEW.deleted_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Kantor Pusat tidak boleh dinonaktifkan, ditutup, atau dihapus');
    END;
  `);

  // Kantor Pusat -- idempotent (migration berjalan sekali per DB, tetapi aman bila diulang).
  const existing = await knex("branches").where({ is_head_office: true }).first();
  if (!existing) {
    await knex("branches").insert({
      id: crypto.randomUUID(),
      code: "PUSAT",
      name: "Kantor Pusat",
      status: "ACTIVE",
      is_head_office: true,
      sort_order: 0,
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS branches_head_office_protect");
  await knex.raw("DROP TRIGGER IF EXISTS branches_head_office_flag_immutable");
  await knex.raw("DROP TRIGGER IF EXISTS branches_code_immutable");
  await knex.raw("DROP TRIGGER IF EXISTS branches_no_delete");
  await knex.raw("DROP INDEX IF EXISTS branches_single_head_office");
  await knex.schema.dropTableIfExists("branches");
}
