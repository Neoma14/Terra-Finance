// PHASE 5.0 -- GOLDEN MASTER pada server hasil build (HTTP sungguhan) + validasi sumber transaksi lewat oracle independen.
//   node golden.mjs capture <dataset>   : rekam respons semua endpoint baca-keuangan -> docs/uat/golden-master/phase5/<dataset>.golden.json
//   node golden.mjs verify  <dataset>   : jalankan ulang dan bandingkan hash dengan golden tersimpan (dipakai di 5A/5B untuk bukti "identik")
//   node golden.mjs scopes  <dataset>   : hitung expected-by-scope (oracle per cabang / subset) + invarian Σ cabang = perusahaan
// Dataset: small | uat-1 | uat-3 | uat-7 (dibuat build-datasets.mjs). Semua pada SALINAN scratch; bukan produksi, bukan port 4000.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { OUT, S, ROOT, Database, dist } from "./build-datasets.mjs";
import { Oracle, FLOW } from "./oracle.mjs";

const [mode = "capture", dataset = "uat-1"] = process.argv.slice(2);
const GOLD_DIR = `${ROOT}/docs/uat/golden-master/phase5`;
fs.mkdirSync(GOLD_DIR, { recursive: true });
const PORT = 4514;
const BASE = `http://127.0.0.1:${PORT}`;
const A = "/api/company-db/pt-terra-nusantara";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Phase 5A: respons laporan kini memuat `scope` (cakupan yang dipakai server) dan dokumen ekspor memuat `scopeLabel: null` (flag OFF).
// Keduanya dikecualikan SECARA EKSPLISIT dari perbandingan (rencana Phase 5 bagian 11.1); semua angka dan field lain harus identik byte-per-byte.
const stripScope = (v) => { if (v && typeof v === "object" && !Array.isArray(v)) { const { scope, scopeLabel, interBranch, ...rest } = v; void interBranch; if (scopeLabel === null || scopeLabel === undefined || scope !== undefined) return rest; return { ...rest, scopeLabel }; } return v; };
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// ---------------------------------------------------------------- data dir server (salin backup UAT + company.db dataset)
const W = `${S}/p50/http/data`;
function prepareDataDir() {
  fs.rmSync(`${S}/p50/http`, { recursive: true, force: true });
  fs.mkdirSync(`${W}/companies`, { recursive: true });
  const BK = `${S}/uat5/backup`;
  fs.copyFileSync(`${BK}/terra-finance-2026-10-06T02-00-10-045Z.sqlite`, `${W}/terra-finance.sqlite`);
  fs.copyFileSync(`${BK}/terra-system-2026-10-06T02-00-10-045Z.sqlite`, `${W}/terra-system.sqlite`);
  for (const slug of fs.readdirSync(`${BK}/companies`)) {
    const f = fs.readdirSync(`${BK}/companies/${slug}`).find((n) => n.endsWith(".db"));
    fs.mkdirSync(`${W}/companies/${slug}`, { recursive: true });
    fs.copyFileSync(`${BK}/companies/${slug}/${f}`, `${W}/companies/${slug}/company.db`);
  }
  fs.copyFileSync(`${OUT}/${dataset}/company.db`, `${W}/companies/pt-terra-nusantara/company.db`);
}

async function withServer(fn) {
  prepareDataDir();
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(PORT),
    DB_FILE_PATH: `${W}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${W}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${W}/companies`,
    STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("golden").digest("hex"),
  };
  const srv = spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: "ignore" });
  try {
    let ok = false;
    for (let i = 0; i < 200 && !ok; i++) { try { ok = (await fetch(`${BASE}/api/health`)).ok; } catch { /* belum siap */ } if (!ok) await sleep(400); }
    if (!ok) throw new Error("server tidak sehat");
    let cookie = "";
    const get = async (p, method = "GET", body) => {
      const r = await fetch(BASE + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* bukan JSON */ }
      return { status: r.status, text, json };
    };
    const login = await get("/api/auth/login", "POST", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" });
    if (login.status !== 200) throw new Error("login gagal");
    // tunggu hingga proses upgrade/start selesai: ping laporan ringan
    return await fn(get);
  } finally {
    srv.kill("SIGTERM"); await sleep(1500); try { srv.kill("SIGKILL"); } catch { /* sudah berhenti */ }
  }
}

// ---------------------------------------------------------------- daftar permintaan (dibangun dari data, bukan hardcode id)
function buildRequests() {
  const raw = new Database(`${OUT}/${dataset}/company.db`, { readonly: true });
  const minDate = String(raw.prepare("SELECT MIN(entry_date) FROM journal_entries").pluck().get()).slice(0, 10);
  const maxDate = String(raw.prepare("SELECT MAX(entry_date) FROM journal_entries").pluck().get()).slice(0, 10);
  const years = [...new Set(raw.prepare("SELECT substr(entry_date,1,4) y FROM journal_entries").all().map((r) => r.y))].sort();
  const periods = raw.prepare("SELECT p.id, p.label FROM periods p WHERE EXISTS (SELECT 1 FROM journal_entries je WHERE je.period_id=p.id) ORDER BY p.end_date").all();
  const topAccounts = raw.prepare("SELECT account_id id, COUNT(*) n FROM journal_entry_lines GROUP BY account_id ORDER BY n DESC LIMIT 5").all().map((r) => r.id);
  raw.close();
  const R = [];
  // GOLDEN_SCOPE=all: dataset multi-cabang (flag ON) diminta bercakupan "seluruh cabang" agar angka gabungan dapat dibandingkan dengan golden perusahaan-penuh (Phase 5A/5B).
  const SCOPED_PREFIX = /^(bs|is|eq|cf|dash|tb|ledger|cp):/;
  const add = (id, path) => R.push({ id, path: process.env.GOLDEN_SCOPE && SCOPED_PREFIX.test(id) ? `${path}${path.includes("?") ? "&" : "?"}scope=${process.env.GOLDEN_SCOPE}` : path });
  add("bs:full", `/reports/balance-sheet?fromDate=${minDate}&toDate=${maxDate}`);
  for (const y of years) {
    const to = y === years[years.length - 1] ? maxDate : `${y}-12-31`;
    add(`bs:${y}`, `/reports/balance-sheet?fromDate=${y}-01-01&toDate=${to}`);
    add(`is:${y}`, `/reports/income-statement?fromDate=${y}-01-01&toDate=${to}`);
    add(`eq:${y}`, `/reports/equity?fromDate=${y}-01-01&toDate=${to}`);
    add(`cf:${y}`, `/reports/cash-flow?fromDate=${y}-01-01&toDate=${to}`);
    add(`dash:${y}`, `/dashboard?fromDate=${y}-01-01&toDate=${to}`);
  }
  add("is:Q1-last", `/reports/income-statement?fromDate=${years[years.length - 1]}-01-01&toDate=${years[years.length - 1]}-03-31`);
  for (const p of periods) add(`tb:${p.label}`, `/trial-balance?periodId=${p.id}`);
  topAccounts.forEach((id, i) => { add(`ledger:top${i + 1}:full`, `/ledger/${id}?fromDate=${minDate}&toDate=${maxDate}`); add(`ledger:top${i + 1}:last-year`, `/ledger/${id}?fromDate=${years[years.length - 1]}-01-01&toDate=${maxDate}`); });
  add("cp:vendor", "/counterparties/balances?type=vendor");
  add("cp:customer", "/counterparties/balances?type=customer");
  add("analysis", `/analysis?fromDate=${years[years.length - 1]}-01-01&toDate=${maxDate}`);
  add("projection", `/projection?asOfDate=${maxDate}&monthsAhead=3`);
  add("tax-summary", `/tax-summary?fromDate=${years[years.length - 1]}-01-01&toDate=${maxDate}`);
  for (const q of ["kas", "1000000", "gaji"]) add(`search:${q}`, `/search?q=${encodeURIComponent(q)}`);
  add("journals:p1", "/journals?pageSize=50&page=1");
  return { R, minDate, maxDate, years, periods, topAccounts };
}

function summarize(id, json) {
  if (!json) return undefined;
  if (id.startsWith("bs:")) return { assets: json.totalAssets, liabilities: json.totalLiabilities, equity: json.totalEquity, balanced: json.isBalanced };
  if (id.startsWith("is:")) return { net: json.netProfit, gross: json.grossProfit };
  if (id.startsWith("cf:")) return { net: json.netChangeInCash, begin: json.beginningCash, end: json.endingCash, unclassified: json.unclassifiedAmount };
  if (id.startsWith("eq:")) return { opening: json.openingEquity, closing: json.closingEquity };
  if (id.startsWith("tb:")) return { debit: json.totalDebit, credit: json.totalCredit, balanced: json.isBalanced };
  if (id.startsWith("ledger:")) return { opening: json.openingBalance, ending: json.endingBalance, lines: json.lines?.length };
  return undefined;
}

async function captureOnce() {
  const { R, ...meta } = buildRequests();
  const results = [];
  await withServer(async (get) => {
    for (const r of R) {
      const res = await get(`${A}${r.path}`);
      results.push({ id: r.id, path: r.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>"), status: res.status, bytes: res.text.length, sha256: sha(canon(stripScope(res.json) ?? res.text)), summary: summarize(r.id, res.json), _json: res.json });
    }
  });
  return { meta, results };
}

// ---------------------------------------------------------------- ekspor (dokumen laporan, in-process; deterministik)
async function exportDocs(meta) {
  const { createCompanyDb } = await dist("db/company/index.js");
  const { buildExportDocument } = await dist("modules/report-export/build.js");
  const db = createCompanyDb(`${OUT}/${dataset}/company.db`);
  const y = meta.years[meta.years.length - 1];
  const docs = {};
  for (const [kind, q] of [["balance-sheet", { fromDate: `${y}-01-01`, toDate: meta.maxDate }], ["income-statement", { fromDate: `${y}-01-01`, toDate: meta.maxDate }], ["equity", { fromDate: `${y}-01-01`, toDate: meta.maxDate }], ["cash-flow", { fromDate: `${y}-01-01`, toDate: meta.maxDate }], ["trial-balance", { periodId: meta.periods[meta.periods.length - 1].id }], ["ledger", { accountId: meta.topAccounts[0], fromDate: `${y}-01-01`, toDate: meta.maxDate }]]) {
    const doc = await buildExportDocument(db, kind, q, "PT UAT");
    docs[`export:${kind}`] = sha(canon(stripScope(doc)));
  }
  await db.destroy();
  return docs;
}

// ---------------------------------------------------------------- validasi sumber transaksi (oracle) -- perusahaan penuh
function verifyAgainstOracle(meta, results) {
  const raw = new Database(`${OUT}/${dataset}/company.db`, { readonly: true });
  const o = new Oracle(raw, null);
  const byId = Object.fromEntries(results.map((r) => [r.id, r._json]));
  const checks = [];
  const eq = (name, a, b) => checks.push({ name, pass: a === b, got: a, expected: b });
  const accIdByCode = Object.fromEntries(o.accounts.map((a) => [a.code, a.id]));
  const secOf = (arr) => Object.fromEntries((arr ?? []).map((l) => [l.accountCode, l.amount]));
  const FYs = meta.years;
  for (const y of ["full", ...FYs]) {
    const to = y === "full" ? meta.maxDate : y === FYs[FYs.length - 1] ? meta.maxDate : `${y}-12-31`;
    const bs = byId[`bs:${y}`]; const exp = o.balanceSheet(to);
    eq(`BS ${y}: total aset`, bs.totalAssets, exp.totalAssets); eq(`BS ${y}: total kewajiban`, bs.totalLiabilities, exp.totalLiabilities); eq(`BS ${y}: total ekuitas (+RE-BRIDGE)`, bs.totalEquity, exp.totalEquity);
    for (const [sec, key] of [["ASSET", "assets"], ["LIABILITY", "liabilities"], ["EQUITY", "equity"]]) {
      const got = secOf(bs[key].lines); delete got["RE-BRIDGE"];
      const want = Object.fromEntries(exp.sections[sec].map((l) => [l.code, l.amount]));
      eq(`BS ${y}: ${sec} per akun (${Object.keys(want).length} akun)`, canon(got), canon(want));
    }
    eq(`BS ${y}: seimbang`, bs.balanceDifference, 0);
  }
  for (const y of FYs) {
    const to = y === FYs[FYs.length - 1] ? meta.maxDate : `${y}-12-31`;
    const is = byId[`is:${y}`]; const exp = o.incomeStatement(`${y}-01-01`, to);
    eq(`IS ${y}: laba bersih`, is.netProfit, exp.netProfit); eq(`IS ${y}: laba kotor`, is.grossProfit, exp.grossProfit); eq(`IS ${y}: laba operasi`, is.operatingProfit, exp.operatingProfit);
    const cf = byId[`cf:${y}`]; const cash = o.cash(`${y}-01-01`, to);
    eq(`CF ${y}: kas awal`, cf.beginningCash, cash.beginning); eq(`CF ${y}: kas akhir`, cf.endingCash, cash.ending); eq(`CF ${y}: perubahan kas`, cf.netChangeInCash, cash.net);
    eq(`CF ${y}: Σ aktivitas + tak terklasifikasi = perubahan kas`, Math.round((cf.operating.amount + cf.investing.amount + cf.financing.amount + cf.unclassifiedAmount) * 100), Math.round(cf.netChangeInCash * 100));
  }
  for (const p of meta.periods) {
    const tb = byId[`tb:${p.label}`]; const exp = o.trialBalance(p.id);
    eq(`TB ${p.label}: total debit`, tb.totalDebit, exp.totalDebit); eq(`TB ${p.label}: total kredit`, tb.totalCredit, exp.totalCredit);
  }
  meta.topAccounts.forEach((id, i) => {
    const y = FYs[FYs.length - 1];
    const full = byId[`ledger:top${i + 1}:full`]; const ef = o.ledger(id, meta.minDate, meta.maxDate);
    eq(`Ledger top${i + 1} penuh: saldo awal/akhir/baris`, `${full.openingBalance}|${full.endingBalance}|${full.lines.length}`, `${ef.opening}|${ef.ending}|${ef.lines}`);
    const ly = byId[`ledger:top${i + 1}:last-year`]; const el = o.ledger(id, `${y}-01-01`, meta.maxDate);
    eq(`Ledger top${i + 1} tahun terakhir: saldo awal/akhir/baris`, `${ly.openingBalance}|${ly.endingBalance}|${ly.lines.length}`, `${el.opening}|${el.ending}|${el.lines}`);
  });
  for (const [t, key] of [["vendor", "cp:vendor"], ["customer", "cp:customer"]]) {
    const m = o.counterparties(t);
    const got = Object.fromEntries((byId[key].balances ?? byId[key]).map((r) => [r.counterpartyId, r.balance]));
    const bad = Object.keys(got).filter((id) => (m.get(id) ?? 0) !== got[id]);
    eq(`Counterparty ${t}: ${Object.keys(got).length} saldo = oracle`, bad.length, 0);
  }
  raw.close();
  void accIdByCode; void FLOW;
  return checks;
}

// ---------------------------------------------------------------- expected-by-scope
function scopesExpectations(meta) {
  const raw = new Database(`${OUT}/${dataset}/company.db`, { readonly: true });
  const info = JSON.parse(fs.readFileSync(`${OUT}/${dataset}/info.json`, "utf8"));
  const branchRows = raw.prepare("SELECT id, code, name FROM branches ORDER BY sort_order, code").all();
  const company = new Oracle(raw, null);
  const y = meta.years[meta.years.length - 1];
  const lastPeriod = meta.periods[meta.periods.length - 1];
  const fp = (o) => ({
    bs: (() => { const b = o.balanceSheet(meta.maxDate); return { totalAssets: b.totalAssets, totalLiabilities: b.totalLiabilities, totalEquity: b.totalEquity, bridge: b.bridge, difference: b.difference, accounts: Object.fromEntries(Object.entries(b.sections).map(([k, v]) => [k, v.map((l) => ({ code: l.code, amount: l.amount, journals: l.journals, lines: l.lines, sourceFp: l.fp }))])) }; })(),
    is: (() => { const i = o.incomeStatement(`${y}-01-01`, meta.maxDate); return { netProfit: i.netProfit, grossProfit: i.grossProfit, operatingProfit: i.operatingProfit }; })(),
    tb: (() => { const t = o.trialBalance(lastPeriod.id); return { totalDebit: t.totalDebit, totalCredit: t.totalCredit, difference: t.difference, bridge: t.bridge, signedByAccount: Object.fromEntries(t.rows.map((r) => [r.code, r.debit - r.credit])) }; })(),
    cash: o.cash(`${y}-01-01`, meta.maxDate),
    ledgerTop1: (() => { const l = o.ledger(meta.topAccounts[0], meta.minDate, meta.maxDate); return { opening: l.opening, ending: l.ending, lines: l.lines, sourceFp: l.fp }; })(),
  });
  const out = { dataset, branches: branchRows, scopes: {}, invariants: [] };
  out.scopes.company = fp(company);
  const per = {};
  for (const b of branchRows) { per[b.code] = new Oracle(raw, [b.id]); out.scopes[`branch:${b.code}`] = fp(per[b.code]); }
  // subset contoh (dua cabang pertama) + semua cabang
  if (branchRows.length >= 2) {
    const ids = branchRows.slice(0, 2).map((b) => b.id);
    out.scopes[`selected:${branchRows.slice(0, 2).map((b) => b.code).join("+")}`] = fp(new Oracle(raw, ids));
  }
  out.scopes.all = fp(new Oracle(raw, branchRows.map((b) => b.id)));
  // invarian: Σ cabang = perusahaan; tiap neraca cabang seimbang
  const inv = (name, pass, detail) => out.invariants.push({ name, pass, detail });
  const sum = (k) => Object.entries(out.scopes).filter(([s]) => s.startsWith("branch:")).reduce((t, [, v]) => t + k(v), 0);
  inv("Σ aset cabang = aset perusahaan", sum((v) => v.bs.totalAssets) === out.scopes.company.bs.totalAssets, [sum((v) => v.bs.totalAssets), out.scopes.company.bs.totalAssets]);
  inv("Σ kewajiban cabang = kewajiban perusahaan", sum((v) => v.bs.totalLiabilities) === out.scopes.company.bs.totalLiabilities);
  inv("Σ ekuitas (+RE-BRIDGE) cabang = perusahaan", sum((v) => v.bs.totalEquity) === out.scopes.company.bs.totalEquity);
  inv("Σ laba bersih cabang = perusahaan", sum((v) => v.is.netProfit) === out.scopes.company.is.netProfit);
  // TB: kolom debit/kredit per cabang TIDAK boleh dijumlahkan kolom-demi-kolom (saldo bersih tiap akun menentukan kolomnya);
  // yang berlaku adalah Σ saldo bertanda (debit - kredit) per akun. Ini aturan rekonsiliasi untuk komparasi 5B.
  const codes = new Set(Object.keys(out.scopes.company.tb.signedByAccount));
  const branchScopes = Object.entries(out.scopes).filter(([s]) => s.startsWith("branch:")).map(([, v]) => v);
  branchScopes.forEach((v) => Object.keys(v.tb.signedByAccount).forEach((c) => codes.add(c)));
  const badCodes = [...codes].filter((c) => branchScopes.reduce((t, v) => t + (v.tb.signedByAccount[c] ?? 0), 0) !== (out.scopes.company.tb.signedByAccount[c] ?? 0));
  inv("Σ saldo bertanda TB per akun (debit-kredit) cabang = perusahaan", badCodes.length === 0, badCodes);
  inv("(info) Σ kolom debit TB per cabang BOLEH berbeda dari perusahaan karena netting per akun", true, [sum((v) => v.tb.totalDebit), out.scopes.company.tb.totalDebit]);
  inv("Σ perubahan kas cabang = perusahaan", sum((v) => v.cash.net) === out.scopes.company.cash.net);
  inv("Σ saldo akhir buku besar akun teratas = perusahaan", sum((v) => v.ledgerTop1.ending) === out.scopes.company.ledgerTop1.ending);
  inv("Σ jumlah jurnal cabang = total jurnal", info.perBranch.reduce((t, x) => t + x.c, 0) === info.journals);
  for (const [s, v] of Object.entries(out.scopes)) inv(`neraca seimbang: ${s}`, v.bs.difference === 0, v.bs.difference);
  inv("gabungan semua cabang = perusahaan (aset, laba)", out.scopes.all.bs.totalAssets === out.scopes.company.bs.totalAssets && out.scopes.all.is.netProfit === out.scopes.company.is.netProfit);
  raw.close();
  return out;
}

// ---------------------------------------------------------------- main
if (mode === "scopes") {
  const { R, ...meta } = buildRequests(); void R;
  const exp = scopesExpectations(meta);
  fs.writeFileSync(`${GOLD_DIR}/expected-by-scope.${dataset}.json`, JSON.stringify(exp, null, 1));
  for (const c of exp.invariants) console.log((c.pass ? "PASS " : "FAIL ") + c.name);
  console.log(`\n${exp.invariants.filter((c) => c.pass).length}/${exp.invariants.length} invarian lulus`);
  process.exit(exp.invariants.every((c) => c.pass) ? 0 : 1);
}

// ---------------------------------------------------------------- Phase 5A/5B: verifikasi laporan per cabang terhadap oracle SQL independen
//   node golden.mjs scoped <dataset>   (dataset multi-cabang: uat-3 | uat-7; flag ON)
// Tiap cabang, subset dua cabang, dan "seluruh cabang" diminta lewat HTTP (`scope=...`) lalu dibandingkan dengan angka
// yang dihitung oracle langsung dari baris jurnal (expected-by-scope.<dataset>.json). Komparasi: kolom per cabang + Gabungan
// harus terekonsiliasi (200) dan waktu responsnya dicatat.
if (mode === "scoped") {
  const { R, ...meta } = buildRequests(); void R;
  const exp = JSON.parse(fs.readFileSync(`${GOLD_DIR}/expected-by-scope.${dataset}.json`, "utf8"));
  const y = meta.years[meta.years.length - 1];
  const last = meta.periods[meta.periods.length - 1];
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, pass: JSON.stringify(got) === JSON.stringify(want), got, want });
  const scopes = [...exp.branches.map((b) => [`branch:${b.code}`, `branch:${b.id}`]), [exp.scopes && Object.keys(exp.scopes).find((k) => k.startsWith("selected:")), `selected:${exp.branches.slice(0, 2).map((b) => b.id).join(",")}`], ["all", "all"]];
  await withServer(async (get) => {
    for (const [key, param] of scopes) {
      const want = exp.scopes[key];
      const q = `scope=${encodeURIComponent(param)}`;
      const bs = (await get(`${A}/reports/balance-sheet?fromDate=${meta.minDate}&toDate=${meta.maxDate}&${q}`)).json;
      const is = (await get(`${A}/reports/income-statement?fromDate=${y}-01-01&toDate=${meta.maxDate}&${q}`)).json;
      const cf = (await get(`${A}/reports/cash-flow?fromDate=${y}-01-01&toDate=${meta.maxDate}&${q}`)).json;
      const tb = (await get(`${A}/trial-balance?periodId=${last.id}&${q}`)).json;
      const lg = (await get(`${A}/ledger/${meta.topAccounts[0]}?fromDate=${meta.minDate}&toDate=${meta.maxDate}&${q}`)).json;
      eq(`${key}: aset/kewajiban/ekuitas`, [bs.totalAssets, bs.totalLiabilities, bs.totalEquity], [want.bs.totalAssets, want.bs.totalLiabilities, want.bs.totalEquity]);
      eq(`${key}: neraca seimbang`, bs.balanceDifference, 0);
      eq(`${key}: laba bersih`, is.netProfit, want.is.netProfit);
      eq(`${key}: perubahan kas`, cf.netChangeInCash, want.cash.net);
      eq(`${key}: neraca saldo seimbang + saldo bertanda per akun`, [tb.isBalanced, Object.fromEntries(tb.rows.filter((r) => !r.isBridge).map((r) => [r.code, r.debit - r.credit]))], [true, Object.fromEntries(Object.entries(want.tb.signedByAccount).filter(([c]) => c !== "RE-BRIDGE"))]);
      eq(`${key}: buku besar akun teratas (awal/akhir/baris)`, [lg.openingBalance, lg.endingBalance, lg.lines.length], [want.ledgerTop1.opening, want.ledgerTop1.ending, want.ledgerTop1.lines]);
      eq(`${key}: respons memuat scope`, [bs.scope?.mode !== undefined, is.scope?.mode !== undefined, tb.scope?.mode !== undefined], [true, true, true]);
    }
    // komparasi + rekonsiliasi + waktu
    const ids = exp.branches.map((b) => b.id);
    for (const [label, path] of [
      ["Neraca", `/reports/balance-sheet?fromDate=${meta.minDate}&toDate=${meta.maxDate}`],
      ["Laba Rugi", `/reports/income-statement?fromDate=${y}-01-01&toDate=${meta.maxDate}`],
      ["Ekuitas", `/reports/equity?fromDate=${y}-01-01&toDate=${meta.maxDate}`],
      ["Neraca Saldo", `/trial-balance?periodId=${last.id}`],
    ]) {
      const t0 = Date.now();
      const res = await get(`${A}${path}${path.includes("?") ? "&" : "?"}scope=${encodeURIComponent("branches:" + ids.join(","))}`);
      const ms = Date.now() - t0;
      eq(`komparasi ${ids.length} cabang + Gabungan: ${label}: 200 & terekonsiliasi (${ms} ms)`, [res.status, res.json?.comparison?.reconciliation?.ok === true, res.json?.comparison?.columns?.length], [200, true, ids.length]);
      console.log(`  waktu komparasi ${label} (${ids.length} cabang + Gabungan): ${ms} ms`);
    }
  });
  for (const c of checks.filter((c) => !c.pass)) console.log("FAIL:", c.name, JSON.stringify(c.got).slice(0, 200), "!=", JSON.stringify(c.want).slice(0, 200));
  console.log(`${checks.filter((c) => c.pass).length}/${checks.length} pemeriksaan per cabang sama dengan oracle (${dataset})`);
  process.exit(checks.every((c) => c.pass) ? 0 : 1);
}

// ---------------------------------------------------------------- Phase 5 stabilisasi: perbarui HANYA hash dokumen ekspor (format teks periode berubah dengan sengaja)
//   node golden.mjs reexport <dataset>   : menghitung ulang `exportDocuments`, mencetak tiap hash lama/baru, dan menulis ulang HANYA bagian itu.
//   Semua respons laporan (`requests`, `aggregateSha256`) TIDAK disentuh; periksa dulu diff dokumen sebelum/sesudah (scratch p9/export-dump.mjs).
if (mode === "reexport") {
  const { R, ...meta } = buildRequests(); void R;
  const file = `${GOLD_DIR}/${dataset}.golden.json`;
  const gold = JSON.parse(fs.readFileSync(file, "utf8"));
  const fresh = await exportDocs(meta);
  let changed = 0;
  for (const [k, v] of Object.entries(fresh)) {
    const same = gold.exportDocuments[k] === v;
    if (!same) changed++;
    console.log(`${same ? "SAMA " : "BEDA "} ${k}`);
  }
  gold.exportDocuments = fresh;
  fs.writeFileSync(file, JSON.stringify(gold, null, 1));
  console.log(`${dataset}: ${changed} dari ${Object.keys(fresh).length} hash ekspor diperbarui; bagian lain tidak diubah`);
  process.exit(0);
}

const run1 = await captureOnce();
const exports1 = await exportDocs(run1.meta);
if (mode === "capture") {
  const run2 = await captureOnce(); // uji determinisme: dua kali rekam harus identik
  const diff = run1.results.filter((r, i) => r.sha256 !== run2.results[i].sha256).map((r) => r.id);
  console.log(`determinisme: ${diff.length === 0 ? "OK (2x rekam identik)" : "GAGAL: " + diff.join(", ")}`);
  const checks = dataset === "small" || dataset === "uat-1" ? verifyAgainstOracle(run1.meta, run1.results) : [];
  for (const c of checks.filter((c) => !c.pass)) console.log("FAIL oracle:", c.name, c.got, "!=", c.expected);
  console.log(`oracle (sumber transaksi -> angka): ${checks.filter((c) => c.pass).length}/${checks.length} sama persis`);
  const golden = {
    phase: "5.0", dataset, capturedFrom: "server hasil build (node dist/server.js) pada salinan data UAT", meta: { minDate: run1.meta.minDate, maxDate: run1.meta.maxDate, years: run1.meta.years, periods: run1.meta.periods.length },
    determinism: diff.length === 0, oracleChecks: { total: checks.length, passed: checks.filter((c) => c.pass).length },
    requests: run1.results.map(({ _json, ...r }) => r), exportDocuments: exports1,
    aggregateSha256: sha(canon(run1.results.map((r) => [r.id, r.status, r.sha256]))),
  };
  fs.writeFileSync(`${GOLD_DIR}/${dataset}.golden.json`, JSON.stringify(golden, null, 1));
  fs.mkdirSync(`${S}/p50/golden-full`, { recursive: true });
  fs.writeFileSync(`${S}/p50/golden-full/${dataset}.responses.json`, JSON.stringify(run1.results.map((r) => ({ id: r.id, json: r._json })), null, 0));
  console.log(`golden ditulis: ${GOLD_DIR}/${dataset}.golden.json (${golden.requests.length} permintaan + ${Object.keys(exports1).length} dokumen ekspor) agregat=${golden.aggregateSha256.slice(0, 16)}…`);
  process.exit(diff.length === 0 && checks.every((c) => c.pass) ? 0 : 1);
}
if (mode === "verify") {
  const gold = JSON.parse(fs.readFileSync(`${GOLD_DIR}/${process.env.GOLDEN_FROM ?? dataset}.golden.json`, "utf8"));
  const skip = new Set((process.env.SKIP_IDS ?? "").split(",").filter(Boolean));
  let bad = 0, n = 0;
  for (const g of gold.requests) {
    if (skip.has(g.id) || [...skip].some((s) => s.endsWith("*") && g.id.startsWith(s.slice(0, -1)))) continue;
    const r = run1.results.find((x) => x.id === g.id); n++;
    if (!r || r.status !== g.status || r.sha256 !== g.sha256) { bad++; console.log("BEDA:", g.id, r?.status, g.status); }
  }
  for (const [k, v] of Object.entries(gold.exportDocuments)) { n++; if (exports1[k] !== v) { bad++; console.log("BEDA ekspor:", k); } }
  console.log(`${n - bad}/${n} identik dengan golden (${process.env.GOLDEN_FROM ?? dataset})`);
  process.exit(bad === 0 ? 0 : 1);
}
