import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import knexLib, { type Knex } from "knex";
import companyKnexfile from "./knexfile.js";
import { createCompanyDb } from "./index.js";
import { resolveCompanyDatabasePath, assertSafeCompanySlug } from "../system/company-db-path.js";

/**
 * Company creation flow -- bagian "buat file" saja (TASK-DB-ARCH-008),
 * TANPA menyentuh System DB/registry sama sekali (itu tanggung jawab
 * route handler, lihat modules/company/routes.ts, supaya file ini tetap
 * murni filesystem+Company-DB, reusable tanpa dependency ke System DB).
 *
 * Migration runner yang dipakai: `companyKnexfile` (db/company/knexfile.ts,
 * SUDAH ADA sejak TASK-DB-ARCH-003) -- TIDAK membuat migration runner
 * kedua (§3/§13 instruksi).
 */

export class CompanyDirectoryExistsError extends Error {
  readonly code = "COMPANY_DIRECTORY_EXISTS" as const;
}

export class CompanyDatabaseExistsError extends Error {
  readonly code = "COMPANY_DATABASE_EXISTS" as const;
}

export class CompanyMigrationFailedError extends Error {
  readonly code = "COMPANY_MIGRATION_FAILED" as const;
}

export class CompanyCreationFailedError extends Error {
  readonly code = "COMPANY_CREATION_FAILED" as const;
}

export interface CompanyProfileInput {
  name: string;
  tradeName?: string | null;
  legalEntityType?: string | null;
  industry?: string | null;
  industryTemplate?: string;
  npwp?: string | null;
  nib?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  currency?: string;
  fiscalYearStartMonth?: number;
}

export interface ProvisionCompanyDbInput {
  dataRoot: string;
  slug: string;
  profile: CompanyProfileInput;
}

export interface ProvisionCompanyDbResult {
  databasePath: string;
  companyProfileId: string;
  migrationsApplied: number;
}

const REQUIRED_TABLES = [
  "company_profile",
  "account_types",
  "accounts",
  "periods",
  "counterparties",
  "statement_lines",
  "statement_line_accounts",
  "journal_entries",
  "journal_entry_lines",
  "trial_balance_snapshots",
  "tax_reference_settings",
  "company_audit_log",
  "branches",
];

/**
 * Buat folder + company.db + attachments/ + jalankan C0001-C0012 +
 * inisialisasi company_profile. Kalau GAGAL di langkah mana pun SETELAH
 * folder dibuat, folder dibersihkan (best-effort) sebelum melempar error
 * -- caller (route handler) TIDAK PERNAH melihat folder "setengah jadi"
 * sebagai hasil sukses (§4 Atomicity).
 */
export async function provisionCompanyDb(input: ProvisionCompanyDbInput): Promise<ProvisionCompanyDbResult> {
  assertSafeCompanySlug(input.slug); // re-validasi defense-in-depth, sama persis helper existing
  const dbPath = resolveCompanyDatabasePath(input.dataRoot, input.slug);
  const companyDir = path.dirname(dbPath);

  if (fs.existsSync(companyDir)) {
    throw new CompanyDirectoryExistsError(`Folder perusahaan untuk slug "${input.slug}" sudah ada.`);
  }
  if (fs.existsSync(dbPath)) {
    // Skenario tepi: folder belum ada tapi file company.db entah bagaimana
    // sudah ada (seharusnya tidak terjadi krn selalu dibuat bersamaan) --
    // tetap dicek eksplisit, jangan diam-diam overwrite (§6).
    throw new CompanyDatabaseExistsError(`File company.db untuk slug "${input.slug}" sudah ada.`);
  }

  fs.mkdirSync(companyDir, { recursive: true });
  fs.mkdirSync(path.join(companyDir, "attachments"), { recursive: true });

  const cleanupAndThrow = (err: unknown, wrap: (message: string) => Error): never => {
    try {
      fs.rmSync(companyDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      // Jangan menyembunyikan kegagalan cleanup (§12) -- lempar error asli,
      // tapi catat juga kegagalan cleanup sbg bagian pesan internal (bukan
      // ke client -- route handler yang menyaring lewat toUserErrorMessage).
      throw wrap(`${(err as Error).message} (DAN cleanup folder gagal: ${(cleanupErr as Error).message})`);
    }
    throw wrap((err as Error).message);
  };

  let migrationsApplied = 0;
  try {
    const migrationDb = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
    try {
      const [, migrationNamesRun] = await migrationDb.migrate.latest();
      migrationsApplied = migrationNamesRun.length;
    } finally {
      await migrationDb.destroy();
    }
  } catch (err) {
    return cleanupAndThrow(err, (m) => new CompanyMigrationFailedError(m));
  }

  // Verifikasi tabel penting benar-benar ada (§13) -- lewat connection
  // "resmi" (createCompanyDb) supaya langkah ini SEKALIGUS membuktikan
  // company DB bisa dibuka lewat jalur yang sama dgn company-resolver.ts.
  const companyProfileId = crypto.randomUUID();
  const db = createCompanyDb(dbPath);
  try {
    const tables = await db("sqlite_master").where({ type: "table" }).select("name");
    const tableNames = new Set(tables.map((t: any) => t.name as string));
    const missing = REQUIRED_TABLES.filter((t) => !tableNames.has(t));
    if (missing.length > 0) {
      throw new Error(`Tabel wajib tidak lengkap setelah migration: ${missing.join(", ")}`);
    }

    await db("company_profile").insert({
      id: companyProfileId,
      name: input.profile.name,
      trade_name: input.profile.tradeName ?? null,
      legal_entity_type: input.profile.legalEntityType ?? null,
      industry: input.profile.industry ?? null,
      industry_template: input.profile.industryTemplate ?? "general",
      npwp: input.profile.npwp ?? null,
      nib: input.profile.nib ?? null,
      address: input.profile.address ?? null,
      city: input.profile.city ?? null,
      province: input.profile.province ?? null,
      postal_code: input.profile.postalCode ?? null,
      phone: input.profile.phone ?? null,
      email: input.profile.email ?? null,
      website: input.profile.website ?? null,
      currency: input.profile.currency ?? "IDR",
      fiscal_year_start_month: input.profile.fiscalYearStartMonth ?? 1,
    });
  } catch (err) {
    await db.destroy().catch(() => undefined);
    return cleanupAndThrow(err, (m) => new CompanyCreationFailedError(m));
  }
  await db.destroy();

  return { databasePath: dbPath, companyProfileId, migrationsApplied };
}
