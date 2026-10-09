import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import knexLib from "knex";
import { env } from "../../config/env.js";

/**
 * System Database (ADR-001 -- lihat Architecture_Decision_Record.md &
 * System_DB_Schema.md). Menyimpan HANYA data level-aplikasi/instalasi:
 * system_users, sessions, companies_registry, licenses, device_registry,
 * system_settings, system_audit_log, error_log, anomaly_flags,
 * company_profile (identitas firm konsultan sendiri -- BUKAN klien, lihat
 * catatan di System_DB_Schema.md §2).
 *
 * TIDAK BOLEH pernah menyimpan data accounting milik perusahaan klien
 * (accounts, journal_entries, periods, dst -- itu tinggal di company.db
 * masing-masing, lihat db/company/, BELUM dibangun di task ini).
 *
 * File TERPISAH dari db/master (terra-finance.sqlite, shared-DB lama) --
 * keduanya hidup berdampingan sampai migrasi data existing (lihat
 * Existing_Data_Migration_Spec.md) dijalankan & disetujui terpisah.
 */
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dbFilePath = env.SYSTEM_DB_FILE_PATH ?? path.join(apiRoot, "data", "terra-system.sqlite");
fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

export const systemDb = knexLib({
  client: "better-sqlite3",
  connection: { filename: dbFilePath },
  useNullAsDefault: true,
  // Sama alasannya dgn db/master/index.ts: better-sqlite3 synchronous, tapi
  // knex tetap butuh pool utk API async-nya -- dipaksa max 1 koneksi supaya
  // tidak ada write bersamaan dari dua koneksi ("database is locked").
  pool: {
    min: 1,
    max: 1,
    afterCreate: (conn: { pragma: (sql: string) => void }, done: (err: Error | null, conn: unknown) => void) => {
      conn.pragma("foreign_keys = ON");
      done(null, conn);
    },
  },
});

export function getSystemDbFilePath(): string {
  return dbFilePath;
}
