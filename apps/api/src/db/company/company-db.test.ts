import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createCompanyDb, UnsafeCompanyDatabasePathError } from "./index.js";
import { resolveCompanyDatabasePath } from "../system/company-db-path.js";

// Pola sama dgn db/system/system-db.test.ts (TASK-DB-ARCH-002): import
// statik `baseKnexConfig` sekali (migrations.directory/extension tidak
// tergantung path file), override `connection.filename` per test supaya
// tiap test terisolasi tanpa dynamic-import cache-busting (yang bermasalah
// di bawah vite-node/esbuild, lihat catatan di system-db.test.ts).

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openCompanyDbAt(filePath: string): Knex {
  const config: Knex.Config = { ...baseKnexConfig, connection: { filename: filePath } };
  return knexLib(config);
}

const COMPANY_TABLES = [
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
];

const SYSTEM_ONLY_TABLES = [
  "system_users",
  "sessions",
  "companies_registry",
  "licenses",
  "device_registry",
  "system_settings",
  "system_audit_log",
  "error_log",
];

describe("Company DB foundation (TASK-DB-ARCH-003)", () => {
  let tmpFile: string;
  let tmpDir: string;
  let db: Knex;

  beforeEach(() => {
    tmpDir = freshTmpDir("terra-company-test-");
    tmpFile = path.join(tmpDir, "company.db");
    db = openCompanyDbAt(tmpFile);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Test 1: Company DB kosong dapat dibuat di temp directory", async () => {
    const result = await db.raw("select 1 as ok");
    expect(result[0].ok).toBe(1);
  });

  it("Test 2: Semua Company migration berjalan dari database kosong", async () => {
    await expect(db.migrate.latest()).resolves.toBeDefined();
  });

  it("Test 3: Migration dapat dijalankan ulang tanpa error (idempotent)", async () => {
    await db.migrate.latest();
    const [, secondRunLog] = await db.migrate.latest();
    expect(secondRunLog).toEqual([]);
  });

  it("Test 4: Semua tabel Company DB yang disetujui tersedia", async () => {
    await db.migrate.latest();
    const rows = await db("sqlite_master").where({ type: "table" }).select("name");
    const names = rows.map((r: any) => r.name as string);
    for (const table of COMPANY_TABLES) {
      expect(names, `expected table "${table}" to exist`).toContain(table);
    }
  });

  it("Test 5: Tidak ada tabel System DB yang masuk ke Company DB", async () => {
    await db.migrate.latest();
    const rows = await db("sqlite_master").where({ type: "table" }).select("name");
    const names = rows.map((r: any) => r.name as string);
    for (const table of SYSTEM_ONLY_TABLES) {
      expect(names, `table "${table}" is System DB-only and must NOT appear in Company DB`).not.toContain(table);
    }
  });

  it("Test 6: Tabel accounting inti tersedia", async () => {
    await db.migrate.latest();
    const rows = await db("sqlite_master").where({ type: "table" }).select("name");
    const names = rows.map((r: any) => r.name as string);
    for (const table of ["accounts", "account_types", "periods", "journal_entries", "journal_entry_lines"]) {
      expect(names).toContain(table);
    }
  });

  describe("dengan data dasar (account_types seed + 1 account + 1 period)", () => {
    let assetTypeId: string;
    let accountId: string;
    let periodId: string;

    beforeEach(async () => {
      await db.migrate.latest();
      const assetType = await db("account_types").where({ code: "ASSET" }).first();
      assetTypeId = assetType.id;

      accountId = crypto.randomUUID();
      await db("accounts").insert({
        id: accountId,
        code: "1000",
        name: "Kas",
        account_type_id: assetTypeId,
        normal_balance: "debit",
      });

      periodId = crypto.randomUUID();
      await db("periods").insert({
        id: periodId,
        label: "Jan 2026",
        start_date: "2026-01-01",
        end_date: "2026-01-31",
        period_type: "month",
        fiscal_year: 2026,
      });
    });

    it("Test 7: Foreign key enforcement aktif", async () => {
      await expect(
        db("accounts").insert({
          id: crypto.randomUUID(),
          code: "9999",
          name: "Akun tidak valid",
          account_type_id: "account-type-does-not-exist",
          normal_balance: "debit",
        }),
      ).rejects.toThrow();
    });

    it("Test 8: Journal line menunjuk journal_entry yang tidak ada ditolak", async () => {
      await expect(
        db("journal_entry_lines").insert({
          id: crypto.randomUUID(),
          journal_entry_id: "journal-does-not-exist",
          account_id: accountId,
          debit: 100,
          credit: 0,
        }),
      ).rejects.toThrow();
    });

    it("Test 9: Journal line menunjuk account yang tidak ada ditolak", async () => {
      const journalId = crypto.randomUUID();
      await db("journal_entries").insert({
        id: journalId,
        entry_date: "2026-01-05",
        period_id: periodId,
        reference_no: "JRN-000001",
      });

      await expect(
        db("journal_entry_lines").insert({
          id: crypto.randomUUID(),
          journal_entry_id: journalId,
          account_id: "account-does-not-exist",
          debit: 100,
          credit: 0,
        }),
      ).rejects.toThrow();
    });

    it("Test 10: Journal status di luar DRAFT/POSTED/REVERSED/VOID ditolak", async () => {
      await expect(
        db("journal_entries").insert({
          id: crypto.randomUUID(),
          entry_date: "2026-01-05",
          period_id: periodId,
          reference_no: "JRN-000002",
          status: "NOT_A_REAL_STATUS",
        }),
      ).rejects.toThrow();
    });

    it("Test 11: CHECK constraint debit/credit struktural", async () => {
      const journalId = crypto.randomUUID();
      await db("journal_entries").insert({
        id: journalId,
        entry_date: "2026-01-05",
        period_id: periodId,
        reference_no: "JRN-000003",
      });

      // Valid: hanya debit terisi
      await expect(
        db("journal_entry_lines").insert({
          id: crypto.randomUUID(),
          journal_entry_id: journalId,
          account_id: accountId,
          debit: 100,
          credit: 0,
        }),
      ).resolves.toBeDefined();

      // Invalid: debit DAN credit > 0 bersamaan -- harus ditolak CHECK constraint
      await expect(
        db("journal_entry_lines").insert({
          id: crypto.randomUUID(),
          journal_entry_id: journalId,
          account_id: accountId,
          debit: 100,
          credit: 50,
        }),
      ).rejects.toThrow();

      // Invalid: nilai negatif
      await expect(
        db("journal_entry_lines").insert({
          id: crypto.randomUUID(),
          journal_entry_id: journalId,
          account_id: accountId,
          debit: -10,
          credit: 0,
        }),
      ).rejects.toThrow();
    });

    it("Test 12: Reversal FK menunjuk journal_entry yang ada, menolak referensi tidak valid", async () => {
      const originalId = crypto.randomUUID();
      await db("journal_entries").insert({
        id: originalId,
        entry_date: "2026-01-05",
        period_id: periodId,
        reference_no: "JRN-000004",
        status: "POSTED",
      });

      const reversalId = crypto.randomUUID();
      await expect(
        db("journal_entries").insert({
          id: reversalId,
          entry_date: "2026-01-06",
          period_id: periodId,
          reference_no: "JRN-000004-REV",
          status: "REVERSED",
          reversal_of_journal_id: originalId,
          reversal_reason: "Kesalahan input nominal",
        }),
      ).resolves.toBeDefined();

      await expect(
        db("journal_entries").insert({
          id: crypto.randomUUID(),
          entry_date: "2026-01-07",
          period_id: periodId,
          reference_no: "JRN-000005-REV",
          reversal_of_journal_id: "journal-does-not-exist",
        }),
      ).rejects.toThrow();
    });
  });

  it("Test 13: Tabel accounting Company DB tidak punya kolom company_id", async () => {
    await db.migrate.latest();
    const accountingTables = [
      "accounts",
      "periods",
      "counterparties",
      "journal_entries",
      "journal_entry_lines",
      "statement_lines",
      "statement_line_accounts",
      "trial_balance_snapshots",
      "tax_reference_settings",
      "company_audit_log",
    ];
    for (const table of accountingTables) {
      const columns = await db(table).columnInfo();
      expect(Object.keys(columns), `table "${table}" should not have a company_id column`).not.toContain("company_id");
    }
  });
});

describe("Company DB connection factory safety (STEP 24, TASK-DB-ARCH-003)", () => {
  it("Test: menolak membuka file yang bukan company.db", () => {
    expect(() => createCompanyDb(path.join(os.tmpdir(), "not-company.sqlite"))).toThrow(UnsafeCompanyDatabasePathError);
  });

  it("Test: menerima path company.db yang valid", () => {
    const dir = freshTmpDir("terra-company-factory-test-");
    const dbPath = resolveCompanyDatabasePath(dir, "pt-abc");
    expect(path.basename(dbPath)).toBe("company.db");
    const db = createCompanyDb(dbPath);
    expect(db).toBeDefined();
    return db.destroy().finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  });
});

describe("Test 15: Isolasi antar Company DB (sangat penting)", () => {
  it("Company-A dan Company-B tidak saling bocor data", async () => {
    const rootA = freshTmpDir("terra-company-a-");
    const rootB = freshTmpDir("terra-company-b-");
    const pathA = resolveCompanyDatabasePath(rootA, "company-a");
    const pathB = resolveCompanyDatabasePath(rootB, "company-b");
    fs.mkdirSync(path.dirname(pathA), { recursive: true });
    fs.mkdirSync(path.dirname(pathB), { recursive: true });

    const dbA = openCompanyDbAt(pathA);
    const dbB = openCompanyDbAt(pathB);

    try {
      await dbA.migrate.latest();
      await dbB.migrate.latest();

      await dbA("company_profile").insert({ id: crypto.randomUUID(), name: "PT Company A" });
      await dbB("company_profile").insert({ id: crypto.randomUUID(), name: "PT Company B" });

      const rowsA = await dbA("company_profile").select("name");
      const rowsB = await dbB("company_profile").select("name");

      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0].name).toBe("PT Company A");
      expect(rowsB[0].name).toBe("PT Company B");
      expect(rowsA[0].name).not.toBe(rowsB[0].name);

      // Tidak ada mekanisme query lintas file sama sekali -- dbA tidak
      // "melihat" tabel/baris dbB dengan cara apa pun selain membuka
      // koneksi terpisah ke file lain secara eksplisit (yang TIDAK
      // dilakukan di sini), membuktikan isolasi struktural ADR-001 §8.
      expect(pathA).not.toBe(pathB);
    } finally {
      await dbA.destroy();
      await dbB.destroy();
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe("Test 14: Existing production data safety", () => {
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

  it("file existing (kalau ada di mesin ini) tidak disentuh oleh test suite Company DB", () => {
    if (!statBefore) {
      expect(true).toBe(true);
      return;
    }
    expect(fs.existsSync(existingDbPath)).toBe(true);
  });
});
