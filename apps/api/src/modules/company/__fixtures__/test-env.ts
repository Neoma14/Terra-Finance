import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Side-effect SAJA -- HARUS jadi import PERTAMA di file test (pola sama
 * persis dgn modules/company-journal/__fixtures__/legacy-db-env.ts,
 * TASK-DB-ARCH-007 -- lihat komentar lengkap di sana ttg urutan eksekusi
 * import ES module). Task ini butuh TIGA env var diarahkan ke temp
 * SEBELUM modul manapun meng-import `config/env.ts` (yang membaca
 * `process.env` sekali, di-snapshot, saat modul itu pertama di-load):
 *
 *   DB_FILE_PATH        -- masterDb (legacy, dipakai requireAuth/session)
 *   SYSTEM_DB_FILE_PATH  -- systemDb (companies_registry, system_audit_log)
 *   COMPANY_DATA_ROOT    -- root folder company.db baru dibuat
 *
 * Melindungi `terra-finance.sqlite` produksi (TASK-DB-ARCH-008 §18) DAN
 * memastikan test tidak pernah membuat company.db di luar temp dir
 * (§23 -- dilarang keras memakai folder Data/ produksi utk artifact test).
 */
export const TEST_LEGACY_DB_PATH = path.join(
  os.tmpdir(),
  `terra-legacy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
export const TEST_SYSTEM_DB_PATH = path.join(
  os.tmpdir(),
  `terra-system-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
export const TEST_COMPANY_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "terra-company-data-root-test-"));

process.env.DB_FILE_PATH = TEST_LEGACY_DB_PATH;
process.env.SYSTEM_DB_FILE_PATH = TEST_SYSTEM_DB_PATH;
process.env.COMPANY_DATA_ROOT = TEST_COMPANY_DATA_ROOT;
