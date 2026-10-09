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
import { companyPeriodsRoutes } from "./routes.js";
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
  app.register(companyPeriodsRoutes);
  return app;
}

describe("Period Lifecycle API (TASK-DB-ARCH-011 Part B)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;
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
    slug = `periods-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Periods");
    await grantAccess(owner, companyId, "OWNER");

    periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("GET periods -- list berhasil", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/periods`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().periods).toHaveLength(1);
  });

  it("POST periods -- TASK-023 hotfix: OWNER berhasil membuat periode baru, audit 'period.create' tercatat", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/periods`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { label: "Feb 2026", startDate: "2026-02-01", endDate: "2026-02-28", periodType: "month", fiscalYear: 2026 },
    });
    expect(res.statusCode).toBe(201);
    const audit = await companyDb("company_audit_log").where({ action: "period.create" }).first();
    expect(audit).toBeDefined();
  });

  it("POST periods -- ACCOUNTANT (tanpa company.update) DITOLAK 403", async () => {
    const accountant = await createTestUserAndToken("Accountant Create Period");
    await grantAccess(accountant, companyId, "ACCOUNTANT");
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/periods`,
      cookies: { [SESSION_COOKIE]: accountant.token },
      payload: { label: "Mar 2026", startDate: "2026-03-01", endDate: "2026-03-31", periodType: "month", fiscalYear: 2026 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST periods -- overlap dgn periode existing (Jan 2026) ditolak 409, tidak membuat data ambigu", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/periods`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { label: "Jan 2026 Duplikat", startDate: "2026-01-15", endDate: "2026-02-15", periodType: "month", fiscalYear: 2026 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST periods/generate-monthly -- TASK-023 hotfix: bikin periode 2023-2026 sekaligus (kasus nyata user: import historis bertahun-tahun), idempotent thd periode yang sudah ada", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/periods/generate-monthly`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { fromDate: "2023-01-01", toDate: "2024-03-31" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(15); // Jan 2023 - Mar 2024 = 15 bulan
    expect(body.skipped).toBe(0); // tidak overlap dgn "Jan 2026" yang sudah ada

    const list = await app.inject({ method: "GET", url: `/api/company-db/${slug}/periods`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(list.json().periods).toHaveLength(16); // 15 baru + 1 existing

    // Jalankan lagi dgn rentang yang SAMA -- harus idempotent (semua skip, bukan error/duplikat)
    const retry = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/periods/generate-monthly`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { fromDate: "2023-01-01", toDate: "2024-03-31" },
    });
    expect(retry.json().created).toBe(0);
    expect(retry.json().skipped).toBe(15);
  });

  it("POST :id/lock -- OWNER (company.update) berhasil", async () => {
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/periods/${periodId}/lock`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const period = await companyDb("periods").where({ id: periodId }).first();
    expect(period.status).toBe("LOCKED");
  });

  it("POST :id/lock -- ACCOUNTANT (tanpa company.update) DITOLAK 403", async () => {
    const accountant = await createTestUserAndToken("Accountant Periods");
    await grantAccess(accountant, companyId, "ACCOUNTANT");

    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/periods/${periodId}/lock`, cookies: { [SESSION_COOKIE]: accountant.token } });
    expect(res.statusCode).toBe(403);
  });

  it("POST :id/close -- ditolak sebelum LOCKED (409 InvalidPeriodTransition)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/periods/${periodId}/close`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(409);
  });

  it("GET :id/closing-check -- melaporkan issues tanpa mengubah status", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/periods/${periodId}/lock`, cookies: { [SESSION_COOKIE]: owner.token } });
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/periods/${periodId}/closing-check`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().canClose).toBe(true); // nol jurnal, trial balance kosong = balanced
  });

  it("Lock lalu Close berurutan -- berhasil, status akhir CLOSED", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/periods/${periodId}/lock`, cookies: { [SESSION_COOKIE]: owner.token } });
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/periods/${periodId}/close`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const period = await companyDb("periods").where({ id: periodId }).first();
    expect(period.status).toBe("CLOSED");
  });
});
