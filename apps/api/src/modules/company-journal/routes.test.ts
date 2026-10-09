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
  app.register(companyJournalRoutes);
  return app;
}

describe("Company Journal API (TASK-DB-ARCH-007/010)", () => {
  let app: FastifyInstance;
  let user: TestUser;

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

  beforeEach(async () => {
    user = await createTestUserAndToken(`Konsultan ${crypto.randomUUID().slice(0, 8)}`);
  });

  it("Test 1: request tanpa session -> 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/company-db/company-a/journal", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("Test 17: company tidak terdaftar di registry -> 404 (authorization gate, sebelum journal service)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/company-db/company-yang-tidak-ada/journal",
      cookies: { [SESSION_COOKIE]: user.token },
      payload: { referenceNo: "JRN-X", periodId: "x", entryDate: "2026-01-01", lines: [{ accountId: "a", debit: 1, credit: 0 }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.payload).not.toContain(TEST_COMPANY_DATA_ROOT);
  });

  describe("dengan Company A siap (OPEN period, user punya access OWNER)", () => {
    let dbA: Knex;
    let kasId: string;
    let modalId: string;
    let periodId: string;

    beforeEach(async () => {
      dbA = await createTestCompany("company-a");
      const seeded = await seedAccountsAndPeriod(dbA, "OPEN");
      kasId = seeded.kasId;
      modalId = seeded.modalId;
      periodId = seeded.periodId;
      await registerCompanyAndGrantAccess("company-a", companyDbPathFor("company-a"), user, "OWNER");
    });

    afterEach(async () => {
      await dbA.destroy();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, "company-a"), { recursive: true, force: true });
      // systemDb adalah singleton (1 file utk seluruh test di file ini,
      // TIDAK di-recreate per test seperti dbA) -- bersihkan registry+access
      // "company-a" supaya test berikutnya bisa daftar ulang slug yang sama.
      const registryRow = await systemDb("companies_registry").where({ slug: "company-a" }).first();
      if (registryRow) {
        await systemDb("company_access").where({ company_id: registryRow.id }).del();
        await systemDb("companies_registry").where({ id: registryRow.id }).del();
      }
    });

    function balancedLinesPayload() {
      return [
        { accountId: kasId, debit: 100_000, credit: 0 },
        { accountId: modalId, debit: 0, credit: 100_000 },
      ];
    }

    it("UAT-011: baris debit+kredit sekaligus / nol-nol / negatif via API langsung -> 400 terkontrol (bukan 500), DB tidak berubah", async () => {
      const count = async () => ({
        j: Number((await dbA("journal_entries").count<{ c: number }[]>("* as c"))[0].c),
        l: Number((await dbA("journal_entry_lines").count<{ c: number }[]>("* as c"))[0].c),
        a: Number((await dbA("company_audit_log").count<{ c: number }[]>("* as c"))[0].c),
      });
      const before = await count();
      const cases: Array<[string, unknown[]]> = [
        ["both", [{ accountId: kasId, debit: 100_000, credit: 50_000 }, { accountId: modalId, debit: 0, credit: 50_000 }]],
        ["both-balanced", [{ accountId: kasId, debit: 100_000, credit: 100_000 }, { accountId: modalId, debit: 0, credit: 0 }]],
        ["zero-zero-extra", [{ accountId: kasId, debit: 100_000, credit: 0 }, { accountId: modalId, debit: 0, credit: 100_000 }, { accountId: kasId, debit: 0, credit: 0 }]],
        ["negative-debit", [{ accountId: kasId, debit: -100_000, credit: 0 }, { accountId: modalId, debit: 0, credit: -100_000 }]],
        ["not-a-number", [{ accountId: kasId, debit: "100000", credit: 0 }, { accountId: modalId, debit: 0, credit: 100_000 }]],
      ];
      for (const [name, lines] of cases) {
        const res = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: `JRN-BAD-${name}`, periodId, entryDate: "2026-01-05", lines },
        });
        expect(res.statusCode, name).toBe(400);
        expect(res.payload, name).not.toMatch(/SQLITE|constraint|chk_/i);
      }
      expect(await count()).toEqual(before);
    });

    it("UAT-011: pesan penolakan debit+kredit jelas; jurnal valid sesudahnya tetap bisa dibuat dan diposting", async () => {
      const bad = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-BOTH", periodId, entryDate: "2026-01-05", lines: [{ accountId: kasId, debit: 100_000, credit: 50_000 }, { accountId: modalId, debit: 0, credit: 50_000 }] },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/debit dan kredit sekaligus/);
      const ok = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-OK", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      expect(ok.statusCode).toBe(201);
      const post = await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${ok.json().journalId}/post`, cookies: { [SESSION_COOKIE]: user.token } });
      expect(post.statusCode).toBe(200);
    });

    it("Test 2,5,6,7: request dgn session+access valid -> create journal DRAFT, audit journal.create, actor dari session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0001", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.status).toBe("DRAFT");

      const entry = await dbA("journal_entries").where({ id: body.journalId }).first();
      expect(entry.status).toBe("DRAFT");

      const audit = await dbA("company_audit_log").where({ action: "journal.create", entity_id: body.journalId }).first();
      expect(audit).toBeDefined();
      expect(audit.actor_label).toBe(user.fullName);
    });

    it("Test 21: actorId pada body diabaikan -- actor tetap dari session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: {
          referenceNo: "JRN-0002",
          periodId,
          entryDate: "2026-01-05",
          lines: balancedLinesPayload(),
          actorId: "orang-lain-yang-dipaksakan",
        },
      });
      expect(res.statusCode).toBe(201);
      const audit = await dbA("company_audit_log").where({ action: "journal.create", entity_id: res.json().journalId }).first();
      expect(audit.actor_label).toBe(user.fullName);
      expect(audit.actor_id).not.toBe("orang-lain-yang-dipaksakan");
    });

    it("BUG-001: jurnal memakai akun nonaktif -> 409 dgn pesan aman (bukan 500), tidak ada jurnal tersimpan", async () => {
      await dbA("accounts").where({ id: kasId }).update({ is_active: 0 });
      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-BUG001", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/tidak aktif/);
      const count = await dbA("journal_entries").where({ reference_no: "JRN-BUG001" }).count<{ c: number }[]>("* as c");
      expect(Number(count[0].c)).toBe(0);
    });

    it("BUG-001: jurnal memakai akun yang tidak ada -> 404 (bukan 500)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: {
          referenceNo: "JRN-BUG001B",
          periodId,
          entryDate: "2026-01-05",
          lines: [
            { accountId: "akun-tidak-ada", debit: 100_000, credit: 0 },
            { accountId: modalId, debit: 0, credit: 100_000 },
          ],
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it("Final UAT: tanggal tidak valid / di luar periode -> 400; nomor referensi duplikat -> 409 (bukan 500)", async () => {
      const send = (referenceNo: string, entryDate: string) =>
        app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo, periodId, entryDate, lines: balancedLinesPayload() },
        });
      expect((await send("JRN-UAT-BAD", "2026-13-45")).statusCode).toBe(400);
      expect((await send("JRN-UAT-OUT", "2026-03-15")).statusCode).toBe(400);
      expect((await send("JRN-UAT-DUP", "2026-01-05")).statusCode).toBe(201);
      const dup = await send("JRN-UAT-DUP", "2026-01-06");
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toMatch(/sudah dipakai/);
      expect(await dbA("journal_entries").whereIn("reference_no", ["JRN-UAT-BAD", "JRN-UAT-OUT"])).toHaveLength(0);
    });

    it("Test 8,9,10: post journal -> POSTED, audit journal.post, actor dari session", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0003", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      const journalId = createRes.json().journalId;

      const postRes = await app.inject({
        method: "POST",
        url: `/api/company-db/company-a/journal/${journalId}/post`,
        cookies: { [SESSION_COOKIE]: user.token },
      });
      expect(postRes.statusCode).toBe(200);
      expect(postRes.json().status).toBe("POSTED");

      const entry = await dbA("journal_entries").where({ id: journalId }).first();
      expect(entry.status).toBe("POSTED");

      const audit = await dbA("company_audit_log").where({ action: "journal.post", entity_id: journalId }).first();
      expect(audit).toBeDefined();
      expect(audit.actor_label).toBe(user.fullName);
    });

    it("Test 11,12,13,14: reverse journal -> original REVERSED, reversal POSTED, audit tertelusur", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0004", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      const journalId = createRes.json().journalId;
      await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${journalId}/post`, cookies: { [SESSION_COOKIE]: user.token } });

      const reverseRes = await app.inject({
        method: "POST",
        url: `/api/company-db/company-a/journal/${journalId}/reverse`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { targetPeriodId: periodId, reason: "Koreksi nominal" },
      });
      expect(reverseRes.statusCode).toBe(200);
      const body = reverseRes.json();
      expect(body.originalJournalId).toBe(journalId);
      expect(body.reversalJournalId).toBeDefined();

      const original = await dbA("journal_entries").where({ id: journalId }).first();
      expect(original.status).toBe("REVERSED");
      const reversal = await dbA("journal_entries").where({ id: body.reversalJournalId }).first();
      expect(reversal.status).toBe("POSTED");

      const audit = await dbA("company_audit_log").where({ action: "journal.reverse", entity_id: journalId }).first();
      expect(audit).toBeDefined();
      expect(JSON.parse(audit.after_json).reversalJournalId).toBe(body.reversalJournalId);
    });

    it("Test 18: post journal yang sudah POSTED -> 409", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0005", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      const journalId = createRes.json().journalId;
      await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${journalId}/post`, cookies: { [SESSION_COOKIE]: user.token } });

      const secondPost = await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${journalId}/post`, cookies: { [SESSION_COOKIE]: user.token } });
      expect(secondPost.statusCode).toBe(409);
    });

    it("Test 19: reverse journal yang bukan POSTED (masih DRAFT) -> 409", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0006", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      const journalId = createRes.json().journalId;

      const reverseRes = await app.inject({
        method: "POST",
        url: `/api/company-db/company-a/journal/${journalId}/reverse`,
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { targetPeriodId: periodId, reason: "Percobaan invalid" },
      });
      expect(reverseRes.statusCode).toBe(409);
    });

    it("Test 15: periode CLOSED -> create & post ditolak", async () => {
      await dbA("periods").where({ id: periodId }).update({ status: "CLOSED" });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0007", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      expect(createRes.statusCode).toBe(409);
    });

    it("Test 16: periode LOCKED -> create & post ditolak", async () => {
      await dbA("periods").where({ id: periodId }).update({ status: "LOCKED" });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0008", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      expect(createRes.statusCode).toBe(409);
    });

    it("Test 20: audit gagal -> accounting mutation ROLLBACK (tidak ada partial state)", async () => {
      await dbA.schema.dropTable("company_audit_log");

      const res = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-0009", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      expect(res.statusCode).toBe(500);
      expect(res.payload).not.toMatch(/insert into|select .* from|no such table/i);

      const entries = await dbA("journal_entries").where({ reference_no: "JRN-0009" });
      expect(entries).toHaveLength(0);
    });

    it("Test 3,4: company isolation -- journal Company A tidak muncul di Company B", async () => {
      const dbB = await createTestCompany("company-b");
      try {
        await seedAccountsAndPeriod(dbB, "OPEN");
        await registerCompanyAndGrantAccess("company-b", companyDbPathFor("company-b"), user, "OWNER");

        const res = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-ISOLATION", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        expect(res.statusCode).toBe(201);

        const inA = await dbA("journal_entries").where({ reference_no: "JRN-ISOLATION" });
        const inB = await dbB("journal_entries").where({ reference_no: "JRN-ISOLATION" });
        expect(inA).toHaveLength(1);
        expect(inB).toHaveLength(0);
      } finally {
        await dbB.destroy();
        fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, "company-b"), { recursive: true, force: true });
      }
    });

    it("Test 22: dua request berurutan dgn actor berbeda (keduanya punya access) tidak saling bocor", async () => {
      const otherUser = await createTestUserAndToken("Konsultan Lain");
      const systemUserIdOther = await ensureSystemIdentity(systemDb, {
        id: otherUser.id,
        email: otherUser.email,
        fullName: otherUser.fullName,
        role: "admin",
        avatarUrl: null,
      });
      const registryRow = await systemDb("companies_registry").where({ slug: "company-a" }).first();
      await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId: systemUserIdOther, companyId: registryRow.id, role: "OWNER" });

      const res1 = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: user.token },
        payload: { referenceNo: "JRN-ACTOR-1", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });
      const res2 = await app.inject({
        method: "POST",
        url: "/api/company-db/company-a/journal",
        cookies: { [SESSION_COOKIE]: otherUser.token },
        payload: { referenceNo: "JRN-ACTOR-2", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
      });

      const audit1 = await dbA("company_audit_log").where({ entity_id: res1.json().journalId }).first();
      const audit2 = await dbA("company_audit_log").where({ entity_id: res2.json().journalId }).first();
      expect(audit1.actor_label).toBe(user.fullName);
      expect(audit2.actor_label).toBe("Konsultan Lain");
      expect(audit1.actor_label).not.toBe(audit2.actor_label);
    });

    describe("TASK-DB-ARCH-014: GET /journals filter/pagination, DELETE, PUT (edit draft)", () => {
      it("GET /journals -- filter search (referenceNo) + fromDate/toDate + pagination", async () => {
        await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-FILTER-A", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-FILTER-B", periodId, entryDate: "2026-01-20", lines: balancedLinesPayload() },
        });

        const searchRes = await app.inject({
          method: "GET",
          url: "/api/company-db/company-a/journals?search=filter-a",
          cookies: { [SESSION_COOKIE]: user.token },
        });
        expect(searchRes.statusCode).toBe(200);
        expect(searchRes.json().journals).toHaveLength(1);
        expect(searchRes.json().journals[0].referenceNo).toBe("JRN-FILTER-A");

        const dateRes = await app.inject({
          method: "GET",
          url: "/api/company-db/company-a/journals?fromDate=2026-01-15&toDate=2026-01-31",
          cookies: { [SESSION_COOKIE]: user.token },
        });
        expect(dateRes.json().journals).toHaveLength(1);
        expect(dateRes.json().journals[0].referenceNo).toBe("JRN-FILTER-B");

        const pageRes = await app.inject({
          method: "GET",
          url: "/api/company-db/company-a/journals?pageSize=1&page=1",
          cookies: { [SESSION_COOKIE]: user.token },
        });
        expect(pageRes.json().journals).toHaveLength(1);
        expect(pageRes.json().total).toBeGreaterThanOrEqual(2);
        expect(pageRes.json().pageSize).toBe(1);
      });

      it("DELETE /journal/:id -- berhasil hapus DRAFT", async () => {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-DEL-1", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        const journalId = createRes.json().journalId;

        const delRes = await app.inject({
          method: "DELETE",
          url: `/api/company-db/company-a/journal/${journalId}`,
          cookies: { [SESSION_COOKIE]: user.token },
        });
        expect(delRes.statusCode).toBe(200);
        const entry = await dbA("journal_entries").where({ id: journalId }).first();
        expect(entry).toBeUndefined();
      });

      it("DELETE /journal/:id -- DITOLAK 409 kalau sudah POSTED", async () => {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-DEL-2", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        const journalId = createRes.json().journalId;
        await app.inject({ method: "POST", url: `/api/company-db/company-a/journal/${journalId}/post`, cookies: { [SESSION_COOKIE]: user.token } });

        const delRes = await app.inject({
          method: "DELETE",
          url: `/api/company-db/company-a/journal/${journalId}`,
          cookies: { [SESSION_COOKIE]: user.token },
        });
        expect(delRes.statusCode).toBe(409);
        const entry = await dbA("journal_entries").where({ id: journalId }).first();
        expect(entry.status).toBe("POSTED");
      });

      it("DELETE/PUT /journal/:id -- STAFF (tanpa journal.create tambahan selain create) tetap boleh (gate journal.create)", async () => {
        // STAFF punya journal.create (lihat db/system/rbac.ts) -- memverifikasi
        // gate yang dipasang pada DELETE/PUT memang journal.create, bukan
        // sengaja terlalu ketat/longgar.
        const staff = await createTestUserAndToken(`Staff ${crypto.randomUUID().slice(0, 8)}`);
        const systemUserId = await ensureSystemIdentity(systemDb, { id: staff.id, email: staff.email, fullName: staff.fullName, role: "admin", avatarUrl: null });
        const registryRow = await systemDb("companies_registry").where({ slug: "company-a" }).first();
        await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId: registryRow.id, role: "STAFF" });

        const createRes = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: staff.token },
          payload: { referenceNo: "JRN-STAFF-EDIT", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        expect(createRes.statusCode).toBe(201);

        const putRes = await app.inject({
          method: "PUT",
          url: `/api/company-db/company-a/journal/${createRes.json().journalId}`,
          cookies: { [SESSION_COOKIE]: staff.token },
          payload: { referenceNo: "JRN-STAFF-EDIT-V2", periodId, entryDate: "2026-01-06", lines: balancedLinesPayload() },
        });
        expect(putRes.statusCode).toBe(200);
      });

      it("PUT /journal/:id -- edit DRAFT berhasil: draft lama hilang, draft baru dgn data baru muncul", async () => {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-EDIT-1", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        const oldId = createRes.json().journalId;

        const putRes = await app.inject({
          method: "PUT",
          url: `/api/company-db/company-a/journal/${oldId}`,
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-EDIT-1-REVISED", description: "Revisi", periodId, entryDate: "2026-01-07", lines: balancedLinesPayload() },
        });
        expect(putRes.statusCode).toBe(200);
        const newId = putRes.json().journalId;
        expect(newId).not.toBe(oldId);

        const oldEntry = await dbA("journal_entries").where({ id: oldId }).first();
        expect(oldEntry).toBeUndefined();
        const newEntry = await dbA("journal_entries").where({ id: newId }).first();
        expect(newEntry.reference_no).toBe("JRN-EDIT-1-REVISED");
        expect(newEntry.entry_date).toContain("2026-01-07");
      });

      it("PUT /journal/:id -- ATOMIC: validasi baris baru gagal (tidak balance) -> draft LAMA TETAP ADA (tidak hilang)", async () => {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/company-db/company-a/journal",
          cookies: { [SESSION_COOKIE]: user.token },
          payload: { referenceNo: "JRN-EDIT-2", periodId, entryDate: "2026-01-05", lines: balancedLinesPayload() },
        });
        const oldId = createRes.json().journalId;

        const putRes = await app.inject({
          method: "PUT",
          url: `/api/company-db/company-a/journal/${oldId}`,
          cookies: { [SESSION_COOKIE]: user.token },
          payload: {
            referenceNo: "JRN-EDIT-2-BROKEN",
            periodId,
            entryDate: "2026-01-07",
            lines: [
              { accountId: kasId, debit: 500_000, credit: 0 },
              { accountId: modalId, debit: 0, credit: 100_000 }, // tidak balance
            ],
          },
        });
        expect(putRes.statusCode).toBe(400);

        const oldEntry = await dbA("journal_entries").where({ id: oldId }).first();
        expect(oldEntry).toBeDefined(); // ROLLBACK -- draft lama TIDAK ikut terhapus
        expect(oldEntry.status).toBe("DRAFT");
      });
    });
  });
});
