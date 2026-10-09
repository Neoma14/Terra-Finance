import path from "node:path";
import knexLib, { type Knex } from "knex";

/**
 * Minimal connection factory utk SATU company.db yang pathnya SUDAH
 * divalidasi (TASK-DB-ARCH-003 §24-25) -- BUKAN CompanyDbManager. Tidak ada
 * open/close/switch/lifecycle orchestration, tidak ada resolve-dari-slug
 * (itu tanggung jawab db/system/company-db-path.ts, dipanggil CALLER
 * sebelum fungsi ini, bukan di sini), tidak ada company creation wizard.
 * CompanyDbManager penuh adalah scope task mendatang.
 *
 * Lapis pertahanan tambahan (murah, di sini): menolak membuka file yang
 * basename-nya bukan literally "company.db" -- supaya fungsi ini sendiri
 * juga tidak bisa dipakai membuka file sembarang walau suatu saat dipanggil
 * tanpa lewat resolveCompanyDatabasePath() di hulu.
 */
export class UnsafeCompanyDatabasePathError extends Error {}

export function createCompanyDb(databaseFilePath: string): Knex {
  if (path.basename(databaseFilePath) !== "company.db") {
    throw new UnsafeCompanyDatabasePathError(
      `Company DB connection hanya boleh dibuka utk file bernama "company.db", diterima: "${path.basename(databaseFilePath)}".`,
    );
  }

  return knexLib({
    client: "better-sqlite3",
    connection: { filename: databaseFilePath },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn: { pragma: (sql: string) => void }, done: (err: Error | null, conn: unknown) => void) => {
        conn.pragma("foreign_keys = ON");
        // Trigger DELETE ikut menyala pada INSERT OR REPLACE (penghapusan implisit). Tanpa ini, REPLACE dapat melewati penjaga
        // integritas Inter-Branch (jurnal bertaut, transaksi, persetujuan) yang dipasang sebagai trigger BEFORE DELETE.
        conn.pragma("recursive_triggers = ON");
        done(null, conn);
      },
    },
  });
}
