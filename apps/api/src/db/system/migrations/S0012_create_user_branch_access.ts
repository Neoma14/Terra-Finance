import type { Knex } from "knex";

/**
 * Multi-Branch Phase 1 -- relasi user <-> cabang (satu user banyak cabang).
 *
 *   user (system_users) -> company_access -> user_branch_access -> branch
 *
 * Cabang hidup di company.db (file lain), jadi `branch_id` tidak bisa
 * di-FK: divalidasi aplikasi saat menulis, dan resolver membuang id yang
 * tidak dikenal saat membaca (fail-closed). Integritas lintas-perusahaan
 * dijaga di level database oleh trigger: `company_id` baris harus sama
 * dengan `company_id` dari `company_access` yang dirujuk `access_id`.
 *
 * Riwayat utuh: tidak ada DELETE dari aplikasi, hanya status
 * ACTIVE -> REVOKED. (CASCADE dari company_access dipertahankan agar
 * pencabutan akses perusahaan yang sudah ada tetap berfungsi; jejaknya
 * tetap ada di system_audit_log.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("user_branch_access", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies_registry").onDelete("RESTRICT");
    t.string("access_id").notNullable().references("id").inTable("company_access").onDelete("CASCADE");
    t.string("branch_id").notNullable();
    t.string("status").notNullable().defaultTo("ACTIVE").checkIn(["ACTIVE", "REVOKED"]);
    t.string("granted_by");
    t.timestamp("granted_at").notNullable().defaultTo(knex.fn.now());
    t.string("granted_via_delegation_id");
    t.string("revoked_by");
    t.timestamp("revoked_at");
    t.text("revoke_reason");
    t.index(["company_id", "branch_id"]);
    t.index(["access_id"]);
  });

  await knex.raw("CREATE UNIQUE INDEX uq_user_branch_access_active ON user_branch_access(access_id, branch_id) WHERE status = 'ACTIVE'");

  await knex.raw(`
    CREATE TRIGGER user_branch_access_company_match_ins
    BEFORE INSERT ON user_branch_access
    WHEN (SELECT company_id FROM company_access WHERE id = NEW.access_id) IS NULL
      OR (SELECT company_id FROM company_access WHERE id = NEW.access_id) <> NEW.company_id
    BEGIN
      SELECT RAISE(ABORT, 'Akses cabang tidak boleh menghubungkan user dengan perusahaan yang berbeda');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER user_branch_access_company_match_upd
    BEFORE UPDATE OF company_id, access_id ON user_branch_access
    WHEN (SELECT company_id FROM company_access WHERE id = NEW.access_id) IS NULL
      OR (SELECT company_id FROM company_access WHERE id = NEW.access_id) <> NEW.company_id
    BEGIN
      SELECT RAISE(ABORT, 'Akses cabang tidak boleh menghubungkan user dengan perusahaan yang berbeda');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER user_branch_access_immutable_identity
    BEFORE UPDATE OF company_id, access_id, branch_id ON user_branch_access
    WHEN NEW.company_id <> OLD.company_id OR NEW.access_id <> OLD.access_id OR NEW.branch_id <> OLD.branch_id
    BEGIN
      SELECT RAISE(ABORT, 'Identitas baris akses cabang tidak dapat diubah; cabut lalu beri akses baru');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS user_branch_access_immutable_identity");
  await knex.raw("DROP TRIGGER IF EXISTS user_branch_access_company_match_upd");
  await knex.raw("DROP TRIGGER IF EXISTS user_branch_access_company_match_ins");
  await knex.raw("DROP INDEX IF EXISTS uq_user_branch_access_active");
  await knex.schema.dropTableIfExists("user_branch_access");
}
