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
import { companyTaxRoutes } from "./routes.js";
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
  app.register(companyTaxRoutes);
  return app;
}

describe("Tax Settings API (TASK-023 §7)", () => {
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
    slug = `tax-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Tax");
    viewer = await createTestUserAndToken("Viewer Tax");
    await grantAccess(owner, companyId, "OWNER");
    await grantAccess(viewer, companyId, "VIEWER");
  });

  afterEach(async () => {
    await companyDb.destroy();
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
  });

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/tax-settings` });
    expect(res.statusCode).toBe(401);
  });

  it("404 generic kalau user tidak punya company_access", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/tax-settings`, cookies: { [SESSION_COOKIE]: stranger.token } });
    expect(res.statusCode).toBe(404);
  });

  it("GET -- lazy-seed baris default (provisioning TIDAK pernah insert row ke tax_reference_settings) TANPA perlu migration backfill", async () => {
    const before = await companyDb("tax_reference_settings").count("* as c").first();
    expect(Number((before as any).c)).toBe(0);

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/tax-settings`, cookies: { [SESSION_COOKIE]: viewer.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.vatStatus).toBe("kena_pajak"); // default skema C0011

    const after = await companyDb("tax_reference_settings").count("* as c").first();
    expect(Number((after as any).c)).toBe(1); // tepat satu baris, tidak dobel
  });

  it("PATCH -- OWNER berhasil update, VIEWER (tanpa company.update) ditolak 403", async () => {
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/tax-settings`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { vatStatus: "non_pkp", generalNotes: ["Catatan uji"] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.vatStatus).toBe("non_pkp");
    expect(ok.json().settings.generalNotes).toEqual(["Catatan uji"]);

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/tax-settings`,
      cookies: { [SESSION_COOKIE]: viewer.token },
      payload: { vatStatus: "kena_pajak" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("GET tax-summary -- dasar pengenaan = revenue dari Income Statement yang sama dgn Dashboard (bukan kalkulasi tarif baru)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/tax-summary?fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revenue).toBe(0); // belum ada transaksi di fixture ini -- nilai nyata (0), bukan dikarang
  });
});
