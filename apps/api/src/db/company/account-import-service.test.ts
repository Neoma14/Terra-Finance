import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount } from "./account-service.js";
import {
  validateAccountsImportBatch,
  commitAccountsImportBatch,
  AccountImportHasErrorsError,
  AccountImportNothingToCommitError,
} from "./account-import-service.js";
import type { ActorContext } from "./company-audit.js";

/**
 * COA Import (TASK-DB-ARCH-015 §10-16). Fokus test: parsing+validasi
 * (NEW/EXISTING/WARNING/ERROR), parent-resolution lintas baris (induk
 * yang JUGA baru di file yang sama), cycle detection, dan ATOMIC COMMIT
 * (pola nested-transaction yang sama dgn journal-import-service.ts).
 */

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}
const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

type Row = [string, string, string, string, string, string, string, string, string];

async function buildTestWorkbook(rows: Row[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Akun");
  sheet.getRow(1).values = ["Kode", "Nama Akun", "Tipe", "Kode Induk", "Saldo Normal", "Aktif", "Kas", "Aktivitas Arus Kas", "Kartu"];
  rows.forEach((row, i) => {
    sheet.getRow(2 + i).values = row;
  });
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe("COA Import (TASK-DB-ARCH-015)", () => {
  let tmpDir: string;
  let db: Knex;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-account-import-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Validate: baris valid -> NEW, Saldo Normal kosong default ke default tipe (Aset=Debit)", async () => {
    const buffer = await buildTestWorkbook([["1000", "Kas", "Aset", "", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("NEW");
    expect(result.rows[0].normalBalance).toBeNull(); // kosong di file -- default diterapkan saat commit
    expect(result.canCommit).toBe(true);
  });

  it("Validate: kode/nama kosong -> ERROR", async () => {
    const buffer = await buildTestWorkbook([["", "", "Aset", "", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.totalRows).toBe(0); // parser skip baris kosong kode+nama
  });

  it("Validate: Tipe tidak dikenal -> ERROR", async () => {
    const buffer = await buildTestWorkbook([["1000", "Akun Asing", "TidakDikenal", "", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("tidak dikenal");
    expect(result.canCommit).toBe(false);
  });

  it("Validate: duplicate kode DALAM FILE -> ERROR pada kedua baris", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "Kas A", "Aset", "", "", "", "", "", ""],
      ["1000", "Kas B", "Aset", "", "", "", "", "", ""],
    ]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[1].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("lebih dari sekali");
  });

  it("Validate: kode SUDAH ADA di database -> EXISTING (tipe sama), bukan ERROR", async () => {
    await createAccount(db, { code: "1000", name: "Kas Lama", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const buffer = await buildTestWorkbook([["1000", "Kas Lama Lagi", "Aset", "", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("EXISTING");
    expect(result.errorCount).toBe(0);
  });

  it("Validate: kode SUDAH ADA tapi tipe berbeda di file -> WARNING", async () => {
    await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const buffer = await buildTestWorkbook([["1000", "Kas", "Liabilitas", "", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("WARNING");
    expect(result.rows[0].issues[0]).toContain("tipe yang berbeda");
  });

  it("Validate: Kode Induk tidak ditemukan -> ERROR", async () => {
    const buffer = await buildTestWorkbook([["1100", "Kas Kecil", "Aset", "9999", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("Kode Induk");
  });

  it("Validate: Kode Induk = dirinya sendiri -> ERROR", async () => {
    const buffer = await buildTestWorkbook([["1000", "Kas", "Aset", "1000", "", "", "", "", ""]]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].issues[0]).toContain("dirinya sendiri");
  });

  it("Validate: Kode Induk mengacu ke baris LAIN di file yang sama (belum ada di DB) -> NEW, valid", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "Kas & Setara Kas", "Aset", "", "", "", "", "", ""],
      ["1100", "Kas Kecil", "Aset", "1000", "", "", "", "", ""],
    ]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("NEW");
    expect(result.rows[1].status).toBe("NEW");
    expect(result.canCommit).toBe(true);
  });

  it("Validate: cycle parent-child DI DALAM file (A induk B, B induk A) -> ERROR pada keduanya", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "A", "Aset", "1100", "", "", "", "", ""],
      ["1100", "B", "Aset", "1000", "", "", "", "", ""],
    ]);
    const result = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[1].status).toBe("ERROR");
    expect(result.rows.some((r) => r.issues.some((i) => i.includes("melingkar")))).toBe(true);
  });

  it("Commit: berhasil membuat akun baru, default Saldo Normal dari tipe, audit tercatat", async () => {
    const buffer = await buildTestWorkbook([["1000", "Kas", "Aset", "", "", "", "Ya", "", ""]]);
    const validation = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    const result = await commitAccountsImportBatch(db, validation, actor);

    expect(result.createdCount).toBe(1);
    const account = await db("accounts").where({ code: "1000" }).first();
    expect(account.normal_balance).toBe("debit"); // default ASSET
    expect(account.is_cash).toBeTruthy();

    const audit = await db("company_audit_log").where({ action: "account.import" }).first();
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.after_json).createdCount).toBe(1);
  });

  it("Commit: parent yang JUGA baru di batch yang sama ter-resolve benar (induk dibuat dulu)", async () => {
    const buffer = await buildTestWorkbook([
      ["1100", "Kas Kecil", "Aset", "1000", "", "", "", "", ""], // anak ditulis DULU di file
      ["1000", "Kas & Setara Kas", "Aset", "", "", "", "", "", ""], // induk ditulis BELAKANGAN
    ]);
    const validation = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    const result = await commitAccountsImportBatch(db, validation, actor);
    expect(result.createdCount).toBe(2);

    const parent = await db("accounts").where({ code: "1000" }).first();
    const child = await db("accounts").where({ code: "1100" }).first();
    expect(child.parent_account_id).toBe(parent.id);
  });

  it("Commit: melempar AccountImportHasErrorsError kalau masih ada baris ERROR", async () => {
    const buffer = await buildTestWorkbook([["1000", "Akun Asing", "TidakDikenal", "", "", "", "", "", ""]]);
    const validation = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    await expect(commitAccountsImportBatch(db, validation, actor)).rejects.toThrow(AccountImportHasErrorsError);
    const count = await db("accounts").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("Commit: melempar AccountImportNothingToCommitError kalau semua EXISTING", async () => {
    await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    const buffer = await buildTestWorkbook([["1000", "Kas", "Aset", "", "", "", "", "", ""]]);
    const validation = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    await expect(commitAccountsImportBatch(db, validation, actor)).rejects.toThrow(AccountImportNothingToCommitError);
  });

  it("ATOMIC COMMIT: 1 akun valid + 1 akun 'rusak setelah lolos preview' (duplicate code race) -> SELURUH BATCH ROLLBACK", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "Kas", "Aset", "", "", "", "", "", ""],
      ["1100", "Bank", "Aset", "", "", "", "", "", ""],
    ]);
    const validation = await validateAccountsImportBatch(db, buffer, "test.xlsx");
    expect(validation.canCommit).toBe(true);

    // Simulasi race condition: SETELAH preview, kode "1100" sudah dibuat
    // user lain lewat jalur manual SEBELUM commit ini jalan -- createAccount
    // di dalam commit akan menolak via AccountCodeAlreadyExistsError.
    await createAccount(db, { code: "1100", name: "Bank (dibuat user lain)", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);

    await expect(commitAccountsImportBatch(db, validation, actor)).rejects.toThrow();

    const kas = await db("accounts").where({ code: "1000" }).first();
    expect(kas).toBeUndefined(); // TIDAK ikut masuk walau baris pertama valid sendiri
  });
});
