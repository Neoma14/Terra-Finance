// PHASE 5.0 -- profiling layanan laporan SAAT INI (kode tidak diubah) pada dataset scratch.
// Dua mode:
//   cold : koneksi BARU per panggilan (persis route produksi: openCompanyDbForSlug -> layanan -> destroy). Cache halaman SQLite kosong.
//   warm : satu koneksi, setelah pemanasan (batas bawah: berapa cepat bila cache hangat).
// Per target: waktu dinding (median 3x), jumlah query, total waktu SQL, waktu non-SQL (JS), bentuk query teratas, EXPLAIN QUERY PLAN.
// Varian PRAGMA (hanya mode cold) untuk menilai kebutuhan nyata: base | cache64 | cache64+mmap
// Pemakaian: node profile.mjs [--modes=cold,warm] [--pragma=base,cache64,cache64mmap] [dataset ...]
import fs from "node:fs";
import { OUT, Database, dist, S } from "./build-datasets.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1].split(",");
const modes = opt("modes", "cold,warm");
const pragmaVariants = opt("pragma", "base");
const datasets = args.filter((a) => !a.startsWith("--")).length ? args.filter((a) => !a.startsWith("--")) : ["small", "uat-1", "uat-3", "uat-7"];
const PRAGMAS = { base: [], cache64: ["PRAGMA cache_size = -65536"], cache64mmap: ["PRAGMA cache_size = -65536", "PRAGMA mmap_size = 268435456"] };

const { createCompanyDb } = await dist("db/company/index.js");
const { getBalanceSheet } = await dist("db/company/reporting/balance-sheet-service.js");
const { getIncomeStatement } = await dist("db/company/reporting/income-statement-service.js");
const { getEquityStatement } = await dist("db/company/reporting/equity-statement-service.js");
const { getCashFlowStatement } = await dist("db/company/reporting/cash-flow-service.js");
const { getTrialBalance } = await dist("db/company/trial-balance-service.js");
const { getAccountLedgerByRange } = await dist("db/company/ledger-service.js");
const { getDashboardSummary } = await dist("db/company/dashboard-service.js");
const { getCounterpartyBalances } = await dist("db/company/counterparty-service.js");
const { getRatioAnalysis } = await dist("db/company/ratio-analysis-service.js");
const { getProjection } = await dist("db/company/projection-service.js");

const norm = (sql) => sql.replace(/\s+/g, " ").replace(/\(\?(, \?)*\)/g, "(?…)").trim();
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function instrument(db) {
  const state = { rec: null, starts: new Map() };
  db.on("query", (q) => { if (state.rec) state.starts.set(q.__knexQueryUid, { t: performance.now(), sql: q.sql, bindings: q.bindings }); });
  const finish = (q, rows) => {
    const s = state.starts.get(q.__knexQueryUid);
    if (!s || !state.rec) return;
    state.starts.delete(q.__knexQueryUid);
    const d = performance.now() - s.t;
    const key = norm(s.sql);
    const e = state.rec.shapes.get(key) ?? { count: 0, ms: 0, rows: 0, sample: s.bindings, raw: s.sql };
    e.count++; e.ms += d; e.rows += Array.isArray(rows) ? rows.length : 0;
    state.rec.shapes.set(key, e);
    state.rec.queries++; state.rec.sqlMs += d;
  };
  db.on("query-response", (rows, q) => finish(q, rows));
  db.on("query-error", (_e, q) => finish(q, null));
  return state;
}

async function once(dbPath, fn, pragmas) {
  const db = createCompanyDb(dbPath);
  for (const p of pragmas) await db.raw(p);
  const st = instrument(db);
  st.rec = { queries: 0, sqlMs: 0, shapes: new Map() };
  const t = performance.now();
  await fn(db);
  const wall = performance.now() - t;
  const rec = st.rec;
  await db.destroy();
  return { wall, rec };
}

const results = {};
for (const name of datasets) {
  const dbPath = `${OUT}/${name}/company.db`;
  const raw = new Database(dbPath, { readonly: true });
  const minDate = String(raw.prepare("SELECT MIN(entry_date) FROM journal_entries").pluck().get()).slice(0, 10);
  const maxDate = String(raw.prepare("SELECT MAX(entry_date) FROM journal_entries").pluck().get()).slice(0, 10);
  const fyFrom = `${maxDate.slice(0, 4)}-01-01`;
  const lastPeriod = raw.prepare("SELECT p.id FROM periods p WHERE EXISTS (SELECT 1 FROM journal_entries je WHERE je.period_id = p.id) ORDER BY p.end_date DESC LIMIT 1").pluck().get();
  const busyAccount = raw.prepare("SELECT account_id FROM journal_entry_lines GROUP BY account_id ORDER BY COUNT(*) DESC LIMIT 1").pluck().get();
  raw.close();
  const targets = {
    "balance-sheet": (db) => getBalanceSheet(db, minDate, maxDate),
    "income-statement": (db) => getIncomeStatement(db, fyFrom, maxDate),
    equity: (db) => getEquityStatement(db, fyFrom, maxDate),
    "cash-flow": (db) => getCashFlowStatement(db, fyFrom, maxDate),
    "trial-balance": (db) => getTrialBalance(db, lastPeriod),
    "ledger(akun tersibuk)": (db) => getAccountLedgerByRange(db, busyAccount, minDate, maxDate),
    dashboard: (db) => getDashboardSummary(db, fyFrom, maxDate),
    "counterparty-balances": async (db) => { await getCounterpartyBalances(db, "vendor"); await getCounterpartyBalances(db, "customer"); },
    "ratio-analysis": (db) => getRatioAnalysis(db, fyFrom, maxDate),
    projection: (db) => getProjection(db, maxDate, 3),
  };
  results[name] = {};
  for (const mode of modes) {
    for (const pv of mode === "cold" ? pragmaVariants : ["base"]) {
      for (const [tname, fn] of Object.entries(targets)) {
        let walls = [];
        let rec;
        if (mode === "cold") {
          await once(dbPath, fn, PRAGMAS[pv]); // menghangatkan cache OS (bukan cache SQLite -- koneksi baru)
          for (let i = 0; i < 3; i++) { const r = await once(dbPath, fn, PRAGMAS[pv]); walls.push(r.wall); rec = r.rec; }
        } else {
          const db = createCompanyDb(dbPath);
          const st = instrument(db);
          await fn(db);
          for (let i = 0; i < 3; i++) {
            st.rec = { queries: 0, sqlMs: 0, shapes: new Map() };
            const t = performance.now(); await fn(db); walls.push(performance.now() - t); rec = st.rec;
          }
          await db.destroy();
        }
        const wall = median(walls);
        const top = [...rec.shapes.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 4).map(([sql, e]) => ({ sql: sql.slice(0, 260), count: e.count, totalMs: Math.round(e.ms), rowsReturned: e.rows }));
        const plans = {};
        if (mode === "cold" && pv === "base") {
          const rdb = new Database(dbPath, { readonly: true });
          for (const [sql, e] of rec.shapes.entries()) {
            try { plans[sql.slice(0, 200)] = rdb.prepare(`EXPLAIN QUERY PLAN ${e.raw}`).all(...(e.sample ?? [])).map((r) => r.detail); } catch (err) { plans[sql.slice(0, 200)] = [`(EXPLAIN gagal: ${String(err.message).slice(0, 60)})`]; }
          }
          rdb.close();
        }
        const key = `${mode}${mode === "cold" ? ":" + pv : ""}`;
        (results[name][tname] ??= {})[key] = { wallMs: Math.round(wall), walls: walls.map(Math.round), minMs: Math.round(Math.min(...walls)), maxMs: Math.round(Math.max(...walls)), queries: rec.queries, sqlMs: Math.round(rec.sqlMs), jsMs: Math.round(wall - rec.sqlMs), shapes: rec.shapes.size, top, ...(Object.keys(plans).length ? { plans } : {}) };
        console.log(`${name.padEnd(6)} ${key.padEnd(16)} ${tname.padEnd(22)} wall=${String(Math.round(wall)).padStart(6)}ms  queries=${String(rec.queries).padStart(6)}  sql=${String(Math.round(rec.sqlMs)).padStart(6)}ms  js=${String(Math.round(wall - rec.sqlMs)).padStart(6)}ms`);
      }
    }
  }
}
fs.mkdirSync(`${S}/p50`, { recursive: true });
const tag = args.filter((a) => a.startsWith("--")).join("_").replace(/[^a-z0-9_,=-]/gi, "") || "default";
fs.writeFileSync(`${S}/p50/profile-current-${tag}.json`, JSON.stringify(results, null, 1));
