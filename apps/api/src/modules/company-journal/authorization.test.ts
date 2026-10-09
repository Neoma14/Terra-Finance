import "./__fixtures__/legacy-db-env.js"; // HARUS import pertama
import { TEST_COMPANY_DATA_ROOT } from "./__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyJournalRoutes } from "./routes.js";
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

/**
 * Authorization flow end-to-end (TASK-DB-ARCH-010 §25: Company Access,
 * Status, RBAC, Journal API, Security/IDOR/Privilege Escalation). Berbeda
 * dari routes.test.ts (fokus functional journal) -- file ini fokus
 * SIAPA BOLEH APA.
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

async function createCompanyWithPeriod(slug: string): Promise<{ db: Knex; periodId: string; kasId: string; modalId: string }> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();

  const assetType = await db("account_types").where({ code: "ASSET" }).first();
  const equityType = await db("account_types").where({ code: "EQUITY" }).first();
  const kasId = crypto.randomUUID();
  await db("accounts").insert({ id: kasId, code: "1000", name: "Kas", account_type_id: assetType.id, normal_balance: "debit" });
  const modalId = crypto.randomUUID();
  await db("accounts").insert({ id: modalId, code: "3000", name: "Modal", account_type_id: equityType.id, normal_balance: "credit" });

  const periodId = crypto.randomUUID();
  await db("periods").insert({
    id: periodId,
    label: "Jan 2026",
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    period_type: "month",
    fiscal_year: 2026,
    status: "OPEN",
  });

  return { db, periodId, kasId, modalId };
}

async function registerCompany(slug: string, status: "active" | "archived" = "active"): Promise<string> {
  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({
    id: companyId,
    slug,
    name: slug,
    database_path: path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db"),
    status,
    schema_version: 12,
    last_migration_status: "READY",
  });
  return companyId;
}

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await systemDb("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: companyId, role, status });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(companyJournalRoutes);
  return app;
}

function balancedLines(kasId: string, modalId: string) {
  return [
    { accountId: kasId, debit: 50_000, credit: 0 },
    { accountId: modalId, debit: 0, credit: 50_000 },
  ];
}

describe("Authorization flow: Company Access + RBAC (TASK-DB-ARCH-010)", () => {
  let app: FastifyInstance;

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

  describe("Company Access", () => {
    let companyDb: Knex;
    let periodId: string;
    let kasId: string;
    let modalId: string;
    let companyId: string;
    const slug = "authz-company-access";

    beforeEach(async () => {
      const created = await createCompanyWithPeriod(slug);
      companyDb = created.db;
      periodId = created.periodId;
      kasId = created.kasId;
      modalId = created.modalId;
      companyId = await registerCompany(slug);
    });

    afterEach(async () => {
      await companyDb.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyId }).del();
      await systemDb("companies_registry").where({ id: companyId }).del();
    });

    it("User A + Company A access = ALLOW", async () => {
      const userA = await createTestUserAndToken("User A");
      await grantAccess(userA, companyId, "OWNER");

      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: userA.token },
        payload: { referenceNo: "JRN-AA", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(res.statusCode).toBe(201);
    });

    it("User A + Company B (nol access) = DENY (404, generic)", async () => {
      const userA = await createTestUserAndToken("User A");
      // TIDAK grant access sama sekali.

      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: userA.token },
        payload: { referenceNo: "JRN-AB", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(res.statusCode).toBe(404);
    });

    it("User B + Company B (punya access) = ALLOW -- independen dari User A", async () => {
      const userB = await createTestUserAndToken("User B");
      await grantAccess(userB, companyId, "STAFF");

      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: userB.token },
        payload: { referenceNo: "JRN-BB", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(res.statusCode).toBe(201);
    });

    it("Status SUSPENDED pada company_access = DENY meski baris access ADA", async () => {
      const user = await createTestUserAndToken("User Suspended");
      await grantAccess(user, companyId, "OWNER", "SUSPENDED");

      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-SUSP", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(res.statusCode).toBe(404);
    });

    it("Company registry status != active = DENY meski user punya access ACTIVE", async () => {
      await systemDb("companies_registry").where({ id: companyId }).update({ status: "archived" });
      const user = await createTestUserAndToken("User Archived Co");
      await grantAccess(user, companyId, "OWNER");

      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-ARCHIVED", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("RBAC per role (journal.create/post/reverse)", () => {
    let companyDb: Knex;
    let periodId: string;
    let kasId: string;
    let modalId: string;
    let companyId: string;
    const slug = "authz-rbac";

    beforeEach(async () => {
      const created = await createCompanyWithPeriod(slug);
      companyDb = created.db;
      periodId = created.periodId;
      kasId = created.kasId;
      modalId = created.modalId;
      companyId = await registerCompany(slug);
    });

    afterEach(async () => {
      await companyDb.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyId }).del();
      await systemDb("companies_registry").where({ id: companyId }).del();
    });

    async function userWithRole(role: CompanyRole): Promise<TestUser> {
      const user = await createTestUserAndToken(`User ${role}`);
      await grantAccess(user, companyId, role);
      return user;
    }

    it("VIEWER -> journal.create DENY (403)", async () => {
      const user = await userWithRole("VIEWER");
      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-V1", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(res.statusCode).toBe(403);
    });

    it("STAFF -> journal.create ALLOW, journal.post DENY (403)", async () => {
      const user = await userWithRole("STAFF");
      const createRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-S1", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(createRes.statusCode).toBe(201);

      const postRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal/${createRes.json().journalId}/post`,
        cookies: { [SESSION_COOKIE]: user.token },
      });
      expect(postRes.statusCode).toBe(403);
    });

    it("ACCOUNTANT -> journal.create + journal.post ALLOW", async () => {
      const user = await userWithRole("ACCOUNTANT");
      const createRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-ACC1", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      expect(createRes.statusCode).toBe(201);

      const postRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal/${createRes.json().journalId}/post`,
        cookies: { [SESSION_COOKIE]: user.token },
      });
      expect(postRes.statusCode).toBe(200);
    });

    it("OWNER -> journal.create + post + reverse semua ALLOW", async () => {
      const user = await userWithRole("OWNER");
      const createRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-OWN1", periodId, entryDate: "2026-01-05", lines: balancedLines(kasId, modalId) },
      });
      const journalId = createRes.json().journalId;
      await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal/${journalId}/post`, cookies: { [SESSION_COOKIE]: user.token } });

      const reverseRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/journal/${journalId}/reverse`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { targetPeriodId: periodId, reason: "Koreksi" },
      });
      expect(reverseRes.statusCode).toBe(200);
    });
  });

  describe("Security: Privilege Escalation", () => {
    it("Request tidak bisa menentukan role dirinya sendiri lewat header/body apa pun", async () => {
      const slug = "authz-privesc";
      const created = await createCompanyWithPeriod(slug);
      const companyId = await registerCompany(slug);
      const user = await createTestUserAndToken("User Privesc");
      await grantAccess(user, companyId, "VIEWER"); // role sesungguhnya: VIEWER

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/company-db/${slug}/journal`,
          cookies: { [SESSION_COOKIE]: user.token },
          payload: {
            referenceNo: "JRN-PRIVESC",
            periodId: created.periodId,
            entryDate: "2026-01-05",
            lines: balancedLines(created.kasId, created.modalId),
            role: "OWNER", // field TIDAK ADA di schema zod -- harus diabaikan
          },
        });
        // Tetap DITOLAK sesuai role ASLI (VIEWER), bukan "OWNER" yang
        // dikirim di body.
        expect(res.statusCode).toBe(403);
      } finally {
        await created.db.destroy();
        fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
        await systemDb("company_access").where({ company_id: companyId }).del();
        await systemDb("companies_registry").where({ id: companyId }).del();
      }
    });
  });
});
