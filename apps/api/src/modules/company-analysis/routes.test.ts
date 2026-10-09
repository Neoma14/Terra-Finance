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
import { companyAnalysisRoutes } from "./routes.js";
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
  app.register(companyAnalysisRoutes);
  return app;
}

const actor: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };

describe("Analysis API (TASK-023 §10)", () => {
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
    slug = `analysis-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Analysis");
    await grantAccess(owner, companyId, "OWNER");

    const kasId = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    const modalId = (await createAccount(companyDb, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    const revenueId = (await createAccount(companyDb, { code: "4000", name: "Pendapatan Jasa", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    const expenseId = (await createAccount(companyDb, { code: "5000", name: "Beban Operasional", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    const periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    const opening = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-01", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: opening.id }, actor);

    // Revenue 1.000.000, Expense 400.000 -> net profit 600.000, margin 60%.
    const sale = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-10", periodId, referenceNo: "JRN-0001", lines: [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: revenueId, debit: 0, credit: 1_000_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: sale.id }, actor);

    const expense = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-15", periodId, referenceNo: "JRN-0002", lines: [
      { accountId: expenseId, debit: 400_000, credit: 0 },
      { accountId: kasId, debit: 0, credit: 400_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: expense.id }, actor);
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/analysis?fromDate=2026-01-01&toDate=2026-01-31` });
    expect(res.statusCode).toBe(401);
  });

  it("404 generic kalau user tidak punya company_access (company isolation)", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/analysis?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: stranger.token },
    });
    expect(res.statusCode).toBe(404);
  });

  it("200 -- margin dihitung dari Income Statement/Balance Sheet yang sama dgn Dashboard, bukan formula kedua", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/analysis?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profitability.netProfitMargin.value).toBeCloseTo(0.6, 5); // 600.000 / 1.000.000
    expect(body.profitability.operatingMargin.value).toBeCloseTo(0.6, 5); // revenue - operatingExpenses, tidak ada COGS
    expect(body.profitability.grossProfitMargin.value).toBeCloseTo(1, 5); // grossProfit = revenue - cogs(0) = revenue penuh, krn tidak ada akun COGS di fixture ini
  });

  it("Current Ratio selalu null dgn alasan eksplisit (skema tidak py breakdown lancar/tidak lancar) -- bukan 0", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/analysis?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    const body = res.json();
    expect(body.liquidity.currentRatio.value).toBeNull();
    expect(body.liquidity.currentRatio.unavailableReason).toBeTruthy();
  });

  it("400 kalau fromDate/toDate tidak diisi", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/analysis`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(400);
  });
});
