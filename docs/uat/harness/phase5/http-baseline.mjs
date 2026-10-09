// PHASE 5.0 -- baseline waktu respons END-TO-END (HTTP, server hasil build) dengan sebaran: min / median / p95 dari N pengukuran,
// dan beban CPU sebelum pengukuran. (Pelajaran 5.0: pengukuran tunggal pada mesin yang sedang sibuk bisa menyesatkan 4-7x.)
// Pemakaian: node http-baseline.mjs [dataset ...]   -> docs/uat/phase5/http-baseline.json
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { OUT, S, ROOT, Database } from "./build-datasets.mjs";

const datasets = process.argv.slice(2).length ? process.argv.slice(2) : ["small", "uat-1", "uat-3", "uat-7"];
const N = 9;
const PORT = 4515;
const BASE = `http://127.0.0.1:${PORT}`;
const A = "/api/company-db/pt-terra-nusantara";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const cpuLoad = () => { try { return Number(execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"').toString().trim()); } catch { return null; } };

const results = { machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 1e9), node: process.version, sqlite: "3.49.2 (better-sqlite3 11.10)" }, runs: {} };

for (const ds of datasets) {
  const W = `${S}/p50/http-bl/data`;
  fs.rmSync(`${S}/p50/http-bl`, { recursive: true, force: true });
  fs.mkdirSync(`${W}/companies`, { recursive: true });
  const BK = `${S}/uat5/backup`;
  fs.copyFileSync(`${BK}/terra-finance-2026-10-06T02-00-10-045Z.sqlite`, `${W}/terra-finance.sqlite`);
  fs.copyFileSync(`${BK}/terra-system-2026-10-06T02-00-10-045Z.sqlite`, `${W}/terra-system.sqlite`);
  for (const slug of fs.readdirSync(`${BK}/companies`)) {
    const f = fs.readdirSync(`${BK}/companies/${slug}`).find((n) => n.endsWith(".db"));
    fs.mkdirSync(`${W}/companies/${slug}`, { recursive: true });
    fs.copyFileSync(`${BK}/companies/${slug}/${f}`, `${W}/companies/${slug}/company.db`);
  }
  fs.copyFileSync(`${OUT}/${ds}/company.db`, `${W}/companies/pt-terra-nusantara/company.db`);
  const raw = new Database(`${OUT}/${ds}/company.db`, { readonly: true });
  const maxDate = String(raw.prepare("SELECT MAX(entry_date) FROM journal_entries").pluck().get()).slice(0, 10);
  const minDate = String(raw.prepare("SELECT MIN(entry_date) FROM journal_entries").pluck().get()).slice(0, 10);
  const fy = `${maxDate.slice(0, 4)}-01-01`;
  const lastPeriod = raw.prepare("SELECT p.id FROM periods p WHERE EXISTS (SELECT 1 FROM journal_entries je WHERE je.period_id=p.id) ORDER BY p.end_date DESC LIMIT 1").pluck().get();
  const busy = raw.prepare("SELECT account_id FROM journal_entry_lines GROUP BY account_id ORDER BY COUNT(*) DESC LIMIT 1").pluck().get();
  raw.close();
  const reqs = {
    "balance-sheet": `/reports/balance-sheet?fromDate=${minDate}&toDate=${maxDate}`,
    "income-statement": `/reports/income-statement?fromDate=${fy}&toDate=${maxDate}`,
    equity: `/reports/equity?fromDate=${fy}&toDate=${maxDate}`,
    "cash-flow": `/reports/cash-flow?fromDate=${fy}&toDate=${maxDate}`,
    "trial-balance": `/trial-balance?periodId=${lastPeriod}`,
    ledger: `/ledger/${busy}?fromDate=${minDate}&toDate=${maxDate}`,
    dashboard: `/dashboard?fromDate=${fy}&toDate=${maxDate}`,
    "counterparty-balances": "/counterparties/balances?type=vendor",
    search: "/search?q=kas",
    analysis: `/analysis?fromDate=${fy}&toDate=${maxDate}`,
    projection: `/projection?asOfDate=${maxDate}&monthsAhead=3`,
    "tax-summary": `/tax-summary?fromDate=${fy}&toDate=${maxDate}`,
    "journals(p1)": "/journals?pageSize=50&page=1",
    "branch-context(baseline overhead)": "/branch-context",
  };
  const env = { ...process.env, NODE_ENV: "production", PORT: String(PORT), DB_FILE_PATH: `${W}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${W}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${W}/companies`, STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("bl").digest("hex") };
  const srv = spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) { try { ok = (await fetch(`${BASE}/api/health`)).ok; } catch { /* belum siap */ } if (!ok) await sleep(400); }
  let cookie = "";
  const call = async (p, method = "GET", body) => { const t = performance.now(); const r = await fetch(BASE + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const x = await r.text(); return { status: r.status, ms: performance.now() - t, bytes: x.length }; };
  await call("/api/auth/login", "POST", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" });
  await sleep(3000); // beri waktu pekerjaan latar saat start (backup/cek integritas) selesai sebelum mengukur
  const load = cpuLoad();
  results.runs[ds] = { cpuLoadBefore: load, endpoints: {} };
  for (const [name, path] of Object.entries(reqs)) {
    await call(A + path); // pemanasan
    const ms = []; let status = 0, bytes = 0;
    for (let i = 0; i < N; i++) { const r = await call(A + path); ms.push(r.ms); status = r.status; bytes = r.bytes; }
    results.runs[ds].endpoints[name] = { status, bytes, minMs: Math.round(Math.min(...ms)), medianMs: Math.round(q(ms, 0.5)), p95Ms: Math.round(q(ms, 0.95)), maxMs: Math.round(Math.max(...ms)) };
    console.log(`${ds.padEnd(6)} ${name.padEnd(36)} ${status}  min=${String(Math.round(Math.min(...ms))).padStart(5)}  med=${String(Math.round(q(ms, 0.5))).padStart(5)}  p95=${String(Math.round(q(ms, 0.95))).padStart(5)} ms`);
  }
  srv.kill("SIGTERM"); await sleep(1500); try { srv.kill("SIGKILL"); } catch { /* sudah berhenti */ }
}
fs.mkdirSync(`${ROOT}/docs/uat/phase5`, { recursive: true });
fs.writeFileSync(process.env.HTTP_BASELINE_OUT ?? `${ROOT}/docs/uat/phase5/http-baseline.json`, JSON.stringify(results, null, 1));
