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
import { companyAuditLogRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess } from "../../db/system/company-access.js";
import { createAccount } from "../../db/company/account-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
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
  app.register(attachAuthUser);
  app.register(companyAuditLogRoutes);
  return app;
}

const actor: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };

describe("Audit Log API (TASK-023 §14)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;
  let staff: TestUser;

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
    slug = `audit-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Audit");
    staff = await createTestUserAndToken("Staff Audit");
    await grantAccess(owner, companyId, "OWNER");
    await grantAccess(staff, companyId, "STAFF");

    // Memicu entry audit nyata (account.create) -- bukan insert manual ke
    // company_audit_log, supaya test mencerminkan jalur produksi sungguhan.
    await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor);
    await createAccount(companyDb, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor);
  });

  afterEach(async () => {
    await companyDb.destroy();
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
  });

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/audit-log` });
    expect(res.statusCode).toBe(401);
  });

  it("404 kalau user tidak punya company_access (company isolation)", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/audit-log`, cookies: { [SESSION_COOKIE]: stranger.token } });
    expect(res.statusCode).toBe(404);
  });

  it("STAFF (tanpa users.manage) ditolak 403 -- audit log hanya utk ADMIN/OWNER", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/audit-log`, cookies: { [SESSION_COOKIE]: staff.token } });
    expect(res.statusCode).toBe(403);
  });

  it("200 utk OWNER -- entry nyata dari account.create tampil, terurut terbaru dulu", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/audit-log`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.entries.some((e: any) => e.action === "account.create")).toBe(true);
    // terbaru dulu: entry pertama createdAt >= entry kedua
    expect(new Date(body.entries[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(body.entries[1].createdAt).getTime());
  });

  it("pagination -- pageSize=1 mengembalikan 1 entry walau total lebih banyak", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/audit-log?pageSize=1&page=1`, cookies: { [SESSION_COOKIE]: owner.token } });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("read-only -- tidak ada endpoint POST/PATCH/DELETE terdaftar utk audit-log", async () => {
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/audit-log`, cookies: { [SESSION_COOKIE]: owner.token }, payload: {} });
    expect(res.statusCode).toBe(404); // route tidak terdaftar sama sekali
  });
});
