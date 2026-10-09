import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { S, Client, A, rec, note, timed, state, ExcelJS } from "./lib.mjs";
import { code } from "./gen.mjs";

const { accId, periodByMonth } = state();
fs.mkdirSync(`${S}/exports`, { recursive: true });
const bucket = (ms) => (ms < 1000 ? "<1s" : ms < 3000 ? "1-3s" : ms < 5000 ? "3-5s" : ms < 10000 ? "5-10s" : ">10s");
const perf = (id, label, ms, sev = "MEDIUM") => { rec(id, "performance", `${label}: ${ms} ms (${bucket(ms)})`, ms < 10000, bucket(ms), ms >= 10000 ? "HIGH" : sev); };

// ---- performa
const c = new Client("owner");
let p = await timed("login", () => c.login("owner@terra-nusantara.test", "Uat#Owner2026")); perf("PERF-login", "Login", p.ms);
p = await timed("company list", () => c.get("/api/company-db")); perf("PERF-list", "Daftar perusahaan", p.ms);
p = await timed("dashboard 1 thn", () => c.get(`${A()}/dashboard?fromDate=2025-01-01&toDate=2025-12-31`)); perf("PERF-dash1", "Dashboard 1 tahun", p.ms);
p = await timed("dashboard 5 thn", () => c.get(`${A()}/dashboard?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-dash5", "Dashboard 5 tahun", p.ms);
p = await timed("ledger BCA 5y", () => c.get(`${A()}/ledger/${accId[code.bca]}?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-led5", "Ledger Bank BCA 5 tahun (2.009 baris)", p.ms);
p = await timed("ledger BCA 1 bln", () => c.get(`${A()}/ledger/${accId[code.bca]}?fromDate=2025-12-01&toDate=2025-12-31`)); perf("PERF-led1m", "Ledger Bank BCA 1 bulan", p.ms);
p = await timed("trial balance", () => c.get(`${A()}/trial-balance?periodId=${periodByMonth["2025-12"]}`)); perf("PERF-tb", "Trial Balance Des 2025", p.ms);
p = await timed("income statement 1y", () => c.get(`${A()}/reports/income-statement?fromDate=2025-01-01&toDate=2025-12-31`)); perf("PERF-is1", "Laba Rugi 1 tahun", p.ms);
p = await timed("income statement 5y", () => c.get(`${A()}/reports/income-statement?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-is5", "Laba Rugi 5 tahun", p.ms);
p = await timed("balance sheet 5y", () => c.get(`${A()}/reports/balance-sheet?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-bs5", "Neraca 5 tahun", p.ms);
p = await timed("cash flow 5y", () => c.get(`${A()}/reports/cash-flow?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-cf5", "Arus Kas 5 tahun", p.ms);
p = await timed("equity 5y", () => c.get(`${A()}/reports/equity?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-eq5", "Ekuitas 5 tahun", p.ms);
p = await timed("analysis", () => c.get(`${A()}/analysis?fromDate=2021-01-01&toDate=2025-12-31`)); perf("PERF-ana", "Analisis rasio 5 tahun", p.ms);
p = await timed("projection", () => c.get(`${A()}/projection?asOfDate=2025-12-31&monthsAhead=6`)); perf("PERF-proj", "Proyeksi", p.ms);
p = await timed("search ref", () => c.get(`${A()}/search?q=PST-2025`)); perf("PERF-s1", "Search nomor jurnal", p.ms);
p = await timed("search nominal", () => c.get(`${A()}/search?q=${encodeURIComponent("Rp 12.500")}`)); perf("PERF-s2", "Search nominal", p.ms);
p = await timed("search teks", () => c.get(`${A()}/search?q=penjualan`)); perf("PERF-s3", "Search teks umum", p.ms);
p = await timed("journal list", () => c.get(`${A()}/journals?page=1&pageSize=50`)); perf("PERF-jl", "Daftar jurnal (halaman 1 dari 5.965)", p.ms);
p = await timed("journal list search", () => c.get(`${A()}/journals?search=Pembelian&pageSize=50`)); perf("PERF-jls", "Daftar jurnal + pencarian teks", p.ms);
p = await timed("audit log", () => c.get(`${A()}/audit-log?page=1&pageSize=50`)); perf("PERF-audit", "Audit log", p.ms);
p = await timed("counterparty balances", () => c.get(`${A()}/counterparties/balances?type=customer`)); perf("PERF-cp", "Saldo Hutang/Piutang", p.ms);

// ---- export
const exp = [];
const kinds = [["balance-sheet", "2021-01-01"], ["income-statement", null], ["equity", null], ["cash-flow", null]];
const ranges = { "1 hari": ["2025-12-31", "2025-12-31"], "1 bulan": ["2025-12-01", "2025-12-31"], "1 tahun": ["2025-01-01", "2025-12-31"], "5 tahun": ["2021-01-01", "2025-12-31"] };
const fnameOk = (h) => /^attachment; filename="[A-Za-z0-9._-]+\.(xlsx|pdf)"$/.test(h ?? "");
const API = { "balance-sheet": (f, t) => `/reports/balance-sheet?fromDate=${f}&toDate=${t}`, "income-statement": (f, t) => `/reports/income-statement?fromDate=${f}&toDate=${t}`, equity: (f, t) => `/reports/equity?fromDate=${f}&toDate=${t}`, "cash-flow": (f, t) => `/reports/cash-flow?fromDate=${f}&toDate=${t}` };
const keyOf = (kind, j) => (kind === "balance-sheet" ? j.totalAssets : kind === "income-statement" ? j.netProfit : kind === "equity" ? j.closingEquity : j.endingCash);
async function xlsxHas(buf, needles) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); let txt = []; let formulas = 0; wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => { const v = cell.value; if (v && typeof v === "object" && "formula" in v) formulas++; txt.push(String(v?.result ?? v ?? "")); }))); const all = txt.join("\n"); return { found: needles.map((n) => all.includes(n)), all, formulas }; }
for (const [kind] of kinds) for (const [rn, [f0, t]] of Object.entries(ranges)) {
  const f = kind === "balance-sheet" ? "2021-01-01" : f0; // Neraca selalu kumulatif dari awal pembukuan
  const api = (await c.get(`${A()}${API[kind](f, t)}`)).json; const want = keyOf(kind, api);
  for (const fmt of ["xlsx", "pdf"]) {
    const r = await timed(`export ${kind} ${rn} ${fmt}`, () => c.get(`${A()}/reports/export/${kind}?format=${fmt}&fromDate=${f}&toDate=${t}`, { raw: true }));
    const res = r.res; const magic = fmt === "xlsx" ? res.buf.subarray(0, 2).toString() === "PK" : res.buf.subarray(0, 5).toString() === "%PDF-";
    const cd = res.headers.get("content-disposition"); const file = `${S}/exports/${kind}-${rn.replace(" ", "")}.${fmt}`; fs.writeFileSync(file, res.buf);
    let ok = res.status === 200 && magic && fnameOk(cd); let detail = `status ${res.status} ${res.buf.length}B ${r.ms}ms`;
    if (fmt === "xlsx" && ok) { const x = await xlsxHas(res.buf, ["PT TERRA NUSANTARA"]); ok = x.found[0] && !x.all.includes("PT PEMBANDING") && x.formulas === 0; const num = Math.round(Math.abs(want)); const hit = x.all.includes(String(num)); if (!hit) { ok = false; detail += ` angka ${num} tidak ditemukan`; } }
    rec(`EXP-${kind}-${rn.replace(" ", "")}-${fmt}`, "export", `Export ${kind} ${rn} ${fmt.toUpperCase()}`, ok, detail, "HIGH");
    exp.push({ kind, rn, fmt, file, want: Math.round(Math.abs(want)), ms: r.ms, size: res.buf.length });
  }
}
// trial balance & ledger
for (const [label, url, base] of [["trial-balance Des2025", `trial-balance&periodId=${periodByMonth["2025-12"]}`, "tb"], ["ledger BCA 5 tahun", `ledger&accountId=${accId[code.bca]}&fromDate=2021-01-01&toDate=2025-12-31`, "ledgerBCA5y"], ["ledger BCA 1 hari", `ledger&accountId=${accId[code.bca]}&fromDate=2025-12-31&toDate=2025-12-31`, "ledgerBCA1d"], ["ledger Kas Metro 1 tahun", `ledger&accountId=${accId[code.kas("MTR")]}&fromDate=2025-01-01&toDate=2025-12-31`, "ledgerMTR1y"]]) {
  const kind = url.split("&")[0]; const q = url.split("&").slice(1).join("&");
  for (const fmt of ["xlsx", "pdf"]) {
    const r = await timed(`export ${label} ${fmt}`, () => c.get(`${A()}/reports/export/${kind}?format=${fmt}&${q}`, { raw: true }));
    const res = r.res; const magic = fmt === "xlsx" ? res.buf.subarray(0, 2).toString() === "PK" : res.buf.subarray(0, 5).toString() === "%PDF-";
    fs.writeFileSync(`${S}/exports/${base}.${fmt}`, res.buf);
    rec(`EXP-${base}-${fmt}`, "export", `Export ${label} ${fmt.toUpperCase()}`, res.status === 200 && magic && fnameOk(res.headers.get("content-disposition")), `status ${res.status} ${res.buf.length}B ${r.ms}ms`, "HIGH");
    exp.push({ kind: label, rn: "", fmt, file: `${S}/exports/${base}.${fmt}`, want: null, ms: r.ms, size: res.buf.length });
  }
}
// PDF: baca teks dengan pymupdf, cek nama perusahaan, halaman, dan angka kunci
fs.writeFileSync(`${S}/pdfcheck.py`, `import json,sys,pymupdf
items=json.load(open(sys.argv[1],encoding='utf8')); out=[]
for it in items:
    if it['fmt']!='pdf': continue
    try:
        d=pymupdf.open(it['file']); txt=''.join(p.get_text() for p in d); n=d.page_count
        fm=None
        if it.get('want'):
            s=f"{it['want']:,}".replace(',','.'); fm=s in txt
        out.append({'file':it['file'],'pages':n,'company':'PT TERRA NUSANTARA' in txt,'otherCompany':'PT PEMBANDING' in txt,'amountFound':fm})
    except Exception as e: out.append({'file':it['file'],'error':str(e)})
print(json.dumps(out))`);
fs.writeFileSync(`${S}/exp-items.json`, JSON.stringify(exp));
const pc = JSON.parse(execFileSync("python", [`${S}/pdfcheck.py`, `${S}/exp-items.json`]).toString());
for (const x of pc) { const nm = x.file.split("/").pop(); rec(`PDF-${nm}`, "export", `PDF terbaca (${nm}): ${x.pages} hal, nama perusahaan, tanpa data company lain, angka kunci`, !x.error && x.pages > 0 && x.company && !x.otherCompany && x.amountFound !== false, JSON.stringify({ pages: x.pages, company: x.company, other: x.otherCompany, amount: x.amountFound, err: x.error }), "HIGH"); }
note("EXP-size", "export", "ukuran/waktu export terbesar", JSON.stringify(exp.sort((a, b) => b.ms - a.ms).slice(0, 4).map((e) => [e.kind, e.rn, e.fmt, e.ms + "ms", e.size + "B"])));
console.log("PERF+EXPORT SELESAI"); process.exit(0);
