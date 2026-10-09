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
import { companyAccountsRoutes } from "./routes.js";
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
  app.register(companyAccountsRoutes);
  return app;
}

describe("Chart of Accounts API (TASK-DB-ARCH-011 Part B)", () => {
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
    slug = `coa-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner COA");
    await grantAccess(owner, companyId, "OWNER");
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("POST accounts -- OWNER (account.create) berhasil membuat akun", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/accounts`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
    });
    expect(res.statusCode).toBe(201);

    const account = await companyDb("accounts").where({ id: res.json().accountId }).first();
    expect(account.code).toBe("1000");
  });

  it("GET accounts -- list berhasil utk VIEWER (account.read)", async () => {
    await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/accounts`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
    });

    const viewer = await createTestUserAndToken("Viewer COA");
    await grantAccess(viewer, companyId, "VIEWER");

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/accounts`, cookies: { [SESSION_COOKIE]: viewer.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accounts).toHaveLength(1);
  });

  it("POST accounts -- VIEWER (tanpa account.create) DITOLAK 403", async () => {
    const viewer = await createTestUserAndToken("Viewer COA 2");
    await grantAccess(viewer, companyId, "VIEWER");

    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/accounts`,
      cookies: { [SESSION_COOKIE]: viewer.token },
      payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH accounts/:id -- STAFF (tanpa account.update) DITOLAK 403, ACCOUNTANT berhasil", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/accounts`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
    });
    const accountId = createRes.json().accountId;

    const staff = await createTestUserAndToken("Staff COA");
    await grantAccess(staff, companyId, "STAFF");
    const staffRes = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/accounts/${accountId}`,
      cookies: { [SESSION_COOKIE]: staff.token },
      payload: { isActive: false },
    });
    expect(staffRes.statusCode).toBe(403);

    const accountant = await createTestUserAndToken("Accountant COA");
    await grantAccess(accountant, companyId, "ACCOUNTANT");
    const accRes = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/accounts/${accountId}`,
      cookies: { [SESSION_COOKIE]: accountant.token },
      payload: { isActive: false },
    });
    expect(accRes.statusCode).toBe(200);
  });

  it("Isolation -- akun Company A tidak terlihat/terjangkau lewat slug Company B", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/accounts`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
    });
    const accountId = createRes.json().accountId;

    const slugB = `coa-b-${crypto.randomUUID().slice(0, 8)}`;
    const companyB = await createCompany(slugB);
    await grantAccess(owner, companyB.companyId, "OWNER");

    try {
      const res = await app.inject({ method: "GET", url: `/api/company-db/${slugB}/accounts/${accountId}`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(res.statusCode).toBe(404); // accountId milik company A, tidak ada di file company B
    } finally {
      await companyB.db.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slugB), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyB.companyId }).del();
      await systemDb("companies_registry").where({ id: companyB.companyId }).del();
    }
  });

  describe("TASK-DB-ARCH-015: search/filter/pagination, account-types, parent/normal_balance validation", () => {
    it("GET accounts -- search by code/name + pagination, response punya 'total'", async () => {
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: "POST",
          url: `/api/company-db/${slug}/accounts`,
          cookies: { [SESSION_COOKIE]: owner.token },
          payload: { code: `100${i}`, name: `Akun ${i}`, accountTypeCode: "ASSET", normalBalance: "debit" },
        });
      }

      const searchRes = await app.inject({ method: "GET", url: `/api/company-db/${slug}/accounts?search=akun%201`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(searchRes.json().accounts).toHaveLength(1);
      expect(searchRes.json().accounts[0].code).toBe("1001");

      const pageRes = await app.inject({ method: "GET", url: `/api/company-db/${slug}/accounts?pageSize=2&page=1`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(pageRes.json().accounts).toHaveLength(2);
      expect(pageRes.json().total).toBe(3);
    });

    it("GET account-types -- mengembalikan 9 tipe", async () => {
      const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/account-types`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(res.statusCode).toBe(200);
      expect(res.json().accountTypes).toHaveLength(9);
    });

    it("POST accounts -- parentAccountId tidak ditemukan -> 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/accounts`,
        cookies: { [SESSION_COOKIE]: owner.token },
        payload: { code: "1100", name: "Kas Kecil", accountTypeCode: "ASSET", normalBalance: "debit", parentAccountId: "tidak-ada" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("PATCH accounts/:id -- parentAccountId = dirinya sendiri -> 400", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/accounts`,
        cookies: { [SESSION_COOKIE]: owner.token },
        payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
      });
      const accountId = createRes.json().accountId;

      const res = await app.inject({
        method: "PATCH",
        url: `/api/company-db/${slug}/accounts/${accountId}`,
        cookies: { [SESSION_COOKIE]: owner.token },
        payload: { parentAccountId: accountId },
      });
      expect(res.statusCode).toBe(400);
    });

    it("PATCH accounts/:id -- normal_balance akun yang sudah dipakai jurnal -> 409", async () => {
      const kasRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/accounts`,
        cookies: { [SESSION_COOKIE]: owner.token },
        payload: { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" },
      });
      const modalRes = await app.inject({
        method: "POST",
        url: `/api/company-db/${slug}/accounts`,
        cookies: { [SESSION_COOKIE]: owner.token },
        payload: { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" },
      });
      const kasId = kasRes.json().accountId;
      const modalId = modalRes.json().accountId;

      const periodId = crypto.randomUUID();
      await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      const entryId = crypto.randomUUID();
      await companyDb("journal_entries").insert({ id: entryId, entry_date: "2026-01-05", period_id: periodId, reference_no: "JRN-0001", status: "DRAFT" });
      await companyDb("journal_entry_lines").insert([
        { id: crypto.randomUUID(), journal_entry_id: entryId, account_id: kasId, debit: 100_000, credit: 0, line_order: 0 },
        { id: crypto.randomUUID(), journal_entry_id: entryId, account_id: modalId, debit: 0, credit: 100_000, line_order: 1 },
      ]);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/company-db/${slug}/accounts/${kasId}`,
        cookies: { [SESSION_COOKIE]: owner.token },
        payload: { normalBalance: "credit" },
      });
      expect(res.statusCode).toBe(409);
    });
  });
});
