import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyProfileRoutes } from "./routes.js";
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

/** TASK-023 §3/§13 -- Company Profile ("Perusahaan"/"Pengaturan"), matrix
 * wajib sama dgn module company-db lain: auth/permission/company isolation. */

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

async function createCompany(slug: string, name: string): Promise<{ db: Knex; companyId: string }> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();
  await db("company_profile").insert({ id: crypto.randomUUID(), name, currency: "IDR", fiscal_year_start_month: 1 });

  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({ id: companyId, slug, name, database_path: dbPath, status: "active", schema_version: 12, last_migration_status: "READY" });
  return { db, companyId };
}

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole) {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId, role });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(companyProfileRoutes);
  return app;
}

describe("Company Profile API (TASK-023)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;
  let viewer: TestUser;

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
    slug = `profile-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug, "PT Contoh Sejahtera");
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Profile");
    viewer = await createTestUserAndToken("Viewer Profile");
    await grantAccess(owner, companyId, "OWNER");
    await grantAccess(viewer, companyId, "VIEWER");
  });

  afterEach(async () => {
    await companyDb.destroy();
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
  });

  it("GET profile -- 401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/profile` });
    expect(res.statusCode).toBe(401);
  });

  it("GET profile -- 200 utk VIEWER (company.read dimiliki semua role)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/profile`, cookies: { [SESSION_COOKIE]: viewer.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.name).toBe("PT Contoh Sejahtera");
  });

  it("GET profile -- 404 generic kalau user tidak punya company_access (anti-enumeration, company isolation)", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/profile`, cookies: { [SESSION_COOKIE]: stranger.token } });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH profile -- OWNER berhasil update alamat & currency, audit tercatat", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/profile`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { address: "Jl. Sudirman No. 1", city: "Jakarta", currency: "IDR" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.address).toBe("Jl. Sudirman No. 1");

    const audit = await companyDb("company_audit_log").where({ action: "company_profile.change" }).first();
    expect(audit).toBeDefined();
  });

  it("PATCH profile -- VIEWER (tanpa company.update) ditolak 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/profile`,
      cookies: { [SESSION_COOKIE]: viewer.token },
      payload: { address: "Coba Ubah" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH profile -- nama kosong ditolak 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/profile`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH profile -- fiscalYearStartMonth di luar 1-12 ditolak 400 (validasi schema)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/profile`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { fiscalYearStartMonth: 13 },
    });
    expect(res.statusCode).toBe(400);
  });
});
