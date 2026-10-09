import type { Knex } from "knex";

/**
 * Multi-Branch Phase 3 -- override permission per user per perusahaan.
 *
 *   Effective = (permission role  UNION  GRANT aktif)  MINUS  DENY aktif
 *
 * Hanya permission operasional dalam daftar tertutup (CHECK di bawah, sama
 * dengan OVERRIDABLE_PERMISSIONS di rbac.ts -- migrasi dibekukan, tidak
 * mengimpor kode aplikasi). Permission administratif tidak dapat masuk ke
 * tabel ini sama sekali. Riwayat utuh: tidak ada DELETE, hanya
 * ACTIVE -> REVOKED. DENY pada OWNER ditolak oleh database (OWNER selalu penuh).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("access_permission_overrides", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies_registry").onDelete("RESTRICT");
    t.string("access_id").notNullable().references("id").inTable("company_access").onDelete("CASCADE");
    t.string("permission").notNullable().checkIn(["interbranch.read", "interbranch.create", "interbranch.approve", "interbranch.reverse", "report.consolidated"]);
    t.string("effect").notNullable().checkIn(["GRANT", "DENY"]);
    t.string("status").notNullable().defaultTo("ACTIVE").checkIn(["ACTIVE", "REVOKED"]);
    t.text("reason");
    t.string("created_by");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.string("revoked_by");
    t.timestamp("revoked_at");
    t.text("revoke_reason");
    t.index(["access_id", "status"]);
    t.index(["company_id"]);
  });

  await knex.raw("CREATE UNIQUE INDEX uq_access_permission_overrides_active ON access_permission_overrides(access_id, permission) WHERE status = 'ACTIVE'");

  await knex.raw(`
    CREATE TRIGGER access_permission_overrides_company_match_ins
    BEFORE INSERT ON access_permission_overrides
    WHEN (SELECT company_id FROM company_access WHERE id = NEW.access_id) IS NULL
      OR (SELECT company_id FROM company_access WHERE id = NEW.access_id) <> NEW.company_id
    BEGIN
      SELECT RAISE(ABORT, 'Override permission tidak boleh menghubungkan user dengan perusahaan yang berbeda');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER access_permission_overrides_no_deny_owner
    BEFORE INSERT ON access_permission_overrides
    WHEN NEW.effect = 'DENY' AND (SELECT role FROM company_access WHERE id = NEW.access_id) = 'OWNER'
    BEGIN
      SELECT RAISE(ABORT, 'Permission OWNER tidak dapat dibatasi (DENY)');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER access_permission_overrides_immutable_identity
    BEFORE UPDATE OF company_id, access_id, permission, effect ON access_permission_overrides
    WHEN NEW.company_id <> OLD.company_id OR NEW.access_id <> OLD.access_id OR NEW.permission <> OLD.permission OR NEW.effect <> OLD.effect
    BEGIN
      SELECT RAISE(ABORT, 'Identitas override tidak dapat diubah; cabut lalu buat override baru');
    END;
  `);
  await knex.raw(`
    CREATE TRIGGER access_permission_overrides_no_delete
    BEFORE DELETE ON access_permission_overrides
    WHEN (SELECT COUNT(*) FROM company_access WHERE id = OLD.access_id) > 0
    BEGIN
      SELECT RAISE(ABORT, 'Override permission tidak boleh dihapus; cabut dengan status REVOKED');
    END;
  `);
}

export async function down(knex: Knex): Promise<void> {
  for (const trg of ["no_delete", "immutable_identity", "no_deny_owner", "company_match_ins"]) {
    await knex.raw(`DROP TRIGGER IF EXISTS access_permission_overrides_${trg}`);
  }
  await knex.raw("DROP INDEX IF EXISTS uq_access_permission_overrides_active");
  await knex.schema.dropTableIfExists("access_permission_overrides");
}
