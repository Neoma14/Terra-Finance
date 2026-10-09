import type { Knex } from "knex";

/**
 * Multi-Branch Phase 3 koreksi desain -- delegasi KEMBALI ke model Revisi 5 (O.3 / Z.4 / Skema delegations):
 *
 *   - 4 kapabilitas tetap: manage_users, manage_branch_info, view_branch_reports, inter_branch
 *   - max_role (VIEWER | STAFF | ACCOUNTANT), selalu di bawah peran penerima
 *   - cakupan = daftar cabang (delegation_branches); TIDAK ADA delegasi "semua cabang"
 *   - satu delegasi aktif per penerima; kedalaman 1 (penerima tidak membuat delegasi)
 *
 * Model sebelumnya (S0015: satu permission x cabang per baris) TIDAK dibuang diam-diam: tabelnya diganti nama
 * menjadi `*_p3_archive` (riwayat tetap ada, tanpa fungsi). Tidak ada data klien yang terpengaruh (multi-cabang
 * belum aktif di perusahaan mana pun).
 */
export async function up(knex: Knex): Promise<void> {
  for (const trg of [
    "delegation_branches_no_update",
    "delegation_branches_scope_check",
    "delegations_no_delete",
    "delegations_immutable_identity",
    "delegations_no_owner_grantee",
    "delegations_party_check_ins",
  ]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${trg}`);
  }
  for (const idx of [
    "uq_delegations_active",
    "delegations_company_id_grantee_access_id_status_index",
    "delegations_grantor_access_id_index",
    "delegation_branches_delegation_id_branch_id_unique",
    "delegation_branches_branch_id_index",
  ]) {
    await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
  }
  await knex.schema.renameTable("delegation_branches", "delegation_branches_p3_archive");
  await knex.schema.renameTable("delegations", "delegations_p3_archive");

  await knex.schema.createTable("delegations", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies_registry").onDelete("RESTRICT");
    t.string("grantor_access_id").notNullable().references("id").inTable("company_access").onDelete("CASCADE");
    t.string("grantee_access_id").notNullable().references("id").inTable("company_access").onDelete("CASCADE");
    t.specificType("can_manage_users", "INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_users IN (0, 1))");
    t.specificType("can_manage_branch_info", "INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_branch_info IN (0, 1))");
    t.specificType("can_view_branch_reports", "INTEGER NOT NULL DEFAULT 0 CHECK (can_view_branch_reports IN (0, 1))");
    t.specificType("can_inter_branch", "INTEGER NOT NULL DEFAULT 0 CHECK (can_inter_branch IN (0, 1))");
    t.string("max_role").notNullable().checkIn(["VIEWER", "STAFF", "ACCOUNTANT"]);
    t.timestamp("expires_at");
    t.string("status").notNullable().defaultTo("ACTIVE").checkIn(["ACTIVE", "REVOKED"]);
    t.text("reason");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.string("revoked_by");
    t.timestamp("revoked_at");
    t.text("revoke_reason");
    t.index(["company_id", "status"], "idx_delegations_company_status");
    t.index(["grantor_access_id"], "idx_delegations_grantor");
    // minimal satu kapabilitas
    t.check("(can_manage_users + can_manage_branch_info + can_view_branch_reports + can_inter_branch) >= 1", undefined, "ck_delegations_has_capability");
  });
  // satu delegasi aktif per penerima
  await knex.raw("CREATE UNIQUE INDEX uq_delegations_active_grantee ON delegations(grantee_access_id) WHERE status = 'ACTIVE'");

  await knex.schema.createTable("delegation_branches", (t) => {
    t.string("delegation_id").notNullable().references("id").inTable("delegations").onDelete("CASCADE");
    t.string("branch_id").notNullable();
    t.unique(["delegation_id", "branch_id"], { indexName: "uq_delegation_branches_pair" });
    t.index(["branch_id"], "idx_delegation_branches_branch");
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
    CREATE TRIGGER delegations_eligible_grantee
    BEFORE INSERT ON delegations
    WHEN (SELECT role FROM company_access WHERE id = NEW.grantee_access_id) NOT IN ('ADMIN', 'ACCOUNTANT')
    BEGIN
      SELECT RAISE(ABORT, 'Penerima delegasi harus berperan ADMIN atau ACCOUNTANT');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegations_max_role_below_grantee
    BEFORE INSERT ON delegations
    WHEN (CASE NEW.max_role WHEN 'VIEWER' THEN 0 WHEN 'STAFF' THEN 1 WHEN 'ACCOUNTANT' THEN 2 ELSE 99 END)
       >= (CASE (SELECT role FROM company_access WHERE id = NEW.grantee_access_id) WHEN 'ACCOUNTANT' THEN 2 WHEN 'ADMIN' THEN 3 ELSE 0 END)
    BEGIN
      SELECT RAISE(ABORT, 'max_role harus berada di bawah peran penerima delegasi');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER delegations_immutable_identity
    BEFORE UPDATE OF company_id, grantor_access_id, grantee_access_id, can_manage_users, can_manage_branch_info, can_view_branch_reports, can_inter_branch, max_role ON delegations
    WHEN NEW.company_id <> OLD.company_id OR NEW.grantor_access_id <> OLD.grantor_access_id OR NEW.grantee_access_id <> OLD.grantee_access_id
      OR NEW.can_manage_users <> OLD.can_manage_users OR NEW.can_manage_branch_info <> OLD.can_manage_branch_info
      OR NEW.can_view_branch_reports <> OLD.can_view_branch_reports OR NEW.can_inter_branch <> OLD.can_inter_branch OR NEW.max_role <> OLD.max_role
    BEGIN
      SELECT RAISE(ABORT, 'Isi delegasi tidak dapat diubah; cabut lalu buat delegasi baru');
    END;
  `);
  // Penghapusan langsung ditolak selama kedua pihak masih ada; CASCADE dari pencabutan akses perusahaan salah satu pihak tetap boleh.
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
    CREATE TRIGGER delegation_branches_no_update
    BEFORE UPDATE ON delegation_branches
    BEGIN
      SELECT RAISE(ABORT, 'Cabang cakupan delegasi tidak dapat diubah; cabut lalu buat delegasi baru');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  for (const trg of ["delegation_branches_no_update", "delegations_no_delete", "delegations_immutable_identity", "delegations_max_role_below_grantee", "delegations_eligible_grantee", "delegations_party_check_ins"]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${trg}`);
  }
  await knex.schema.dropTableIfExists("delegation_branches");
  await knex.raw("DROP INDEX IF EXISTS uq_delegations_active_grantee");
  await knex.schema.dropTableIfExists("delegations");
  await knex.schema.renameTable("delegations_p3_archive", "delegations");
  await knex.schema.renameTable("delegation_branches_p3_archive", "delegation_branches");
}
