import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { assertSafeCompanySlug, resolveCompanyDatabasePath, InvalidCompanySlugError } from "./company-db-path.js";
import baseKnexConfig from "./knexfile.js";

// `baseKnexConfig` statik (satu kali di-import, pola Knex config yang SAMA
// PERSIS dipakai runMigrations() di server.ts/produksi -- migrations.directory
// & extension TIDAK tergantung env var, aman dipakai ulang). `connection`
// di-override per test dgn file temp sendiri-sendiri, supaya tiap test
// terisolasi tanpa perlu re-import modul (menghindari masalah cache-busting
// dynamic import di bawah vite-node/esbuild).
let tmpFile: string;

function freshTmpFile(): string {
  return path.join(os.tmpdir(), `terra-system-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function openSystemDbAt(filePath: string): Knex {
  const config: Knex.Config = { ...baseKnexConfig, connection: { filename: filePath } };
  return knexLib(config);
}

const SYSTEM_TABLES = [
  "system_users",
  "sessions",
  "company_profile",
  "system_audit_log",
  "error_log",
  "device_registry",
  "licenses",
  "anomaly_flags",
  "companies_registry",
  "system_settings",
  "company_access", // S0010, TASK-DB-ARCH-010
];

// Tabel yang MILIK Company DB (Company_DB_Schema.md) -- tidak boleh pernah
// muncul di System DB manapun.
const COMPANY_ONLY_TABLES = [
  "accounts",
  "statement_lines",
  "statement_line_accounts",
  "periods",
  "counterparties",
  "journal_entries",
  "journal_entry_lines",
  "trial_balance_snapshots",
  "tax_reference_settings",
];

describe("System DB foundation (TASK-DB-ARCH-002)", () => {
  let db: Knex;

  beforeEach(() => {
    tmpFile = freshTmpFile();
    db = openSystemDbAt(tmpFile);
  });

  afterEach(async () => {
    await db.destroy();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("Test 1: System DB dapat dibuat di temporary directory", async () => {
    expect(fs.existsSync(path.dirname(tmpFile))).toBe(true);
    // file sqlite belum tentu ada sebelum migration pertama berjalan di
    // better-sqlite3 -- cukup pastikan knex instance berhasil dibuat tanpa
    // throw (koneksi valid).
    const result = await db.raw("select 1 as ok");
    expect(result[0].ok).toBe(1);
  });

  it("Test 2: System migrations dapat dijalankan dari database kosong", async () => {
    await expect(db.migrate.latest()).resolves.toBeDefined();
  });

  it("Test 3: Semua tabel System DB yang ditargetkan tersedia", async () => {
    await db.migrate.latest();
    const rows = await db("sqlite_master").where({ type: "table" }).select("name");
    const names = rows.map((r: any) => r.name as string);
    for (const table of SYSTEM_TABLES) {
      expect(names, `expected table "${table}" to exist`).toContain(table);
    }
  });

  it("Test 4: Foreign key constraints aktif", async () => {
    await db.migrate.latest();
    await expect(
      db("sessions").insert({
        id: "session-orphan",
        user_id: "user-does-not-exist",
        token_hash: "hash",
        expires_at: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });

  it("Test 5: Migration dapat dijalankan ulang tanpa error (idempotent)", async () => {
    await db.migrate.latest();
    const [, firstRunLog] = await db.migrate.latest();
    // Panggilan kedua ke migrate.latest() tidak boleh menjalankan migration
    // apa pun lagi (sudah di versi terbaru) dan tidak boleh throw.
    expect(firstRunLog).toEqual([]);
  });

  it("Test 6: Tidak ada tabel accounting Company DB yang masuk ke System DB", async () => {
    await db.migrate.latest();
    const rows = await db("sqlite_master").where({ type: "table" }).select("name");
    const names = rows.map((r: any) => r.name as string);
    for (const table of COMPANY_ONLY_TABLES) {
      expect(names, `table "${table}" is Company DB-only and must NOT appear in System DB`).not.toContain(table);
    }
  });
});

describe("Company database path validation (STEP 7, TASK-DB-ARCH-002)", () => {
  const dataRoot = path.join(os.tmpdir(), "terra-data-root-test");

  it("Test 7a: menerima slug aman dan menghasilkan path di bawah data root", () => {
    const resolved = resolveCompanyDatabasePath(dataRoot, "pt-abc-indonesia");
    expect(resolved).toBe(path.join(path.resolve(dataRoot), "pt-abc-indonesia", "company.db"));
  });

  it("Test 7b: menolak path traversal (../)", () => {
    expect(() => resolveCompanyDatabasePath(dataRoot, "../../etc")).toThrow(InvalidCompanySlugError);
  });

  it("Test 7c: menolak slug berisi separator path", () => {
    expect(() => assertSafeCompanySlug("pt/abc")).toThrow(InvalidCompanySlugError);
    expect(() => assertSafeCompanySlug("pt\\abc")).toThrow(InvalidCompanySlugError);
  });

  it("Test 7d: menolak slug kosong", () => {
    expect(() => assertSafeCompanySlug("")).toThrow(InvalidCompanySlugError);
  });

  it("Test 7e: selalu menghasilkan nama file company.db, tidak bisa disuntik nama/ekstensi lain", () => {
    const resolved = resolveCompanyDatabasePath(dataRoot, "cv-maju");
    expect(path.basename(resolved)).toBe("company.db");
  });

  it("Test 7f: menolak slug absolute-path-like yang lolos pola tapi mencoba escape lewat root berbeda", () => {
    // Pola regex sendiri sudah menolak "/", tapi uji eksplisit defense-in-depth
    // resolveCompanyDatabasePath (relative-path check) tetap jadi lapisan kedua.
    expect(() => resolveCompanyDatabasePath(dataRoot, "..")).toThrow(InvalidCompanySlugError);
  });
});

describe("Existing production data safety (STEP 9, TASK-DB-ARCH-002)", () => {
  const existingDbPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "data",
    "terra-finance.sqlite",
  );

  let statBefore: fs.Stats | null = null;

  beforeAll(() => {
    if (fs.existsSync(existingDbPath)) {
      statBefore = fs.statSync(existingDbPath);
    }
  });

  afterAll(() => {
    if (statBefore) {
      const statAfter = fs.statSync(existingDbPath);
      expect(statAfter.size, "terra-finance.sqlite size must not change").toBe(statBefore.size);
      expect(statAfter.mtimeMs, "terra-finance.sqlite mtime must not change").toBe(statBefore.mtimeMs);
    }
  });

  it("Test 8: file existing (kalau ada di mesin ini) tidak disentuh oleh test suite System DB", () => {
    if (!statBefore) {
      // Tidak ada di environment ini (mis. CI bersih) -- bukan kegagalan,
      // cukup catat bahwa pengecekan dilewati.
      expect(true).toBe(true);
      return;
    }
    expect(fs.existsSync(existingDbPath)).toBe(true);
  });
});
