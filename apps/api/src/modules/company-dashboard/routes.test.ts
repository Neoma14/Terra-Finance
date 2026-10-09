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
import { companyDashboardRoutes } from "./routes.js";
import { companyReportsRoutes } from "../company-reports/routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { createAccount } from "../../db/company/account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "../../db/company/journal-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import type { CompanyRole } from "../../db/system/rbac.js";

/**
 * KPI Dashboard API (TASK-020). Auth matrix MENGIKUTI pola
 * company-reports/routes.test.ts persis (reuse `report.read`, TIDAK diuji
 * ulang dgn pola berbeda). Fokus UTAMA file ini: RECONCILIATION (§33
 * instruksi "paling penting") -- angka dashboard HARUS SAMA PERSIS dgn
 * laporan existing utk periode & definisi metric yang sama, dibuktikan
 * dgn memanggil KEDUA endpoint lewat HTTP sungguhan lalu `toBe()`
 * langsung, bukan cuma baca kode dan percaya.
 */

async function migrateMasterDb(): Promise<void> {
  const db = knexLib(masterKnexfile);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}
async function migrateSystemDb(): Promise<void> {
  const db = knexLib(systemKnexfile);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

interface TestUser {
  id: string;
  email: string;
  fullName: string;
  token: string;
}

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

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await systemDb("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: companyId, role, status });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(companyDashboardRoutes);
  app.register(companyReportsRoutes);
  return app;
}

const actor: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };

describe("KPI Dashboard API (TASK-020)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;
  let kasId: string;
  let modalId: string;
  let pendapatanId: string;
  let bebanId: string;
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
    slug = `dash-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Dashboard");
    await grantAccess(owner, companyId, "OWNER");

    kasId = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit", isCash: true }, actor)).id;
    modalId = (await createAccount(companyDb, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    pendapatanId = (await createAccount(companyDb, { code: "4000", name: "Pendapatan Jasa", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    bebanId = (await createAccount(companyDb, { code: "6000", name: "Beban Operasional", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    // Opening balance: Kas 1.000.000 Dr / Modal 1.000.000 Cr
    const ob = await createDraftJournalEntry(
      companyDb,
      { entryDate: "2026-01-02", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
        { accountId: kasId, debit: 1_000_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 1_000_000 },
      ] },
      actor,
    );
    await postJournalEntry(companyDb, { journalEntryId: ob.id }, actor);

    // Penjualan jasa tunai: Kas 500.000 Dr / Pendapatan 500.000 Cr
    const sale = await createDraftJournalEntry(
      companyDb,
      { entryDate: "2026-01-10", periodId, referenceNo: "JRN-0001", lines: [
        { accountId: kasId, debit: 500_000, credit: 0 },
        { accountId: pendapatanId, debit: 0, credit: 500_000 },
      ] },
      actor,
    );
    await postJournalEntry(companyDb, { journalEntryId: sale.id }, actor);

    // Beban operasional tunai: Beban 150.000 Dr / Kas 150.000 Cr
    const expense = await createDraftJournalEntry(
      companyDb,
      { entryDate: "2026-01-15", periodId, referenceNo: "JRN-0002", lines: [
        { accountId: bebanId, debit: 150_000, credit: 0 },
        { accountId: kasId, debit: 0, credit: 150_000 },
      ] },
      actor,
    );
    await postJournalEntry(companyDb, { journalEntryId: expense.id }, actor);
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("200 utk OWNER dgn fromDate/toDate valid", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
  });

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31` });
    expect(res.statusCode).toBe(401);
  });

  it("404 kalau user tidak punya company_access", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: stranger.token },
    });
    expect(res.statusCode).toBe(404);
  });

  it("200 utk VIEWER (report.read dimiliki semua role)", async () => {
    const viewer = await createTestUserAndToken("Viewer Dashboard");
    await grantAccess(viewer, companyId, "VIEWER");
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: viewer.token },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400 kalau fromDate/toDate tidak diisi", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/dashboard`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(400);
  });

  it("§33 RECONCILIATION -- Dashboard KPI = Income Statement + Balance Sheet + Cash Flow utk periode yang SAMA (bukti HTTP sungguhan, bukan baca kode)", async () => {
    const qs = "fromDate=2026-01-01&toDate=2026-01-31";
    const [dashRes, incomeRes, balanceRes, cashRes] = await Promise.all([
      app.inject({ method: "GET", url: `/api/company-db/${slug}/dashboard?${qs}`, cookies: { [SESSION_COOKIE]: owner.token } }),
      app.inject({ method: "GET", url: `/api/company-db/${slug}/reports/income-statement?${qs}`, cookies: { [SESSION_COOKIE]: owner.token } }),
      app.inject({ method: "GET", url: `/api/company-db/${slug}/reports/balance-sheet?${qs}`, cookies: { [SESSION_COOKIE]: owner.token } }),
      app.inject({ method: "GET", url: `/api/company-db/${slug}/reports/cash-flow?${qs}`, cookies: { [SESSION_COOKIE]: owner.token } }),
    ]);
    expect(dashRes.statusCode).toBe(200);
    expect(incomeRes.statusCode).toBe(200);
    expect(balanceRes.statusCode).toBe(200);
    expect(cashRes.statusCode).toBe(200);

    const dashboard = dashRes.json();
    const income = incomeRes.json();
    const balance = balanceRes.json();
    const cash = cashRes.json();

    // Sanity: angka sungguhan, bukan nol semua (membuktikan dataset test
    // benar2 ter-posting, bukan kebetulan 0===0).
    expect(income.revenue.total).toBe(500_000);
    expect(income.netProfit).toBe(350_000); // 500.000 - 150.000

    expect(dashboard.kpis.revenue.value).toBe(income.revenue.total);
    expect(dashboard.kpis.expense.value).toBe(income.cogs.total + income.operatingExpenses.total + income.otherExpense.total);
    expect(dashboard.kpis.netProfit.value).toBe(income.netProfit);
    expect(dashboard.kpis.totalAssets.value).toBe(balance.totalAssets);
    expect(dashboard.kpis.totalLiabilities.value).toBe(balance.totalLiabilities);
    expect(dashboard.kpis.totalEquity.value).toBe(balance.totalEquity);
    expect(dashboard.kpis.cashAndBank.value).toBe(cash.endingCash);
    expect(dashboard.kpis.profitMargin.value).toBeCloseTo(income.netProfit / income.revenue.total, 10);

    expect(dashboard.financialPosition.totalAssets).toBe(balance.totalAssets);
    expect(dashboard.financialPosition.totalLiabilities).toBe(balance.totalLiabilities);
    expect(dashboard.financialPosition.totalEquity).toBe(balance.totalEquity);

    // Assets = Liabilities + Equity -- harus tetap benar scr matematis
    // (bukan cuma "sama dgn balance sheet", tapi balance sheet-nya SENDIRI
    // juga harus balance -- kalau tidak, getBalanceSheet sudah throw 500
    // SEBELUM assertion ini tercapai).
    expect(balance.totalAssets).toBe(balance.totalLiabilities + balance.totalEquity);
  });

  it("§24 -- comparison null (bukan Infinity%/NaN%) kalau periode sebelumnya tidak py data sama sekali (perusahaan baru)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    const dashboard = res.json();
    // Periode sebelumnya (Des 2025) tidak py periode/jurnal terdaftar sama
    // sekali -- revenue/expense sebelumnya seharusnya 0, dan karena 0 jadi
    // pembagi, changePercent utk revenue HARUS null (bukan Infinity).
    expect(dashboard.kpis.revenue.changePercent).toBeNull();
    expect(Number.isFinite(dashboard.kpis.revenue.changePercent ?? 0)).toBe(true);
  });

  it("§22 -- profitMargin null (bukan 0) kalau revenue = 0 (pembagi nol)", async () => {
    // Periode TANPA transaksi revenue sama sekali (hanya opening balance,
    // di luar rentang filter) -- pakai rentang tanggal sebelum penjualan terjadi.
    const periodAwalId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodAwalId, label: "Des 2025", start_date: "2025-12-01", end_date: "2025-12-31", period_type: "month", fiscal_year: 2025, status: "OPEN" });

    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2025-12-01&toDate=2025-12-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    const dashboard = res.json();
    expect(dashboard.kpis.revenue.value).toBe(0);
    expect(dashboard.kpis.profitMargin.value).toBeNull();
  });

  it("alerts: draft journal yang belum diposting terdeteksi", async () => {
    await createDraftJournalEntry(
      companyDb,
      { entryDate: "2026-01-20", periodId, referenceNo: "JRN-DRAFT", lines: [
        { accountId: kasId, debit: 10_000, credit: 0 },
        { accountId: pendapatanId, debit: 0, credit: 10_000 },
      ] },
      actor,
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    const dashboard = res.json();
    expect(dashboard.alerts.some((a: any) => a.type === "draft_journals")).toBe(true);
  });

  it("recentActivity berisi aktivitas nyata dari company_audit_log (bukan data fake/hardcoded)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/dashboard?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    const dashboard = res.json();
    expect(dashboard.recentActivity.length).toBeGreaterThan(0);
    expect(dashboard.recentActivity.some((a: any) => a.action === "journal.post")).toBe(true);
  });
});
