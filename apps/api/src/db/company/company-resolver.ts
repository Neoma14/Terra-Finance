import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { env } from "../../config/env.js";
import { resolveCompanyDatabasePath } from "../system/company-db-path.js";
import { createCompanyDb } from "./index.js";

/**
 * Company resolver MINIMAL untuk API layer (TASK-DB-ARCH-007) -- satu-
 * satunya tempat ":companySlug" dari URL diterjemahkan jadi koneksi
 * Company DB. BUKAN CompanyDbManager (tidak ada cache/open-once/switch/
 * lifecycle -- satu koneksi dibuka per request, ditutup di `finally` route
 * handler, lihat `modules/company-journal/routes.ts`).
 *
 * KEPUTUSAN ARSITEKTUR (dicatat, bukan diam-diam): `companies_registry`
 * (System DB, `S0008`) belum punya consumer yang mengisinya (dikonfirmasi
 * TASK-DB-ARCH-004: "skema ada, tidak ada service yang mengisi/membaca").
 * Membangun wiring registry penuh di luar scope task ini (itu
 * TASK-DB-ARCH-004 butir "Company registry" yang masih "[ ] BELUM" di
 * TASK.md). Resolver ini memakai jalur DETERMINISTIK yang SUDAH tersedia
 * (`resolveCompanyDatabasePath`, TASK-DB-ARCH-002) + pengecekan file
 * benar-benar ada di disk sebagai definisi "company exists" untuk
 * arsitektur Company DB -- ini BUKAN permission/RBAC (siapa boleh akses
 * company mana), hanya EXISTENCE check + isolasi path deterministik
 * (satu slug -> selalu satu file yang sama, tidak pernah file company
 * lain). Lihat Final Report TASK-DB-ARCH-007 bagian F utk gap RBAC yang
 * TETAP terbuka (tidak diperbesar atau diperkecil oleh resolver ini).
 */

export class CompanyNotFoundError extends Error {
  readonly code = "COMPANY_NOT_FOUND" as const;
}

/** Exported (TASK-DB-ARCH-008) supaya company-provisioning.ts memakai root
 * yang SAMA PERSIS, bukan menduplikasi logic fallback path ini. */
export function getCompanyDataRoot(): string {
  if (env.COMPANY_DATA_ROOT) return env.COMPANY_DATA_ROOT;
  // Default dev: sibling dari file System/Master DB, bukan di dalam folder
  // instalasi app (konsisten dgn db/system/db/master -- lihat komentar
  // path serupa di sana).
  const apiRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "../../..");
  return path.join(decodeURIComponent(apiRoot), "data", "companies");
}

/** Path company.db utk sebuah slug -- TIDAK mengecek eksistensi file,
 * murni perhitungan path (bisa dipakai operasi "create company" di task
 * mendatang). Melempar `InvalidCompanySlugError` kalau slug tidak aman. */
export function resolveCompanyDbPath(slug: string): string {
  return resolveCompanyDatabasePath(getCompanyDataRoot(), slug);
}

/** Buka koneksi Company DB utk slug tertentu -- melempar
 * `CompanyNotFoundError` kalau file company.db belum ada di disk. Caller
 * WAJIB `.destroy()` koneksi ini setelah selesai (lihat routes.ts). */
export function openCompanyDbForSlug(slug: string): Knex {
  const dbPath = resolveCompanyDbPath(slug);
  if (!fs.existsSync(dbPath)) {
    throw new CompanyNotFoundError(`Company dengan slug "${slug}" tidak ditemukan.`);
  }
  return createCompanyDb(dbPath);
}
