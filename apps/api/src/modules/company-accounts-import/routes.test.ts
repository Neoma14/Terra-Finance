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
import { companyAccountsImportRoutes } from "./routes.js";
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
  app.register(companyAccountsImportRoutes);
  return app;
}

type Row = [string, string, string, string, string, string, string, string, string];

async function buildTestWorkbookFormData(rows: Row[], filename = "akun.xlsx"): Promise<FormData> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Akun");
  sheet.getRow(1).values = ["Kode", "Nama Akun", "Tipe", "Kode Induk", "Saldo Normal", "Aktif", "Kas", "Aktivitas Arus Kas", "Kartu"];
  rows.forEach((row, i) => sheet.getRow(2 + i).values = row);
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  return fd;
}

describe("COA Import API (TASK-DB-ARCH-015)", () => {
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
    slug = `coa-import-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner COA Import");
    await grantAccess(owner, companyId, "OWNER");
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("GET accounts-import/template -- 200, xlsx sheet Akun+Referensi", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/accounts-import/template`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    expect(workbook.getWorksheet("Akun")).toBeDefined();
    expect(workbook.getWorksheet("Referensi")).toBeDefined();
  });

  it("POST accounts-import/preview -- 200, baris baru NEW, canCommit true", async () => {
    const fd = await buildTestWorkbookFormData([["1000", "Kas", "Aset", "", "", "", "Ya", "", ""]]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/preview`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(200);
    expect(res.json().newCount).toBe(1);
    expect(res.json().canCommit).toBe(true);
  });

  it("POST accounts-import/preview -- TIDAK menulis apa pun ke DB", async () => {
    const fd = await buildTestWorkbookFormData([["1000", "Kas", "Aset", "", "", "", "", "", ""]]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/preview`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    const account = await companyDb("accounts").where({ code: "1000" }).first();
    expect(account).toBeUndefined();
  });

  it("POST accounts-import/commit -- OWNER berhasil, akun masuk DB, audit account.import tercatat", async () => {
    const fd = await buildTestWorkbookFormData([["1000", "Kas", "Aset", "", "", "", "Ya", "", ""]]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(200);
    expect(res.json().createdCount).toBe(1);

    const account = await companyDb("accounts").where({ code: "1000" }).first();
    expect(account).toBeDefined();
    const audit = await companyDb("company_audit_log").where({ action: "account.import" }).first();
    expect(audit).toBeDefined();
  });

  it("POST accounts-import/commit -- 400 kalau ada baris ERROR", async () => {
    const fd = await buildTestWorkbookFormData([["1000", "Akun Asing", "TidakDikenal", "", "", "", "", "", ""]]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(400);
    const account = await companyDb("accounts").where({ code: "1000" }).first();
    expect(account).toBeUndefined();
  });

  it("POST accounts-import/commit -- VIEWER (tanpa account.create) DITOLAK 403", async () => {
    const viewer = await createTestUserAndToken("Viewer COA Import");
    await grantAccess(viewer, companyId, "VIEWER");
    const fd = await buildTestWorkbookFormData([["1000", "Kas", "Aset", "", "", "", "", "", ""]]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/commit`, cookies: { [SESSION_COOKIE]: viewer.token }, payload: fd });
    expect(res.statusCode).toBe(403);
  });

  it("Unauthenticated -> 401", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/accounts-import/template` });
    expect(res.statusCode).toBe(401);
  });

  it("GET accounts-import/history -- menampilkan batch yang sudah di-commit", async () => {
    const fd = await buildTestWorkbookFormData([["1000", "Kas", "Aset", "", "", "", "", "", ""]]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/accounts-import/history`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().history).toHaveLength(1);
    expect(res.json().history[0].createdCount).toBe(1);
  });

  it("Company isolation -- history Company B tidak terpengaruh import Company A", async () => {
    const fd = await buildTestWorkbookFormData([["1000", "Kas", "Aset", "", "", "", "", "", ""]]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/accounts-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });

    const slugB = `coa-import-b-${crypto.randomUUID().slice(0, 8)}`;
    const companyB = await createCompany(slugB);
    await grantAccess(owner, companyB.companyId, "OWNER");
    try {
      const res = await app.inject({ method: "GET", url: `/api/company-db/${slugB}/accounts-import/history`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(res.json().history).toHaveLength(0);
    } finally {
      await companyB.db.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slugB), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyB.companyId }).del();
      await systemDb("companies_registry").where({ id: companyB.companyId }).del();
    }
  });
});
