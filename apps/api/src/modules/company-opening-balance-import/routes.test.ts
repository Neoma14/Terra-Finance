import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import multipart from "@fastify/multipart";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyOpeningBalanceImportRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess } from "../../db/system/company-access.js";
import type { CompanyRole } from "../../db/system/rbac.js";

async function migrateMasterDb(): Promise<void> {
  const db = knexLib(masterKnexfile);
  try { await db.migrate.latest(); } finally { await db.destroy(); }
}
async function migrateSystemDb(): Promise<void> {
  const db = knexLib(systemKnexfile);
  try { await db.migrate.latest(); } finally { await db.destroy(); }
}

interface TestUser { id: string; email: string; fullName: string; token: string }

async function createTestUserAndToken(label: string): Promise<TestUser> {
  const userId = crypto.randomUUID();
  const email = `${userId}@test.local`;
  await masterDb("users").insert({ id: userId, email, password_hash: "x", full_name: label, role: "admin" });
  const { token } = await createSession(userId, {});
  return { id: userId, email, fullName: label, token };
}

async function createCompany(slug: string): Promise<{ db: Knex; companyId: string }> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();
  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({ id: companyId, slug, name: slug, database_path: dbPath, status: "active", schema_version: 12, last_migration_status: "READY" });
  return { db, companyId };
}

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole) {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId, role });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(multipart);
  app.register(attachAuthUser);
  app.register(companyOpeningBalanceImportRoutes);
  return app;
}

type Row = [string, string, number | null, number | null, string];

async function buildTestWorkbookFormData(openingDate: string, rows: Row[], filename = "saldo-awal.xlsx"): Promise<FormData> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Saldo Awal");
  sheet.getCell("A3").value = "Tanggal Saldo Awal:";
  sheet.getCell("B3").value = openingDate;
  sheet.getRow(5).values = ["Kode Akun", "Nama Akun", "Debet", "Kredit", "Keterangan"];
  rows.forEach((row, i) => sheet.getRow(6 + i).values = row);
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  return fd;
}

describe("Opening Balance Import API (TASK-DB-ARCH-016)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;

  beforeAll(async () => {
    await migrateMasterDb();
    await migrateSystemDb();
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  beforeEach(async () => {
    slug = `ob-import-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner OB Import");
    await grantAccess(owner, companyId, "OWNER");

    const assetType = await companyDb("account_types").where({ code: "ASSET" }).first();
    const equityType = await companyDb("account_types").where({ code: "EQUITY" }).first();
    await companyDb("accounts").insert({ id: crypto.randomUUID(), code: "1000", name: "Kas", account_type_id: assetType.id, normal_balance: "debit" });
    await companyDb("accounts").insert({ id: crypto.randomUUID(), code: "3000", name: "Modal", account_type_id: equityType.id, normal_balance: "credit" });
    await companyDb("periods").insert({ id: crypto.randomUUID(), label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("GET template -- 200, xlsx sheet Saldo Awal + Daftar Akun", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/opening-balance-import/template`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    expect(workbook.getWorksheet("Saldo Awal")).toBeDefined();
    expect(workbook.getWorksheet("Daftar Akun")).toBeDefined();
  });

  it("POST preview -- 200, balance, canCommit true", async () => {
    const fd = await buildTestWorkbookFormData("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance-import/preview`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(200);
    expect(res.json().canCommit).toBe(true);
    expect(res.json().isBalanced).toBe(true);
  });

  it("POST preview -- TIDAK menulis apa pun ke DB", async () => {
    const fd = await buildTestWorkbookFormData("2026-01-01", [["1000", "Kas", 1_000_000, null, ""]]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance-import/preview`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    const count = await companyDb("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("POST commit -- OWNER berhasil, entry POSTED", async () => {
    const fd = await buildTestWorkbookFormData("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(200);

    const entry = await companyDb("journal_entries").where({ id: res.json().id }).first();
    expect(entry.status).toBe("POSTED");
    expect(entry.is_opening_balance).toBeTruthy();
  });

  it("POST commit -- 400 kalau tidak balance", async () => {
    const fd = await buildTestWorkbookFormData("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 900_000, ""],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(400);
  });

  it("POST commit -- STAFF (journal.create TANPA journal.post) DITOLAK 403", async () => {
    const staff = await createTestUserAndToken("Staff OB Import");
    await grantAccess(staff, companyId, "STAFF");
    const fd = await buildTestWorkbookFormData("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance-import/commit`, cookies: { [SESSION_COOKIE]: staff.token }, payload: fd });
    expect(res.statusCode).toBe(403);
    const count = await companyDb("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("Unauthenticated -> 401", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/opening-balance-import/template` });
    expect(res.statusCode).toBe(401);
  });

  it("Company isolation -- commit Company A tidak membuat opening balance di Company B", async () => {
    const fd = await buildTestWorkbookFormData("2026-01-01", [
      ["1000", "Kas", 1_000_000, null, ""],
      ["3000", "Modal", null, 1_000_000, ""],
    ]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });

    const slugB = `ob-import-b-${crypto.randomUUID().slice(0, 8)}`;
    const companyB = await createCompany(slugB);
    await grantAccess(owner, companyB.companyId, "OWNER");
    try {
      const count = await companyB.db("journal_entries").count<{ count: string }>({ count: "*" }).first();
      expect(Number(count?.count ?? 0)).toBe(0);
    } finally {
      await companyB.db.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slugB), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyB.companyId }).del();
      await systemDb("companies_registry").where({ id: companyB.companyId }).del();
    }
  });
});
