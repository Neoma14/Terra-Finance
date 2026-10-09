import type { Knex } from "knex";

/**
 * Helper baca/tulis `companies_registry` (skema `S0008`, TIDAK diubah di
 * task ini). TASK-DB-ARCH-008 -- menutup gap "registry belum punya
 * consumer" yang dicatat di TASK-DB-ARCH-004/007.
 *
 * Nama kolom PERSIS sesuai migration S0008 (tidak diasumsikan): id, slug,
 * name, database_path, status, schema_version, last_migration_status,
 * last_migration_at, last_backup_at, created_by, created_at, updated_at.
 */

export interface CompanyRegistryRow {
  id: string;
  slug: string;
  name: string;
  databasePath: string;
  status: string;
  schemaVersion: number;
  lastMigrationStatus: string;
  lastMigrationAt: string | null;
  lastBackupAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const REGISTRY_COLUMNS = [
  "id",
  "slug",
  "name",
  "database_path as databasePath",
  "status",
  "schema_version as schemaVersion",
  "last_migration_status as lastMigrationStatus",
  "last_migration_at as lastMigrationAt",
  "last_backup_at as lastBackupAt",
  "created_by as createdBy",
  "created_at as createdAt",
  "updated_at as updatedAt",
];

export async function findCompanyRegistryBySlug(systemDb: Knex, slug: string): Promise<CompanyRegistryRow | undefined> {
  return systemDb("companies_registry").select(REGISTRY_COLUMNS).where({ slug }).first();
}

export interface InsertCompanyRegistryInput {
  id: string;
  slug: string;
  name: string;
  databasePath: string;
  schemaVersion: number;
  /** createdBy dibiarkan null kalau actor session tidak punya baris
   * `system_users` yang valid -- lihat komentar panjang di
   * modules/company/routes.ts ("GAP: session user vs system_users"). FK
   * `created_by -> system_users.id` akan ditolak DB kalau dipaksa diisi id
   * yang tidak ada di tabel itu. */
  createdBy: string | null;
}

/** INSERT saja -- dipanggil dari dalam `systemDb.transaction()` di route
 * handler (TASK-DB-ARCH-008 §12), bukan dari sini, supaya atomic dgn
 * penulisan `system_audit_log` utk event yang sama. */
export async function insertCompanyRegistry(trx: Knex, input: InsertCompanyRegistryInput): Promise<void> {
  const now = new Date().toISOString();
  await trx("companies_registry").insert({
    id: input.id,
    slug: input.slug,
    name: input.name,
    database_path: input.databasePath,
    status: "active",
    schema_version: input.schemaVersion,
    last_migration_status: "READY",
    last_migration_at: now,
    last_backup_at: null,
    created_by: input.createdBy,
  });
}
