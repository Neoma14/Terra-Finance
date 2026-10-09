import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama

import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { benchmarkRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";

/**
 * TASK-021 -- regression test utk celah isolasi company di `/api/benchmark`
 * yang ditemukan audit TASK-021 (lihat komentar panjang di routes.ts):
 * SEBELUM fix ini, fungsi `computeBenchmarkResults` membaca
 * `masterDb.companies` TANPA filter `company_access` sama sekali, jadi
 * staf yang company_access-nya SENGAJA dibatasi tetap bisa lihat rasio
 * keuangan company lain lewat Benchmarking (kelas bug sama dgn CRITICAL #1
 * TASK-020, cuma terlewat krn rute ini bukan `/api/c/:companySlug/*`).
 * Matrix wajib: Company A -> Company A = ALLOW, Company A -> Company B =
 * DENY, tanpa company_access sama sekali = kosong (bukan error/semua
 * company), dan client TIDAK BISA menyisipkan company lain lewat query
 * string `companyIds` (defense-in-depth).
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

/** Company legacy (masterDb) + SATU periode yang beririsan dgn rentang tes
 * -- cukup utk lolos cek `periods.length === 0` di computeBenchmarkResults;
 * nilai rasio/metrik tidak relevan utk tes isolasi akses ini. */
async function createLegacyCompanyWithPeriod(slug: string): Promise<{ companyId: string }> {
  const companyId = crypto.randomUUID();
  await masterDb("companies").insert({ id: companyId, slug, name: slug, industry_template: "general", status: "active" });
  await masterDb("periods").insert({
    id: crypto.randomUUID(),
    company_id: companyId,
    label: "Jan 2026",
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    period_type: "month",
    fiscal_year: 2026,
  });
  return { companyId };
}

/** Registrasi company di arsitektur baru + grant akses ke user tertentu
 * -- MEWAKILI company yang sudah dimigrasi (lihat legacy-company-migration.ts),
 * TANPA perlu company.db sungguhan krn benchmark hanya baca masterDb. */
async function registerAndGrantAccess(slug: string, user: TestUser): Promise<void> {
  const registryId = crypto.randomUUID();
  await systemDb("companies_registry").insert({
    id: registryId,
    slug,
    name: slug,
    database_path: `/tmp/not-used-${registryId}.db`,
    status: "active",
    schema_version: 12,
    last_migration_status: "READY",
  });
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await systemDb("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: registryId, role: "OWNER", status: "ACTIVE" });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(benchmarkRoutes);
  return app;
}

describe("Benchmark API company isolation (TASK-021)", () => {
  let app: FastifyInstance;
  let ownerA: TestUser;
  let ownerB: TestUser;
  let slugA: string;
  let slugB: string;
  let companyIdA: string;
  let companyIdB: string;

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
    const suffix = crypto.randomUUID().slice(0, 8);
    slugA = `bench-a-${suffix}`;
    slugB = `bench-b-${suffix}`;

    ownerA = await createTestUserAndToken("Owner A");
    ownerB = await createTestUserAndToken("Owner B");

    const a = await createLegacyCompanyWithPeriod(slugA);
    const b = await createLegacyCompanyWithPeriod(slugB);
    companyIdA = a.companyId;
    companyIdB = b.companyId;

    await registerAndGrantAccess(slugA, ownerA);
    await registerAndGrantAccess(slugB, ownerB);
  });

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: "/api/benchmark?from=2026-01-01&to=2026-01-31" });
    expect(res.statusCode).toBe(401);
  });

  it("Company A -> Company A = ALLOW (owner lihat company miliknya sendiri)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/benchmark?from=2026-01-01&to=2026-01-31",
      cookies: { [SESSION_COOKIE]: ownerA.token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const slugs = body.companies.map((c: any) => c.companySlug);
    expect(slugs).toContain(slugA);
  });

  it("Company A -> Company B = DENY (celah TASK-021 -- owner A TIDAK boleh lihat company B)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/benchmark?from=2026-01-01&to=2026-01-31",
      cookies: { [SESSION_COOKIE]: ownerA.token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const slugs = body.companies.map((c: any) => c.companySlug);
    expect(slugs).not.toContain(slugB);
  });

  it("companyIds dari client TIDAK BISA bypass filter akses (defense-in-depth)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/benchmark?from=2026-01-01&to=2026-01-31&companyIds=${companyIdA},${companyIdB}`,
      cookies: { [SESSION_COOKIE]: ownerA.token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const slugs = body.companies.map((c: any) => c.companySlug);
    expect(slugs).toContain(slugA);
    expect(slugs).not.toContain(slugB);
  });

  it("user tanpa company_access sama sekali -> companies kosong (bukan error, bukan semua company)", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({
      method: "GET",
      url: "/api/benchmark?from=2026-01-01&to=2026-01-31",
      cookies: { [SESSION_COOKIE]: stranger.token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.companies).toEqual([]);
  });
});
