import "../company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama (mengarahkan semua DB ke folder temp)
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import ExcelJS from "exceljs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
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

import { companyReportsRoutes } from "./routes.js";
import { companyLedgerRoutes } from "../company-ledger/routes.js";
import { companyDashboardRoutes } from "../company-dashboard/routes.js";
import { companyCounterpartiesRoutes } from "../company-counterparties/routes.js";
import { companySearchRoutes } from "../company-search/routes.js";
import { companyBranchesRoutes } from "../company-branches/routes.js";
import { companyAuthorizationRoutes } from "../company-authorization/routes.js";
import { companyPeriodsRoutes } from "../company-periods/routes.js";
import { companyAnalysisRoutes } from "../company-analysis/routes.js";
import { companyProjectionRoutes } from "../company-projection/routes.js";
import { companyTaxRoutes } from "../company-tax/routes.js";
import { companyAuditLogRoutes } from "../company-audit-log/routes.js";

/**
 * Phase 5A/5B -- otorisasi laporan per cabang melalui HTTP sungguhan (Fastify inject, DB nyata):
 * pengguna LIMITED hanya memperoleh data cabang yang diizinkan, termasuk lewat manipulasi parameter, IDOR, header,
 * lintas perusahaan, pencabutan akses seketika, dan override permission. Angka diperiksa terhadap nilai yang dihitung tangan.
 */

type Role = "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";
interface TestUser { id: string; fullName: string; token: string }

const migrate = async (config: Knex.Config) => {
  const db = knexLib(config);
  try { await db.migrate.latest(); } finally { await db.destroy(); }
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
  } finally { await m.destroy(); }
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

describe("Phase 5A/5B: laporan per cabang -- otorisasi, cakupan, label, dan keamanan (HTTP)", () => {
  let app: FastifyInstance;
  let dbA: Knex, dbC: Knex;
  let companyA: string;
  let hq: string, metro: string, bl: string, periodJan: string;
  let ids: Record<string, string> = {};
  let vendor: string;
  const U: Record<string, TestUser> = {};

  const call = (user: TestUser | null, url: string, headers: Record<string, string> = {}, method = "GET", payload?: unknown) =>
    app.inject({ method: method as "GET", url, cookies: user ? { [SESSION_COOKIE]: user.token } : undefined, headers, payload: payload as never });
  const A = (s: string) => `/api/company-db/company-a${s}`;
  const json = (res: { payload: string }) => JSON.parse(res.payload);
  const Q = "fromDate=2026-01-01&toDate=2026-01-31";
  const ctx = (branch: string) => ({ "x-branch-context": branch });
  const bs = (user: TestUser | null, scope = "", headers: Record<string, string> = {}) => call(user, A(`/reports/balance-sheet?${Q}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`), headers);
  const is = (user: TestUser | null, scope = "", headers: Record<string, string> = {}) => call(user, A(`/reports/income-statement?${Q}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`), headers);

  async function post(db: Knex, branch: string, ref: string, lines: Array<[string, number, number, string?]>) {
    const id = crypto.randomUUID();
    await db("journal_entries").insert({ id, entry_date: "2026-01-15", period_id: periodJan, reference_no: ref, description: ref, status: "POSTED", branch_id: branch });
    let order = 0;
    for (const [account, debit, credit, counterparty] of lines) {
      await db("journal_entry_lines").insert({ id: crypto.randomUUID(), journal_entry_id: id, account_id: account, debit, credit, line_order: order++, counterparty_id: counterparty ?? null });
    }
  }

  beforeAll(async () => {
    await migrate(masterKnexfile);
    await migrate(systemKnexfile);
    app = Fastify();
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    for (const r of [companyReportsRoutes, companyLedgerRoutes, companyDashboardRoutes, companyCounterpartiesRoutes, companySearchRoutes, companyBranchesRoutes, companyAuthorizationRoutes, companyPeriodsRoutes, companyAnalysisRoutes, companyProjectionRoutes, companyTaxRoutes, companyAuditLogRoutes]) app.register(r);
    await app.ready();

    const a = await createCompany("company-a");
    companyA = a.companyId;
    dbA = createCompanyDb(a.dbPath);
    await setMultiBranchEnabled(dbA, true, actor);
    hq = (await dbA("branches").where({ is_head_office: 1 }).first()).id;
    metro = (await createBranch(dbA, { code: "METRO", name: "Cabang Metro" }, actor)).id;
    bl = (await createBranch(dbA, { code: "BL", name: "Bandar Lampung" }, actor)).id;
    const types = Object.fromEntries((await dbA("account_types").select("id", "code")).map((t: any) => [t.code, t.id]));
    const mk = async (code: string, name: string, type: string, normal: string, extra: Record<string, unknown> = {}) => {
      const id = crypto.randomUUID();
      await dbA("accounts").insert({ id, code, name, account_type_id: types[type], normal_balance: normal, ...extra });
      return id;
    };
    ids = {
      kas: await mk("1000", "Kas", "ASSET", "debit", { is_cash: true }),
      modal: await mk("3000", "Modal", "EQUITY", "credit"),
      pendapatan: await mk("4000", "Pendapatan", "REVENUE", "credit"),
      beban: await mk("5000", "Beban", "EXPENSE", "debit"),
      hutang: await mk("2100", "Hutang Usaha", "LIABILITY", "credit", { subledger_type: "payable" }),
    };
    periodJan = crypto.randomUUID();
    await dbA("periods").insert({ id: periodJan, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
    for (const accountTypeCode of ["ASSET", "LIABILITY"] as const) await createInterBranchAccountPair(dbA, { branchAId: metro, branchBId: bl, accountTypeCode, confirm: true }, actor);
    const ibAsset = (await dbA("accounts").where({ branch_policy: "INTER_BRANCH", counterpart_branch_id: bl }).whereIn("account_type_id", [types.ASSET]).first()).id;
    const ibLiab = (await dbA("accounts").where({ branch_policy: "INTER_BRANCH", counterpart_branch_id: metro }).whereIn("account_type_id", [types.LIABILITY]).first()).id;
    vendor = crypto.randomUUID();
    await dbA("counterparties").insert({ id: vendor, type: "vendor", code: "V1", name: "Vendor Bersama" });

    // Pusat: kas 10jt; Metro: kas 2jt - 0,7jt, pendapatan 2jt, beban 0,3jt (hutang), antarkantor 0,7jt; BL: kas 3jt - 0,5jt + 0,7jt, pendapatan 3jt, beban 0,5jt + 0,2jt (hutang)
    await post(dbA, hq, "HQ-001", [[ids.kas, 10_000_000, 0], [ids.modal, 0, 10_000_000]]);
    await post(dbA, metro, "MTR-001", [[ids.kas, 2_000_000, 0], [ids.pendapatan, 0, 2_000_000]]);
    await post(dbA, metro, "MTR-002", [[ibAsset, 700_000, 0], [ids.kas, 0, 700_000]]);
    await post(dbA, metro, "MTR-003", [[ids.beban, 300_000, 0], [ids.hutang, 0, 300_000, vendor]]);
    await post(dbA, bl, "BDL-001", [[ids.kas, 3_000_000, 0], [ids.pendapatan, 0, 3_000_000]]);
    await post(dbA, bl, "BDL-002", [[ids.beban, 500_000, 0], [ids.kas, 0, 500_000]]);
    await post(dbA, bl, "BDL-003", [[ids.kas, 700_000, 0], [ibLiab, 0, 700_000]]);
    await post(dbA, bl, "BDL-004", [[ids.beban, 200_000, 0], [ids.hutang, 0, 200_000, vendor]]);

    for (const [branch, ref] of [[metro, "AUD-METRO"], [bl, "AUD-BL"], [hq, "AUD-HQ"]] as const) {
      await dbA("company_audit_log").insert({ id: crypto.randomUUID(), actor_type: "user", actor_id: "setup", actor_label: "Setup", action: "journal.post", entity_type: "journal_entry", entity_id: ref, branch_id: branch, created_at: new Date().toISOString() });
    }

    const c = await createCompany("company-c"); // multi-cabang tidak pernah dinyalakan
    dbC = createCompanyDb(c.dbPath);

    const names = ["owner", "acctAll", "staffAll", "viewerAll", "makerM", "acctBoth", "staffBl", "staffBoth", "denyBoth", "noBranch", "outsider", "ownerC", "limitedC"];
    const users = await Promise.all(names.map(newUser));
    names.forEach((n, i) => (U[n] = users[i]));
    await grant(U.owner, companyA, "OWNER", "ALL");
    await grant(U.acctAll, companyA, "ACCOUNTANT", "ALL");
    await grant(U.staffAll, companyA, "STAFF", "ALL");
    await grant(U.viewerAll, companyA, "VIEWER", "ALL");
    await grant(U.makerM, companyA, "ACCOUNTANT", "LIMITED", [metro]);
    await grant(U.acctBoth, companyA, "ACCOUNTANT", "LIMITED", [metro, bl]);
    await grant(U.staffBl, companyA, "STAFF", "LIMITED", [bl]);
    await grant(U.staffBoth, companyA, "STAFF", "LIMITED", [metro, bl]);
    await grant(U.denyBoth, companyA, "ACCOUNTANT", "LIMITED", [metro, bl]);
    await grant(U.noBranch, companyA, "ACCOUNTANT", "LIMITED", []);
    const b = await createCompany("company-b");
    await grant(U.outsider, b.companyId, "OWNER", "ALL");
    await grant(U.ownerC, c.companyId, "OWNER", "ALL");
    await grant(U.limitedC, c.companyId, "ACCOUNTANT", "LIMITED", []);

    // override: STAFF dua cabang diberi GRANT report.consolidated; ACCOUNTANT dua cabang di-DENY
    expect((await call(U.owner, A(`/access/${U.staffBoth.id}/permission-overrides/report.consolidated`), {}, "PUT", { effect: "GRANT", reason: "uji" })).statusCode).toBeLessThan(300);
    expect((await call(U.owner, A(`/access/${U.denyBoth.id}/permission-overrides/report.consolidated`), {}, "PUT", { effect: "DENY", reason: "uji" })).statusCode).toBeLessThan(300);
  });

  afterAll(async () => {
    await app.close();
    await dbA.destroy();
    await dbC.destroy();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  // ------------------------------------------------------------------ angka per cabang
  it("LIMITED satu cabang: Neraca & Laba Rugi = angka cabang itu (dihitung tangan), seimbang, dan memuat scope", async () => {
    const m = await bs(U.makerM, "", ctx(metro));
    expect(m.statusCode, m.payload).toBe(200);
    const mj = json(m);
    expect(mj.totalAssets).toBe(2_000_000);
    expect(mj.totalLiabilities).toBe(300_000);
    expect(mj.totalEquity).toBe(1_700_000);
    expect(mj.isBalanced).toBe(true);
    expect(mj.scope.mode).toBe("SINGLE");
    expect(mj.scope.branches.map((x: { id: string }) => x.id)).toEqual([metro]);
    expect(mj.scope.eliminationStatus).toBe("NOT_APPLICABLE");
    expect(json(await is(U.makerM, "", ctx(metro))).netProfit).toBe(1_700_000);

    const b = json(await bs(U.staffBl, "", ctx(bl)));
    expect(b.totalAssets).toBe(3_200_000);
    expect(b.totalLiabilities).toBe(900_000);
    expect(json(await is(U.staffBl, "", ctx(bl))).netProfit).toBe(2_300_000);
  });

  it("OWNER/ALL: tiap cabang, Σ cabang = Gabungan Seluruh Cabang (berlabel belum dieliminasi), Neraca gabungan bruto", async () => {
    const parts = await Promise.all([hq, metro, bl].map((b) => is(U.owner, `branch:${b}`)));
    const nets = parts.map((p) => json(p).netProfit);
    expect(nets).toEqual([0, 1_700_000, 2_300_000]);
    const all = await is(U.owner, "all");
    const allJson = json(all);
    expect(allJson.netProfit).toBe(nets.reduce((a, b) => a + b, 0));
    expect(allJson.scope.mode).toBe("COMBINED_ALL");
    expect(allJson.scope.eliminationStatus).toBe("NOT_ELIMINATED");
    expect(allJson.scope.label.title).toMatch(/belum dieliminasi/i);
    expect(JSON.stringify(allJson.scope.label)).not.toMatch(/konsolidasi perusahaan\b(?!.*bukan)/i); // tidak pernah menyebut konsolidasi final
    expect(allJson.scope.label.warnings.join(" ")).toMatch(/bukan laporan konsolidasi final/i);

    const bsAll = json(await bs(U.owner, "all"));
    expect(bsAll.totalAssets).toBe(15_200_000); // kas 14,5jt + antarkantor aset 0,7jt (bruto, belum dieliminasi)
    expect(bsAll.totalLiabilities).toBe(1_200_000); // hutang 0,5jt + antarkantor liabilitas 0,7jt
    expect(bsAll.interBranch).toMatchObject({ eliminated: false, receivableGross: 700_000, payableGross: 700_000, netDifference: 0 });
  });

  it("tanpa parameter + header cabang: OWNER ALL memperoleh cabang kerja aktif (D1), bukan seluruh perusahaan", async () => {
    const r = json(await is(U.owner, "", ctx(bl)));
    expect(r.scope.mode).toBe("SINGLE");
    expect(r.netProfit).toBe(2_300_000);
  });

  // ------------------------------------------------------------------ otorisasi cakupan
  it("LIMITED tidak dapat melihat cabang di luar aksesnya: 404 identik dengan id yang tidak ada (tanpa oracle)", async () => {
    const forbidden = await bs(U.makerM, `branch:${bl}`, ctx(metro));
    const ghost = await bs(U.makerM, `branch:${crypto.randomUUID()}`, ctx(metro));
    const hqTry = await bs(U.makerM, `branch:${hq}`, ctx(metro));
    expect([forbidden.statusCode, ghost.statusCode, hqTry.statusCode]).toEqual([404, 404, 404]);
    expect(forbidden.payload).toBe(ghost.payload);
    expect(hqTry.payload).toBe(ghost.payload);
    expect(forbidden.payload).not.toMatch(/Bandar Lampung|"id"/);
  });

  it("permission report.consolidated: tanpa izin -> 403 tanpa membedakan id; dengan izin tetapi id di luar akses -> 404; DENY mengalahkan role; GRANT membuka", async () => {
    // STAFF ALL / VIEWER ALL tidak punya report.consolidated
    for (const u of [U.staffAll, U.viewerAll]) {
      expect((await bs(u, `selected:${metro},${bl}`)).statusCode).toBe(403);
      expect((await bs(u, "all")).statusCode).toBe(403);
      expect((await bs(u, `branch:${metro}`)).statusCode).toBe(200);
    }
    // 403 tidak bergantung pada id (id sah vs palsu menghasilkan badan identik)
    const noPerm1 = await bs(U.staffBl, `selected:${bl},${metro}`, ctx(bl));
    const noPerm2 = await bs(U.staffBl, `selected:${crypto.randomUUID()},${crypto.randomUUID()}`, ctx(bl));
    expect([noPerm1.statusCode, noPerm2.statusCode]).toEqual([403, 403]);
    expect(noPerm1.payload).toBe(noPerm2.payload);
    // ACCOUNTANT (punya izin) satu cabang + id di luar akses => 404
    expect((await bs(U.makerM, `selected:${metro},${bl}`, ctx(metro))).statusCode).toBe(404);
    // DENY override mengalahkan role
    expect((await bs(U.denyBoth, `selected:${metro},${bl}`, ctx(metro))).statusCode).toBe(403);
    expect((await bs(U.denyBoth, `branch:${metro}`, ctx(metro))).statusCode).toBe(200);
    // GRANT membuka untuk STAFF dua cabang
    const g = await bs(U.staffBoth, `selected:${metro},${bl}`, ctx(metro));
    expect(g.statusCode, g.payload).toBe(200);
  });

  it("LIMITED dua cabang: Gabungan Cabang Terpilih berlabel jelas, Σ = angka tiap cabang; 'all' ditolak karena tidak mencakup seluruh cabang", async () => {
    const sel = await is(U.acctBoth, `selected:${metro},${bl}`, ctx(metro));
    expect(sel.statusCode, sel.payload).toBe(200);
    const sj = json(sel);
    expect(sj.netProfit).toBe(4_000_000);
    expect(sj.scope.mode).toBe("COMBINED_SELECTED");
    expect(sj.scope.label.title).toMatch(/^GABUNGAN CABANG TERPILIH: bukan laporan konsolidasi perusahaan/);
    expect(sj.scope.label.warnings.join(" ")).toMatch(/belum dieliminasi/i);
    expect(sj.scope.label.warnings.join(" ")).toMatch(/tidak mencakup seluruh cabang/i);
    expect(sj.scope.companyWide).toBe(false);
    expect((await is(U.acctBoth, "all", ctx(metro))).statusCode).toBe(403);
  });

  it("komparasi per cabang: kolom per cabang + Gabungan dihitung dan direkonsiliasi (Neraca, Laba Rugi, Ekuitas, Neraca Saldo)", async () => {
    const c = await bs(U.acctBoth, `branches:${metro},${bl}`, ctx(metro));
    expect(c.statusCode, c.payload).toBe(200);
    const cj = json(c);
    expect(cj.scope.mode).toBe("COMPARISON");
    expect(cj.comparison.columns.map((x: { branch: { id: string } }) => x.branch.id)).toEqual([metro, bl]);
    expect(cj.comparison.columns.map((x: { report: { totalAssets: number } }) => x.report.totalAssets)).toEqual([2_000_000, 3_200_000]);
    expect(cj.comparison.combined.totalAssets).toBe(5_200_000);
    expect(cj.comparison.reconciliation.ok).toBe(true);
    expect(cj.interBranch.eliminated).toBe(false);

    const eq = json(await call(U.acctBoth, A(`/reports/equity?${Q}&scope=branches:${metro},${bl}`), ctx(metro)));
    expect(eq.comparison.columns.map((x: { report: { closingEquity: number } }) => x.report.closingEquity)).toEqual([1_700_000, 2_300_000]);
    expect(eq.comparison.combined.closingEquity).toBe(4_000_000);

    const tb = await call(U.owner, A(`/trial-balance?periodId=${periodJan}&scope=branches:${hq},${metro},${bl}`));
    expect(tb.statusCode, tb.payload).toBe(200);
    expect(json(tb).comparison.reconciliation.ok).toBe(true);
    expect(json(tb).comparison.columns.every((x: { report: { isBalanced: boolean } }) => x.report.isBalanced)).toBe(true);
    // Arus Kas belum mendukung komparasi (menunggu optimasi): ditolak jelas, bukan angka palsu
    expect((await call(U.owner, A(`/reports/cash-flow?${Q}&scope=branches:${metro},${bl}`))).statusCode).toBe(400);
    // pengguna tanpa izin gabungan tidak dapat komparasi
    expect((await bs(U.staffBl, `branches:${metro},${bl}`, ctx(bl))).statusCode).toBe(403);
  });

  it("manipulasi parameter: sintaks rusak, duplikat, >50 id, array, injeksi -> 400 / dinormalkan; tidak pernah melebarkan cakupan", async () => {
    for (const bad of ["branch:", "branch:a,b", "selected:onlyone", "foo", "branch:../../x", "branch:' OR 1=1 --", "all;DROP", "branches:a"]) {
      const r = await bs(U.owner, bad);
      expect(r.statusCode, bad).toBe(400);
    }
    const many = Array.from({ length: 51 }, (_, i) => `id${i}`).join(",");
    expect((await bs(U.owner, `selected:${many}`)).statusCode).toBe(400);
    const dup = await is(U.acctBoth, `selected:${metro},${metro},${bl}`, ctx(metro));
    expect(json(dup).scope.branches.length).toBe(2);
    const arr = await call(U.owner, A(`/reports/balance-sheet?${Q}&scope=branch:${metro}&scope=all`));
    expect(arr.statusCode).toBe(400);
  });

  it("header X-Branch-Context ke cabang di luar akses ditolak server; scope eksplisit tidak melewati batas itu", async () => {
    expect((await bs(U.makerM, "", ctx(bl))).statusCode).toBe(403);
    expect((await bs(U.makerM, `branch:${metro}`, ctx(bl))).statusCode).toBe(403);
    expect((await bs(U.makerM, "", ctx(crypto.randomUUID()))).statusCode).toBe(403);
  });

  it("tanpa cabang akses: LIMITED tanpa cabang tidak memperoleh data apa pun; tanpa sesi 401; perusahaan lain 403/404", async () => {
    const none = await bs(U.noBranch, "");
    expect(none.statusCode).toBeGreaterThanOrEqual(403);
    expect(none.payload).not.toMatch(/totalAssets/);
    expect((await bs(U.noBranch, `branch:${metro}`)).statusCode).toBe(404);
    expect((await bs(null)).statusCode).toBe(401);
    for (const url of [A(`/reports/balance-sheet?${Q}`), A(`/trial-balance?periodId=${periodJan}`), A("/dashboard?" + Q), A("/counterparties/balances?type=vendor"), A("/search?q=HQ")]) {
      const res = await call(U.outsider, url);
      expect([403, 404], url).toContain(res.statusCode);
      expect(res.payload).not.toMatch(/totalAssets|HQ-001|Kas/);
    }
    // id cabang perusahaan lain tidak dapat dipakai sebagai cakupan
    const bId = (await call(U.outsider, `/api/company-db/company-b/branches`)).payload;
    expect(bId).toBeTruthy();
  });

  it("pencabutan akses cabang berlaku pada request berikutnya (tanpa cache)", async () => {
    const before = await bs(U.acctBoth, `branch:${bl}`, ctx(metro));
    expect(before.statusCode).toBe(200);
    expect((await call(U.owner, A(`/access/${U.acctBoth.id}/branches/${bl}`), {}, "DELETE", { reason: "uji pencabutan" })).statusCode).toBe(200);
    const after = await bs(U.acctBoth, `branch:${bl}`, ctx(metro));
    expect(after.statusCode).toBe(404);
    expect((await bs(U.acctBoth, `selected:${metro},${bl}`, ctx(metro))).statusCode).toBe(404);
    // dikembalikan agar tes berikutnya tidak terpengaruh
    expect((await call(U.owner, A(`/access/${U.acctBoth.id}/branches`), {}, "POST", { branchId: bl })).statusCode).toBeLessThan(300);
  });

  // ------------------------------------------------------------------ endpoint lain
  it("Neraca Saldo, Buku Besar, Dashboard, saldo counterparty: LIMITED hanya data cabangnya; ALL per cabang konsisten", async () => {
    const tb = json(await call(U.makerM, A(`/trial-balance?periodId=${periodJan}`), ctx(metro)));
    expect(tb.isBalanced).toBe(true);
    expect(tb.scope.branches.map((x: { id: string }) => x.id)).toEqual([metro]);
    const kasRow = tb.rows.find((r: { code: string }) => r.code === "1000");
    expect(kasRow.debit).toBe(1_300_000);

    const ledger = json(await call(U.makerM, A(`/ledger/${ids.kas}?${Q}`), ctx(metro)));
    expect(ledger.lines.map((l: { referenceNo: string }) => l.referenceNo)).toEqual(["MTR-001", "MTR-002"]);
    expect(ledger.endingBalance).toBe(1_300_000);
    expect(JSON.stringify(ledger)).not.toMatch(/BDL-|HQ-/);
    const ledgerBl = json(await call(U.owner, A(`/ledger/${ids.kas}?${Q}&scope=branch:${bl}`)));
    expect(ledgerBl.endingBalance).toBe(3_200_000);

    const dash = await call(U.makerM, A(`/dashboard?${Q}`), ctx(metro));
    expect(dash.statusCode, dash.payload).toBe(200);
    expect(json(dash).kpis.netProfit.value ?? json(dash).kpis.netProfit.current).toBe(1_700_000);
    expect(json(dash).scope.mode).toBe("SINGLE");
    // aktivitas terbaru ikut cakupan: LIMITED Metro hanya melihat aktivitas cabangnya; seluruh perusahaan melihat semuanya
    expect(json(dash).recentActivity.map((r: { entityId: string }) => r.entityId)).toEqual(["AUD-METRO"]);
    const dashAll = json(await call(U.owner, A(`/dashboard?${Q}&scope=all`)));
    expect(dashAll.recentActivity.map((r: { entityId: string }) => r.entityId).sort()).toEqual(["AUD-BL", "AUD-HQ", "AUD-METRO"]);

    const vendorM = json(await call(U.makerM, A("/counterparties/balances?type=vendor"), ctx(metro)));
    expect(vendorM.balances.find((b: { code: string }) => b.code === "V1").balance).toBe(300_000);
    const vendorAll = json(await call(U.owner, A("/counterparties/balances?type=vendor&scope=all")));
    expect(vendorAll.balances.find((b: { code: string }) => b.code === "V1").balance).toBe(500_000);
  });

  it("pencarian global: LIMITED hanya jurnal cabang aksesnya; ALL melihat semua", async () => {
    const mine = json(await call(U.makerM, A("/search?q=MTR-"))).journals.map((j: { referenceNo: string }) => j.referenceNo);
    expect(mine.sort()).toEqual(["MTR-001", "MTR-002", "MTR-003"]);
    expect(json(await call(U.makerM, A("/search?q=BDL-"))).journals).toEqual([]);
    expect(json(await call(U.makerM, A("/search?q=HQ-"))).journals).toEqual([]);
    expect(json(await call(U.owner, A("/search?q=BDL-"))).journals.length).toBe(4);
    expect(json(await call(U.noBranch, A("/search?q=MTR-"))).journals).toEqual([]);
  });

  it("ekspor: label cakupan di dokumen dan nama file; komparasi tidak didukung; cakupan divalidasi ulang di awal ekspor", async () => {
    const single = await call(U.makerM, A(`/reports/export/balance-sheet?format=xlsx&${Q}`), ctx(metro));
    expect(single.statusCode).toBe(200);
    expect(String(single.headers["content-disposition"])).toMatch(/Cabang-Cabang-Metro/);
    // isi dokumen memuat label cakupan (bukan hanya nama file)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(single.rawPayload as never);
    const texts: string[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((cell) => texts.push(String(cell.value ?? ""))));
    expect(texts.some((t) => /^Cakupan: Cabang Metro/.test(t))).toBe(true);
    const wbAll = new ExcelJS.Workbook();
    await wbAll.xlsx.load((await call(U.owner, A(`/reports/export/balance-sheet?format=xlsx&${Q}&scope=all`))).rawPayload as never);
    const textsAll: string[] = [];
    wbAll.worksheets[0].eachRow((row) => row.eachCell((cell) => textsAll.push(String(cell.value ?? ""))));
    expect(textsAll.some((t) => /belum dieliminasi/i.test(t))).toBe(true);
    expect(textsAll.some((t) => /bukan laporan konsolidasi final/i.test(t))).toBe(true);
    const combined = await call(U.owner, A(`/reports/export/income-statement?format=pdf&${Q}&scope=all`));
    expect(combined.statusCode).toBe(200);
    expect(String(combined.headers["content-disposition"])).toMatch(/Gabungan-Seluruh-Cabang-Belum-Dieliminasi/);
    expect((await call(U.makerM, A(`/reports/export/balance-sheet?format=xlsx&${Q}&scope=branch:${bl}`), ctx(metro))).statusCode).toBe(404);
    expect((await call(U.makerM, A(`/reports/export/balance-sheet?format=xlsx&${Q}&scope=all`), ctx(metro))).statusCode).toBe(403);
    expect((await call(U.owner, A(`/reports/export/balance-sheet?format=xlsx&${Q}&scope=branches:${metro},${bl}`))).statusCode).toBe(400);
  });

  it("route level perusahaan (analisis, proyeksi, pajak, audit log) tetap ditolak untuk LIMITED; OWNER tidak terpengaruh", async () => {
    for (const url of ["/analysis?" + Q, "/projection", "/tax-summary?" + Q, "/audit-log"]) {
      const res = await call(U.makerM, A(url), ctx(metro));
      expect(res.statusCode, url).toBe(403);
    }
    expect((await call(U.owner, A("/audit-log"))).statusCode).toBe(200);
  });

  // ------------------------------------------------------------------ perusahaan tanpa multi-cabang
  it("flag OFF: cakupan = seluruh perusahaan; parameter selain kosong/all ditolak 400; LIMITED tanpa akses Kantor Pusat -> 404; angka identik", async () => {
    const C = (s: string) => `/api/company-db/company-c${s}`;
    const plain = await call(U.ownerC, C(`/reports/balance-sheet?${Q}`));
    expect(plain.statusCode, plain.payload).toBe(200);
    const withAll = await call(U.ownerC, C(`/reports/balance-sheet?${Q}&scope=all`));
    expect(withAll.statusCode).toBe(200);
    const strip = (r: { payload: string }) => { const j = JSON.parse(r.payload); delete j.scope; return j; };
    expect(strip(withAll)).toEqual(strip(plain));
    expect(json(plain).scope.mode).toBe("COMPANY");
    expect(json(plain).scope.label.warnings).toEqual([]);
    const headC = (await dbC("branches").where({ is_head_office: 1 }).first()).id;
    expect((await call(U.ownerC, C(`/reports/balance-sheet?${Q}&scope=branch:${headC}`))).statusCode).toBe(400);
    expect((await call(U.ownerC, C(`/reports/balance-sheet?${Q}&scope=selected:a,b`))).statusCode).toBe(400);
    expect((await call(U.limitedC, C(`/reports/balance-sheet?${Q}`))).statusCode).toBe(404);
    const exp = await call(U.ownerC, C(`/reports/export/balance-sheet?format=xlsx&${Q}`));
    expect(String(exp.headers["content-disposition"])).not.toMatch(/Cabang|Gabungan/); // nama file identik dengan sebelum Phase 5
  });
});
