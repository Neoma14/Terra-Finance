import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";
import dotenv from "dotenv";

// Pola identik dgn db/master/knexfile.ts (lihat komentar lengkap di sana) --
// knex CLI chdir's ke folder file ini SEBELUM require, jadi path TIDAK BOLEH
// pakai process.cwd(), harus relatif ke import.meta.url file ini sendiri.
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(apiRoot, ".env") });

// SENGAJA file SQLite TERPISAH dari db/master (terra-finance.sqlite) --
// System DB (ADR-001) menyimpan HANYA data level-aplikasi/instalasi, tidak
// pernah data accounting perusahaan. Lihat System_DB_Schema.md.
const dbFilePath = process.env.SYSTEM_DB_FILE_PATH ?? path.join(apiRoot, "data", "terra-system.sqlite");
fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

const thisFileExtension = path.extname(fileURLToPath(import.meta.url)).replace(/^\./, "");

const config: Knex.Config = {
  client: "better-sqlite3",
  connection: { filename: dbFilePath },
  useNullAsDefault: true,
  migrations: {
    // Absolut, bukan "./migrations" -- sama alasannya dgn db/master/knexfile.ts:
    // startServer() mengimpor config ini langsung tanpa chdir apa pun.
    directory: path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
    extension: thisFileExtension,
  },
};

export default config;
