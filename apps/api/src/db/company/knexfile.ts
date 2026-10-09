import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";
import dotenv from "dotenv";

// Pola identik dgn db/system/knexfile.ts & db/master/knexfile.ts (lihat
// komentar lengkap di sana) -- path TIDAK BOLEH pakai process.cwd(), harus
// relatif ke import.meta.url file ini sendiri.
//
// BEDA PENTING dari System/Master: Company DB BUKAN singleton (satu
// instalasi bisa punya N company.db, satu per perusahaan). File ini HANYA
// berguna utk `migrations.directory`/`extension` (dipakai bareng `connection`
// yg di-override per-pemanggilan, lihat db/company/index.ts createCompanyDb())
// dan utk kebutuhan CLI (`knex migrate:make` saat menulis migration baru) --
// BUKAN dipakai langsung sbg config runtime production (production SELALU
// lewat createCompanyDb(path) dgn path yg sudah divalidasi
// resolveCompanyDatabasePath(), tidak pernah file default di sini).
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(apiRoot, ".env") });

// Default HANYA utk kenyamanan CLI/dev (`migrate:make`, atau eksperimen
// manual) -- TIDAK PERNAH dipakai oleh kode aplikasi yang sesungguhnya,
// yang selalu lewat createCompanyDb(explicitPath).
const dbFilePath = process.env.COMPANY_DB_FILE_PATH ?? path.join(apiRoot, "data", "company-dev.sqlite");
// Folder default dev dibuat HANYA di luar produksi. Di produksi (installer),
// folder instalasi (Program Files) tidak boleh ditulis: membuatnya di sini
// membuat server API mati saat start (EPERM) -- ditemukan di tes instalasi
// nyata. Produksi tidak butuh folder ini karena selalu memakai path eksplisit.
if (process.env.NODE_ENV !== "production" || process.env.COMPANY_DB_FILE_PATH) {
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
}

const thisFileExtension = path.extname(fileURLToPath(import.meta.url)).replace(/^\./, "");

const config: Knex.Config = {
  client: "better-sqlite3",
  connection: { filename: dbFilePath },
  useNullAsDefault: true,
  migrations: {
    directory: path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
    extension: thisFileExtension,
  },
};

export default config;
