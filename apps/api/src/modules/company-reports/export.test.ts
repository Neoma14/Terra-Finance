import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import ExcelJS from "exceljs";
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
import { createAccount } from "../../db/company/account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "../../db/company/journal-service.js";
import { getBalanceSheet } from "../../db/company/reporting/balance-sheet-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import type { CompanyRole } from "../../db/system/rbac.js";

/**
 * HTTP test untuk export laporan (TASK-EXPORT). Fokus: gate auth/company
 * access/isolasi, validasi parameter, format file valid, dan angka di
 * Excel SAMA dengan service laporan (sumber yang sama dgn UI).
 */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ACTOR: ActorContext = { actorType: "user", actorId: "seed", actorLabel: "Seed" };
const COMPANY_NAME = "PT EXPORT TEST";

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

async function createCompany(slug: string, name: string): Promise<{ db: Knex; companyId: string }> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();
  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({ id: companyId, slug, name, database_path: dbPath, status: "active", schema_version: 12, last_migration_status: "READY" });
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

async function sheetRows(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS mengetik Buffer dari versi @types/node lama; cast hanya utk tipe, data tidak berubah.
  await wb.xlsx.load(buffer as never); // tipe Buffer ExcelJS berbeda dgn @types/node; data tidak berubah
  return wb.worksheets[0];
}

describe("Export laporan (TASK-EXPORT) -- HTTP", () => {
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
    slug = `export-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createCompany(slug, COMPANY_NAME);
    companyDb = created.db;
    companyId = created.companyId;
    owner = await createTestUserAndToken("Owner Export");
    await grantAccess(owner, companyId, "OWNER");

    kasId = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, ACTOR)).id;
    modalId = (await createAccount(companyDb, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, ACTOR)).id;
    periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    const entry = await createDraftJournalEntry(companyDb, { entryDate: "2026-01-05", periodId, referenceNo: "OB-0001", isOpeningBalance: true, lines: [
      { accountId: kasId, debit: 1_000_000, credit: 0 },
      { accountId: modalId, debit: 0, credit: 1_000_000 },
    ] }, ACTOR);
    await postJournalEntry(companyDb, { journalEntryId: entry.id }, ACTOR);
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
  });

  const exportUrl = (kind: string, query: Record<string, string>) =>
    `/api/company-db/${slug}/reports/export/${kind}?${new URLSearchParams(query).toString()}`;

  it("401 tanpa login", async () => {
    const res = await app.inject({ method: "GET", url: exportUrl("balance-sheet", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31" }) });
    expect(res.statusCode).toBe(401);
  });

  it("404 generic untuk user tanpa company_access (tidak bisa membedakan 'tidak ada' vs 'tidak punya akses')", async () => {
    const stranger = await createTestUserAndToken("Stranger");
    const res = await app.inject({
      method: "GET",
      url: exportUrl("balance-sheet", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31" }),
      cookies: { [SESSION_COOKIE]: stranger.token },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(COMPANY_NAME);
  });

  it("404 kalau company_access SUSPENDED", async () => {
    const suspended = await createTestUserAndToken("Suspended");
    await grantAccess(suspended, companyId, "VIEWER", "SUSPENDED");
    const res = await app.inject({
      method: "GET",
      url: exportUrl("balance-sheet", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31" }),
      cookies: { [SESSION_COOKIE]: suspended.token },
    });
    expect(res.statusCode).toBe(404);
  });

  it("company isolation: user yg hanya punya akses ke company lain tidak bisa export company ini lewat URL", async () => {
    const otherSlug = `export-other-${crypto.randomUUID().slice(0, 8)}`;
    const other = await createCompany(otherSlug, "PT LAIN");
    const outsider = await createTestUserAndToken("Outsider");
    await grantAccess(outsider, other.companyId, "OWNER");
    try {
      const res = await app.inject({
        method: "GET",
        url: exportUrl("balance-sheet", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31" }),
        cookies: { [SESSION_COOKIE]: outsider.token },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await other.db.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, otherSlug), { recursive: true, force: true });
      await systemDb("company_access").where({ company_id: other.companyId }).del();
      await systemDb("companies_registry").where({ id: other.companyId }).del();
    }
  });

  it("400 kalau format bukan xlsx/pdf; 404 kalau jenis laporan tidak dikenal", async () => {
    const badFormat = await app.inject({
      method: "GET",
      url: exportUrl("balance-sheet", { format: "csv", fromDate: "2026-01-01", toDate: "2026-01-31" }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(badFormat.statusCode).toBe(400);

    const badKind = await app.inject({
      method: "GET",
      url: exportUrl("payroll", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31" }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(badKind.statusCode).toBe(404);
  });

  it("400 kalau rentang tanggal kosong atau fromDate > toDate", async () => {
    const missing = await app.inject({ method: "GET", url: exportUrl("income-statement", { format: "pdf" }), cookies: { [SESSION_COOKIE]: owner.token } });
    expect(missing.statusCode).toBe(400);

    const reversed = await app.inject({
      method: "GET",
      url: exportUrl("income-statement", { format: "pdf", fromDate: "2026-02-01", toDate: "2026-01-01" }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(reversed.statusCode).toBe(400);
  });

  it("Balance Sheet .xlsx: 200, MIME benar, nama file aman, angka Total Assets SAMA dgn service laporan", async () => {
    const res = await app.inject({
      method: "GET",
      url: exportUrl("balance-sheet", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31" }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(XLSX_MIME);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="PT-EXPORT-TEST-Neraca-2026-01-01-2026-01-31.xlsx"`);

    const sheet = await sheetRows(res.rawPayload);
    expect(sheet.getCell(1, 1).value).toBe(COMPANY_NAME);
    expect(sheet.getCell(2, 1).value).toBe("Neraca (Balance Sheet)");
    expect(sheet.getCell(3, 1).value).toBe("Periode: 01 Januari 2026 - 31 Januari 2026");

    const expected = await getBalanceSheet(companyDb, "2026-01-01", "2026-01-31");
    let found: unknown = undefined;
    sheet.eachRow((row) => {
      if (row.getCell(2).value === "Total Assets") found = row.getCell(3).value;
    });
    expect(found).toBe(expected.totalAssets);
    expect(expected.totalAssets).toBe(1_000_000);
  });

  it("Balance Sheet .pdf: 200, file PDF valid (header %PDF, trailer %%EOF), nama file .pdf", async () => {
    const res = await app.inject({
      method: "GET",
      url: exportUrl("balance-sheet", { format: "pdf", fromDate: "2026-01-01", toDate: "2026-01-31" }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain(".pdf");
    const body = res.rawPayload;
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("semua jenis laporan utk xlsx dan pdf mengembalikan 200", async () => {
    const dateRangeKinds = ["balance-sheet", "income-statement", "equity", "cash-flow"];
    for (const kind of dateRangeKinds) {
      for (const format of ["xlsx", "pdf"]) {
        const res = await app.inject({
          method: "GET",
          url: exportUrl(kind, { format, fromDate: "2026-01-01", toDate: "2026-01-31" }),
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        expect(res.statusCode, `${kind}.${format}`).toBe(200);
      }
    }
    for (const format of ["xlsx", "pdf"]) {
      const tb = await app.inject({ method: "GET", url: exportUrl("trial-balance", { format, periodId }), cookies: { [SESSION_COOKIE]: owner.token } });
      expect(tb.statusCode, `trial-balance.${format}`).toBe(200);
      const ledger = await app.inject({ method: "GET", url: exportUrl("ledger", { format, periodId, accountId: kasId }), cookies: { [SESSION_COOKIE]: owner.token } });
      expect(ledger.statusCode, `ledger.${format}`).toBe(200);
    }
  });

  it("Trial Balance .xlsx: nama file memakai periode, total debit = total kredit, angka sama dgn service", async () => {
    const res = await app.inject({
      method: "GET",
      url: exportUrl("trial-balance", { format: "xlsx", periodId }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="PT-EXPORT-TEST-Neraca-Saldo-2026-01-01-2026-01-31.xlsx"`);
    const sheet = await sheetRows(res.rawPayload);
    let totals: unknown[] = [];
    sheet.eachRow((row) => {
      if (row.getCell(2).value === "Total") totals = [row.getCell(3).value, row.getCell(4).value];
    });
    expect(totals).toEqual([1_000_000, 1_000_000]);
  });

  it("Ledger: 404 kalau akun tidak ada; 400 kalau accountId kosong", async () => {
    const missingAccount = await app.inject({
      method: "GET",
      url: exportUrl("ledger", { format: "xlsx", periodId, accountId: "akun-tidak-ada" }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(missingAccount.statusCode).toBe(404);

    const noAccount = await app.inject({
      method: "GET",
      url: exportUrl("ledger", { format: "xlsx", periodId }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(noAccount.statusCode).toBe(400);
  });

  it("Ledger .xlsx: nama file menyertakan kode akun, saldo akhir sama dgn Kas 1.000.000", async () => {
    const res = await app.inject({
      method: "GET",
      url: exportUrl("ledger", { format: "xlsx", periodId, accountId: kasId }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="PT-EXPORT-TEST-Buku-Besar-1000-2026-01-01-2026-01-31.xlsx"`);
    const sheet = await sheetRows(res.rawPayload);
    let ending: unknown = undefined;
    sheet.eachRow((row) => {
      if (row.getCell(3).value === "Saldo Akhir") ending = row.getCell(6).value;
    });
    expect(ending).toBe(1_000_000);
  });

  it("Ledger per RENTANG TANGGAL .xlsx/.pdf: nama file memakai tanggal, saldo akhir sama dgn per periode; rentang terbalik/tidak valid -> 400", async () => {
    const byRange = await app.inject({
      method: "GET",
      url: exportUrl("ledger", { format: "xlsx", fromDate: "2026-01-01", toDate: "2026-01-31", accountId: kasId }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(byRange.statusCode).toBe(200);
    expect(byRange.headers["content-disposition"]).toBe(`attachment; filename="PT-EXPORT-TEST-Buku-Besar-1000-2026-01-01-2026-01-31.xlsx"`);
    const sheet = await sheetRows(byRange.rawPayload);
    let ending: unknown = undefined;
    sheet.eachRow((row) => {
      if (row.getCell(3).value === "Saldo Akhir") ending = row.getCell(6).value;
    });
    expect(ending).toBe(1_000_000);

    const pdf = await app.inject({
      method: "GET",
      url: exportUrl("ledger", { format: "pdf", fromDate: "2026-01-01", toDate: "2026-01-31", accountId: kasId }),
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    for (const [from, to] of [["2026-01-31", "2026-01-01"], ["2026-02-30", "2026-03-01"]]) {
      const bad = await app.inject({
        method: "GET",
        url: exportUrl("ledger", { format: "xlsx", fromDate: from, toDate: to, accountId: kasId }),
        cookies: { [SESSION_COOKIE]: owner.token },
      });
      expect(bad.statusCode, `${from}..${to}`).toBe(400);
    }
  });
});
