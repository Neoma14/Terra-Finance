import "./__fixtures__/legacy-db-env.js"; // HARUS import pertama
import { TEST_COMPANY_DATA_ROOT } from "./__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyJournalRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";

/**
 * REGRESSION SECURITY TEST -- TASK-DB-ARCH-009 membuktikan IDOR
 * (authenticated user dapat mengakses company APAPUN hanya dgn tahu
 * slug). TASK-DB-ARCH-010 menutupnya lewat `requireCompanyAccess`.
 *
 * File ini DIUBAH (sesuai instruksi §25 TASK-DB-ARCH-010: "diubah menjadi
 * regression security test yang EXPECT DENY") -- SEKARANG membuktikan
 * vulnerability tersebut SUDAH DIPERBAIKI, bukan lagi mendemonstrasikan
 * exploit yang masih terbuka. Skenario & kode produksi yang diuji SAMA
 * PERSIS dgn versi TASK-009 (requireAuth asli, route asli, tidak di-mock)
 * -- hanya ekspektasi hasilnya yang berbalik dari "lolos" ke "ditolak".
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

async function createTestCompany(slug: string): Promise<Knex> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();
  return db;
}

describe("TASK-DB-ARCH-010 security regression: company access boundary (IDOR FIXED)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await migrateMasterDb();
    await migrateSystemDb();
    app = Fastify();
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    app.register(companyJournalRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  it("User A (TANPA company_access ke Company B) TIDAK LAGI bisa mencapai journal Company B -- hanya dgn tahu slug", async () => {
    const userAId = crypto.randomUUID();
    await masterDb("users").insert({
      id: userAId,
      email: `${userAId}@test.local`,
      password_hash: "x",
      full_name: "User A (tidak terkait Company B)",
      role: "staff",
    });
    const { token } = await createSession(userAId, {});

    const dbB = await createTestCompany("company-b-secret-v2");
    const registryId = crypto.randomUUID();
    await systemDb("companies_registry").insert({
      id: registryId,
      slug: "company-b-secret-v2",
      name: "Company B (secret)",
      database_path: path.join(TEST_COMPANY_DATA_ROOT, "company-b-secret-v2", "company.db"),
      status: "active",
    });
    // SENGAJA TIDAK grant company_access utk userAId ke company ini --
    // inilah skenario IDOR yang diuji.

    try {
      const periodId = crypto.randomUUID();
      await dbB("periods").insert({
        id: periodId,
        label: "Jan 2026",
        start_date: "2026-01-01",
        end_date: "2026-01-31",
        period_type: "month",
        fiscal_year: 2026,
        status: "OPEN",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-b-secret-v2/journal",
        cookies: { [SESSION_COOKIE]: token },
        payload: { referenceNo: "JRN-BREACH-TEST", periodId, entryDate: "2026-01-05", lines: [{ accountId: "x", debit: 1, credit: 0 }] },
      });

      // FIXED: request DITOLAK sebelum sampai ke business logic/company.db
      // sama sekali. 404 generik (bukan 403) -- Company Enumeration (§24):
      // client tidak bisa membedakan "company tidak ada" dari "company ada
      // tapi tidak punya akses".
      expect(res.statusCode).toBe(404);
      expect(res.json().error).not.toMatch(/account|debit|credit/i); // bukan error bisnis -- berhenti di authorization

      // Pastikan BENAR-BENAR tidak ada perubahan apa pun ke Company B.
      const entries = await dbB("journal_entries").where({ reference_no: "JRN-BREACH-TEST" });
      expect(entries).toHaveLength(0);
    } finally {
      await dbB.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, "company-b-secret-v2"), { recursive: true, force: true });
      await systemDb("companies_registry").where({ id: registryId }).del();
    }
  });
});
