import "../company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama (mengarahkan semua DB ke folder temp)
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { BRANCH_AWARE_ROUTES } from "../../middleware/branch-authority.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { createCompanyDb } from "../../db/company/index.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess } from "../../db/system/company-access.js";
import { grantBranchAccess } from "../../db/system/user-branch-access.js";
import { createBranch, setMultiBranchEnabled } from "../../db/company/branch-service.js";
import { createInterBranchAccountPair } from "../../db/company/account-policy-service.js";
import { verifyInterBranchIntegrity } from "../../db/company/inter-branch-integrity.js";

import { companyInterBranchRoutes } from "./routes.js";
import { companyBranchesRoutes } from "../company-branches/routes.js";
import { companyAuthorizationRoutes } from "../company-authorization/routes.js";
import { companyJournalRoutes } from "../company-journal/routes.js";
import { companyPeriodsRoutes } from "../company-periods/routes.js";

type Role = "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";
interface TestUser {
  id: string;
  fullName: string;
  token: string;
}

const migrate = async (config: Knex.Config) => {
  const db = knexLib(config);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
};

async function newUser(label: string): Promise<TestUser> {
  const id = crypto.randomUUID();
  const email = `${id}@test.local`;
  await masterDb("users").insert({ id, email, password_hash: "x", full_name: label, role: "admin" });
  const { token } = await createSession(id, {});
  await ensureSystemIdentity(systemDb, { id, email, fullName: label, role: "admin", avatarUrl: null });
  return { id, fullName: label, token };
}

async function createCompany(slug: string): Promise<{ companyId: string; dbPath: string }> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const m = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  try {
    await m.migrate.latest();
    await m("company_profile").insert({ id: crypto.randomUUID(), name: slug });
  } finally {
    await m.destroy();
  }
  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({ id: companyId, slug, name: slug, database_path: dbPath, status: "active", schema_version: 19, last_migration_status: "READY" });
  return { companyId, dbPath };
}

async function grant(user: TestUser, companyId: string, role: Role, scope: "ALL" | "LIMITED", branchIds: string[] = []): Promise<void> {
  const accessId = crypto.randomUUID();
  await grantCompanyAccess(systemDb, { id: accessId, systemUserId: user.id, companyId, role, branchScope: scope });
  for (const branchId of branchIds) await grantBranchAccess(systemDb, { companyId, accessId, targetUserId: user.id }, branchId, { actorType: "system", actorLabel: "setup" });
}

const actor = { actorType: "user" as const, actorId: "setup", actorLabel: "Setup" };

describe("Inter-Branch HTTP: otorisasi, IDOR, alur, dan keamanan", () => {
  let app: FastifyInstance;
  const registered: string[] = [];
  let companyA: string, companyB: string;
  let dbA: Knex, dbB: Knex, dbC: Knex;
  let metro: string, bl: string;
  let kas: string, bank: string, hutang: string;
  let owner: TestUser, maker: TestUser, approver: TestUser, adminBoth: TestUser, staffBl: TestUser, viewer: TestUser, noBranch: TestUser, outsider: TestUser, ownerB: TestUser, ownerC: TestUser;

  const call = (user: TestUser | null, method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({ method: method as "GET", url, cookies: user ? { [SESSION_COOKIE]: user.token } : undefined, headers: opts.headers, payload: opts.payload as any });
  const A = (suffix: string) => `/api/company-db/company-a${suffix}`;
  const IB = (suffix = "") => A(`/inter-branch${suffix}`);
  const json = (res: { payload: string }) => JSON.parse(res.payload);
  const as = (branch: string) => ({ "x-branch-context": branch });

  const body = (o: Record<string, unknown> = {}) => ({
    type: "TRANSFER_KAS",
    toBranchId: bl,
    transactionDate: "2026-01-15",
    amount: 1_000_000,
    fromAccountId: kas,
    toAccountSuggestedId: bank,
    description: "Setoran kas ke Bandar Lampung",
    idempotencyKey: crypto.randomUUID(),
    ...o,
  });
  const create = async (by: TestUser = maker, o: Record<string, unknown> = {}, branch = metro) => {
    const res = await call(by, "POST", IB(), { payload: body(o), headers: as(branch) });
    expect(res.statusCode, res.payload).toBe(201);
    return json(res).transaction as { id: string; transactionNo: string; status: string };
  };
  const journalsOf = (id: string) => dbA("journal_entries").where({ inter_branch_transaction_id: id });

  beforeAll(async () => {
    await migrate(masterKnexfile);
    await migrate(systemKnexfile);

    app = Fastify();
    app.addHook("onRoute", (route) => {
      for (const m of ([] as string[]).concat(route.method as string | string[])) if (m !== "HEAD" && m !== "OPTIONS") registered.push(`${m} ${route.url}`);
    });
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    for (const r of [companyInterBranchRoutes, companyBranchesRoutes, companyAuthorizationRoutes, companyJournalRoutes, companyPeriodsRoutes]) app.register(r);
    await app.ready();

    const seedCompany = async (slug: string) => {
      const c = await createCompany(slug);
      const db = createCompanyDb(c.dbPath);
      await setMultiBranchEnabled(db, true, actor);
      const hq = (await db("branches").where({ is_head_office: 1 }).first()).id;
      const m = (await createBranch(db, { code: "METRO", name: "Cabang Metro" }, actor)).id;
      const b = (await createBranch(db, { code: "BL", name: "Bandar Lampung" }, actor)).id;
      const types = Object.fromEntries((await db("account_types").select("id", "code")).map((t: any) => [t.code, t.id]));
      const mk = async (code: string, name: string, type: string, normal: string, cash = false) => {
        const id = crypto.randomUUID();
        await db("accounts").insert({ id, code, name, account_type_id: types[type], normal_balance: normal, is_cash: cash });
        return id;
      };
      const accounts = { kas: await mk("1000", "Kas", "ASSET", "debit", true), bank: await mk("1010", "Bank", "ASSET", "debit", true), hutang: await mk("2000", "Hutang", "LIABILITY", "credit"), beban: await mk("6000", "Beban", "EXPENSE", "debit") };
      await db("periods").insert({ id: crypto.randomUUID(), label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      for (const accountTypeCode of ["ASSET", "LIABILITY"] as const) await createInterBranchAccountPair(db, { branchAId: m, branchBId: b, accountTypeCode, confirm: true }, actor);
      return { ...c, db, hq, m, b, accounts };
    };
    const a = await seedCompany("company-a");
    companyA = a.companyId; dbA = a.db; metro = a.m; bl = a.b; ({ kas, bank, hutang } = a.accounts);
    const b = await seedCompany("company-b");
    companyB = b.companyId; dbB = b.db;
    const c = await createCompany("company-c"); // multi-cabang tidak pernah dinyalakan
    dbC = createCompanyDb(c.dbPath);

    [owner, maker, approver, adminBoth, staffBl, viewer, noBranch, outsider, ownerB, ownerC] = await Promise.all(["owner", "maker", "approver", "admin-both", "staff-bl", "viewer", "no-branch", "outsider", "owner-b", "owner-c"].map(newUser));
    await grant(owner, companyA, "OWNER", "ALL");
    await grant(maker, companyA, "ACCOUNTANT", "LIMITED", [metro]);
    await grant(approver, companyA, "ACCOUNTANT", "LIMITED", [bl]);
    await grant(adminBoth, companyA, "ADMIN", "LIMITED", [metro, bl]);
    await grant(staffBl, companyA, "STAFF", "LIMITED", [bl]);
    await grant(viewer, companyA, "VIEWER", "ALL");
    await grant(noBranch, companyA, "ACCOUNTANT", "LIMITED", []);
    await grant(ownerB, companyB, "OWNER", "ALL");
    await grant(ownerC, c.companyId, "OWNER", "ALL");
  });

  afterAll(async () => {
    await app.close();
    await dbA.destroy();
    await dbB.destroy();
    await dbC.destroy();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  it("semua route Inter-Branch terdaftar sadar-cabang (BRANCH_AWARE) dan lewat requireAuth + requireCompanyAccess", () => {
    const ib = registered.filter((r) => r.includes("/:companySlug/inter-branch"));
    expect(ib.length).toBe(14);
    for (const r of ib) expect(BRANCH_AWARE_ROUTES.has(r), r).toBe(true);
  });

  it("tanpa login: 401 pada semua endpoint; perusahaan tidak ada / bukan miliknya: 404 identik", async () => {
    for (const [method, url] of [["GET", IB()], ["GET", IB("/summary")], ["GET", IB("/x")], ["POST", IB()], ["POST", IB("/x/approve")], ["PUT", IB("/settings")]] as const) {
      expect((await call(null, method, url)).statusCode, `${method} ${url}`).toBe(401);
    }
    const noSuchCompany = await call(owner, "GET", "/api/company-db/tidak-ada/inter-branch");
    const notMine = await call(ownerB, "GET", IB());
    const outsiderRes = await call(outsider, "GET", IB());
    expect(noSuchCompany.statusCode).toBe(404);
    expect(notMine.payload).toBe(noSuchCompany.payload);
    expect(outsiderRes.payload).toBe(noSuchCompany.payload);
  });

  it("flag multi-cabang OFF: seluruh endpoint 404 dengan badan identik (termasuk OWNER); tidak ada kebocoran", async () => {
    const C = (s: string) => `/api/company-db/company-c/inter-branch${s}`;
    const probes = [call(ownerC, "GET", C("")), call(ownerC, "GET", C("/summary")), call(ownerC, "GET", C("/settings")), call(ownerC, "GET", C("/anything")), call(ownerC, "POST", C(""), { payload: body() }), call(ownerC, "POST", C("/x/approve"))];
    const results = await Promise.all(probes);
    for (const res of results) expect([res.statusCode, res.payload]).toEqual([404, results[0].payload]);
    expect(json(results[0])).toEqual({ error: "Tidak ditemukan.", code: "NOT_FOUND" });
  });

  it("flag OFF: input tidak valid (body/query/settings) juga 404 seragam, bukan 400 (validasi SETELAH cek flag)", async () => {
    const C = (s: string) => `/api/company-db/company-c/inter-branch${s}`;
    const probes = await Promise.all([
      call(ownerC, "POST", C(""), { payload: {} }),
      call(ownerC, "GET", C("?status=NGAWUR")),
      call(ownerC, "PUT", C("/settings"), { payload: { expiryDays: "x" } }),
      call(ownerC, "POST", C("/x/reject"), { payload: { reason: 123 } }),
    ]);
    for (const res of probes) expect([res.statusCode, res.payload]).toEqual([404, probes[0].payload]);
  });

  it("alur lengkap: ajukan (201) -> replay idempoten (200) -> daftar penerima -> setujui -> dua jurnal seimbang -> detail", async () => {
    const payload = body();
    const first = await call(maker, "POST", IB(), { payload, headers: as(metro) });
    expect(first.statusCode).toBe(201);
    const tx = json(first).transaction;
    expect(tx).toMatchObject({ status: "WAITING_APPROVAL", accountingEvent: "NOT_POSTED", reversalState: "NOT_REVERSED", fromBranch: { id: metro }, toBranch: { id: bl } });
    expect(tx.transactionNo).toMatch(/^IB-2026-\d{6}$/);
    expect(await journalsOf(tx.id)).toHaveLength(0);

    const replay = await call(maker, "POST", IB(), { payload, headers: as(metro) });
    expect([replay.statusCode, json(replay).replayed, json(replay).transaction.id]).toEqual([200, true, tx.id]);

    const inbox = json(await call(approver, "GET", IB("?box=in&status=WAITING_APPROVAL")));
    expect(inbox.items.map((i: any) => i.id)).toContain(tx.id);
    expect((await call(maker, "GET", IB("?box=in"))).statusCode).toBe(200);
    expect(json(await call(approver, "GET", IB("/summary"))).incomingWaiting).toBeGreaterThanOrEqual(1);

    const approved = await call(approver, "POST", IB(`/${tx.id}/approve`), { payload: { confirmedAccountId: bank } });
    expect(approved.statusCode, approved.payload).toBe(200);
    expect(json(approved).transaction).toMatchObject({ status: "COMPLETED", accountingEvent: "POSTED" });
    expect(await journalsOf(tx.id)).toHaveLength(2);
    expect(await verifyInterBranchIntegrity(dbA)).toEqual([]);

    const again = await call(approver, "POST", IB(`/${tx.id}/approve`));
    expect([again.statusCode, json(again).code]).toEqual([409, "INTER_BRANCH_STATE_CHANGED"]);
    expect(await journalsOf(tx.id)).toHaveLength(2);

    const detail = json(await call(approver, "GET", IB(`/${tx.id}`)));
    expect(detail.fromAccount).toBeNull(); // sisi lawan tidak bocor
    expect(detail.history.map((h: any) => h.action)).toEqual(["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED", "INTER_BRANCH_APPROVED", "INTER_BRANCH_POSTED", "INTER_BRANCH_COMPLETED"]);
  });

  it("SELF-APPROVAL: ADMIN LIMITED yang memegang kedua cabang ditolak 403, walau body/header/query memalsukan peran; OWNER diizinkan", async () => {
    const tx = await create(adminBoth);
    const forged = await call(adminBoth, "POST", IB(`/${tx.id}/approve?role=OWNER&selfApproved=true`), {
      payload: { role: "OWNER", selfApproved: true, status: "COMPLETED", userId: owner.id, companyId: companyB },
      headers: { "x-role": "OWNER", "x-user-id": owner.id },
    });
    expect([forged.statusCode, json(forged).code]).toEqual([403, "SELF_APPROVAL_NOT_ALLOWED"]);
    expect((await call(adminBoth, "POST", IB(`/${tx.id}/reject`), { payload: { reason: "menolak milik sendiri" } })).statusCode).toBe(403);
    expect(await journalsOf(tx.id)).toHaveLength(0);
    expect((await dbA("inter_branch_transactions").where({ id: tx.id }).first()).status).toBe("WAITING_APPROVAL");

    const own = await create(owner, {}, metro);
    const done = await call(owner, "POST", IB(`/${own.id}/approve`));
    expect(done.statusCode, done.payload).toBe(200);
    expect(json(done).transaction).toMatchObject({ status: "COMPLETED", selfApproved: true });
    const audit = await dbA("company_audit_log").where({ entity_id: own.id, action: "INTER_BRANCH_APPROVED" }).first();
    expect(JSON.parse(audit.after_json)).toMatchObject({ actorRole: "OWNER", makerEqualsApprover: true });
  });

  it("matriks otorisasi: VIEWER, STAFF, tanpa cabang, akses salah sisi, DENY override, dan delegasi inter_branch yang tidak memberi hak", async () => {
    const tx = await create();
    expect((await call(viewer, "POST", IB(), { payload: body() })).statusCode).toBe(403);
    expect((await call(viewer, "GET", IB())).statusCode).toBe(403);
    expect((await call(staffBl, "POST", IB(`/${tx.id}/approve`))).statusCode).toBe(403);
    expect(json(await call(noBranch, "GET", IB())).items ?? []).toEqual([]);
    expect((await call(noBranch, "GET", IB(`/${tx.id}`))).statusCode).toBe(404);
    expect((await call(maker, "POST", IB(`/${tx.id}/approve`))).statusCode).toBe(403); // melihat, tetapi bukan penerima
    const otherSide = await call(approver, "POST", IB(), { payload: body({ fromBranchId: metro }), headers: as(bl) });
    expect([404, 409]).toContain(otherSide.statusCode); // body fromBranchId tidak dipercaya

    // DENY override mengalahkan role ACCOUNTANT, dan delegasi dengan kapabilitas inter_branch TIDAK memulihkan hak
    const deny = await call(owner, "PUT", A(`/access/${approver.id}/permission-overrides/interbranch.approve`), { payload: { effect: "DENY", reason: "uji override" } });
    expect(deny.statusCode, deny.payload).toBe(201);
    expect((await call(approver, "POST", IB(`/${tx.id}/approve`))).statusCode).toBe(403);
    const del = await call(owner, "POST", A("/delegations"), { payload: { granteeUserId: approver.id, capabilities: ["inter_branch"], maxRole: "STAFF", branchIds: [bl] } });
    expect(del.statusCode, del.payload).toBe(201);
    expect((await call(approver, "POST", IB(`/${tx.id}/approve`))).statusCode).toBe(403);
    await call(owner, "DELETE", A(`/access/${approver.id}/permission-overrides/interbranch.approve`), { payload: { reason: "selesai" } });
    expect((await call(approver, "POST", IB(`/${tx.id}/approve`))).statusCode).toBe(200);
  });

  it("IDOR dan lintas perusahaan: id perusahaan lain / acak / tak terlihat -> 404 identik; tidak ada perubahan", async () => {
    const tx = await create();
    const bTx = crypto.randomUUID();
    const responses = await Promise.all([
      call(noBranch, "GET", IB(`/${tx.id}`)),
      call(approver, "GET", IB(`/${crypto.randomUUID()}`)),
      call(ownerB, "GET", `/api/company-db/company-b/inter-branch/${tx.id}`), // id milik A di perusahaan B
      call(noBranch, "POST", IB(`/${tx.id}/cancel`)),
      call(noBranch, "POST", IB(`/${tx.id}/reverse`), { payload: { reason: "mencoba membalik transaksi orang" } }),
      call(ownerB, "POST", `/api/company-db/company-b/inter-branch/${bTx}/approve`),
    ]);
    for (const r of responses) expect([r.statusCode, r.payload]).toEqual([404, responses[0].payload]);
    expect((await dbA("inter_branch_transactions").where({ id: tx.id }).first()).status).toBe("WAITING_APPROVAL");
  });

  it("body ber-companyId/fromBranchId/status/createdBy palsu diabaikan; pembuat = pengguna sesi, cabang asal = konteks", async () => {
    const res = await call(maker, "POST", IB(), { payload: { ...body(), companyId: companyB, userId: owner.id, proposedBy: owner.id, status: "COMPLETED", fromBranchId: metro }, headers: as(metro) });
    expect(res.statusCode, res.payload).toBe(201);
    const row = await dbA("inter_branch_transactions").where({ id: json(res).transaction.id }).first();
    expect(row).toMatchObject({ proposed_by: maker.id, status: "WAITING_APPROVAL", from_branch_id: metro });
    expect(await dbB("inter_branch_transactions")).toHaveLength(0);
  });

  it("tolak, batal, validasi (400/422), dan pembalikan lewat HTTP", async () => {
    const t1 = await create();
    expect((await call(approver, "POST", IB(`/${t1.id}/reject`), { payload: { reason: "pendek" } })).statusCode).toBe(400);
    const rej = await call(approver, "POST", IB(`/${t1.id}/reject`), { payload: { reason: "Bukti setoran tidak ada" } });
    expect([rej.statusCode, json(rej).transaction.status]).toEqual([200, "REJECTED"]);
    const t2 = await create();
    expect((await call(approver, "POST", IB(`/${t2.id}/cancel`))).statusCode).toBe(403);
    expect((await call(maker, "POST", IB(`/${t2.id}/cancel`), { payload: { reason: "salah" } })).statusCode).toBe(200);

    expect((await call(maker, "POST", IB(), { payload: { type: "TRANSFER_KAS" }, headers: as(metro) })).statusCode).toBe(400);
    const badType = await call(maker, "POST", IB(), { payload: body({ type: "PERSEDIAAN" }), headers: as(metro) });
    expect(badType.statusCode).toBe(400);
    const notCash = await call(maker, "POST", IB(), { payload: body({ toAccountSuggestedId: hutang }), headers: as(metro) });
    expect([notCash.statusCode, json(notCash).code]).toEqual([422, "INTER_BRANCH_ACCOUNT_INVALID"]);
    const future = await call(maker, "POST", IB(), { payload: body({ transactionDate: "2999-01-01" }), headers: as(metro) });
    expect(future.statusCode).toBe(422);

    const t3 = await create();
    await call(approver, "POST", IB(`/${t3.id}/approve`));
    const req = await call(maker, "POST", IB(`/${t3.id}/reverse`), { payload: { reason: "Salah input nominal setoran" } });
    expect(req.statusCode, req.payload).toBe(200);
    const reversal = json(req).transaction.reversal;
    expect(reversal).toMatchObject({ requestedBy: { id: maker.id } });
    expect((await call(maker, "POST", IB(`/${t3.id}/reverse/${reversal.approvalId}/approve`))).statusCode).toBe(403);
    const ok = await call(approver, "POST", IB(`/${t3.id}/reverse/${reversal.approvalId}/approve`));
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok).transaction).toMatchObject({ status: "COMPLETED", reversalState: "REVERSED" });
    expect(await journalsOf(t3.id)).toHaveLength(4);
    expect(await verifyInterBranchIntegrity(dbA)).toEqual([]);
  });

  it("jalur jurnal biasa tetap menolak jurnal bertaut (reverse/hapus) dan referensi berawalan IB-", async () => {
    const tx = await create();
    await call(approver, "POST", IB(`/${tx.id}/approve`));
    const journal = (await journalsOf(tx.id))[0];
    const rev = await call(owner, "POST", A(`/journal/${journal.id}/reverse`), { payload: { reason: "mencoba membalik lewat jalur biasa" } });
    expect(rev.statusCode).toBe(409);
    expect((await call(owner, "DELETE", A(`/journal/${journal.id}`))).statusCode).toBe(409);
    const period = (await dbA("periods").first()).id;
    const manual = await call(owner, "POST", A("/journal"), {
      payload: { referenceNo: "ib-2026-999999", periodId: period, entryDate: "2026-01-15", lines: [{ accountId: kas, debit: 10, credit: 0 }, { accountId: hutang, debit: 0, credit: 10 }] },
    });
    expect([manual.statusCode, json(manual).error]).toEqual([409, expect.stringMatching(/IB-/)]);
  });

  it("K-3 lewat HTTP: OWNER tidak dapat mematikan multi-cabang selama ada pengajuan menunggu (409 + pesan jelas); setelah selesai boleh", async () => {
    await create();
    const blocked = await call(owner, "PUT", A("/multi-branch"), { payload: { enabled: false } });
    expect([blocked.statusCode, json(blocked).code]).toEqual([409, "MULTI_BRANCH_HAS_PENDING_INTER_BRANCH"]);
    expect(json(blocked).error).toMatch(/menunggu/);
    for (const row of await dbA("inter_branch_transactions").where({ status: "WAITING_APPROVAL" })) {
      expect((await call(owner, "POST", IB(`/${row.id}/cancel`))).statusCode).toBe(200);
    }
    const off = await call(owner, "PUT", A("/multi-branch"), { payload: { enabled: false } });
    expect(off.statusCode, off.payload).toBe(200);
    expect((await call(owner, "GET", IB())).statusCode).toBe(404);
    expect((await call(owner, "PUT", A("/multi-branch"), { payload: { enabled: true } })).statusCode).toBe(200);
  });

  it("konkurensi lewat HTTP: dua penyetuju bersamaan -> satu 200 dan satu 409; tanpa 5xx dan tanpa jurnal ganda", async () => {
    const second = await newUser("approver-2");
    await grant(second, companyA, "ACCOUNTANT", "LIMITED", [bl]);
    const tx = await create();
    const [a, b] = await Promise.all([call(approver, "POST", IB(`/${tx.id}/approve`)), call(second, "POST", IB(`/${tx.id}/approve`))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await journalsOf(tx.id)).toHaveLength(2);
    const [c, d] = await Promise.all([call(maker, "POST", IB(`/${tx.id}/reverse`), { payload: { reason: "Salah input nominal setoran" } }), call(adminBoth, "POST", IB(`/${tx.id}/reverse`), { payload: { reason: "Salah input nominal setoran" } })]);
    expect([c.statusCode, d.statusCode].sort()).toEqual([200, 409]);
    expect(await verifyInterBranchIntegrity(dbA)).toEqual([]);
  });

  it("pilihan formulir: cabang asal = konteks tervalidasi; tujuan = cabang ACTIVE lain dengan kesiapan akun antarkantor; hanya yang berhak membuat", async () => {
    const res = await call(maker, "GET", IB("/options"), { headers: as(metro) });
    expect(res.statusCode, res.payload).toBe(200);
    const options = json(res);
    expect(options.fromBranch.id).toBe(metro);
    expect(options.destinations.find((d: any) => d.id === bl)).toMatchObject({ ready: true, reason: null });
    expect(options.destinations.some((d: any) => d.id === metro)).toBe(false);
    const hq = await call(owner, "GET", IB("/options"));
    expect(json(hq).destinations.find((d: any) => d.id === bl)).toMatchObject({ ready: false });
    expect(json(hq).destinations.find((d: any) => d.id === bl).reason).toMatch(/belum dibuat/);
    expect((await call(viewer, "GET", IB("/options"))).statusCode).toBe(403);
    expect((await call(noBranch, "GET", IB("/options"))).statusCode).toBe(403);
  });

  it("pengaturan masa berlaku: baca oleh pembaca, ubah hanya OWNER", async () => {
    expect(json(await call(maker, "GET", IB("/settings")))).toMatchObject({ expiryDays: 14, minDays: 1, maxDays: 90 });
    expect((await call(adminBoth, "PUT", IB("/settings"), { payload: { expiryDays: 7 } })).statusCode).toBe(403);
    expect((await call(owner, "PUT", IB("/settings"), { payload: { expiryDays: 0 } })).statusCode).toBe(400);
    expect(json(await call(owner, "PUT", IB("/settings"), { payload: { expiryDays: 21 } })).expiryDays).toBe(21);
  });
});
