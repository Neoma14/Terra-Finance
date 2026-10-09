import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import multipart from "@fastify/multipart";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyJournalImportRoutes } from "./routes.js";
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
 * HTTP-level test Journal Import API (TASK-DB-ARCH-014 §11: permission
 * matrix commit journal.create+journal.post, preview vs commit, template
 * download). Aritmatika parsing/validasi SENDIRI sudah dicover
 * db/company/journal-import-service.test.ts -- fokus di sini: wiring
 * HTTP, multipart upload, dan otorisasi.
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

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole) {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId, role });
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(multipart);
  app.register(attachAuthUser);
  app.register(companyJournalImportRoutes);
  return app;
}

type Row = [string, string, string, string, string, number | null, number | null] | null;

async function buildTestWorkbookFormData(rows: Row[], filename = "jurnal.xlsx"): Promise<FormData> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Jurnal");
  sheet.getRow(1).values = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"];
  rows.forEach((row, i) => {
    if (row) sheet.getRow(2 + i).values = row;
  });
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  return fd;
}

describe("Journal Import API (TASK-DB-ARCH-014)", () => {
  let app: FastifyInstance;
  let slug: string;
  let companyDb: Knex;
  let companyId: string;
  let owner: TestUser;
  let kasId: string;
  let modalId: string;

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
    slug = `journal-import-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Import");
    await grantAccess(owner, companyId, "OWNER");

    const assetType = await companyDb("account_types").where({ code: "ASSET" }).first();
    const equityType = await companyDb("account_types").where({ code: "EQUITY" }).first();
    kasId = crypto.randomUUID();
    await companyDb("accounts").insert({ id: kasId, code: "1000", name: "Kas", account_type_id: assetType.id, normal_balance: "debit" });
    modalId = crypto.randomUUID();
    await companyDb("accounts").insert({ id: modalId, code: "3000", name: "Modal", account_type_id: equityType.id, normal_balance: "credit" });
    await companyDb("periods").insert({ id: crypto.randomUUID(), label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  it("GET /journal-import/template -- 200, xlsx berisi Daftar Akun perusahaan", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/company-db/${slug}/journal-import/template`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("Template Jurnal.xlsx");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const daftarAkun = workbook.getWorksheet("Daftar Akun")!;
    expect(daftarAkun.getCell("A2").value).toBe("1000");
  });

  it("POST /journal-import/preview -- 200, transaksi balance VALID, canCommit true", async () => {
    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-1", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-1", "Modal", "Setoran modal", null, 1_000_000],
    ]);

    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/preview`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canCommit).toBe(true);
    expect(body.validCount).toBe(1);
  });

  it("POST /journal-import/preview -- TIDAK menulis apa pun ke DB (read-only)", async () => {
    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-2", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-2", "Modal", "Setoran modal", null, 1_000_000],
    ]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/preview`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });

    const entry = await companyDb("journal_entries").where({ reference_no: "JV-HTTP-2" }).first();
    expect(entry).toBeUndefined();
  });

  it("POST /journal-import/commit -- OWNER berhasil, jurnal masuk POSTED, audit journal.import tercatat", async () => {
    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-3", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-3", "Modal", "Setoran modal", null, 1_000_000],
    ]);

    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(200);
    expect(res.json().committedCount).toBe(1);

    const entry = await companyDb("journal_entries").where({ reference_no: "JV-HTTP-3" }).first();
    expect(entry.status).toBe("POSTED");
    expect(entry.source).toBe("import");

    const audit = await companyDb("company_audit_log").where({ action: "journal.import" }).first();
    expect(audit).toBeDefined();
  });

  it("POST /journal-import/commit -- 400 kalau ada transaksi ERROR (tidak balance)", async () => {
    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-4", "Kas", "Tidak balance", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-4", "Modal", "Tidak balance", null, 500_000],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
    expect(res.statusCode).toBe(400);

    const entry = await companyDb("journal_entries").where({ reference_no: "JV-HTTP-4" }).first();
    expect(entry).toBeUndefined();
  });

  it("POST /journal-import/commit -- STAFF (journal.create TANPA journal.post) DITOLAK 403", async () => {
    const staff = await createTestUserAndToken("Staff Import");
    await grantAccess(staff, companyId, "STAFF");

    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-5", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-5", "Modal", "Setoran modal", null, 1_000_000],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/commit`, cookies: { [SESSION_COOKIE]: staff.token }, payload: fd });
    expect(res.statusCode).toBe(403);

    const entry = await companyDb("journal_entries").where({ reference_no: "JV-HTTP-5" }).first();
    expect(entry).toBeUndefined(); // tidak diam-diam auto-post lewat jalur import
  });

  it("POST /journal-import/preview -- STAFF (punya journal.create) boleh preview", async () => {
    const staff = await createTestUserAndToken("Staff Import Preview");
    await grantAccess(staff, companyId, "STAFF");

    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-6", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-6", "Modal", "Setoran modal", null, 1_000_000],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/preview`, cookies: { [SESSION_COOKIE]: staff.token }, payload: fd });
    expect(res.statusCode).toBe(200);
  });

  it("POST /journal-import/commit -- VIEWER (tanpa journal.create) DITOLAK 403", async () => {
    const viewer = await createTestUserAndToken("Viewer Import");
    await grantAccess(viewer, companyId, "VIEWER");

    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-7", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-7", "Modal", "Setoran modal", null, 1_000_000],
    ]);
    const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/commit`, cookies: { [SESSION_COOKIE]: viewer.token }, payload: fd });
    expect(res.statusCode).toBe(403);
  });

  it("Final UAT: file rusak/bukan Excel -> 400 dgn pesan jelas (bukan 500 + pesan mentah library), di preview dan commit", async () => {
    for (const endpoint of ["preview", "commit"]) {
      const fd = new FormData();
      fd.append("file", new Blob([Buffer.from("ini bukan file excel")]), "rusak.xlsx");
      const res = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/${endpoint}`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });
      expect(res.statusCode, endpoint).toBe(400);
      // preview diteruskan ke error handler (di test app: handler bawaan Fastify, pesan di `message`).
      expect(res.json().message ?? res.json().error).toMatch(/tidak dapat dibaca/);
      expect(res.body).not.toMatch(/central directory|zip/i);
    }
  });

  it("Unauthenticated -> 401 di seluruh endpoint import", async () => {
    const fd = await buildTestWorkbookFormData([]);
    const previewRes = await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/preview`, payload: fd });
    expect(previewRes.statusCode).toBe(401);

    const templateRes = await app.inject({ method: "GET", url: `/api/company-db/${slug}/journal-import/template` });
    expect(templateRes.statusCode).toBe(401);
  });

  it("GET /journal-import/history -- menampilkan batch yang sudah di-commit", async () => {
    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-8", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-8", "Modal", "Setoran modal", null, 1_000_000],
    ]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/journal-import/history`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history).toHaveLength(1);
    expect(body.history[0].committedCount).toBe(1);
    expect(body.history[0].fileName).toBe("jurnal.xlsx");
  });

  it("Company isolation -- history Company B tidak terpengaruh import Company A", async () => {
    const fd = await buildTestWorkbookFormData([
      ["1000", "2026-01-05", "JV-HTTP-9", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV-HTTP-9", "Modal", "Setoran modal", null, 1_000_000],
    ]);
    await app.inject({ method: "POST", url: `/api/company-db/${slug}/journal-import/commit`, cookies: { [SESSION_COOKIE]: owner.token }, payload: fd });

    const slugB = `journal-import-b-${crypto.randomUUID().slice(0, 8)}`;
    const companyB = await createCompany(slugB);
    await grantAccess(owner, companyB.companyId, "OWNER");
    try {
      const res = await app.inject({ method: "GET", url: `/api/company-db/${slugB}/journal-import/history`, cookies: { [SESSION_COOKIE]: owner.token } });
      expect(res.statusCode).toBe(200);
      expect(res.json().history).toHaveLength(0);
    } finally {
      await companyB.db.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slugB), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: companyB.companyId }).del();
      await systemDb("companies_registry").where({ id: companyB.companyId }).del();
    }
  });
});
