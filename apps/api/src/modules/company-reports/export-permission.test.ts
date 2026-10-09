import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Role yang dikenal DB selalu punya report.read (lihat rbac.ts), jadi kasus
// "tanpa report.read" diuji dgn membuat permission check menolak report.read.
vi.mock("../../db/system/rbac.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/system/rbac.js")>();
  return {
    ...actual,
    hasPermission: (role: Parameters<typeof actual.hasPermission>[0], permission: Parameters<typeof actual.hasPermission>[1]) =>
      permission === "report.read" ? false : actual.hasPermission(role, permission),
  };
});

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

describe("Export laporan -- permission report.read ditegakkan", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyId: string;
  let companyDb: Knex;
  let token: string;

  beforeAll(async () => {
    const m = knexLib(masterKnexfile);
    await m.migrate.latest();
    await m.destroy();
    const s = knexLib(systemKnexfile);
    await s.migrate.latest();
    await s.destroy();

    app = Fastify();
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    app.register(companyReportsRoutes);
    await app.ready();

    slug = `export-perm-${crypto.randomUUID().slice(0, 8)}`;
    const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    companyDb = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
    await companyDb.migrate.latest();
    companyId = crypto.randomUUID();
    await systemDb("companies_registry").insert({ id: companyId, slug, name: "PT PERMISI", database_path: dbPath, status: "active", schema_version: 12, last_migration_status: "READY" });

    const userId = crypto.randomUUID();
    await masterDb("users").insert({ id: userId, email: `${userId}@test.local`, password_hash: "x", full_name: "Owner Perm", role: "admin" });
    const session = await createSession(userId, {});
    token = session.token;
    const systemUserId = await ensureSystemIdentity(systemDb, { id: userId, email: `${userId}@test.local`, fullName: "Owner Perm", role: "admin", avatarUrl: null });
    await systemDb("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: companyId, role: "OWNER", status: "ACTIVE" });
  });

  afterAll(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
    await app.close();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  it("403 utk export walaupun user punya company_access, kalau report.read tidak diberikan", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/reports/export/balance-sheet?format=xlsx&fromDate=2026-01-01&toDate=2026-01-31`,
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("Stack");
  });
});
