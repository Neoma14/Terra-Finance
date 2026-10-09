import "../modules/company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama (mengarahkan semua DB ke folder temp)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { BRANCH_AWARE_ROUTES } from "../middleware/branch-authority.js";
import { requireAuth } from "../middleware/auth-guard.js";
import { requireCompanyAccess } from "../middleware/company-access-guard.js";

/**
 * PHASE 5.0 -- tes arsitektur FAIL-CLOSED untuk kesiapan cakupan cabang (laporan Phase 5).
 *
 * Tujuan: tidak ada route atau berkas yang menyentuh data jurnal yang "diam-diam" dianggap non-cabang.
 *   1. Setiap route terdaftar di server.ts WAJIB sadar-cabang (BRANCH_AWARE_ROUTES) ATAU tercantum eksplisit di registri di bawah.
 *      Route baru tanpa klasifikasi => tes GAGAL (bukan lolos diam-diam).
 *   2. Registri dan BRANCH_AWARE_ROUTES tidak boleh saling tumpang tindih atau menyimpan entri usang.
 *      Saat 5A menjadikan sebuah route sadar-cakupan, entrinya HARUS dipindah dari registri -- tes memaksa keputusan sadar itu.
 *   3. Setiap route ber-:companySlug WAJIB lewat requireAuth + requireCompanyAccess.
 *   4. Hanya berkas yang tercantum yang boleh menyebut tabel jurnal; berkas baru yang menyentuhnya => GAGAL sampai diklasifikasikan.
 *
 * Perilaku produk TIDAK diubah oleh tes ini; ia hanya mengunci keadaan Phase 3 sebagai titik awal 5A.
 */

/** Route baca-keuangan yang sadar-cakupan (Phase 5A/5B) beserta modul yang wajib menurunkan cakupan di server. */
const SCOPED_READ_ROUTES: Record<string, string> = {
  "GET /api/company-db/:companySlug/reports/balance-sheet": "modules/company-reports/routes.ts",
  "GET /api/company-db/:companySlug/reports/income-statement": "modules/company-reports/routes.ts",
  "GET /api/company-db/:companySlug/reports/equity": "modules/company-reports/routes.ts",
  "GET /api/company-db/:companySlug/reports/cash-flow": "modules/company-reports/routes.ts",
  "GET /api/company-db/:companySlug/reports/export/:kind": "modules/company-reports/routes.ts",
  "GET /api/company-db/:companySlug/trial-balance": "modules/company-ledger/routes.ts",
  "GET /api/company-db/:companySlug/ledger/:accountId": "modules/company-ledger/routes.ts",
  "GET /api/company-db/:companySlug/dashboard": "modules/company-dashboard/routes.ts",
  "GET /api/company-db/:companySlug/counterparties/balances": "modules/company-counterparties/routes.ts",
  "GET /api/company-db/:companySlug/search": "modules/company-search/routes.ts",
};

type RouteClass =
  | "READ_FINANCIAL_PENDING_5A" // membaca angka keuangan; saat ini ditolak untuk LIMITED; 5A: wajib AuthorizedScope
  | "REVIEW_5A" // perlu keputusan sebelum 5A (lihat laporan 5.0)
  | "ADMIN_ALL_BY_DESIGN" // tetap hanya scope ALL (D9)
  | "COMPANY_LEVEL" // master/pengaturan level perusahaan, tanpa angka per cabang
  | "PHASE1_3_ADMIN_ALL" // pengelolaan cabang/akses/delegasi (baseline beku), hanya scope ALL
  | "LEGACY_MASTER" // jalur master-DB lama (`/api/c/:slug`), bukan company.db
  | "COMPANY_REGISTRY" // daftar/pendaftaran perusahaan (tanpa slug)
  | "NON_COMPANY"; // auth, administrator, lisensi, setup, pengguna instalasi

const REGISTRY: Record<RouteClass, string[]> = {
  // Phase 5A/5B: 10 route lain sudah sadar-cakupan (lihat SCOPED_READ_ROUTES). Sisanya tetap level perusahaan (D3): LIMITED ditolak.
  READ_FINANCIAL_PENDING_5A: [
    "GET /api/company-db/:companySlug/analysis",
    "GET /api/company-db/:companySlug/projection",
    "GET /api/company-db/:companySlug/tax-summary",
  ],
  REVIEW_5A: [
    "GET /api/company-db/:companySlug/journal-import/history",
  ],
  ADMIN_ALL_BY_DESIGN: [
    "GET /api/company-db/:companySlug/audit-log",
  ],
  COMPANY_LEVEL: [
    "GET /api/company-db/:companySlug/accounts-import/history",
    "GET /api/company-db/:companySlug/accounts-import/template",
    "GET /api/company-db/:companySlug/counterparties",
    "GET /api/company-db/:companySlug/periods/:id/closing-check",
    "GET /api/company-db/:companySlug/tax-settings",
    "PATCH /api/company-db/:companySlug/accounts/:id",
    "PATCH /api/company-db/:companySlug/profile",
    "PATCH /api/company-db/:companySlug/tax-settings",
    "POST /api/company-db/:companySlug/accounts",
    "POST /api/company-db/:companySlug/accounts-import/commit",
    "POST /api/company-db/:companySlug/accounts-import/preview",
    "POST /api/company-db/:companySlug/accounts/:id/lock",
    "POST /api/company-db/:companySlug/accounts/:id/unlock",
    "POST /api/company-db/:companySlug/counterparties",
    "POST /api/company-db/:companySlug/periods",
    "POST /api/company-db/:companySlug/periods/:id/close",
    "POST /api/company-db/:companySlug/periods/:id/lock",
    "POST /api/company-db/:companySlug/periods/generate-monthly",
  ],
  PHASE1_3_ADMIN_ALL: [
    "DELETE /api/company-db/:companySlug/access/:userId",
    "DELETE /api/company-db/:companySlug/branches/:id",
    "GET /api/company-db/:companySlug/access",
    "GET /api/company-db/:companySlug/branches/:id/close-preview",
    "PATCH /api/company-db/:companySlug/access/:userId",
    "PATCH /api/company-db/:companySlug/access/:userId/status",
    "POST /api/company-db/:companySlug/access",
    "POST /api/company-db/:companySlug/accounts/inter-branch",
    "POST /api/company-db/:companySlug/accounts/inter-branch/preview",
    "POST /api/company-db/:companySlug/branches",
    "POST /api/company-db/:companySlug/branches/:id/status",
    "PUT /api/company-db/:companySlug/access/:userId/branch-scope",
    "PUT /api/company-db/:companySlug/accounts/:id/branch-policy",
    "PUT /api/company-db/:companySlug/journal-settings",
    "PUT /api/company-db/:companySlug/multi-branch",
  ],
  LEGACY_MASTER: [
    "DELETE /api/c/:companySlug/accounts/:id",
    "DELETE /api/c/:companySlug/logo",
    "GET /api/c/:companySlug",
    "GET /api/c/:companySlug/accounts",
    "GET /api/c/:companySlug/accounts/export/range",
    "GET /api/c/:companySlug/accounts/import/template",
    "GET /api/c/:companySlug/counterparties",
    "GET /api/c/:companySlug/journal",
    "GET /api/c/:companySlug/journal/:id",
    "GET /api/c/:companySlug/journal/export",
    "GET /api/c/:companySlug/journal/template",
    "GET /api/c/:companySlug/ledger",
    "GET /api/c/:companySlug/ledger/balances",
    "GET /api/c/:companySlug/ledger/balances/range",
    "GET /api/c/:companySlug/ledger/export/range",
    "GET /api/c/:companySlug/ledger/range",
    "GET /api/c/:companySlug/periods",
    "GET /api/c/:companySlug/ratios/export/range",
    "GET /api/c/:companySlug/ratios/range",
    "GET /api/c/:companySlug/ratios/trend",
    "GET /api/c/:companySlug/statement-lines",
    "GET /api/c/:companySlug/statements/balance-sheet",
    "GET /api/c/:companySlug/statements/cash-flow",
    "GET /api/c/:companySlug/statements/cash-flow/detail/range",
    "GET /api/c/:companySlug/statements/equity",
    "GET /api/c/:companySlug/statements/export/range",
    "GET /api/c/:companySlug/statements/income-statement",
    "GET /api/c/:companySlug/statements/trend/range",
    "GET /api/c/:companySlug/tax/estimate",
    "GET /api/c/:companySlug/tax/estimate/export/range",
    "GET /api/c/:companySlug/tax/estimate/range",
    "GET /api/c/:companySlug/tax/reference",
    "PATCH /api/c/:companySlug",
    "PATCH /api/c/:companySlug/accounts/:id",
    "POST /api/c/:companySlug/accounts",
    "POST /api/c/:companySlug/accounts/import/commit",
    "POST /api/c/:companySlug/accounts/import/preview",
    "POST /api/c/:companySlug/counterparties",
    "POST /api/c/:companySlug/journal/commit",
    "POST /api/c/:companySlug/journal/manual",
    "POST /api/c/:companySlug/journal/preview",
    "POST /api/c/:companySlug/journal/reversal",
    "POST /api/c/:companySlug/logo",
    "PUT /api/c/:companySlug/tax/reference",
  ],
  COMPANY_REGISTRY: [
    "GET /api/company-db",
    "POST /api/company-db",
  ],
  NON_COMPANY: [
    "DELETE /api/auth/me/avatar",
    "GET /api/administrator/anomalies",
    "GET /api/administrator/audit-log",
    "GET /api/administrator/devices",
    "GET /api/administrator/diagnostics",
    "GET /api/administrator/error-log",
    "GET /api/administrator/me",
    "GET /api/auth/audit",
    "GET /api/auth/me",
    "GET /api/benchmark",
    "GET /api/benchmark/export",
    "GET /api/companies",
    "GET /api/license/status",
    "GET /api/setup/status",
    "GET /api/users",
    "PATCH /api/users/:id/active",
    "POST /api/administrator/anomalies/:id/review",
    "POST /api/administrator/devices/:id/approve",
    "POST /api/administrator/login",
    "POST /api/administrator/logout",
    "POST /api/administrator/repair",
    "POST /api/auth/activity",
    "POST /api/auth/login",
    "POST /api/auth/logout",
    "POST /api/auth/me/avatar",
    "POST /api/companies",
    "POST /api/license/inspect",
    "POST /api/license/replace",
    "POST /api/setup/complete",
    "POST /api/users",
  ],
};

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readServerRegistrations(): Array<{ name: string; from: string }> {
  const server = fs.readFileSync(path.join(SRC, "server.ts"), "utf8");
  const imports = Object.fromEntries([...server.matchAll(/import \{ (\w+Routes) \} from "(.+?)";/g)].map((m) => [m[1], m[2]]));
  return [...server.matchAll(/app\.register\((\w+Routes)\)/g)].map((m) => ({ name: m[1], from: imports[m[1]] }));
}

let collected: ReturnType<typeof collectRoutesOnce> | null = null;
/** Memoized: mengimpor seluruh modul route cukup sekali (mahal di bawah beban paralel suite). */
function collectRoutes() {
  collected ??= collectRoutesOnce();
  return collected;
}

async function collectRoutesOnce() {
  const app = Fastify();
  const found: Array<{ key: string; url: string; preHandler: unknown[] }> = [];
  app.addHook("onRoute", (route) => {
    const pre = ([] as unknown[]).concat((route.preHandler as unknown) ?? []);
    for (const m of ([] as string[]).concat(route.method as string | string[])) {
      if (m !== "HEAD" && m !== "OPTIONS") found.push({ key: `${m} ${route.url}`, url: route.url, preHandler: pre });
    }
  });
  const regs = readServerRegistrations();
  for (const r of regs) {
    const mod = (await import(/* @vite-ignore */ path.join(SRC, r.from.replace(/\.js$/, ".ts")).replace(/\\/g, "/"))) as Record<string, unknown>;
    expect(mod[r.name], `modul ${r.name} harus mengekspor fungsi route`).toBeTypeOf("function");
    app.register(mod[r.name] as never);
  }
  await app.ready();
  await app.close();
  return { found, regs };
}

describe("Phase 5.0: registri klasifikasi route (fail-closed)", { timeout: 120_000 }, () => {
  const classified = new Map<string, RouteClass>();
  for (const [cls, routes] of Object.entries(REGISTRY) as Array<[RouteClass, string[]]>) {
    for (const r of routes) {
      if (classified.has(r)) throw new Error(`entri ganda di registri: ${r}`);
      classified.set(r, cls);
    }
  }

  it("setiap route terdaftar sadar-cabang ATAU terklasifikasi eksplisit (route baru tanpa klasifikasi => gagal)", async () => {
    const { found, regs } = await collectRoutes();
    expect(regs.length).toBeGreaterThan(30); // server.ts terbaca (bukan daftar kosong yang lolos diam-diam)
    const unclassified = found.filter((f) => !BRANCH_AWARE_ROUTES.has(f.key) && !classified.has(f.key)).map((f) => f.key);
    expect(unclassified, `Route belum diklasifikasikan. Tentukan: sadar-cabang (BRANCH_AWARE_ROUTES) atau tambahkan ke REGISTRY dengan kelas yang tepat:\n${unclassified.join("\n")}`).toEqual([]);
  });

  it("registri tidak menyimpan entri usang dan tidak tumpang tindih dengan BRANCH_AWARE_ROUTES", async () => {
    const { found } = await collectRoutes();
    const keys = new Set(found.map((f) => f.key));
    const stale = [...classified.keys()].filter((k) => !keys.has(k));
    expect(stale, `entri registri tanpa route terdaftar:\n${stale.join("\n")}`).toEqual([]);
    const overlap = [...classified.keys()].filter((k) => BRANCH_AWARE_ROUTES.has(k));
    expect(overlap, `route sudah sadar-cabang: hapus dari REGISTRY:\n${overlap.join("\n")}`).toEqual([]);
  });

  it("setiap entri BRANCH_AWARE_ROUTES menunjuk route yang benar-benar terdaftar", async () => {
    const { found } = await collectRoutes();
    const keys = new Set(found.map((f) => f.key));
    const missing = [...BRANCH_AWARE_ROUTES].filter((k) => !keys.has(k));
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("route level-perusahaan yang tersisa (analysis/projection/tax-summary, D3) tetap ditolak untuk akun LIMITED (deny-by-default)", () => {
    for (const r of REGISTRY.READ_FINANCIAL_PENDING_5A) expect(BRANCH_AWARE_ROUTES.has(r), r).toBe(false);
    expect(REGISTRY.READ_FINANCIAL_PENDING_5A.length).toBe(3);
  });

  it("10 route baca-keuangan Phase 5A/5B sadar-cabang DAN modulnya memakai resolveRequestReportScope (tidak ada route yang lupa cakupan)", () => {
    for (const [route, file] of Object.entries(SCOPED_READ_ROUTES)) {
      expect(BRANCH_AWARE_ROUTES.has(route), route).toBe(true);
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      const usesScope = /resolveRequestReportScope\(/.test(source) || /branchScope === "LIMITED"/.test(source); // pencarian memfilter dari akses server
      expect(usesScope, `${route} (${file}) terdaftar sadar-cabang tetapi tidak menurunkan cakupan di server`).toBe(true);
    }
    expect(Object.keys(SCOPED_READ_ROUTES).length).toBe(10);
  });

  it("setiap route ber-:companySlug melewati requireAuth + requireCompanyAccess", async () => {
    const { found } = await collectRoutes();
    const bad = found.filter((f) => f.url.includes(":companySlug") && !(f.preHandler.includes(requireAuth) && f.preHandler.includes(requireCompanyAccess))).map((f) => f.key);
    expect(bad, `route company-scoped tanpa guard standar:\n${bad.join("\n")}`).toEqual([]);
  });
});

/** Berkas sumber (non-tes, non-migrasi) yang boleh menyebut tabel jurnal, beserta perannya. */
const JOURNAL_TABLE_FILES: Record<string, "READ_FINANCIAL_5A" | "INDIRECT" | "WRITE_PATH_PHASE2" | "COMPANY_LEVEL" | "LEGACY_MASTER"> = {
  // pembacaan angka keuangan -- 5A WAJIB menerima AuthorizedScope
  "db/company/counterparty-service.ts": "READ_FINANCIAL_5A",
  "db/company/dashboard-service.ts": "READ_FINANCIAL_5A",
  "db/company/ledger-service.ts": "READ_FINANCIAL_5A",
  "db/company/reporting/cash-flow-service.ts": "READ_FINANCIAL_5A",
  "db/company/reporting/inter-branch-position.ts": "READ_FINANCIAL_5A",
  "db/company/reporting/reporting-utils.ts": "READ_FINANCIAL_5A",
  "db/company/trial-balance-service.ts": "READ_FINANCIAL_5A",
  "modules/company-search/routes.ts": "READ_FINANCIAL_5A",
  // hanya menyebut tabel di komentar/penjelasan; angka lewat primitif di atas
  "db/company/reporting/balance-sheet-service.ts": "INDIRECT",
  "modules/company-opening-balance-import/parser.ts": "INDIRECT",
  "db/system/index.ts": "INDIRECT",
  // jalur tulis/validasi jurnal (sudah sadar-cabang sejak Phase 2)
  "db/company/journal-service.ts": "WRITE_PATH_PHASE2",
  "db/company/journal-import-service.ts": "WRITE_PATH_PHASE2",
  "db/company/opening-balance-service.ts": "WRITE_PATH_PHASE2",
  "db/company/account-policy-service.ts": "WRITE_PATH_PHASE2",
  "db/company/branch-service.ts": "WRITE_PATH_PHASE2",
  "db/company/company-provisioning.ts": "WRITE_PATH_PHASE2",
  "modules/company-journal/routes.ts": "WRITE_PATH_PHASE2",
  // pemeriksaan administratif level perusahaan (bukan angka laporan)
  "db/company/account-service.ts": "COMPANY_LEVEL",
  "db/company/period-closing-service.ts": "COMPANY_LEVEL",
  // Inter-Branch (IB-1): pengalokasi nomor/ketersediaan referensi dan diagnostik integritas read-only (bukan laporan keuangan)
  "db/company/inter-branch-domain.ts": "COMPANY_LEVEL",
  "db/company/inter-branch-integrity.ts": "COMPANY_LEVEL",
  // Inter-Branch (IB-2/IB-3): jalur tulis dua sisi (memakai fungsi jurnal yang sadar-cabang) dan pembacaan terbatas pada jurnal bertaut transaksi antar-cabang milik cabang yang dapat dibaca pengguna
  "db/company/inter-branch-service.ts": "WRITE_PATH_PHASE2",
  "db/company/inter-branch-queries.ts": "COMPANY_LEVEL",
  // jalur master-DB lama (bukan company.db)
  "db/system/legacy-company-migration.ts": "LEGACY_MASTER",
  "modules/accounts/routes.ts": "LEGACY_MASTER",
  "modules/journal/parser.ts": "LEGACY_MASTER",
  "modules/journal/posting.ts": "LEGACY_MASTER",
  "modules/journal/routes.ts": "LEGACY_MASTER",
  "modules/ledger/routes.ts": "LEGACY_MASTER",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "migrations" || e.name === "__fixtures__" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("Phase 5.0: hanya berkas terklasifikasi yang boleh menyebut tabel jurnal (fail-closed)", () => {
  const touching = walk(SRC)
    .filter((f) => /journal_entries|journal_entry_lines/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
    .sort();

  it("tidak ada berkas baru yang menyentuh tabel jurnal tanpa klasifikasi", () => {
    const unknown = touching.filter((f) => !(f in JOURNAL_TABLE_FILES));
    expect(unknown, `berkas baru menyentuh journal_entries/journal_entry_lines -- klasifikasikan di JOURNAL_TABLE_FILES (dan bila membaca angka keuangan: wajib AuthorizedScope di 5A):\n${unknown.join("\n")}`).toEqual([]);
  });

  it("tidak ada entri usang (berkas yang tak lagi menyentuh tabel jurnal harus dikeluarkan dari daftar)", () => {
    const stale = Object.keys(JOURNAL_TABLE_FILES).filter((f) => !touching.includes(f));
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("daftar kerja 5A (pembacaan angka keuangan) terkunci: 8 berkas", () => {
    expect(
      Object.entries(JOURNAL_TABLE_FILES)
        .filter(([, c]) => c === "READ_FINANCIAL_5A")
        .map(([f]) => f)
        .sort(),
    ).toEqual([
      "db/company/counterparty-service.ts",
      "db/company/dashboard-service.ts",
      "db/company/ledger-service.ts",
      "db/company/reporting/cash-flow-service.ts",
      "db/company/reporting/inter-branch-position.ts",
      "db/company/reporting/reporting-utils.ts",
      "db/company/trial-balance-service.ts",
      "modules/company-search/routes.ts",
    ]);
  });

  it("Phase 5: setiap berkas pembaca angka keuangan memfilter cakupan (applyBranchScope atau filter cabang akses) -- tidak ada pembaca tanpa cakupan", () => {
    const readers = Object.entries(JOURNAL_TABLE_FILES).filter(([, c]) => c === "READ_FINANCIAL_5A").map(([f]) => f);
    const missing = readers.filter((f) => !/applyBranchScope\(|branchFilter/.test(fs.readFileSync(path.join(SRC, f), "utf8")));
    expect(missing, `pembaca keuangan tanpa penyaringan cakupan: ${missing.join(", ")}`).toEqual([]);
  });
});
