// Verifikasi migrasi Multi-Branch pada SALINAN data UAT 5 tahun (bukan data produksi, bukan port 4000).
// Alur = startup produksi: server dijalankan terhadap data lama -> migrasi sistem & company otomatis.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad";
const SRC = `${S}/uat5/data`;
const WORK = `${S}/mbverify/data`;
const PORT = 4510;
const BASE = `http://127.0.0.1:${PORT}`;
const req = createRequire(`${ROOT}/apps/api/package.json`);
const Database = req("better-sqlite3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(`${S}/mbverify/data`, { recursive: true, force: true });
// Sumber: set backup UAT 5 tahun (master + system + company.db 24 MB), disalin ke folder kerja terpisah.
const BK = `${S}/uat5/backup`;
fs.mkdirSync(`${WORK}/companies`, { recursive: true });
fs.copyFileSync(`${BK}/terra-finance-2026-10-06T02-00-10-045Z.sqlite`, `${WORK}/terra-finance.sqlite`);
fs.copyFileSync(`${BK}/terra-system-2026-10-06T02-00-10-045Z.sqlite`, `${WORK}/terra-system.sqlite`);
for (const slug of fs.readdirSync(`${BK}/companies`)) {
  const f = fs.readdirSync(`${BK}/companies/${slug}`).find((n) => n.endsWith(".db"));
  fs.mkdirSync(`${WORK}/companies/${slug}`, { recursive: true });
  fs.copyFileSync(`${BK}/companies/${slug}/${f}`, `${WORK}/companies/${slug}/company.db`);
}

const companies = fs.readdirSync(`${WORK}/companies`).filter((d) => fs.existsSync(`${WORK}/companies/${d}/company.db`));
const hashLines = (db) => {
  const h = crypto.createHash("sha256");
  for (const r of db.prepare("SELECT id, journal_entry_id, account_id, debit, credit, line_order FROM journal_entry_lines ORDER BY id").iterate()) h.update(JSON.stringify(r));
  return h.digest("hex");
};
const hashAccounts = (db) => crypto.createHash("sha256").update(JSON.stringify(db.prepare("SELECT id, code, name, account_type_id, normal_balance, is_active FROM accounts ORDER BY id").all())).digest("hex");
const hashJournals = (db) => crypto.createHash("sha256").update(JSON.stringify(db.prepare("SELECT id, entry_date, period_id, reference_no, status, is_opening_balance, source FROM journal_entries ORDER BY id").all())).digest("hex");
const stats = (file) => {
  const db = new Database(file, { readonly: true });
  try {
    const n = (sql) => db.prepare(sql).pluck().get();
    const integrity = db.pragma("integrity_check").map((r) => r.integrity_check);
    const fk = db.pragma("foreign_key_check");
    const cols = db.prepare("PRAGMA table_info(journal_entries)").all().map((c) => c.name);
    return {
      sizeBytes: fs.statSync(file).size,
      journals: n("SELECT COUNT(*) FROM journal_entries"),
      lines: n("SELECT COUNT(*) FROM journal_entry_lines"),
      accounts: n("SELECT COUNT(*) FROM accounts"),
      periods: n("SELECT COUNT(*) FROM periods"),
      auditRows: n("SELECT COUNT(*) FROM company_audit_log"),
      debitCents: n("SELECT COALESCE(SUM(CAST(ROUND(debit*100) AS INTEGER)),0) FROM journal_entry_lines"),
      creditCents: n("SELECT COALESCE(SUM(CAST(ROUND(credit*100) AS INTEGER)),0) FROM journal_entry_lines"),
      branches: cols.includes("branch_id") ? n("SELECT COUNT(*) FROM branches") : "(belum ada tabel)",
      journalsWithoutBranch: cols.includes("branch_id") ? n("SELECT COUNT(*) FROM journal_entries WHERE branch_id IS NULL") : "-",
      journalsNotHq: cols.includes("branch_id") ? n("SELECT COUNT(*) FROM journal_entries WHERE branch_id <> (SELECT id FROM branches WHERE is_head_office=1)") : "-",
      nonDefaultPolicies: cols.includes("branch_id") ? n("SELECT COUNT(*) FROM accounts WHERE branch_policy <> 'ALL_BRANCH'") : "-",
      integrity,
      foreignKeyViolations: fk.length,
      linesHash: hashLines(db),
      accountsHash: hashAccounts(db),
      journalsHash: hashJournals(db),
    };
  } finally {
    db.close();
  }
};
const sysStats = (file) => {
  const db = new Database(file, { readonly: true });
  try {
    const cols = db.prepare("PRAGMA table_info(company_access)").all().map((c) => c.name);
    return {
      sizeBytes: fs.statSync(file).size,
      companyAccess: db.prepare("SELECT COUNT(*) FROM company_access").pluck().get(),
      scopes: cols.includes("branch_scope") ? db.prepare("SELECT branch_scope, COUNT(*) c FROM company_access GROUP BY branch_scope").all() : "(belum ada kolom)",
      hasUserBranchAccess: db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='user_branch_access'").pluck().get() === 1,
      integrity: db.pragma("integrity_check").map((r) => r.integrity_check),
      foreignKeyViolations: db.pragma("foreign_key_check").length,
    };
  } finally {
    db.close();
  }
};

const before = { system: sysStats(`${WORK}/terra-system.sqlite`), companies: {} };
for (const c of companies) before.companies[c] = stats(`${WORK}/companies/${c}/company.db`);

// ---- jalankan server produksi (dist) terhadap salinan data
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  DB_FILE_PATH: `${WORK}/terra-finance.sqlite`,
  SYSTEM_DB_FILE_PATH: `${WORK}/terra-system.sqlite`,
  COMPANY_DATA_ROOT: `${WORK}/companies`,
  STATIC_WEB_DIR: `${ROOT}/apps/web/dist`,
  SESSION_SECRET: crypto.createHash("sha256").update("mbverify-secret").digest("hex"),
};
const log = fs.openSync(`${S}/mbverify/server.log`, "w");
// PACKAGED=1: jalankan server DARI INSTALLER (runtime Electron + better-sqlite3 hasil rebuild), bukan node dev.
const PKG = `${ROOT}/apps/desktop/dist/win-unpacked`;
if (process.env.PACKAGED === "1") { env.ELECTRON_RUN_AS_NODE = "1"; env.STATIC_WEB_DIR = `${PKG}/resources/web/dist`; }
const srv = process.env.PACKAGED === "1"
  ? spawn(`${PKG}/TERRA FINANCE.exe`, [`${PKG}/resources/api/dist/server.js`], { env, stdio: ["ignore", log, log] })
  : spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", log, log] });
let healthy = false;
for (let i = 0; i < 150 && !healthy; i++) {
  try { healthy = (await fetch(`${BASE}/api/health`)).ok; } catch {}
  if (!healthy) await sleep(400);
}
const api = {};
if (healthy) {
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@terra-nusantara.test", password: "Uat#Owner2026" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  api.loginStatus = login.status;
  const get = async (p) => { const r = await fetch(BASE + p, { headers: { Cookie: cookie } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };
  const A = "/api/company-db/pt-terra-nusantara";
  const ctx = await get(`${A}/branch-context`);
  api.branchContext = { status: ctx.status, multiBranchEnabled: ctx.json?.multiBranchEnabled, scope: ctx.json?.scope, branches: ctx.json?.branches?.map((b) => b.code), context: ctx.json?.context?.code };
  const list = await get(`${A}/journals?pageSize=5`);
  api.journalsList = { status: list.status, total: list.json?.total, firstHasBranchId: Boolean(list.json?.journals?.[0]?.branchId) };
  const bs = await get(`${A}/reports/balance-sheet?fromDate=2021-01-01&toDate=2026-12-31`);
  api.balanceSheet = { status: bs.status, isBalanced: bs.json?.isBalanced, totalAssets: bs.json?.totalAssets, totalLiabilities: bs.json?.totalLiabilities, totalEquity: bs.json?.totalEquity };
  const acc = await get(`${A}/accounts?pageSize=3`);
  api.accountsList = { status: acc.status, hasBranchPolicy: acc.json?.accounts?.[0]?.branchPolicy ?? null };
  const dash = await get(`${A}/dashboard?fromDate=2026-01-01&toDate=2026-12-31`);
  api.dashboard = { status: dash.status };
  const ob = await get(`${A}/opening-balance`);
  api.openingBalance = { status: ob.status, exists: ob.json?.exists, branchId: Boolean(ob.json?.branchId) };
}
srv.kill("SIGTERM");
await sleep(2500);
try { srv.kill("SIGKILL"); } catch {}
await sleep(500);

const after = { system: sysStats(`${WORK}/terra-system.sqlite`), companies: {} };
for (const c of companies) after.companies[c] = stats(`${WORK}/companies/${c}/company.db`);
const backups = fs.readdirSync(WORK, { recursive: true }).map(String).filter((f) => f.includes(".pre-"));

const checks = [];
const ok = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
ok("server sehat setelah migrasi otomatis", healthy);
for (const c of companies) {
  const b = before.companies[c], a = after.companies[c];
  ok(`${c}: jumlah jurnal sama`, a.journals === b.journals, `${b.journals} -> ${a.journals}`);
  ok(`${c}: jumlah baris jurnal sama`, a.lines === b.lines, `${b.lines} -> ${a.lines}`);
  ok(`${c}: jumlah akun sama`, a.accounts === b.accounts, `${b.accounts} -> ${a.accounts}`);
  ok(`${c}: jumlah periode sama`, a.periods === b.periods);
  ok(`${c}: total debit/kredit (sen) sama`, a.debitCents === b.debitCents && a.creditCents === b.creditCents, `${b.debitCents}/${b.creditCents}`);
  ok(`${c}: isi baris jurnal identik (hash)`, a.linesHash === b.linesHash);
  ok(`${c}: isi akun identik (hash)`, a.accountsHash === b.accountsHash);
  ok(`${c}: header jurnal identik (hash)`, a.journalsHash === b.journalsHash);
  ok(`${c}: 1 cabang (Kantor Pusat), tidak ada jurnal tanpa/bukan Pusat`, a.branches === 1 && a.journalsWithoutBranch === 0 && a.journalsNotHq === 0);
  ok(`${c}: semua akun ALL_BRANCH`, a.nonDefaultPolicies === 0);
  ok(`${c}: integrity_check ok sebelum & sesudah`, JSON.stringify(b.integrity) === '["ok"]' && JSON.stringify(a.integrity) === '["ok"]');
  ok(`${c}: foreign_key_check bersih sebelum & sesudah`, b.foreignKeyViolations === 0 && a.foreignKeyViolations === 0, `${b.foreignKeyViolations}/${a.foreignKeyViolations}`);
  ok(`${c}: salinan pengaman .pre-C0014 ada`, backups.some((f) => f.includes(`${c}`) && f.endsWith(".pre-C0014")));
}
ok("System DB: user lama semua scope ALL", Array.isArray(after.system.scopes) && after.system.scopes.every((s) => s.branch_scope === "ALL"));
ok("System DB: tabel user_branch_access ada, integritas ok", after.system.hasUserBranchAccess && JSON.stringify(after.system.integrity) === '["ok"]' && after.system.foreignKeyViolations === 0);
ok("System DB: salinan pengaman .pre-S0011 ada", backups.some((f) => f.endsWith("terra-system.sqlite.pre-S0011")));
ok("API: login & branch-context (ALL, konteks Kantor Pusat, multi-cabang mati)", api.loginStatus === 200 && api.branchContext?.scope === "ALL" && api.branchContext?.multiBranchEnabled === false && api.branchContext?.context === "PUSAT");
ok("API: daftar jurnal dan laporan tetap berfungsi, Neraca seimbang", api.journalsList?.status === 200 && api.balanceSheet?.status === 200 && api.balanceSheet?.isBalanced === true && api.dashboard?.status === 200);

const out = { before, after, backups, api, checks, serverLogTail: fs.readFileSync(`${S}/mbverify/server.log`, "utf8").split("\n").filter((l) => l.includes("company-upgrade")).slice(0, 10) };
fs.writeFileSync(`${S}/mbverify/result.json`, JSON.stringify(out, null, 1));
for (const c of checks) console.log((c.pass ? "PASS " : "FAIL ") + c.name + (c.detail ? " | " + c.detail : ""));
console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} lulus`);
