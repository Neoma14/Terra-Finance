import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Side-effect SAJA -- HARUS jadi import PERTAMA (lihat komentar lengkap
 * di modules/company/__fixtures__/test-env.ts ttg urutan eksekusi import
 * ES module). TASK-DB-ARCH-010 menambah `SYSTEM_DB_FILE_PATH` -- route
 * journal sekarang lewat `requireCompanyAccess` yang query `systemDb`
 * (`companies_registry`/`company_access`), jadi test file HARUS
 * mengarahkan System DB ke temp juga, atau systemDb singleton jatuh balik
 * ke default `apps/api/data/terra-system.sqlite` (FILE PRODUKSI, meski
 * belum dipakai main.js -- tetap tidak boleh tersentuh test).
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
