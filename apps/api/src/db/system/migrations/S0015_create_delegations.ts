import type { Knex } from "knex";

/**
 * Multi-Branch Phase 3 -- delegasi wewenang (kedalaman 1).
 *
 * Satu baris = satu permission yang diberikan `grantor` kepada `grantee`
 * untuk cabang tertentu (`delegation_branches`) atau seluruh cabang
 * (`scope_all = 1`, hanya boleh dibuat grantor ber-scope ALL -- ditegakkan
 * aplikasi). Delegasi TIDAK mengubah role dan TIDAK memberi akses cabang;
 * hak efektif = delegasi x akses cabang grantee saat ini x hak grantor
 * saat ini (diperiksa tiap request, tanpa cache).
 * Riwayat utuh: tidak ada DELETE, hanya ACTIVE -> REVOKED. Pengecualian satu-satunya: ikut terhapus
 * (CASCADE) saat akses perusahaan salah satu pihak dihapus -- trigger hanya memblokir penghapusan
 * langsung selama KEDUA pihak masih ada. Jejaknya tetap di system_audit_log.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("delegations", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies_registry").onDelete("RESTRICT");
    t.string("grantor_access_id").notNullable().references("id").inTable("company_access").onDelete("CASCADE");
    t.string("grantee_access_id").notNullable().references("id").inTable("company_access").onDelete("CASCADE");
    t.string("permission").notNullable().checkIn(["interbranch.read", "interbranch.create", "interbranch.approve", "interbranch.reverse", "report.consolidated"]);
    t.specificType("scope_all", "INTEGER NOT NULL DEFAULT 0 CHECK (scope_all IN (0, 1))");
    t.timestamp("expires_at");
    t.string("status").notNullable().defaultTo("ACTIVE").checkIn(["ACTIVE", "REVOKED"]);
    t.text("reason");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.string("revoked_by");
    t.timestamp("revoked_at");
    t.text("revoke_reason");
    t.index(["company_id", "grantee_access_id", "status"]);
    t.index(["grantor_access_id"]);
  });
  await knex.raw("CREATE UNIQUE INDEX uq_delegations_active ON delegations(grantor_access_id, grantee_access_id, permission) WHERE status = 'ACTIVE'");

  await knex.schema.createTable("delegation_branches", (t) => {
    t.string("delegation_id").notNullable().references("id").inTable("delegations").onDelete("CASCADE");
    t.string("branch_id").notNullable();
    t.unique(["delegation_id", "branch_id"]);
    t.index(["branch_id"]);
  });

  await knex.raw(`
    CREATE TRIGGER delegations_party_check_ins
    BEFORE INSERT ON delegations
    WHEN NEW.grantor_access_id = NEW.grantee_access_id
      OR (SELECT company_id FROM company_access WHERE id = NEW.grantor_access_id) IS NULL
      OR (SELECT company_id FROM company_access WHERE id = NEW.grantor_access_id) <> NEW.company_id
      OR (SELECT company_id FROM company_access WHERE id = NEW.grantee_access_id) IS NULL
      OR (SELECT company_id FROM company_access WHERE id = NEW.grantee_access_id) <> NEW.company_id
    BEGIN
      SELECT RAISE(ABORT, 'Delegasi harus antara dua user berbeda pada perusahaan yang sama');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegations_no_owner_grantee
    BEFORE INSERT ON delegations
    WHEN (SELECT role FROM company_access WHERE id = NEW.grantee_access_id) = 'OWNER'
    BEGIN
      SELECT RAISE(ABORT, 'OWNER tidak perlu menerima delegasi');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegations_immutable_identity
    BEFORE UPDATE OF company_id, grantor_access_id, grantee_access_id, permission, scope_all ON delegations
    WHEN NEW.company_id <> OLD.company_id OR NEW.grantor_access_id <> OLD.grantor_access_id
      OR NEW.grantee_access_id <> OLD.grantee_access_id OR NEW.permission <> OLD.permission OR NEW.scope_all <> OLD.scope_all
    BEGIN
      SELECT RAISE(ABORT, 'Identitas delegasi tidak dapat diubah; cabut lalu buat delegasi baru');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegations_no_delete
    BEFORE DELETE ON delegations
    WHEN (SELECT COUNT(*) FROM company_access WHERE id = OLD.grantee_access_id) > 0
      AND (SELECT COUNT(*) FROM company_access WHERE id = OLD.grantor_access_id) > 0
    BEGIN
      SELECT RAISE(ABORT, 'Delegasi tidak boleh dihapus; cabut dengan status REVOKED');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegation_branches_scope_check
    BEFORE INSERT ON delegation_branches
    WHEN (SELECT scope_all FROM delegations WHERE id = NEW.delegation_id) IS NULL
      OR (SELECT scope_all FROM delegations WHERE id = NEW.delegation_id) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Delegasi semua cabang tidak memiliki daftar cabang');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegation_branches_no_update
    BEFORE UPDATE ON delegation_branches
    BEGIN
      SELECT RAISE(ABORT, 'Cabang cakupan delegasi tidak dapat diubah; cabut lalu buat delegasi baru');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  for (const trg of ["delegation_branches_no_update", "delegation_branches_scope_check", "delegations_no_delete", "delegations_immutable_identity", "delegations_no_owner_grantee", "delegations_party_check_ins"]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${trg}`);
  }
  await knex.schema.dropTableIfExists("delegation_branches");
  await knex.raw("DROP INDEX IF EXISTS uq_delegations_active");
  await knex.schema.dropTableIfExists("delegations");
}
