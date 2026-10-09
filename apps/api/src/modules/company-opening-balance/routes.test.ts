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
import { companyOpeningBalanceRoutes } from "./routes.js";
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
  app.register(attachAuthUser);
  app.register(companyOpeningBalanceRoutes);
  return app;
}

describe("Opening Balance API (TASK-DB-ARCH-016)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;
  let kasId: string;
  let modalId: string;
  let periodId: string;

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
    slug = `ob-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner OB");
    await grantAccess(owner, companyId, "OWNER");

    const assetType = await companyDb("account_types").where({ code: "ASSET" }).first();
    const equityType = await companyDb("account_types").where({ code: "EQUITY" }).first();
    kasId = crypto.randomUUID();
    await companyDb("accounts").insert({ id: kasId, code: "1000", name: "Kas", account_type_id: assetType.id, normal_balance: "debit" });
    modalId = crypto.randomUUID();
    await companyDb("accounts").insert({ id: modalId, code: "3000", name: "Modal", account_type_id: equityType.id, normal_balance: "credit" });
    periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  function balancedLines() {
    return [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ];
  }

  it("GET -- belum ada, exists=false", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().exists).toBe(false);
  });

  it("POST -- OWNER berhasil create DRAFT", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/opening-balance`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("DRAFT");
  });

  it("POST -- STAFF (tanpa journal.create) DITOLAK 403", async () => {
    const viewer = await createTestUserAndToken("Viewer OB");
    await grantAccess(viewer, companyId, "VIEWER");
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/opening-balance`,
      cookies: { [SESSION_COOKIE]: viewer.token },
      payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST -- tidak balance -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/opening-balance`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { entryDate: "2026-01-01", periodId, lines: [{ accountId: kasId, debit: 1_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 900_000 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST -- sudah ada yang aktif -> 409", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-02", periodId, lines: balancedLines() } });
    expect(res.statusCode).toBe(409);
  });

  it("PUT -- edit DRAFT berhasil", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });
    const res = await app.inject({
      method: "PUT",
      url: `/api/company-db/${slug}/opening-balance`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { entryDate: "2026-01-05", periodId, lines: [{ accountId: kasId, debit: 2_000_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 2_000_000 }] },
    });
    expect(res.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(getRes.json().totalDebit).toBe(2_000_000);
  });

  it("DELETE -- hapus DRAFT berhasil", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });
    const res = await app.inject({ method: "DELETE", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const getRes = await app.inject({ method: "GET", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(getRes.json().exists).toBe(false);
  });

  it("POST /post -- OWNER berhasil posting, lalu DELETE ditolak 409", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });
    const postRes = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance/post`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(postRes.statusCode).toBe(200);

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(deleteRes.statusCode).toBe(409);
  });

  it("POST /post -- STAFF (journal.create TANPA journal.post) DITOLAK 403", async () => {
    const staff = await createTestUserAndToken("Staff OB");
    await grantAccess(staff, companyId, "STAFF");
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: staff.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });

    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance/post`, cookies: { [SESSION_COOKIE]: staff.token } });
    expect(res.statusCode).toBe(403);
  });

  it("POST /reverse -- OWNER berhasil, lalu bisa create opening balance baru", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance/post`, cookies: { [SESSION_COOKIE]: owner.token } });

    const reverseRes = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/opening-balance/reverse`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { targetPeriodId: periodId, reason: "Koreksi" },
    });
    expect(reverseRes.statusCode).toBe(200);

    const newRes = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/opening-balance`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { entryDate: "2026-01-10", periodId, lines: balancedLines() },
    });
    expect(newRes.statusCode).toBe(201);
  });

  it("Unauthenticated -> 401", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/opening-balance` });
    expect(res.statusCode).toBe(401);
  });

  it("Company isolation -- opening balance Company A tidak terlihat dari Company B", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { entryDate: "2026-01-01", periodId, lines: balancedLines() } });

    const slugB = `ob-b-${crypto.randomUUID().slice(0, 8)}`;
    const companyB = await createCompany(slugB);
    await grantAccess(owner, companyB.companyId, "OWNER");
    try {
      const res = await app.inject({ method: "GET", url: `/api/company-db/${slugB}/opening-balance`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(res.json().exists).toBe(false);
    } finally {
      await companyB.db.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slugB), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyB.companyId }).del();
      await systemDb("companies_registry").where({ id: companyB.companyId }).del();
    }
  });
});
