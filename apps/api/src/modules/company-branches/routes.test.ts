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
import { createBranch, setMultiBranchEnabled, changeBranchStatus } from "../../db/company/branch-service.js";
import { createDraftJournalEntry, postJournalEntry } from "../../db/company/journal-service.js";

import { companyBranchesRoutes } from "./routes.js";
import { companyInterBranchRoutes } from "../company-inter-branch/routes.js";
import { companyAuthorizationRoutes } from "../company-authorization/routes.js";
import { companyJournalRoutes } from "../company-journal/routes.js";
import { companyOpeningBalanceRoutes } from "../company-opening-balance/routes.js";
import { companyOpeningBalanceImportRoutes } from "../company-opening-balance-import/routes.js";
import { companyJournalImportRoutes } from "../company-journal-import/routes.js";
import { companyAccessRoutes } from "../company-access/routes.js";
import { companyAccountsRoutes } from "../company-accounts/routes.js";
import { companyAccountsImportRoutes } from "../company-accounts-import/routes.js";
import { companyLedgerRoutes } from "../company-ledger/routes.js";
import { companySearchRoutes } from "../company-search/routes.js";
import { companyPeriodsRoutes } from "../company-periods/routes.js";
import { companyReportsRoutes } from "../company-reports/routes.js";
import { companyDashboardRoutes } from "../company-dashboard/routes.js";
import { companyProfileRoutes } from "../company-profile/routes.js";
import { companyAnalysisRoutes } from "../company-analysis/routes.js";
import { companyCounterpartiesRoutes } from "../company-counterparties/routes.js";
import { companyTaxRoutes } from "../company-tax/routes.js";
import { companyProjectionRoutes } from "../company-projection/routes.js";
import { companyAuditLogRoutes } from "../company-audit-log/routes.js";
import { companyRoutes } from "../company/routes.js";
import { accountsRoutes } from "../accounts/routes.js";
import { periodsRoutes } from "../periods/routes.js";
import { journalRoutes } from "../journal/routes.js";
import { ledgerRoutes } from "../ledger/routes.js";
import { counterpartyRoutes } from "../counterparties/routes.js";
import { statementRoutes } from "../statements/routes.js";
import { ratioRoutes } from "../ratios/routes.js";
import { taxRoutes } from "../tax/routes.js";

type Role = "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";
interface TestUser {
  id: string;
  email: string;
  fullName: string;
  token: string;
  accessId?: string;
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
  return { id, email, fullName: label, token };
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
  await systemDb("companies_registry").insert({ id: companyId, slug, name: slug, database_path: dbPath, status: "active", schema_version: 18, last_migration_status: "READY" });
  return { companyId, dbPath };
}

async function grant(user: TestUser, companyId: string, role: Role, scope: "ALL" | "LIMITED", branchIds: string[] = []): Promise<void> {
  const accessId = crypto.randomUUID();
  await grantCompanyAccess(systemDb, { id: accessId, systemUserId: user.id, companyId, role, branchScope: scope });
  for (const branchId of branchIds) {
    await grantBranchAccess(systemDb, { companyId, accessId, targetUserId: user.id }, branchId, { actorType: "system", actorLabel: "setup" });
  }
  user.accessId = accessId;
}

const actor = { actorType: "user" as const, actorId: "setup", actorLabel: "Setup" };

describe("Otorisasi cabang HTTP (Multi-Branch Phase 1-2)", () => {
  let app: FastifyInstance;
  const registeredRoutes: Array<{ method: string; url: string }> = [];

  // perusahaan A (multi-cabang aktif) dan B (perusahaan lain)
  let companyA: string;
  let companyB: string;
  let dbA: Knex;
  let dbB: Knex;
  let hq: string, metro: string, bandar: string, kotabumi: string, bHq: string, bBranch: string;
  let kasId: string, modalId: string, hutangId: string, periodId: string;
  let journalKotabumi: string, draftKotabumi: string, journalMetro: string;

  let owner: TestUser, admin: TestUser, accountant: TestUser;
  let staffMetro: TestUser, staffMetroBl: TestUser, noBranch: TestUser, staffAll: TestUser, outsider: TestUser;

  const call = (user: TestUser | null, method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: method as "GET",
      url,
      cookies: user ? { [SESSION_COOKIE]: user.token } : undefined,
      headers: opts.headers,
      payload: opts.payload as any,
    });
  const A = (suffix: string) => `/api/company-db/company-a${suffix}`;
  const json = (res: { payload: string }) => JSON.parse(res.payload);

  const journalBody = (extra: Record<string, unknown> = {}) => ({
    referenceNo: `HTTP-${crypto.randomUUID().slice(0, 8)}`,
    periodId,
    entryDate: "2026-01-15",
    lines: [
      { accountId: kasId, debit: 1000, credit: 0 },
      { accountId: hutangId, debit: 0, credit: 1000 },
    ],
    ...extra,
  });

  beforeAll(async () => {
    await migrate(masterKnexfile);
    await migrate(systemKnexfile);

    app = Fastify();
    app.addHook("onRoute", (route) => {
      for (const m of ([] as string[]).concat(route.method as string | string[])) {
        if (m !== "HEAD" && m !== "OPTIONS") registeredRoutes.push({ method: m, url: route.url });
      }
    });
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    for (const r of [
      companyBranchesRoutes, companyInterBranchRoutes, companyAuthorizationRoutes, companyJournalRoutes, companyOpeningBalanceRoutes, companyOpeningBalanceImportRoutes, companyJournalImportRoutes,
      companyAccessRoutes, companyAccountsRoutes, companyAccountsImportRoutes, companyLedgerRoutes, companySearchRoutes, companyPeriodsRoutes,
      companyReportsRoutes, companyDashboardRoutes, companyProfileRoutes, companyAnalysisRoutes, companyCounterpartiesRoutes, companyTaxRoutes,
      companyProjectionRoutes, companyAuditLogRoutes, companyRoutes,
      accountsRoutes, periodsRoutes, journalRoutes, ledgerRoutes, counterpartyRoutes, statementRoutes, ratioRoutes, taxRoutes,
    ]) {
      app.register(r);
    }
    await app.ready();

    // ---- perusahaan A
    const a = await createCompany("company-a");
    companyA = a.companyId;
    dbA = createCompanyDb(a.dbPath);
    await setMultiBranchEnabled(dbA, true, actor);
    hq = (await dbA("branches").where({ is_head_office: 1 }).first()).id;
    metro = (await createBranch(dbA, { code: "METRO", name: "Cabang Metro" }, actor)).id;
    bandar = (await createBranch(dbA, { code: "BL", name: "Bandar Lampung" }, actor)).id;
    kotabumi = (await createBranch(dbA, { code: "KOTABUMI", name: "Cabang Kotabumi" }, actor)).id;
    const types = Object.fromEntries((await dbA("account_types").select("id", "code")).map((t: any) => [t.code, t.id]));
    const mk = async (code: string, name: string, type: string, normal: string) => {
      const id = crypto.randomUUID();
      await dbA("accounts").insert({ id, code, name, account_type_id: types[type], normal_balance: normal });
      return id;
    };
    kasId = await mk("1000", "Kas", "ASSET", "debit");
    hutangId = await mk("2000", "Hutang", "LIABILITY", "credit");
    modalId = await mk("3000", "Modal", "EQUITY", "credit");
    periodId = crypto.randomUUID();
    await dbA("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });

    const mkJournal = async (branchId: string, post: boolean) => {
      const { id } = await createDraftJournalEntry(dbA, { entryDate: "2026-01-10", periodId, referenceNo: `SEED-${crypto.randomUUID().slice(0, 8)}`, branchId, lines: [{ accountId: kasId, debit: 500, credit: 0 }, { accountId: hutangId, debit: 0, credit: 500 }] }, actor);
      if (post) await postJournalEntry(dbA, { journalEntryId: id }, actor);
      return id;
    };
    journalKotabumi = await mkJournal(kotabumi, true);
    draftKotabumi = await mkJournal(kotabumi, false);
    journalMetro = await mkJournal(metro, true);

    // ---- perusahaan B (perusahaan lain, juga multi-cabang)
    const b = await createCompany("company-b");
    companyB = b.companyId;
    dbB = createCompanyDb(b.dbPath);
    await setMultiBranchEnabled(dbB, true, actor);
    bHq = (await dbB("branches").where({ is_head_office: 1 }).first()).id;
    bBranch = (await createBranch(dbB, { code: "ASING", name: "Cabang Perusahaan B" }, actor)).id;

    // ---- user
    [owner, admin, accountant, staffMetro, staffMetroBl, noBranch, staffAll, outsider] = await Promise.all(
      ["owner", "admin", "akuntan", "staf-metro", "staf-metro-bl", "tanpa-cabang", "staf-semua", "orang-luar"].map(newUser),
    );
    await grant(owner, companyA, "OWNER", "ALL");
    await grant(admin, companyA, "ADMIN", "ALL");
    await grant(accountant, companyA, "ACCOUNTANT", "ALL");
    await grant(staffMetro, companyA, "ACCOUNTANT", "LIMITED", [metro]);
    await grant(staffMetroBl, companyA, "ACCOUNTANT", "LIMITED", [metro, bandar]);
    await grant(noBranch, companyA, "ACCOUNTANT", "LIMITED", []);
    await grant(staffAll, companyA, "STAFF", "ALL");
    await grant(outsider, companyB, "OWNER", "ALL");
  });

  afterAll(async () => {
    await app.close();
    await dbA.destroy();
    await dbB.destroy();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  // ------------------------------------------------------------------ akses & konteks
  describe("akses cabang & konteks kerja", () => {
    it("OWNER (ALL) melihat semua cabang; konteks default = Kantor Pusat", async () => {
      const res = await call(owner, "GET", A("/branch-context"));
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.scope).toBe("ALL");
      expect(body.branches.map((b: any) => b.code).sort()).toEqual(["BL", "KOTABUMI", "METRO", "PUSAT"]);
      expect(body.context.id).toBe(hq);
      expect(body.capabilities).toMatchObject({ manageBranches: true, reopenBranches: true, setAccountPolicy: true });
    });

    it("user LIMITED hanya melihat cabangnya; cabang lain 404 seragam (tanpa membocorkan keberadaan)", async () => {
      const list = json(await call(staffMetro, "GET", A("/branches")));
      expect(list.branches.map((b: any) => b.code)).toEqual(["METRO"]);
      const own = await call(staffMetro, "GET", A(`/branches/${metro}`));
      expect(own.statusCode).toBe(200);
      const other = await call(staffMetro, "GET", A(`/branches/${kotabumi}`));
      const missing = await call(staffMetro, "GET", A(`/branches/id-yang-tidak-ada`));
      expect(other.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(other.payload).toBe(missing.payload); // tidak dapat dibedakan
      expect(json(await call(staffMetro, "GET", A("/branch-context"))).context.id).toBe(metro);
    });

    it("LIMITED tanpa akses cabang apa pun: tidak melihat cabang, tidak punya konteks, tidak bisa menulis (fail-closed)", async () => {
      expect(json(await call(noBranch, "GET", A("/branches"))).branches).toEqual([]);
      expect(json(await call(noBranch, "GET", A("/branch-context"))).context).toBeNull();
      const res = await call(noBranch, "POST", A("/journal"), { payload: journalBody() });
      expect(res.statusCode).toBe(403);
      expect(json(res).code).toBe("BRANCH_CONTEXT_INVALID");
    });

    it("header konteks palsu / cabang di luar akses ditolak server (403 BRANCH_CONTEXT_INVALID), bukan jalan pintas otorisasi", async () => {
      for (const forged of [kotabumi, hq, "cabang-fiktif", bBranch]) {
        const res = await call(staffMetro, "POST", A("/journal"), { payload: journalBody(), headers: { "x-branch-context": forged } });
        expect(res.statusCode, `header ${forged}`).toBe(403);
        expect(json(res).code).toBe("BRANCH_CONTEXT_INVALID");
      }
      expect(await dbA("journal_entries").where({ branch_id: kotabumi })).toHaveLength(2); // tidak bertambah
    });

    it("PUT branch-context: hanya ke cabang ACTIVE dalam akses; preferensi dipakai request berikutnya tanpa header; bukan perubahan permission", async () => {
      expect((await call(staffMetroBl, "PUT", A("/branch-context"), { payload: { branchId: kotabumi } })).statusCode).toBe(404);
      expect((await call(staffMetroBl, "PUT", A("/branch-context"), { payload: { branchId: bBranch } })).statusCode).toBe(404);
      expect((await call(staffMetroBl, "PUT", A("/branch-context"), { payload: { branchId: bandar } })).statusCode).toBe(200);
      expect(json(await call(staffMetroBl, "GET", A("/branch-context"))).context.id).toBe(bandar);
      const created = await call(staffMetroBl, "POST", A("/journal"), { payload: journalBody() });
      expect(created.statusCode).toBe(201);
      expect((await dbA("journal_entries").where({ id: json(created).journalId }).first()).branch_id).toBe(bandar);
      // permission tidak berubah: tetap tidak bisa mengakses cabang lain
      expect((await call(staffMetroBl, "GET", A(`/branches/${kotabumi}`))).statusCode).toBe(404);
      // kembalikan preferensi
      await call(staffMetroBl, "PUT", A("/branch-context"), { payload: { branchId: metro } });
    });
  });

  // ------------------------------------------------------------------ jurnal
  describe("jurnal: branch_id ditentukan/divalidasi server", () => {
    it("tanpa header & tanpa branchId: jurnal masuk cabang kerja user; branchId di body tidak boleh menembus akses", async () => {
      const ok = await call(staffMetro, "POST", A("/journal"), { payload: journalBody() });
      expect(ok.statusCode).toBe(201);
      expect((await dbA("journal_entries").where({ id: json(ok).journalId }).first())).toMatchObject({ branch_id: metro, origin: "manual" });

      for (const forged of [kotabumi, hq, bBranch, "palsu"]) {
        const res = await call(staffMetro, "POST", A("/journal"), { payload: journalBody({ branchId: forged }) });
        expect(res.statusCode, `branchId ${forged}`).toBe(404);
      }
      // cabang dalam akses tetapi bukan konteks kerja aktif -> 409, harus pindah konteks dulu
      const mismatch = await call(staffMetroBl, "POST", A("/journal"), { payload: journalBody({ branchId: bandar }), headers: { "x-branch-context": metro } });
      expect(mismatch.statusCode).toBe(409);
      expect(json(mismatch).code).toBe("BRANCH_CONTEXT_MISMATCH");
      const switched = await call(staffMetroBl, "POST", A("/journal"), { payload: journalBody({ branchId: bandar }), headers: { "x-branch-context": bandar } });
      expect(switched.statusCode).toBe(201);
    });

    it("company_id palsu pada body diabaikan (satu-satunya sumber perusahaan adalah slug yang diverifikasi)", async () => {
      const res = await call(staffMetro, "POST", A("/journal"), { payload: journalBody({ companyId: companyB, company_id: companyB }) });
      expect(res.statusCode).toBe(201);
      expect(await dbB("journal_entries")).toHaveLength(0);
    });

    it("IDOR: jurnal cabang lain tidak dapat dibaca/diposting/di-reverse/dihapus/diubah (404 seragam)", async () => {
      const unknown = await call(staffMetro, "GET", A("/journals/id-tidak-ada"));
      for (const [method, url, payload] of [
        ["GET", `/journals/${journalKotabumi}`, undefined],
        ["POST", `/journal/${draftKotabumi}/post`, undefined],
        ["POST", `/journal/${journalKotabumi}/reverse`, { reason: "uji" }],
        ["DELETE", `/journal/${draftKotabumi}`, undefined],
        ["PUT", `/journal/${draftKotabumi}`, journalBody()],
      ] as const) {
        const res = await call(staffMetro, method, A(url), { payload });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect(unknown.statusCode).toBe(404);
      expect((await dbA("journal_entries").where({ id: draftKotabumi }).first()).status).toBe("DRAFT");
      expect((await dbA("journal_entries").where({ id: journalKotabumi }).first()).status).toBe("POSTED");
    });

    it("IDOR reversal berdasarkan nomor referensi pada cabang lain ditolak", async () => {
      const ref = (await dbA("journal_entries").where({ id: journalKotabumi }).first()).reference_no;
      const res = await call(staffMetro, "POST", A("/journal/reversal"), { payload: { referenceNo: ref, entryDate: "2026-01-10", reason: "uji" } });
      expect(res.statusCode).toBe(404);
    });

    it("daftar jurnal dibatasi ke cabang kerja; ?branchId di luar akses 404; cabang sendiri boleh", async () => {
      const mine = json(await call(staffMetro, "GET", A("/journals")));
      expect(mine.journals.length).toBeGreaterThan(0);
      expect(new Set(mine.journals.map((j: any) => j.branchId))).toEqual(new Set([metro]));
      expect((await call(staffMetro, "GET", A(`/journals?branchId=${kotabumi}`))).statusCode).toBe(404);
      expect(json(await call(staffMetro, "GET", A(`/journals/${journalMetro}`))).journal.branch_id).toBe(metro);
      // user ALL: ?branchId memilih cabang mana pun; tanpa parameter = cabang kerja (Pusat)
      const k = json(await call(owner, "GET", A(`/journals?branchId=${kotabumi}`)));
      expect(k.journals.map((j: any) => j.id).sort()).toEqual([draftKotabumi, journalKotabumi].sort());
      expect(json(await call(owner, "GET", A("/journals"))).journals.every((j: any) => j.branchId === hq)).toBe(true);
    });

    it("akses dicabut -> berlaku di request berikutnya (sesi masih hidup); riwayat akses tetap ada", async () => {
      const victim = await newUser("dicabut");
      await grant(victim, companyA, "ACCOUNTANT", "LIMITED", [metro]);
      expect((await call(victim, "POST", A("/journal"), { payload: journalBody(), headers: { "x-branch-context": metro } })).statusCode).toBe(201);
      const revoke = await call(owner, "DELETE", A(`/access/${victim.id}/branches/${metro}`), { payload: { reason: "mutasi" } });
      expect(revoke.statusCode).toBe(200);
      const after = await call(victim, "POST", A("/journal"), { payload: journalBody(), headers: { "x-branch-context": metro } });
      expect(after.statusCode).toBe(403);
      expect(json(after).code).toBe("BRANCH_CONTEXT_INVALID");
      expect((await call(victim, "GET", A(`/journals/${journalMetro}`))).statusCode).toBe(404);
      expect(await systemDb("user_branch_access").where({ access_id: victim.accessId })).toEqual([expect.objectContaining({ status: "REVOKED", revoke_reason: "mutasi" })]);
    });

    it("cabang INACTIVE/CLOSED: tidak bisa jadi konteks atau menerima jurnal baru, tetapi data historis tetap dapat dibaca", async () => {
      const cabang = (await createBranch(dbA, { code: "TUTUP", name: "Cabang Akan Tutup" }, actor)).id;
      const worker = await newUser("pekerja-tutup");
      await grant(worker, companyA, "ACCOUNTANT", "LIMITED", [cabang]);
      const first = await call(worker, "POST", A("/journal"), { payload: journalBody() });
      expect(first.statusCode).toBe(201);
      await postJournalEntry(dbA, { journalEntryId: json(first).journalId }, actor);

      await changeBranchStatus(dbA, cabang, { to: "CLOSED", reason: "Cabang ditutup" }, actor);
      const denied = await call(worker, "POST", A("/journal"), { payload: journalBody() });
      expect(denied.statusCode).toBe(403);
      expect(json(denied).code).toBe("BRANCH_CONTEXT_INVALID");
      const forcedHeader = await call(worker, "POST", A("/journal"), { payload: journalBody(), headers: { "x-branch-context": cabang } });
      expect(forcedHeader.statusCode).toBe(403);
      // PUT konteks ke cabang CLOSED (dalam akses tetapi bukan operasional) juga ditolak
      const pickClosed = await call(worker, "PUT", A("/branch-context"), { payload: { branchId: cabang } });
      expect(pickClosed.statusCode).toBe(403);
      expect(json(pickClosed).code).toBe("BRANCH_CONTEXT_INVALID");
      // historis tetap terbaca lewat ?branchId (cakupan akses, bukan konteks)
      const history = await call(worker, "GET", A(`/journals?branchId=${cabang}`));
      expect(history.statusCode).toBe(200);
      expect(json(history).journals).toHaveLength(1);
      expect((await call(worker, "GET", A(`/journals/${json(first).journalId}`))).statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------ deny-by-default
  describe("akun LIMITED: deny-by-default pada route yang belum sadar-cabang", () => {
    it("audit log, analisis, proyeksi, pajak, riwayat impor, daftar akses (level perusahaan) -> 403 BRANCH_SCOPE_UNSUPPORTED; laporan/ledger/dashboard/pencarian/saldo counterparty/export kini sadar-cakupan (Phase 5, diuji di report-scope-http.test.ts)", async () => {
      const urls = [
        "/audit-log",
        "/analysis?fromDate=2026-01-01&toDate=2026-01-31",
        "/projection",
        "/tax-summary?fromDate=2026-01-01&toDate=2026-01-31",
        "/journal-import/history",
        "/access",
      ];
      for (const url of urls) {
        const res = await call(staffMetro, "GET", A(url));
        expect(res.statusCode, url).toBe(403);
        expect(json(res).code, url).toBe("BRANCH_SCOPE_UNSUPPORTED");
      }
      // pemilik (ALL) tidak terpengaruh -- perilaku lama
      expect((await call(owner, "GET", A("/audit-log"))).statusCode).toBe(200);
    });

    it("MATRIKS: setiap route perusahaan yang tidak ada di daftar sadar-cabang ditolak untuk akun LIMITED; tidak ada entri daftar yang usang", async () => {
      const companyRoutesFound = registeredRoutes.filter((r) => r.url.startsWith("/api/company-db/:companySlug"));
      expect(companyRoutesFound.length).toBeGreaterThan(40);

      // 1) tidak ada entri BRANCH_AWARE_ROUTES yang menunjuk route yang tidak terdaftar
      const known = new Set(companyRoutesFound.map((r) => `${r.method} ${r.url}`));
      for (const entry of BRANCH_AWARE_ROUTES) expect(known.has(entry), `entri usang: ${entry}`).toBe(true);

      // 2) route lain -> 403 BRANCH_SCOPE_UNSUPPORTED untuk LIMITED (guard berjalan sebelum handler)
      const leaks: string[] = [];
      for (const r of companyRoutesFound) {
        if (BRANCH_AWARE_ROUTES.has(`${r.method} ${r.url}`)) continue;
        const url = r.url.replace(":companySlug", "company-a").replace(/:[A-Za-z]+/g, "x");
        const res = await call(staffMetro, r.method, url, { payload: ["GET", "DELETE"].includes(r.method) ? undefined : {} });
        let code: string | undefined;
        try {
          code = json(res).code;
        } catch {
          /* bukan JSON */
        }
        if (res.statusCode !== 403 || code !== "BRANCH_SCOPE_UNSUPPORTED") leaks.push(`${r.method} ${r.url} -> ${res.statusCode} ${code ?? ""}`);
      }
      expect(leaks, `route tanpa penjagaan LIMITED:\n${leaks.join("\n")}`).toEqual([]);
    });

    it("route legacy (master DB) yang memakai requireCompanyAccess juga tertutup untuk akun LIMITED", async () => {
      const legacy = registeredRoutes.filter((r) => r.url.includes(":companySlug") && !r.url.startsWith("/api/company-db/:companySlug"));
      expect(legacy.length).toBeGreaterThan(0);
      const open: string[] = [];
      for (const r of legacy) {
        const url = r.url.replace(":companySlug", "company-a").replace(/:[A-Za-z]+/g, "x");
        const res = await call(staffMetro, r.method, url, { payload: ["GET", "DELETE"].includes(r.method) ? undefined : {} });
        // tidak boleh sukses (2xx) untuk user LIMITED
        if (res.statusCode >= 200 && res.statusCode < 300) open.push(`${r.method} ${r.url} -> ${res.statusCode}`);
      }
      expect(open, open.join("\n")).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ lintas perusahaan
  describe("isolasi antar perusahaan", () => {
    it("user perusahaan B tidak dapat mengakses perusahaan A sama sekali (404), walau mengetahui id cabang/jurnal", async () => {
      for (const [method, url] of [
        ["GET", A("/branches")],
        ["GET", A(`/branches/${metro}`)],
        ["GET", A(`/journals/${journalMetro}`)],
        ["GET", A("/branch-context")],
        ["POST", A(`/branches/${metro}/status`)],
      ] as const) {
        const res = await call(outsider, method, url, { payload: method === "POST" ? { to: "CLOSED", reason: "serang" } : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await dbA("branches").where({ id: metro }).first()).status).toBe("ACTIVE");
    });

    it("id cabang perusahaan B tidak dapat di-resolve di perusahaan A (konteks, jurnal, grant, transfer, kebijakan akun)", async () => {
      expect((await call(owner, "POST", A("/journal"), { payload: journalBody({ branchId: bBranch }) })).statusCode).toBe(404);
      expect((await call(owner, "POST", A("/journal"), { payload: journalBody(), headers: { "x-branch-context": bBranch } })).statusCode).toBe(403);
      expect((await call(owner, "GET", A(`/branches/${bBranch}`))).statusCode).toBe(404);
      expect((await call(owner, "POST", A(`/access/${staffAll.id}/branches`), { payload: { branchId: bBranch } })).statusCode).toBe(404);
      expect((await call(owner, "POST", A(`/access/${staffAll.id}/branches/transfer`), { payload: { fromBranchId: metro, toBranchId: bBranch } })).statusCode).toBe(404);
      const policy = await call(owner, "PUT", A(`/accounts/${kasId}/branch-policy`), { payload: { policy: "INTER_BRANCH", counterpartBranchId: bBranch, reason: "uji lintas perusahaan" } });
      expect(policy.statusCode).toBe(400);
      expect((await dbA("accounts").where({ id: kasId }).first()).branch_policy).toBe("ALL_BRANCH");
    });

    it("mengelola akses user dari perusahaan lain ditolak: user bukan anggota perusahaan ini -> 404", async () => {
      const res = await call(owner, "POST", A(`/access/${outsider.id}/branches`), { payload: { branchId: metro } });
      expect(res.statusCode).toBe(404);
      expect(await systemDb("user_branch_access").where({ branch_id: metro, status: "ACTIVE" }).whereIn("access_id", [outsider.accessId!])).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ permission & manajemen
  describe("permission pengelolaan cabang & akses", () => {
    it("pembuatan/ubah/tutup cabang hanya untuk yang berizin; ADMIN boleh, ACCOUNTANT/STAFF tidak; reopen hanya OWNER", async () => {
      const body = { code: "BARU1", name: "Cabang Baru" };
      expect((await call(accountant, "POST", A("/branches"), { payload: body })).statusCode).toBe(403);
      expect((await call(staffAll, "POST", A("/branches"), { payload: body })).statusCode).toBe(403);
      expect((await call(staffMetro, "POST", A("/branches"), { payload: body })).statusCode).toBe(403); // LIMITED
      const created = await call(admin, "POST", A("/branches"), { payload: body });
      expect(created.statusCode).toBe(201);
      const id = json(created).id;

      expect((await call(admin, "PATCH", A(`/branches/${id}`), { payload: { name: "Cabang Baru 2" } })).statusCode).toBe(200);
      expect((await call(accountant, "PATCH", A(`/branches/${id}`), { payload: { name: "x" } })).statusCode).toBe(403);
      expect((await call(admin, "POST", A(`/branches/${id}/status`), { payload: { to: "CLOSED", reason: "Ditutup" } })).statusCode).toBe(200);
      const reopenByAdmin = await call(admin, "POST", A(`/branches/${id}/status`), { payload: { to: "ACTIVE", reason: "Dibuka lagi" } });
      expect(reopenByAdmin.statusCode).toBe(403);
      expect((await call(owner, "POST", A(`/branches/${id}/status`), { payload: { to: "ACTIVE", reason: "Dibuka lagi" } })).statusCode).toBe(200);
      expect((await call(accountant, "POST", A(`/branches/${id}/status`), { payload: { to: "INACTIVE" } })).statusCode).toBe(403);
    });

    it("menutup cabang: draft memblokir (409 + rincian), preview tersedia; alasan wajib; tidak ada hard delete; soft delete hanya OWNER & cabang kosong", async () => {
      const blocked = await call(owner, "POST", A(`/branches/${kotabumi}/status`), { payload: { to: "CLOSED", reason: "Tutup" } });
      expect(blocked.statusCode).toBe(409);
      expect(json(blocked).blockers[0].code).toBe("DRAFT_JOURNALS");
      const preview = json(await call(owner, "GET", A(`/branches/${kotabumi}/close-preview`)));
      expect(preview.blockers[0].count).toBe(1);
      expect((await call(accountant, "GET", A(`/branches/${kotabumi}/close-preview`))).statusCode).toBe(403);
      const noReason = await call(owner, "POST", A(`/branches/${bandar}/status`), { payload: { to: "CLOSED" } });
      expect(noReason.statusCode).toBe(400);

      expect((await call(admin, "DELETE", A(`/branches/${bandar}`))).statusCode).toBe(403); // hanya OWNER
      const inUse = await call(owner, "DELETE", A(`/branches/${kotabumi}`));
      expect(inUse.statusCode).toBe(409);
      expect(json(inUse).code).toBe("BRANCH_IN_USE");
      const spare = json(await call(owner, "POST", A("/branches"), { payload: { code: "SPARE", name: "Cabang Cadangan" } })).id;
      expect((await call(owner, "DELETE", A(`/branches/${spare}`))).statusCode).toBe(200);
      expect(await dbA("branches").where({ id: kotabumi })).toHaveLength(1);
    });

    it("mengaktifkan multi-cabang hanya OWNER; membuat cabang saat multi-cabang mati ditolak", async () => {
      const slug = "company-off";
      const off = await createCompany(slug);
      const ownerOff = await newUser("owner-off");
      const adminOff = await newUser("admin-off");
      await grant(ownerOff, off.companyId, "OWNER", "ALL");
      await grant(adminOff, off.companyId, "ADMIN", "ALL");
      const O = (s: string) => `/api/company-db/${slug}${s}`;
      expect(json(await call(ownerOff, "GET", O("/branch-context"))).multiBranchEnabled).toBe(false);
      const refused = await call(adminOff, "POST", O("/branches"), { payload: { code: "X1", name: "X" } });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).code).toBe("MULTI_BRANCH_DISABLED");
      expect((await call(adminOff, "PUT", O("/multi-branch"), { payload: { enabled: true } })).statusCode).toBe(403);
      expect((await call(ownerOff, "PUT", O("/multi-branch"), { payload: { enabled: true } })).statusCode).toBe(200);
      expect((await call(adminOff, "POST", O("/branches"), { payload: { code: "X1", name: "X" } })).statusCode).toBe(201);
    });

    it("pengelolaan akses cabang: ADMIN boleh memberi/mencabut/mentransfer; tidak boleh mengubah akses sendiri atau user OWNER; hanya cabang ACTIVE", async () => {
      const target = await newUser("target-akses");
      await grant(target, companyA, "STAFF", "LIMITED", []);
      expect((await call(admin, "POST", A(`/access/${target.id}/branches`), { payload: { branchId: metro } })).statusCode).toBe(201);
      expect((await call(admin, "POST", A(`/access/${target.id}/branches`), { payload: { branchId: metro } })).statusCode).toBe(409); // sudah ada
      expect((await call(admin, "POST", A(`/access/${target.id}/branches/transfer`), { payload: { fromBranchId: metro, toBranchId: bandar, reason: "mutasi" } })).statusCode).toBe(200);
      const view = json(await call(admin, "GET", A(`/access/${target.id}/branches`)));
      expect(view.branches.filter((b: any) => b.status === "ACTIVE").map((b: any) => b.branchId)).toEqual([bandar]);
      expect((await call(admin, "DELETE", A(`/access/${target.id}/branches/${bandar}`), { payload: { reason: "selesai" } })).statusCode).toBe(200);

      expect((await call(admin, "POST", A(`/access/${admin.id}/branches`), { payload: { branchId: metro } })).statusCode).toBe(403); // diri sendiri
      expect((await call(admin, "POST", A(`/access/${owner.id}/branches`), { payload: { branchId: metro } })).statusCode).toBe(403); // melebihi wewenang
      expect((await call(accountant, "POST", A(`/access/${target.id}/branches`), { payload: { branchId: metro } })).statusCode).toBe(403); // tanpa permission

      const inactive = (await createBranch(dbA, { code: "NONAKTIF", name: "Nonaktif", status: "INACTIVE" }, actor)).id;
      expect((await call(admin, "POST", A(`/access/${target.id}/branches`), { payload: { branchId: inactive } })).statusCode).toBe(409);

      const audits = await systemDb("system_audit_log").where({ target_user_id: target.id }).select("action");
      expect(audits.map((a: any) => a.action)).toEqual(expect.arrayContaining(["user_branch.access_granted", "user_branch.transferred", "user_branch.access_revoked"]));
    });

    it("cakupan ALL/LIMITED hanya diubah OWNER; OWNER tidak bisa dibatasi; user yang diubah ke ALL kembali melihat semua cabang", async () => {
      const target = await newUser("target-scope");
      await grant(target, companyA, "STAFF", "LIMITED", [metro]);
      expect((await call(admin, "PUT", A(`/access/${target.id}/branch-scope`), { payload: { scope: "ALL" } })).statusCode).toBe(403);
      expect(json(await call(target, "GET", A("/branches"))).branches).toHaveLength(1);
      expect((await call(owner, "PUT", A(`/access/${target.id}/branch-scope`), { payload: { scope: "ALL" } })).statusCode).toBe(200);
      expect(json(await call(target, "GET", A("/branches"))).branches.length).toBeGreaterThan(1);
      // OWNER lain tidak dapat dibatasi
      const owner2 = await newUser("owner-dua");
      await grant(owner2, companyA, "OWNER", "ALL");
      const lim = await call(owner, "PUT", A(`/access/${owner2.id}/branch-scope`), { payload: { scope: "LIMITED" } });
      expect(lim.statusCode).toBe(409);
      expect(json(lim).code).toBe("OWNER_SCOPE_FIXED");
    });

    it("user baru yang diberi akses perusahaan saat multi-cabang aktif dimulai LIMITED tanpa cabang (tidak melihat apa pun)", async () => {
      const newcomer = await newUser("baru-masuk");
      const res = await call(owner, "POST", A("/access"), { payload: { userId: newcomer.id, role: "STAFF" } });
      expect(res.statusCode).toBe(201);
      const access = await systemDb("company_access").where({ system_user_id: newcomer.id, company_id: companyA }).first();
      expect(access.branch_scope).toBe("LIMITED");
      const peek = await call(newcomer, "GET", A("/journals"));
      expect(peek.statusCode).toBe(200);
      expect(json(peek).journals).toEqual([]);
      expect((await call(newcomer, "GET", A("/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-01-31"))).statusCode).toBe(403);
    });
  });

  // ------------------------------------------------------------------ kebijakan akun via HTTP
  describe("kebijakan akun via API", () => {
    it("hanya OWNER yang mengubah; CENTRAL_ONLY memblokir jurnal user cabang dan menerima Pusat", async () => {
      const body = { policy: "CENTRAL_ONLY", reason: "Modal hanya dikelola pusat" };
      expect((await call(admin, "PUT", A(`/accounts/${modalId}/branch-policy`), { payload: body })).statusCode).toBe(403);
      expect((await call(accountant, "PUT", A(`/accounts/${modalId}/branch-policy`), { payload: body })).statusCode).toBe(403);
      expect((await call(owner, "PUT", A(`/accounts/${modalId}/branch-policy`), { payload: body })).statusCode).toBe(200);

      const lines = [{ accountId: kasId, debit: 100, credit: 0 }, { accountId: modalId, debit: 0, credit: 100 }];
      const denied = await call(staffMetro, "POST", A("/journal"), { payload: journalBody({ lines }) });
      expect(denied.statusCode).toBe(400);
      expect(json(denied)).toMatchObject({ code: "ACCOUNT_POLICY_VIOLATION", policy: "CENTRAL_ONLY" });
      expect((await call(owner, "POST", A("/journal"), { payload: journalBody({ lines }) })).statusCode).toBe(201); // Pusat
      // kembalikan agar tes lain tidak terpengaruh
      await call(owner, "PUT", A(`/accounts/${modalId}/branch-policy`), { payload: { policy: "ALL_BRANCH", reason: "Kembalikan" } });
    });

    it("SYSTEM_ONLY dan INTER_BRANCH tidak dapat dipakai jurnal manual; nama akun tidak mempengaruhi", async () => {
      const sysId = crypto.randomUUID();
      await dbA("accounts").insert({ id: sysId, code: "9001", name: "Akun Sistem", account_type_id: (await dbA("account_types").where({ code: "EXPENSE" }).first()).id, normal_balance: "debit", branch_policy: "SYSTEM_ONLY" });
      const ibId = crypto.randomUUID();
      await dbA("accounts").insert({ id: ibId, code: "9002", name: "Kas Kecil", account_type_id: (await dbA("account_types").where({ code: "LIABILITY" }).first()).id, normal_balance: "credit", branch_policy: "INTER_BRANCH", counterpart_branch_id: kotabumi });
      for (const accountId of [sysId, ibId]) {
        const lines = [{ accountId: kasId, debit: 100, credit: 0 }, { accountId, debit: 0, credit: 100 }];
        const res = await call(owner, "POST", A("/journal"), { payload: journalBody({ lines }) });
        expect(res.statusCode).toBe(400);
        expect(json(res).code).toBe("ACCOUNT_POLICY_VIOLATION");
      }
    });

    it("INTER_BRANCH: counterpart dari perusahaan lain ditolak; pembuatan terpandu butuh preview + konfirmasi dan hanya OWNER", async () => {
      const foreign = await call(owner, "PUT", A(`/accounts/${hutangId}/branch-policy`), { payload: { policy: "INTER_BRANCH", counterpartBranchId: bBranch, reason: "uji" } });
      expect(foreign.statusCode).toBe(400);
      const body = { branchAId: metro, branchBId: bandar, accountTypeCode: "LIABILITY", codeCounterpartB: "1901", codeCounterpartA: "1902" };
      expect((await call(admin, "POST", A("/accounts/inter-branch/preview"), { payload: body })).statusCode).toBe(403);
      const preview = await call(owner, "POST", A("/accounts/inter-branch/preview"), { payload: body });
      expect(preview.statusCode).toBe(200);
      expect(json(preview).canConfirm).toBe(true);
      expect(await dbA("accounts").whereIn("code", ["1901", "1902"])).toHaveLength(0); // preview tidak membuat apa pun
      expect((await call(owner, "POST", A("/accounts/inter-branch"), { payload: { ...body, confirm: false } })).statusCode).toBe(400);
      const created = await call(owner, "POST", A("/accounts/inter-branch"), { payload: { ...body, confirm: true } });
      expect(created.statusCode).toBe(201);
      const rows = await dbA("accounts").whereIn("code", ["1901", "1902"]).orderBy("code");
      expect(rows.map((r: any) => [r.code, r.branch_policy, r.counterpart_branch_id])).toEqual([["1901", "INTER_BRANCH", bandar], ["1902", "INTER_BRANCH", metro]]);
      // percobaan kedua: sudah ada -> tidak digandakan
      expect((await call(owner, "POST", A("/accounts/inter-branch"), { payload: { ...body, confirm: true } })).statusCode).toBe(409);
    });
  });

  // ------------------------------------------------------------------ saldo awal per cabang
  describe("saldo awal per cabang via API", () => {
    it("satu saldo awal per cabang: Metro dan Pusat masing-masing satu; staf cabang lain tidak dapat menyentuh saldo awal Metro", async () => {
      const body = { entryDate: "2026-01-02", periodId, lines: [{ accountId: kasId, debit: 900, credit: 0 }, { accountId: modalId, debit: 0, credit: 900 }] };
      const m = await call(staffMetro, "POST", A("/opening-balance"), { payload: body });
      expect(m.statusCode).toBe(201);
      expect((await call(staffMetro, "POST", A("/opening-balance"), { payload: body })).statusCode).toBe(409);
      expect((await call(owner, "POST", A("/opening-balance"), { payload: body })).statusCode).toBe(201); // Pusat punya sendiri

      expect(json(await call(staffMetro, "GET", A("/opening-balance"))).branchId).toBe(metro);
      // user yang konteksnya Bandar Lampung tidak melihat/menghapus saldo awal Metro
      const bl = await call(staffMetroBl, "GET", A("/opening-balance"), { headers: { "x-branch-context": bandar } });
      expect(json(bl).exists).toBe(false);
      const del = await call(staffMetroBl, "DELETE", A("/opening-balance"), { headers: { "x-branch-context": bandar } });
      expect(del.statusCode).toBe(404);
      expect(await dbA("journal_entries").where({ branch_id: metro, is_opening_balance: 1, status: "DRAFT" })).toHaveLength(1);
      // tampering cabang pada saldo awal: header di luar akses
      expect((await call(staffMetro, "POST", A("/opening-balance"), { payload: body, headers: { "x-branch-context": kotabumi } })).statusCode).toBe(403);
    });
  });
});
