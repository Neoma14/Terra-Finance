import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import knexLib from "knex";
import { env } from "../../config/env.js";

// Satu file SQLite per instalasi -- lokasinya di `userData` milik Electron
// (survive reinstall/update aplikasi, TIDAK di folder instalasi program),
// dioper lewat env var `DB_FILE_PATH` oleh main.js. Fallback (dev server
// tanpa Electron) SENGAJA dihitung relatif ke lokasi FILE INI
// (`import.meta.url`), BUKAN `process.cwd()` -- proses ini bisa dijalankan
// dari cwd manapun (root workspace, `apps/api`, dst tergantung cara
// invoke), dan HARUS resolve ke file yang SAMA PERSIS dengan yang dipakai
// `knexfile.ts` (lihat komentar serupa di sana) supaya migrasi dan query
// aplikasi tidak diam-diam menunjuk ke dua file .sqlite berbeda.
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dbFilePath = env.DB_FILE_PATH ?? path.join(apiRoot, "data", "terra-finance.sqlite");
fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

export const masterDb = knexLib({
  client: "better-sqlite3",
  connection: { filename: dbFilePath },
  useNullAsDefault: true,
  // SQLite dgn better-sqlite3 itu synchronous -- knex TETAP butuh pool utk
  // API async-nya, tapi harus dipaksa max 1 koneksi (satu file, satu proses)
  // supaya tidak ada write dari dua koneksi berbarengan yang bikin "database
  // is locked".
  pool: {
    min: 1,
    max: 1,
    // `PRAGMA foreign_keys` default OFF di SQLite -- WAJIB dinyalakan manual
    // tiap koneksi baru, kalau tidak semua FK constraint di migrasi jadi
    // tidak ditegakkan sama sekali (insert/delete yang seharusnya ditolak
    // malah lolos diam-diam).
    afterCreate: (conn: { pragma: (sql: string) => void }, done: (err: Error | null, conn: unknown) => void) => {
      conn.pragma("foreign_keys = ON");
      done(null, conn);
    },
  },
});

export function getDbFilePath(): string {
  return dbFilePath;
}
