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
import { companyCounterpartiesRoutes } from "./routes.js";
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

async function createTestUserAndToken(label: string, role: CompanyRole = "OWNER"): Promise<TestUser & { role: CompanyRole }> {
  const userId = crypto.randomUUID();
  const email = `${userId}@test.local`;
  await masterDb("users").insert({ id: userId, email, password_hash: "x", full_name: label, role: "admin" });
  const { token } = await createSession(userId, {});
  return { id: userId, email, fullName: label, token, role };
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
  app.register(companyCounterpartiesRoutes);
  return app;
}

const actor: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };

describe("Counterparties API / Hutang-Piutang (TASK-023 §6)", () => {
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
    slug = `ap-ar-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner AP-AR");
    viewer = await createTestUserAndToken("Viewer AP-AR");
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
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/counterparties` });
    expect(res.statusCode).toBe(401);
  });

  it("404 generic kalau user tidak punya company_access (company isolation)", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/counterparties`, cookies: { [SESSION_COOKIE]: stranger.token } });
    expect(res.statusCode).toBe(404);
  });

  it("POST create -- OWNER berhasil tambah vendor, VIEWER (tanpa account.create) ditolak 403", async () => {
    const ok = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/counterparties`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { type: "vendor", code: "V001", name: "PT Pemasok Utama" },
    });
    expect(ok.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/counterparties`,
      cookies: { [SESSION_COOKIE]: viewer.token },
      payload: { type: "vendor", code: "V002", name: "Coba Vendor" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("POST create -- kode duplikat (tipe sama) = 409", async () => {
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/counterparties`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { type: "vendor", code: "V001", name: "Vendor Satu" } });
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/counterparties`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { type: "vendor", code: "V001", name: "Vendor Dua" } });
    expect(res.statusCode).toBe(409);
  });

  it("GET balances -- saldo hutang dihitung dari journal_entry_lines nyata (debit=pembayaran mengurangi, credit=tagihan menambah), bukan tabel saldo terpisah", async () => {
    const kasId = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    const payableId = (await createAccount(companyDb, { code: "2000", name: "Hutang Usaha", accountTypeCode: "LIABILITY", normalBalance: "credit", subledgerType: "payable" }, actor)).id;
    const expenseId = (await createAccount(companyDb, { code: "5000", name: "Beban", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    const vendorRes = await app.inject({ method: "POST", url: `/api/company-db/${slug}/counterparties`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { type: "vendor", code: "V001", name: "PT Pemasok Utama" } });
    const vendorId = vendorRes.json().id;

    const periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    // Tagihan masuk 500.000 (hutang naik)
    const bill = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-05", periodId, referenceNo: "BILL-0001", lines: [
      { accountId: expenseId, debit: 500_000, credit: 0 },
      { accountId: payableId, debit: 0, credit: 500_000, counterpartyId: vendorId },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: bill.id }, actor);

    // Pembayaran sebagian 200.000 (hutang turun)
    const payment = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-20", periodId, referenceNo: "PAY-0001", lines: [
      { accountId: payableId, debit: 200_000, credit: 0, counterpartyId: vendorId },
      { accountId: kasId, debit: 0, credit: 200_000 },
    ] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: payment.id }, actor);

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/counterparties/balances?type=vendor`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const balances = res.json().balances;
    expect(balances).toHaveLength(1);
    expect(balances[0].balance).toBe(300_000); // 500.000 - 200.000, sisa hutang
  });

  it("GET balances -- counterparty tanpa transaksi tetap muncul dgn balance 0 (nilai nyata, bukan disembunyikan)", async () => {
    const vendorRes = await app.inject({ method: "POST", url: `/api/company-db/${slug}/counterparties`, cookies: { [SESSION_COOKIE]: owner.token }, payload: { type: "vendor", code: "V999", name: "Vendor Belum Transaksi" } });
    expect(vendorRes.statusCode).toBe(201);

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/counterparties/balances?type=vendor`, cookies: { [SESSION_COOKIE]: owner.token } });
    const balances = res.json().balances;
    expect(balances.find((b: any) => b.code === "V999").balance).toBe(0);
  });
});
