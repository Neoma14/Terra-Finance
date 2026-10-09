import type { Knex } from "knex";

/**
 * Multi-Branch Phase 2 -- dimensi cabang pada header jurnal.
 *
 * Memakai `ALTER TABLE ... ADD COLUMN` mentah (BUKAN schema builder knex):
 * pada SQLite, `.references()` di `alterTable` membuat knex membangun ulang
 * seluruh tabel -- berbahaya untuk `journal_entries` yang direferensi
 * `journal_entry_lines` (ON DELETE CASCADE). ADD COLUMN ... REFERENCES
 * dengan default NULL adalah operasi aman dan tidak menyentuh baris lama.
 *
 *   - branch_id: FK -> branches (RESTRICT). Nullable pada level kolom
 *     (batasan SQLite untuk ADD COLUMN), dijaga tidak pernah NULL oleh
 *     trigger: INSERT tanpa cabang otomatis jatuh ke Kantor Pusat (jalur
 *     lama yang belum sadar-cabang), UPDATE ke NULL ditolak, dan cabang
 *     jurnal POSTED/REVERSED tidak boleh berubah.
 *   - origin: asal jurnal, ditetapkan SERVER (tidak pernah dari request).
 *   - system_process / exception_reason: penanda & alasan jurnal sistem.
 *   - inter_branch_*: dicadangkan untuk Phase 6 (tanpa FK karena tabel
 *     induknya belum ada); semuanya NULL atau semuanya terisi (trigger),
 *     dan UNIQUE (transaksi, leg, side) mencegah dua jurnal di slot sama.
 *
 * Data lama: semua jurnal -> Kantor Pusat; origin diturunkan dari kolom
 * existing (source/is_opening_balance). Tidak ada jumlah/akun/tanggal/status
 * yang disentuh.
 */
export async function up(knex: Knex): Promise<void> {
  const columns: Array<{ name: string; ddl: string }> = [
    { name: "branch_id", ddl: "branch_id TEXT REFERENCES branches(id) ON DELETE RESTRICT" },
    {
      name: "origin",
      ddl: "origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','import','opening_balance','system','inter_branch','head_office_effect'))",
    },
    { name: "system_process", ddl: "system_process TEXT" },
    { name: "exception_reason", ddl: "exception_reason TEXT" },
    { name: "inter_branch_transaction_id", ddl: "inter_branch_transaction_id TEXT" },
    { name: "inter_branch_leg", ddl: "inter_branch_leg TEXT CHECK (inter_branch_leg IN ('ORIGINAL','REVERSAL'))" },
    { name: "inter_branch_side", ddl: "inter_branch_side TEXT CHECK (inter_branch_side IN ('FROM','TO'))" },
  ];
  const existing = new Set((await knex.raw("PRAGMA table_info(journal_entries)")).map((r: { name: string }) => r.name));
  for (const col of columns) {
    if (!existing.has(col.name)) await knex.raw(`ALTER TABLE journal_entries ADD COLUMN ${col.ddl}`);
  }

  await knex.raw(
    "UPDATE journal_entries SET branch_id = (SELECT id FROM branches WHERE is_head_office = 1) WHERE branch_id IS NULL",
  );
  await knex.raw("UPDATE journal_entries SET origin = 'import' WHERE source = 'import' AND origin = 'manual'");
  await knex.raw("UPDATE journal_entries SET origin = 'opening_balance' WHERE is_opening_balance = 1 AND origin = 'manual'");

  await knex.raw("CREATE INDEX IF NOT EXISTS idx_journal_entries_branch_date ON journal_entries(branch_id, entry_date)");
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_inter_branch_slot ON journal_entries(inter_branch_transaction_id, inter_branch_leg, inter_branch_side) WHERE inter_branch_transaction_id IS NOT NULL",
  );

  await knex.raw(`
    CREATE TRIGGER journal_entries_branch_default
    AFTER INSERT ON journal_entries
    WHEN NEW.branch_id IS NULL
    BEGIN
      UPDATE journal_entries SET branch_id = (SELECT id FROM branches WHERE is_head_office = 1) WHERE id = NEW.id;
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER journal_entries_branch_not_null
    BEFORE UPDATE OF branch_id ON journal_entries
    WHEN NEW.branch_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'branch_id jurnal tidak boleh dikosongkan');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER journal_entries_branch_locked_after_post
    BEFORE UPDATE OF branch_id ON journal_entries
    WHEN OLD.branch_id IS NOT NULL AND NEW.branch_id <> OLD.branch_id AND OLD.status IN ('POSTED','REVERSED')
    BEGIN
      SELECT RAISE(ABORT, 'Cabang jurnal yang sudah diposting tidak dapat diubah');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER journal_entries_inter_branch_all_or_none_ins
    BEFORE INSERT ON journal_entries
    WHEN (NEW.inter_branch_transaction_id IS NULL) <> (NEW.inter_branch_leg IS NULL)
      OR (NEW.inter_branch_transaction_id IS NULL) <> (NEW.inter_branch_side IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Kolom inter_branch_* harus terisi semua atau kosong semua');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER journal_entries_inter_branch_all_or_none_upd
    BEFORE UPDATE OF inter_branch_transaction_id, inter_branch_leg, inter_branch_side ON journal_entries
    WHEN (NEW.inter_branch_transaction_id IS NULL) <> (NEW.inter_branch_leg IS NULL)
      OR (NEW.inter_branch_transaction_id IS NULL) <> (NEW.inter_branch_side IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Kolom inter_branch_* harus terisi semua atau kosong semua');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  for (const trg of [
    "journal_entries_inter_branch_all_or_none_upd",
    "journal_entries_inter_branch_all_or_none_ins",
    "journal_entries_branch_locked_after_post",
    "journal_entries_branch_not_null",
    "journal_entries_branch_default",
  ]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${trg}`);
  }
  await knex.raw("DROP INDEX IF EXISTS uq_journal_entries_inter_branch_slot");
  await knex.raw("DROP INDEX IF EXISTS idx_journal_entries_branch_date");
  for (const col of ["inter_branch_side", "inter_branch_leg", "inter_branch_transaction_id", "exception_reason", "system_process", "origin", "branch_id"]) {
    await knex.raw(`ALTER TABLE journal_entries DROP COLUMN ${col}`);
  }
}
