// PHASE 5.0 -- bukti untuk keputusan desain/indeks (tanpa mengubah kode produk): bentuk SQL calon Phase 5 diukur dan di-EXPLAIN
// pada dataset 1/3/7 cabang, dengan dan tanpa indeks kandidat, pada SALINAN scratch.
//   A  N+1 per akun, tanpa cakupan            (bentuk SAAT INI)
//   B  N+1 per akun, dengan cakupan cabang    (perubahan minimal 5A: tambah `je.branch_id IN (...)`)
//   C  set-based GROUP BY akun, tanpa/ dengan cakupan
//   D  set-based GROUP BY akun+cabang (semua cabang)  (bentuk komparasi 5B)
//   F  Arus Kas: N+1 baris per entri kas vs satu kueri per 500 entri
// Pemakaian: node prototypes.mjs
import fs from "node:fs";
import { OUT, S, Database } from "./build-datasets.mjs";

const REPS = 7;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
const med = (fn) => { fn(); return Math.round(median(Array.from({ length: REPS }, () => time(fn))) * 10) / 10; };
const STATUS = "('POSTED','REVERSED')";

const CANDIDATES = {
  I0_existing: [],
  I1_je_branch_status_date: ["CREATE INDEX cand_je_branch_status_date ON journal_entries(branch_id, status, entry_date)"],
  I2_je_status_date: ["CREATE INDEX cand_je_status_date ON journal_entries(status, entry_date)"],
  I3_jel_covering: ["CREATE INDEX cand_jel_cover ON journal_entry_lines(account_id, journal_entry_id, debit, credit)"],
  I4_I1_plus_I3: ["CREATE INDEX cand_je_branch_status_date ON journal_entries(branch_id, status, entry_date)", "CREATE INDEX cand_jel_cover ON journal_entry_lines(account_id, journal_entry_id, debit, credit)"],
};

const out = {};
for (const ds of ["uat-1", "uat-3", "uat-7"]) {
  const src = `${OUT}/${ds}/company.db`;
  const info = JSON.parse(fs.readFileSync(`${OUT}/${ds}/info.json`, "utf8"));
  const branchIds = info.branchIds;
  out[ds] = {};
  for (const [cname, ddl] of Object.entries(CANDIDATES)) {
    const tmp = `${S}/p50/tmp-${ds}-${cname}.db`;
    fs.copyFileSync(src, tmp);
    const db = new Database(tmp);
    db.pragma("foreign_keys = ON");
    const pagesBefore = db.pragma("page_count", { simple: true });
    for (const d of ddl) db.exec(d);
    db.exec("ANALYZE");
    const pageSize = db.pragma("page_size", { simple: true });
    const addedMB = Math.round(((db.pragma("page_count", { simple: true }) - pagesBefore) * pageSize) / 1e4) / 100;
    const accounts = db.prepare("SELECT id FROM accounts").all().map((r) => r.id);
    const maxDate = db.prepare("SELECT MAX(entry_date) FROM journal_entries").pluck().get();
    const inList = (n) => `(${branchIds.slice(0, n).map(() => "?").join(",")})`;
    const nSets = ds === "uat-1" ? [1] : ds === "uat-3" ? [1, 3] : [1, 3, 7];

    const perAccount = (n) => {
      const where = n ? ` AND je.branch_id IN ${inList(n)}` : "";
      return db.prepare(`SELECT COALESCE(SUM(jel.debit),0) d, COALESCE(SUM(jel.credit),0) c FROM journal_entry_lines jel JOIN journal_entries je ON je.id=jel.journal_entry_id WHERE jel.account_id=? AND je.status IN ${STATUS} AND je.entry_date<=?${where}`);
    };
    const setBased = (n, byBranch) => {
      const where = n ? ` AND je.branch_id IN ${inList(n)}` : "";
      return db.prepare(`SELECT jel.account_id a, ${byBranch ? "je.branch_id b," : ""} COALESCE(SUM(jel.debit),0) d, COALESCE(SUM(jel.credit),0) c FROM journal_entry_lines jel JOIN journal_entries je ON je.id=jel.journal_entry_id WHERE je.status IN ${STATUS} AND je.entry_date<=?${where} GROUP BY jel.account_id${byBranch ? ", je.branch_id" : ""}`);
    };
    const r = {};
    const run = (label, stmt, fnRun, n, plan) => {
      const args = (extra) => [...extra, ...(n ? branchIds.slice(0, n) : [])];
      r[label] = { ms: med(() => fnRun(args)), plan: plan ? db.prepare(`EXPLAIN QUERY PLAN ${stmt.source}`).all(...args(plan)).map((x) => x.detail) : undefined };
    };
    // A: N+1 tanpa cakupan
    { const st = perAccount(0); run("A_n+1_unscoped", st, (a) => accounts.forEach((id) => st.get(...a([id, maxDate]))), 0, ["x", maxDate]); }
    for (const n of nSets) {
      { const st = perAccount(n); run(`B_n+1_scoped_${n}of${branchIds.length}`, st, (a) => accounts.forEach((id) => st.get(...a([id, maxDate]))), n, ["x", maxDate]); }
      { const st = setBased(n, false); run(`C_setbased_scoped_${n}of${branchIds.length}`, st, (a) => st.all(...a([maxDate])), n, [maxDate]); }
    }
    { const st = setBased(0, false); run("C_setbased_unscoped", st, (a) => st.all(...a([maxDate])), 0, [maxDate]); }
    { const st = setBased(0, true); run("D_setbased_group_by_branch_all", st, (a) => st.all(...a([maxDate])), 0, [maxDate]); }

    // F: Arus Kas -- N+1 baris per entri kas vs 1 kueri per 500 entri
    if (cname === "I0_existing" || cname === "I3_jel_covering") {
      const ids = db.prepare(`SELECT DISTINCT je.id FROM journal_entry_lines jel JOIN journal_entries je ON je.id=jel.journal_entry_id JOIN accounts a ON a.id=jel.account_id WHERE a.is_cash=1 AND je.status IN ${STATUS} AND je.entry_date>=? AND je.entry_date<=?`).all(`${String(maxDate).slice(0, 4)}-01-01`, maxDate).map((x) => x.id);
      const one = db.prepare("SELECT jel.journal_entry_id j, jel.account_id a, jel.debit, jel.credit, a.is_cash ic, a.cash_flow_activity cf FROM journal_entry_lines jel JOIN accounts a ON a.id=jel.account_id WHERE jel.journal_entry_id=?");
      r.F_cashflow_lines_n1 = { entries: ids.length, ms: med(() => ids.forEach((id) => one.all(id))) };
      const chunk = (arr, k) => Array.from({ length: Math.ceil(arr.length / k) }, (_, i) => arr.slice(i * k, i * k + k));
      const stmts = new Map();
      const batch = (part) => { let s = stmts.get(part.length); if (!s) { s = db.prepare(`SELECT jel.journal_entry_id j, jel.account_id a, jel.debit, jel.credit, a.is_cash ic, a.cash_flow_activity cf FROM journal_entry_lines jel JOIN accounts a ON a.id=jel.account_id WHERE jel.journal_entry_id IN (${part.map(() => "?").join(",")})`); stmts.set(part.length, s); } return s.all(...part); };
      r.F_cashflow_lines_batched500 = { entries: ids.length, ms: med(() => chunk(ids, 500).forEach(batch)) };
    }
    out[ds][cname] = { addedIndexMB: addedMB, ...r };
    db.close();
    fs.rmSync(tmp, { force: true });
    console.log(`${ds} ${cname.padEnd(26)} +${String(addedMB).padStart(5)}MB  ` + Object.entries(r).filter(([k]) => !k.startsWith("F_")).map(([k, v]) => `${k.replace(/_scoped|_unscoped|_setbased|_n\+1|_group_by_branch_all/g, (m) => m.replace("_", "")).slice(0, 14)}=${v.ms}`).join("  "));
  }
}

// biaya tulis: sisip 3.000 jurnal x 3 baris (mirip impor) dengan/tanpa indeks kandidat
const write = {};
for (const [cname, ddl] of Object.entries(CANDIDATES)) {
  const tmp = `${S}/p50/tmp-write-${cname}.db`;
  fs.copyFileSync(`${OUT}/uat-7/company.db`, tmp);
  const db = new Database(tmp);
  db.pragma("foreign_keys = ON");
  for (const d of ddl) db.exec(d);
  const acc = db.prepare("SELECT id FROM accounts WHERE is_active=1 LIMIT 3").all().map((x) => x.id);
  const period = db.prepare("SELECT id FROM periods ORDER BY end_date DESC LIMIT 1").pluck().get();
  const br = db.prepare("SELECT id FROM branches LIMIT 1").pluck().get();
  const sample = db.prepare("SELECT * FROM journal_entries LIMIT 1").get();
  const cols = Object.keys(sample);
  const jeIns = db.prepare(`INSERT INTO journal_entries (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  const lineSample = db.prepare("SELECT * FROM journal_entry_lines LIMIT 1").get();
  const lcols = Object.keys(lineSample);
  const lnIns = db.prepare(`INSERT INTO journal_entry_lines (${lcols.map((c) => `"${c}"`).join(",")}) VALUES (${lcols.map(() => "?").join(",")})`);
  const t = performance.now();
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      const id = `bench-${cname}-${i}`;
      const je = { ...sample, id, reference_no: `BENCH-${cname}-${i}`, period_id: period, branch_id: br, status: "POSTED", reversal_of_journal_id: null, inter_branch_transaction_id: null, inter_branch_leg: null, inter_branch_side: null, is_reversed: 0 };
      jeIns.run(...cols.map((c) => je[c] ?? null));
      for (let k = 0; k < 3; k++) {
        const ln = { ...lineSample, id: `${id}-l${k}`, journal_entry_id: id, account_id: acc[k], debit: k === 2 ? 0 : 1000, credit: k === 2 ? 2000 : 0, line_order: k + 1, counterparty_id: null };
        lnIns.run(...lcols.map((c) => ln[c] ?? null));
      }
    }
  })();
  write[cname] = Math.round(performance.now() - t);
  db.close();
  fs.rmSync(tmp, { force: true });
}
console.log("tulis 3000 jurnal x 3 baris (ms):", JSON.stringify(write));
out.writeCostMs = write;
fs.writeFileSync(`${S}/p50/prototypes.json`, JSON.stringify(out, null, 1));
