import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount, updateAccount } from "./account-service.js";
import { validateOpeningBalanceImportBatch, commitOpeningBalanceImportBatch, OpeningBalanceImportHasErrorsError } from "./opening-balance-import-service.js";
import { createOpeningBalanceEntry } from "./opening-balance-service.js";
import type { ActorContext } from "./company-audit.js";

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}
const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

async function seedPeriod(db: Knex, label: string, startDate: string, endDate: string, status: "OPEN" | "LOCKED" | "CLOSED" = "OPEN"): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({ id, label, start_date: startDate, end_date: endDate, period_type: "month", fiscal_year: 2026, status });
  return id;
}

type Row = [string, string, number | null, number | null, string];

async function buildTestWorkbook(openingDate: string | null, rows: Row[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Saldo Awal");
  sheet.getCell("A3").value = "Tanggal Saldo Awal:";
  if (openingDate) sheet.getCell("B3").value = openingDate;
  sheet.getRow(5).values = ["Kode Akun", "Nama Akun", "Debet", "Kredit", "Keterangan"];
  rows.forEach((row, i) => {
    sheet.getRow(6 + i).values = row;
  });
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe("Opening Balance Import (TASK-DB-ARCH-016)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-opening-balance-import-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Validate: file valid -> seluruh baris VALID, canCommit true", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.rows.every((r) => r.status === "VALID")).toBe(true);
    expect(result.isBalanced).toBe(true);
    expect(result.canCommit).toBe(true);
    expect(result.periodId).toBe(periodId);
  });

  it("Validate: tidak balance -> fileErrors berisi 'is not balanced', canCommit false", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 900_000, ""],
    ]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.isBalanced).toBe(false);
    expect(result.fileErrors.some((e) => e.toLowerCase().includes("not balanced"))).toBe(true);
    expect(result.canCommit).toBe(false);
  });

  it("Validate: Tanggal Saldo Awal kosong -> fileErrors, canCommit false", async () => {
    const buffer = await buildTestWorkbook(null, [["1000", "Kas", 1_000_000, null, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.fileErrors.length).toBeGreaterThan(0);
    expect(result.canCommit).toBe(false);
  });

  it("Validate: tanggal tanpa periode -> fileErrors (periode TIDAK di-auto-create)", async () => {
    const buffer = await buildTestWorkbook("2026-06-01", [["1000", "Kas", 1_000_000, null, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.fileErrors.some((e) => e.includes("belum ada"))).toBe(true);
    expect(result.periodId).toBeNull();
  });

  it("Validate: periode LOCKED -> fileErrors", async () => {
    await seedPeriod(db, "Feb 2026", "2026-02-01", "2026-02-28", "LOCKED");
    const buffer = await buildTestWorkbook("2026-02-01", [["1000", "Kas", 1_000_000, null, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.fileErrors.some((e) => e.includes("LOCKED"))).toBe(true);
  });

  it("Validate: akun tidak ditemukan -> ERROR per baris", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [["9999", "Asing", 1_000_000, null, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("tidak ditemukan");
  });

  it("Validate: akun nonaktif -> ERROR", async () => {
    await updateAccount(db, kasId, { isActive: false }, actor);
    const buffer = await buildTestWorkbook("2026-01-01", [["1000", "Kas", 1_000_000, null, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("tidak aktif");
  });

  it("Validate: Debit DAN Kredit sekaligus -> ERROR", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [["1000", "Kas", 1_000_000, 1_000_000, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("bersamaan");
  });

  it("Validate: nilai negatif -> ERROR", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [["1000", "Kas", -1_000_000, null, ""]]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("negatif");
  });

  it("Validate: duplicate kode akun DALAM FILE -> ERROR pada kedua baris", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 500_000, null, ""],
      ["1000", "Kas", 500_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[1].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("lebih dari sekali");
  });

  it("Validate: akun kontra (saldo normal berbeda dari arah pengisian) -> WARNING, bukan ERROR", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", 1_000_000, null, ""], // EQUITY normal credit, diisi di Debit -- kontra, bukan salah
    ]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    const modalRow = result.rows.find((r) => r.code === "3000")!;
    expect(modalRow.status).toBe("WARNING");
    expect(modalRow.issues[0]).toContain("kontra");
    expect(result.errorCount).toBe(0);
  });

  it("Validate: opening balance SUDAH ADA -> fileErrors, canCommit false", async () => {
    await createOpeningBalanceEntry(db, { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 500_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 500_000 }] }, actor);

    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const result = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(result.fileErrors.some((e) => e.includes("sudah ada"))).toBe(true);
    expect(result.canCommit).toBe(false);
  });

  it("Commit: berhasil, entry POSTED, audit 'opening_balance.import' tercatat", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, "Saldo awal kas"],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const validation = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    const result = await commitOpeningBalanceImportBatch(db, validation, actor);

    const entry = await db("journal_entries").where({ id: result.id }).first();
    expect(entry.status).toBe("POSTED");
    expect(entry.is_opening_balance).toBeTruthy();

    const audit = await db("company_audit_log").where({ action: "opening_balance.import" }).first();
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.after_json).fileName).toBe("test.xlsx");
  });

  it("Commit: melempar OpeningBalanceImportHasErrorsError kalau tidak balance", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 900_000, ""],
    ]);
    const validation = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    await expect(commitOpeningBalanceImportBatch(db, validation, actor)).rejects.toThrow(OpeningBalanceImportHasErrorsError);
    const count = await db("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("ATOMIC COMMIT (§17): akun jadi nonaktif SETELAH preview (race condition) -> SELURUH BATCH ROLLBACK, nol baris masuk", async () => {
    const buffer = await buildTestWorkbook("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const validation = await validateOpeningBalanceImportBatch(db, buffer, "test.xlsx");
    expect(validation.canCommit).toBe(true); // lolos preview

    await updateAccount(db, modalId, { isActive: false }, actor); // race condition setelah preview

    await expect(commitOpeningBalanceImportBatch(db, validation, actor)).rejects.toThrow();

    const entryCount = await db("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(entryCount?.count ?? 0)).toBe(0);
    const lineCount = await db("journal_entry_lines").count<{ count: string }>({ count: "*" }).first();
    expect(Number(lineCount?.count ?? 0)).toBe(0);
    const auditCount = await db("company_audit_log").where({ action: "opening_balance.import" }).count<{ count: string }>({ count: "*" }).first();
    expect(Number(auditCount?.count ?? 0)).toBe(0); // audit import TIDAK ikut tercatat kalau commit gagal
  });
});
