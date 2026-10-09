import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";
import dotenv from "dotenv";

// Knex CLI chdir's ke folder file ini SEBELUM require, jadi baik
// `dotenv/config` biasa maupun fallback path di bawah TIDAK BOLEH pakai
// `process.cwd()` -- keduanya resolve relatif ke `apps/api` (root package
// ini), bukan ke folder migrations tempat knexfile ini berada.
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(apiRoot, ".env") });

const dbFilePath = process.env.DB_FILE_PATH ?? path.join(apiRoot, "data", "terra-finance.sqlite");
fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

// Ekstensi file migrasi mengikuti ekstensi knexfile ITU SENDIRI saat
// dijalankan -- ".ts" saat dev (tsx menjalankan langsung dari `src/`),
// ".js" di produksi (`tsc` sudah meng-compile semuanya termasuk folder
// migrations ke `dist/` secara seragam). Menghindari hardcode salah satu
// yang cuma benar di satu mode.
const thisFileExtension = path.extname(fileURLToPath(import.meta.url)).replace(/^\./, "");

const config: Knex.Config = {
  client: "better-sqlite3",
  connection: { filename: dbFilePath },
  useNullAsDefault: true,
  migrations: {
    // Absolut, BUKAN "./migrations" -- knex CLI chdir's ke folder file ini
    // dulu (bikin relatif "kebetulan" benar lewat CLI), tapi startServer()
    // di server.ts meng-import config ini LANGSUNG tanpa chdir apa pun,
    // jadi path relatif akan salah resolve ke `process.cwd()` pemanggil.
    directory: path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
    extension: thisFileExtension,
  },
};

export default config;
