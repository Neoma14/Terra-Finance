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
import { companyReportsRoutes } from "./routes.js";
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

/**
 * Financial Reporting API HTTP tests (TASK-DB-ARCH-012 §13/§16). Fokus
 * pada matrix wajib instruksi: unauthenticated/no-access/suspended-
 * access/insufficient-permission/valid-access/invalid-date/company
 * isolation -- SAMA dgn pola authorization.test.ts module lain, bukan
 * mengulang pengujian aritmatika laporan (sudah dicover service-level
 * test di `db/company/reporting/*.test.ts`).
 */

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

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await systemDb("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: companyId, role, status });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(companyReportsRoutes);
  return app;
}

const actor: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };
const REPORT_ENDPOINTS = ["balance-sheet", "income-statement", "equity", "cash-flow"];

describe("Financial Reporting API (TASK-DB-ARCH-012 §13)", () => {
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
    slug = `reports-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Reports");
    await grantAccess(owner, companyId, "OWNER");

    kasId = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(companyDb, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    const entry = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-05", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: entry.id }, actor);
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  for (const endpoint of REPORT_ENDPOINTS) {
    describe(`GET /reports/${endpoint}`, () => {
      it("200 utk OWNER dgn fromDate/toDate valid", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/company-db/${slug}/reports/${endpoint}?fromDate=2026-01-01&toDate=2026-01-31`,
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        expect(res.statusCode).toBe(200);
      });

      it("401 tanpa login (unauthenticated)", async () => {
        const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/reports/${endpoint}?fromDate=2026-01-01&toDate=2026-01-31` });
        expect(res.statusCode).toBe(401);
      });

      it("404 generic kalau user tidak punya company_access sama sekali", async () => {
        const stranger = await createTestUserAndToken("Stranger");
        const res = await app.inject({
          method: "GET",
          url: `/api/company-db/${slug}/reports/${endpoint}?fromDate=2026-01-01&toDate=2026-01-31`,
          cookies: { [SESSION_COOKIE]: stranger.token },
        });
        expect(res.statusCode).toBe(404);
      });

      it("404 kalau company_access berstatus SUSPENDED", async () => {
        const suspended = await createTestUserAndToken("Suspended User");
        await grantAccess(suspended, companyId, "VIEWER", "SUSPENDED");
        const res = await app.inject({
          method: "GET",
          url: `/api/company-db/${slug}/reports/${endpoint}?fromDate=2026-01-01&toDate=2026-01-31`,
          cookies: { [SESSION_COOKIE]: suspended.token },
        });
        expect(res.statusCode).toBe(404);
      });

      it("200 utk VIEWER (report.read dimiliki semua role termasuk VIEWER)", async () => {
        const viewer = await createTestUserAndToken("Viewer Reports");
        await grantAccess(viewer, companyId, "VIEWER");
        const res = await app.inject({
          method: "GET",
          url: `/api/company-db/${slug}/reports/${endpoint}?fromDate=2026-01-01&toDate=2026-01-31`,
          cookies: { [SESSION_COOKIE]: viewer.token },
        });
        expect(res.statusCode).toBe(200);
      });

      it("400 kalau fromDate/toDate tidak diisi", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/company-db/${slug}/reports/${endpoint}`,
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        expect(res.statusCode).toBe(400);
      });

      it("400 kalau fromDate > toDate", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/company-db/${slug}/reports/${endpoint}?fromDate=2026-02-01&toDate=2026-01-01`,
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        expect(res.statusCode).toBe(400);
      });

      it("Isolation -- Company B tidak terpengaruh transaksi Company A", async () => {
        const slugB = `reports-b-${crypto.randomUUID().slice(0, 8)}`;
        const companyB = await createCompany(slugB);
        await grantAccess(owner, companyB.companyId, "OWNER");

        try {
          const res = await app.inject({
            method: "GET",
            url: `/api/company-db/${slugB}/reports/${endpoint}?fromDate=2026-01-01&toDate=2026-01-31`,
            cookies: { [SESSION_COOKIE]: owner.token },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // Company B tidak punya akun/transaksi sama sekali -- tidak boleh
          // "mewarisi" Kas 1.000.000 milik Company A.
          const serialized = JSON.stringify(body);
          expect(serialized).not.toContain("1000000");
        } finally {
          await companyB.db.destroy();
          fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slugB), { recursive: true, force: true });
          await systemDb("company_access").where({ company_id: companyB.companyId }).del();
          await systemDb("companies_registry").where({ id: companyB.companyId }).del();
        }
      });
    });
  }
});
