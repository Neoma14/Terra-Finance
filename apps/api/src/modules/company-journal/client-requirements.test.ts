import "./__fixtures__/legacy-db-env.js"; // HARUS import pertama -- lihat komentar di file itu
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
import { companyAccountsRoutes } from "../company-accounts/routes.js";
import { companyLedgerRoutes } from "../company-ledger/routes.js";
import { companySearchRoutes } from "../company-search/routes.js";
import { authRoutes } from "../auth/routes.js";
import { touchSession, resolveSession, SESSION_IDLE_TIMEOUT_MS } from "../auth/session-service.js";
import { todayLocalDate, subtractDays } from "../../db/company/journal-policy.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess } from "../../db/system/company-access.js";

/**
 * Test HTTP-level Company Journal API. TASK-DB-ARCH-010 menambah
 * authorization (`requireCompanyAccess`/`requirePermission`) di depan
 * route -- setup test di bawah SEKARANG WAJIB: (1) migrate systemDb,
 * (2) daftarkan company ke `companies_registry`, (3) grant `company_access`
 * utk test user, SEBELUM memanggil endpoint journal. Ini BUKAN perubahan
 * business logic journal-service.ts -- murni prasyarat authorization yang
 * baru ditambahkan di layer route.
 */

async function migrateLegacyMasterDb(): Promise<void> {
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
  await masterDb("users").insert({
    id: userId,
    email,
    password_hash: "not-used-in-this-test",
    full_name: label,
    role: "admin",
  });
  const { token } = await createSession(userId, {});
  return { id: userId, email, fullName: label, token };
}

function companyDbPathFor(slug: string): string {
  return path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
}

async function createTestCompany(slug: string): Promise<Knex> {
  const dbPath = companyDbPathFor(slug);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();
  return db;
}

/** Daftarkan company ke `companies_registry` + grant akses (default OWNER)
 * utk satu user -- padanan setup yang SEKARANG wajib dilalui sebelum
 * `requireCompanyAccess` mengizinkan request lewat. */
async function registerCompanyAndGrantAccess(
  slug: string,
  dbPath: string,
  user: TestUser,
  role: "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER" = "OWNER",
): Promise<string> {
  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({
    id: companyId,
    slug,
    name: slug,
    database_path: dbPath,
    status: "active",
    schema_version: 12,
    last_migration_status: "READY",
  });
  const systemUserId = await ensureSystemIdentity(systemDb, {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: "admin",
    avatarUrl: null,
  });
  await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId, role });
  return companyId;
}

async function seedAccountsAndPeriod(db: Knex, periodStatus: "OPEN" | "LOCKED" | "CLOSED" = "OPEN") {
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
    status: periodStatus,
  });

  return { kasId, modalId, periodId };
}


function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(authRoutes);
  app.register(companyJournalRoutes);
  app.register(companyAccountsRoutes);
  app.register(companyLedgerRoutes);
  app.register(companySearchRoutes);
  return app;
}

const today = todayLocalDate();

describe("Permintaan klien -- HTTP", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await migrateLegacyMasterDb();
    await migrateSystemDb();
    app = buildTestApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  let owner: TestUser;
  let staff: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let accountant: TestUser;
  let dbA: Knex;
  let kasId: string;
  let modalId: string;
  let periodId: string;

  const as = (u: TestUser) => ({ [SESSION_COOKIE]: u.token });
  const lines = () => [
    { accountId: kasId, debit: 100_000, credit: 0 },
    { accountId: modalId, debit: 0, credit: 100_000 },
  ];
  async function createJournal(u: TestUser, referenceNo: string, entryDate: string) {
    return app.inject({ method: "POST", url: "/api/company-db/company-a/journal", cookies: as(u), payload: { referenceNo, periodId, entryDate, lines: lines() } });
  }
  async function postAndGetId(ref: string, date = today): Promise<string> {
    const c = await createJournal(owner, ref, date);
    expect(c.statusCode).toBe(201);
    const id = c.json().journalId as string;
    const p = await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${id}/post`, cookies: as(owner) });
    expect(p.statusCode).toBe(200);
    return id;
  }

  beforeEach(async () => {
    owner = await createTestUserAndToken("Owner");
    staff = await createTestUserAndToken("Staff");
    viewer = await createTestUserAndToken("Viewer");
    accountant = await createTestUserAndToken("Accountant");
    outsider = await createTestUserAndToken("Outsider");
    dbA = await createTestCompany("company-a");
    const seeded = await seedAccountsAndPeriod(dbA, "OPEN");
    kasId = seeded.kasId;
    modalId = seeded.modalId;
    // periode lebar yang memuat hari ini s/d 10 hari ke depan
    periodId = crypto.randomUUID();
    await dbA("periods").insert({ id: periodId, label: "Lebar", start_date: subtractDays(today, 60), end_date: subtractDays(today, -10), period_type: "month", fiscal_year: 2026, status: "OPEN" });
    await dbA("company_profile").insert({ id: crypto.randomUUID(), name: "Company A" });
    const companyId = await registerCompanyAndGrantAccess("company-a", companyDbPathFor("company-a"), owner, "OWNER");
    for (const [u, role] of [[staff, "STAFF"], [viewer, "VIEWER"], [accountant, "ACCOUNTANT"]] as const) {
      const systemUserId = await ensureSystemIdentity(systemDb, { id: u.id, email: u.email, fullName: u.fullName, role: "admin", avatarUrl: null });
      await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId, role });
    }
  });

  afterEach(async () => {
    await dbA.destroy();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, "company-a"), { recursive: true, force: true });
    const registryRow = await systemDb("companies_registry").where({ slug: "company-a" }).first();
    if (registryRow) {
      await systemDb("company_access").where({ company_id: registryRow.id }).del();
      await systemDb("companies_registry").where({ id: registryRow.id }).del();
    }
  });

  describe("Backdate & tanggal masa depan (via API)", () => {
    it("GET journal-settings: semua peran dengan akses bisa baca; tanpa session 401; bukan anggota 404", async () => {
      expect((await app.inject({ method: "GET", url: "/api/company-db/company-a/journal-settings" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/company-db/company-a/journal-settings", cookies: as(outsider) })).statusCode).toBe(404);
      const res = await app.inject({ method: "GET", url: "/api/company-db/company-a/journal-settings", cookies: as(viewer) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ maxBackdateDays: null, today });
    });

    it("PUT journal-settings: OWNER boleh, STAFF/VIEWER/ACCOUNTANT 403, nilai tidak valid 400, tercatat di audit", async () => {
      const put = (u: TestUser, v: unknown) => app.inject({ method: "PUT", url: "/api/company-db/company-a/journal-settings", cookies: as(u), payload: { maxBackdateDays: v } });
      expect((await put(staff, 7)).statusCode).toBe(403);
      expect((await put(viewer, 7)).statusCode).toBe(403);
      expect((await put(accountant, 7)).statusCode).toBe(403);
      expect((await put(outsider, 7)).statusCode).toBe(404);
      expect((await put(owner, -1)).statusCode).toBe(400);
      expect((await put(owner, 2.5)).statusCode).toBe(400);
      expect((await put(owner, "abc")).statusCode).toBe(400);
      const ok = await put(owner, 7);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().maxBackdateDays).toBe(7);
      const audit = await dbA("company_audit_log").where({ action: "journal_settings.change" });
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_id).toBe(owner.id);
    });

    it("batas 7 hari: today, today-7 valid (201); today-8 dan besok ditolak 400 -- tidak ada jalan lain lewat API", async () => {
      await app.inject({ method: "PUT", url: "/api/company-db/company-a/journal-settings", cookies: as(owner), payload: { maxBackdateDays: 7 } });
      expect((await createJournal(staff, "T0", today)).statusCode).toBe(201);
      expect((await createJournal(staff, "T7", subtractDays(today, 7))).statusCode).toBe(201);
      const old = await createJournal(staff, "T8", subtractDays(today, 8));
      expect(old.statusCode).toBe(400);
      expect(old.json().error).toMatch(/batas backdate/);
      const future = await createJournal(staff, "TF", subtractDays(today, -1));
      expect(future.statusCode).toBe(400);
      expect(future.json().error).toMatch(/lebih besar dari hari ini/);
      // jalur edit draft (PUT) memakai aturan yang sama
      const c = await createJournal(staff, "EDIT", today);
      const put = await app.inject({
        method: "PUT",
        url: `/api/company-db/company-a/journal/${c.json().journalId}`,
        cookies: as(staff),
        payload: { referenceNo: "EDIT2", periodId, entryDate: subtractDays(today, 30), lines: lines() },
      });
      expect(put.statusCode).toBe(400);
      // draft lama utuh karena transaksi di-rollback
      expect(await dbA("journal_entries").where({ reference_no: "EDIT" }).first()).toBeTruthy();
    });
  });

  describe("Lock / Unlock akun (via API)", () => {
    const lockUrl = (id: string, action: "lock" | "unlock") => `/api/company-db/company-a/accounts/${id}/${action}`;

    it("hanya OWNER/ADMIN: ACCOUNTANT/STAFF/VIEWER 403; tanpa session 401; bukan anggota 404", async () => {
      expect((await app.inject({ method: "POST", url: lockUrl(kasId, "lock") })).statusCode).toBe(401);
      for (const u of [staff, viewer, accountant]) {
        expect((await app.inject({ method: "POST", url: lockUrl(kasId, "lock"), cookies: as(u) })).statusCode).toBe(403);
      }
      expect((await app.inject({ method: "POST", url: lockUrl(kasId, "lock"), cookies: as(outsider) })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: lockUrl("tidak-ada", "lock"), cookies: as(owner) })).statusCode).toBe(404);
    });

    it("lock -> jurnal baru lewat API ditolak 409; unlock -> bisa; lock ganda 409; audit tercatat", async () => {
      const lock = await app.inject({ method: "POST", url: lockUrl(kasId, "lock"), cookies: as(owner) });
      expect(lock.statusCode).toBe(200);
      expect(lock.json().isLocked).toBe(true);
      expect((await app.inject({ method: "POST", url: lockUrl(kasId, "lock"), cookies: as(owner) })).statusCode).toBe(409);

      const blocked = await createJournal(staff, "LK1", today);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toMatch(/dikunci/);

      // daftar akun menampilkan status kunci
      const list = await app.inject({ method: "GET", url: "/api/company-db/company-a/accounts?pageSize=100", cookies: as(viewer) });
      expect(list.json().accounts.find((a: { id: string }) => a.id === kasId).isLocked).toBeTruthy();

      expect((await app.inject({ method: "POST", url: lockUrl(kasId, "unlock"), cookies: as(owner) })).statusCode).toBe(200);
      expect((await createJournal(staff, "LK2", today)).statusCode).toBe(201);

      const audit = await dbA("company_audit_log").whereIn("action", ["account.lock", "account.unlock"]);
      expect(audit).toHaveLength(2);
    });

    it("akun invalid (id tidak ada) pada jurnal -> 404, bukan 500", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: as(staff),
        payload: { referenceNo: "NOACC", periodId, entryDate: today, lines: [{ accountId: "tidak-ada", debit: 5, credit: 0 }, { accountId: modalId, debit: 0, credit: 5 }] },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Reversal Jurnal terpisah (via API)", () => {
    const rev = (u: TestUser | null, payload: unknown) =>
      app.inject({ method: "POST", url: "/api/company-db/company-a/journal/reversal", cookies: u ? as(u) : undefined, payload: payload as object });

    it("alur lengkap: tanggal reversal = tanggal asli, jurnal asli tetap ada (REVERSED), referensi ke asli, tidak bisa dua kali", async () => {
      const date = subtractDays(today, 3);
      const id = await postAndGetId("RV-1", date);

      const res = await rev(accountant, { referenceNo: "RV-1", entryDate: date, reason: "Salah input" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reversalDate).toBe(date);
      expect(body.reversalReferenceNo).toBe("RV-1-REV");

      const original = await dbA("journal_entries").where({ id }).first();
      expect(original.status).toBe("REVERSED");
      const reversal = await dbA("journal_entries").where({ id: body.reversalJournalId }).first();
      expect(String(reversal.entry_date).slice(0, 10)).toBe(date);
      expect(reversal.reversal_of_journal_id).toBe(id);
      expect(reversal.reversal_reason).toBe("Salah input");
      // debit/kredit dibalik, jurnal asli tidak dihapus
      const kasOrig = await dbA("journal_entry_lines").where({ journal_entry_id: id, account_id: kasId }).first();
      const kasRev = await dbA("journal_entry_lines").where({ journal_entry_id: body.reversalJournalId, account_id: kasId }).first();
      expect(Number(kasOrig.debit)).toBe(100_000);
      expect(Number(kasRev.credit)).toBe(100_000);

      // reversal kedua ditolak (409), tidak membuat jurnal ketiga
      const again = await rev(accountant, { referenceNo: "RV-1", entryDate: date, reason: "Lagi" });
      expect(again.statusCode).toBe(409);
      expect(await dbA("journal_entries").count<{ c: number }[]>("* as c").then((r) => r[0].c)).toBe(2);
    });

    it("tanggal tidak sama dengan jurnal asli -> 400; referensi tidak ada -> 404; alasan/field kosong -> 400", async () => {
      await postAndGetId("RV-2", subtractDays(today, 3));
      const wrongDate = await rev(accountant, { referenceNo: "RV-2", entryDate: today, reason: "x" });
      expect(wrongDate.statusCode).toBe(400);
      expect(wrongDate.json().error).toMatch(/tidak cocok/);
      expect((await rev(accountant, { referenceNo: "TIDAK-ADA", entryDate: today, reason: "x" })).statusCode).toBe(404);
      expect((await rev(accountant, { referenceNo: "RV-2", entryDate: subtractDays(today, 3), reason: "   " })).statusCode).toBe(400);
      expect((await rev(accountant, { referenceNo: "RV-2", entryDate: subtractDays(today, 3) })).statusCode).toBe(400);
      expect((await dbA("journal_entries").where({ reference_no: "RV-2" }).first()).status).toBe("POSTED");
    });

    it("draft tidak bisa direversal (409); permission: STAFF/VIEWER 403, tanpa session 401, bukan anggota 404", async () => {
      await createJournal(owner, "RV-DRAFT", today);
      expect((await rev(accountant, { referenceNo: "RV-DRAFT", entryDate: today, reason: "x" })).statusCode).toBe(409);
      expect((await rev(staff, { referenceNo: "RV-DRAFT", entryDate: today, reason: "x" })).statusCode).toBe(403);
      expect((await rev(viewer, { referenceNo: "RV-DRAFT", entryDate: today, reason: "x" })).statusCode).toBe(403);
      expect((await rev(null, { referenceNo: "RV-DRAFT", entryDate: today, reason: "x" })).statusCode).toBe(401);
      expect((await rev(outsider, { referenceNo: "RV-DRAFT", entryDate: today, reason: "x" })).statusCode).toBe(404);
    });

    it("route lama /journal/:id/reverse tidak lagi bisa dipakai untuk tanggal/periode lain (400) dan memakai tanggal asli bila kosong", async () => {
      const date = subtractDays(today, 2);
      const id = await postAndGetId("RV-3", date);
      const bad = await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${id}/reverse`, cookies: as(accountant), payload: { reason: "x", reversalEntryDate: today } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${id}/reverse`, cookies: as(accountant), payload: { reason: "x" } });
      expect(ok.statusCode).toBe(200);
      const reversal = await dbA("journal_entries").where({ id: ok.json().reversalJournalId }).first();
      expect(String(reversal.entry_date).slice(0, 10)).toBe(date);
    });

    it("konsistensi akuntansi setelah reversal: Ledger dan Trial Balance sama-sama bersih", async () => {
      const date = subtractDays(today, 1);
      await postAndGetId("KEEP", date);
      await postAndGetId("UNDO", date);
      await rev(accountant, { referenceNo: "UNDO", entryDate: date, reason: "batal" });
      const ledger = await app.inject({ method: "GET", url: `/api/company-db/company-a/ledger/${kasId}?fromDate=${subtractDays(today, 5)}&toDate=${today}`, cookies: as(viewer) });
      expect(ledger.statusCode).toBe(200);
      expect(ledger.json().endingBalance).toBe(100_000); // KEEP saja; UNDO + reversal-nya saling meniadakan
      const tb = await app.inject({ method: "GET", url: `/api/company-db/company-a/trial-balance?periodId=${periodId}`, cookies: as(viewer) });
      expect(tb.json().isBalanced).toBe(true);
    });
  });

  describe("Ledger rentang tanggal (via API)", () => {
    const url = (q: string) => `/api/company-db/company-a/ledger/${kasId}?${q}`;

    it("401 / 404 (bukan anggota) / 404 akun tidak ada / 400 tanpa tanggal / 400 tanggal invalid / 400 from>to", async () => {
      expect((await app.inject({ method: "GET", url: url(`fromDate=${today}&toDate=${today}`) })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: url(`fromDate=${today}&toDate=${today}`), cookies: as(outsider) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/company-db/company-a/ledger/tidak-ada?fromDate=${today}&toDate=${today}`, cookies: as(viewer) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: url(""), cookies: as(viewer) })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: url(`fromDate=2026-02-30&toDate=2026-03-01`), cookies: as(viewer) })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: url(`fromDate=abc&toDate=2026-03-01`), cookies: as(viewer) })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: url(`fromDate=2026-03-05&toDate=2026-03-01`), cookies: as(viewer) })).statusCode).toBe(400);
    });

    it("rentang menghasilkan transaksi pada fromDate dan toDate (inklusif) dan saldo awal benar", async () => {
      await postAndGetId("LD-1", subtractDays(today, 10));
      await postAndGetId("LD-2", subtractDays(today, 5));
      await postAndGetId("LD-3", subtractDays(today, 1));
      const res = await app.inject({ method: "GET", url: url(`fromDate=${subtractDays(today, 5)}&toDate=${subtractDays(today, 1)}`), cookies: as(viewer) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lines.map((l: { referenceNo: string }) => l.referenceNo)).toEqual(["LD-2", "LD-3"]);
      expect(body.openingBalance).toBe(100_000);
      expect(body.endingBalance).toBe(300_000);
    });

    it("isolasi company: user hanya punya akses company-a tidak bisa baca ledger company-b", async () => {
      const dbB = await createTestCompany("company-b");
      try {
        const sb = await seedAccountsAndPeriod(dbB, "OPEN");
        await registerCompanyAndGrantAccess("company-b", companyDbPathFor("company-b"), outsider, "OWNER");
        const res = await app.inject({ method: "GET", url: `/api/company-db/company-b/ledger/${sb.kasId}?fromDate=${today}&toDate=${today}`, cookies: as(viewer) });
        expect(res.statusCode).toBe(404);
        const ok = await app.inject({ method: "GET", url: `/api/company-db/company-b/ledger/${sb.kasId}?fromDate=${today}&toDate=${today}`, cookies: as(outsider) });
        expect(ok.statusCode).toBe(200);
      } finally {
        await dbB.destroy();
        fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, "company-b"), { recursive: true, force: true });
        const row = await systemDb("companies_registry").where({ slug: "company-b" }).first();
        if (row) {
          await systemDb("company_access").where({ company_id: row.id }).del();
          await systemDb("companies_registry").where({ id: row.id }).del();
        }
      }
    });
  });

  describe("Pencarian global (via API)", () => {
    const search = (q: string, u: TestUser | null) => app.inject({ method: "GET", url: `/api/company-db/company-a/search?q=${encodeURIComponent(q)}`, cookies: u ? as(u) : undefined });

    it("401 tanpa session, 404 bukan anggota, kosong untuk query < 2 huruf", async () => {
      expect((await search("kas", null)).statusCode).toBe(401);
      expect((await search("kas", outsider)).statusCode).toBe(404);
      expect((await search("k", viewer)).json()).toEqual({ journals: [], accounts: [] });
    });

    it("menemukan transaksi dari nomor, tanggal, nominal, dan nama akun; menemukan akun dari kode/nama", async () => {
      await postAndGetId("SRCH-777", subtractDays(today, 2));
      const byRef = await search("srch-777", viewer);
      expect(byRef.json().journals.map((j: { referenceNo: string }) => j.referenceNo)).toEqual(["SRCH-777"]);
      expect((await search(subtractDays(today, 2), viewer)).json().journals).toHaveLength(1);
      expect((await search("Rp 100.000", viewer)).json().journals).toHaveLength(1);
      expect((await search("100000", viewer)).json().journals).toHaveLength(1);
      expect((await search("modal", viewer)).json().journals).toHaveLength(1); // lewat nama akun di barisnya
      const acc = await search("kas", viewer);
      expect(acc.json().accounts.map((a: { code: string }) => a.code)).toEqual(["1000"]);
    });

    it("karakter wildcard LIKE diperlakukan literal (tidak mencocokkan semua)", async () => {
      await postAndGetId("WILD-1", today);
      expect((await search("%%", viewer)).json().journals).toHaveLength(0);
      expect((await search("__", viewer)).json().journals).toHaveLength(0);
    });
  });

  describe("Sesi idle 15 menit (server)", () => {
    it("sesi segar valid; idle > 15 menit ditolak (401); ping aktivitas memperpanjang; sesi idle tidak bisa dihidupkan lagi", async () => {
      const me = (u: TestUser) => app.inject({ method: "GET", url: "/api/auth/me", cookies: as(u) });
      expect((await me(owner)).statusCode).toBe(200);

      const ping = await app.inject({ method: "POST", url: "/api/auth/activity", cookies: as(owner) });
      expect(ping.statusCode).toBe(200);

      // permintaan biasa (me) TIDAK memperpanjang sesi
      await masterDb("sessions").where({ user_id: owner.id }).update({ last_activity_at: new Date(Date.now() - (SESSION_IDLE_TIMEOUT_MS - 5_000)).toISOString() });
      expect((await me(owner)).statusCode).toBe(200);
      const row = await masterDb("sessions").where({ user_id: owner.id }).first();
      expect(new Date(row.last_activity_at).getTime()).toBeLessThan(Date.now() - (SESSION_IDLE_TIMEOUT_MS - 10_000));

      // ping memperpanjang
      expect((await app.inject({ method: "POST", url: "/api/auth/activity", cookies: as(owner) })).statusCode).toBe(200);
      const after = await masterDb("sessions").where({ user_id: owner.id }).first();
      expect(Date.now() - new Date(after.last_activity_at).getTime()).toBeLessThan(5_000);

      // idle melewati batas -> semua ditolak, termasuk ping
      await masterDb("sessions").where({ user_id: owner.id }).update({ last_activity_at: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1_000).toISOString() });
      expect((await me(owner)).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/activity", cookies: as(owner) })).statusCode).toBe(401);
      expect(await touchSession(owner.token)).toBe(false);
      expect(await resolveSession(owner.token)).toBeNull();
      // endpoint bisnis ikut menolak
      expect((await app.inject({ method: "GET", url: "/api/company-db/company-a/journal-settings", cookies: as(owner) })).statusCode).toBe(401);
    });

    it("ping tanpa session -> 401", async () => {
      expect((await app.inject({ method: "POST", url: "/api/auth/activity" })).statusCode).toBe(401);
    });
  });
});
