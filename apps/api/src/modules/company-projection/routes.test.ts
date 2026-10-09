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
import { companyProjectionRoutes } from "./routes.js";
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
import { createDraftJournalEntry, postJournalEntry } from "../../db/company/journal-service.js";
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
  app.register(companyProjectionRoutes);
  return app;
}

const actor: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };

describe("Projection API (TASK-023 §11)", () => {
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
    slug = `projection-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Projection");
    await grantAccess(owner, companyId, "OWNER");
  });

  afterEach(async () => {
    await companyDb.destroy();
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
  });

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/projection?asOfDate=2026-06-30` });
    expect(res.statusCode).toBe(401);
  });

  it("404 kalau user tidak punya company_access (company isolation)", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/projection?asOfDate=2026-06-30`, cookies: { [SESSION_COOKIE]: stranger.token } });
    expect(res.statusCode).toBe(404);
  });

  it("company baru tanpa transaksi -- sufficientData false, 'Belum cukup data' (bukan angka fiktif)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/projection?asOfDate=2026-06-30`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sufficientData).toBe(false);
    expect(body.projected).toEqual([]);
    expect(body.method).toContain("belum cukup");
  });

  it("dua bulan historis dgn revenue nyata -- proyeksi dihasilkan dari tren historis, method dijelaskan transparan", async () => {
    const kasId = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    const revenueId = (await createAccount(companyDb, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;

    const periodMay = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodMay, label: "Mei 2026", start_date: "2026-05-01", end_date: "2026-05-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
    const periodJune = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodJune, label: "Jun 2026", start_date: "2026-06-01", end_date: "2026-06-30", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    const may = await createDraftJournalEntry(companyDb, { entryDate: "2026-05-10", periodId: periodMay, referenceNo: "JRN-MAY", lines: [
      { accountId: kasId, debit: 100_000, credit: 0 },
      { accountId: revenueId, debit: 0, credit: 100_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: may.id }, actor);

    const june = await createDraftJournalEntry(companyDb, { entryDate: "2026-06-10", periodId: periodJune, referenceNo: "JRN-JUN", lines: [
      { accountId: kasId, debit: 150_000, credit: 0 },
      { accountId: revenueId, debit: 0, credit: 150_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: june.id }, actor);

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/projection?asOfDate=2026-06-30&monthsAhead=2`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sufficientData).toBe(true);
    expect(body.projected).toHaveLength(2);
    expect(body.projected[0].revenue).toBeGreaterThan(150_000); // growth positif diekstrapolasi
    expect(body.method).toMatch(/growth/i);
    expect(body.method).toMatch(/bukan prediksi pasti/i); // §11: wajib disclaimer, bukan klaim prediksi pasti
  });
});
