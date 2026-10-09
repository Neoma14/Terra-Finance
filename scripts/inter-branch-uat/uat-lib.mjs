// Pustaka bersama UAT Antar Cabang: server uji terisolasi (build), klien HTTP per persona, snapshot akuntansi baca-saja.
// SEMUA terhadap salinan data UAT di folder kerja (bukan port 4000, bukan data pengguna nyata).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORK = path.resolve(process.argv[2] ?? ".");
export const DATA = `${WORK}/data`;
export const SLUG = "pt-terra-nusantara";
export const OFF_SLUG = "pt-pembanding";
export const COMPANY_DB = `${DATA}/companies/${SLUG}/company.db`;
const req = createRequire(`${ROOT}/apps/api/package.json`);
export const Database = req("better-sqlite3");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const P = JSON.parse(fs.readFileSync(`${WORK}/personas.json`, "utf8"));

export function serverEnv(port, offsetDays = 0) {
  return {
    ...process.env, NODE_ENV: "production", PORT: String(port), UAT_CLOCK_OFFSET_DAYS: String(offsetDays),
    DB_FILE_PATH: `${DATA}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${DATA}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${DATA}/companies`,
    STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("ui").digest("hex"),
  };
}

export async function startServer(port, offsetDays = 0, tag = "srv") {
  const env = serverEnv(port, offsetDays);
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(`${WORK}/${tag}-${port}.log`, "w");
  const args = offsetDays ? ["--import", pathToFileURL(`${ROOT}/scripts/inter-branch-uat/clock.mjs`).href] : [];
  const child = spawn(process.execPath, [...args, `${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base, stop: () => stopProc(child) }; } catch { /* belum siap */ }
    await sleep(400);
  }
  child.kill();
  throw new Error(`server uji port ${port} tidak sehat`);
}
async function stopProc(child) {
  child.kill();
  await sleep(1500);
  try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch { /* sudah berhenti */ }
}

/** Klien HTTP: cookie sesi persona; header cabang aktif opsional. 429 diulang setelah menunggu (dicatat di `rate429`). */
export class Client {
  constructor(base, token, label) { this.base = base; this.cookie = token ? `konsultan_session=${token}` : ""; this.label = label; this.rate429 = 0; this.branch = null; }
  async req(method, p, { body, headers = {}, noRetry = false } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.branch && !h["x-branch-context"]) h["x-branch-context"] = this.branch;
    if (body !== undefined) h["Content-Type"] = "application/json";
    let r, text;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      text = await r.text();
      if (r.status !== 429 || noRetry) break;
      this.rate429++;
      await sleep((Number(r.headers.get("retry-after") ?? 5) + 1) * 1000);
    }
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    let json = null; try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { status: r.status, json, text };
  }
  get(p, o) { return this.req("GET", p, o); }
  post(p, body, o = {}) { return this.req("POST", p, { ...o, body }); }
  put(p, body, o = {}) { return this.req("PUT", p, { ...o, body }); }
}
export const as = (srv, key, branch = null) => { const c = new Client(srv.base, P.personas[key].token, key); c.branch = branch; return c; };
export async function loginAs(srv, key) {
  const c = new Client(srv.base, null, key);
  const r = await c.post("/api/auth/login", { email: P.personas[key].email, password: P.personas[key].password });
  if (r.status !== 200) throw new Error(`login ${key} gagal: ${r.status} ${r.text.slice(0, 120)}`);
  return c;
}

export const IB = `/api/company-db/${SLUG}/inter-branch`;
export const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- akuntansi (baca-saja)
export function ro(file = COMPANY_DB) { return new Database(file, { readonly: true }); }
export function accountsByCode() {
  const d = ro();
  const rows = d.prepare("select id, code, name, is_cash, branch_policy, counterpart_branch_id from accounts").all();
  d.close();
  return rows;
}
export function ibAccount(rows, ownerBranchIdUnused, counterpartBranchId, typeCodePrefix) {
  return rows.find((a) => a.branch_policy === "INTER_BRANCH" && a.counterpart_branch_id === counterpartBranchId && a.code.startsWith(typeCodePrefix));
}

/** Snapshot: saldo bersih (sen) per akun x cabang untuk jurnal POSTED/REVERSED (dasar laporan), hitungan jurnal & audit. */
export function snapshot() {
  const d = ro();
  const bal = {};
  for (const r of d.prepare(`select l.account_id a, j.branch_id b, sum(cast(round(l.debit*100) as integer)) - sum(cast(round(l.credit*100) as integer)) v
    from journal_entry_lines l join journal_entries j on j.id = l.journal_entry_id where j.status in ('POSTED','REVERSED') group by 1,2`).all()) bal[`${r.a}|${r.b}`] = r.v;
  const one = (sql) => d.prepare(sql).get();
  const snap = {
    bal,
    journals: one("select count(*) n from journal_entries").n,
    effective: one("select count(*) n from journal_entries where status in ('POSTED','REVERSED')").n,
    ibJournals: one("select count(*) n from journal_entries where inter_branch_transaction_id is not null").n,
    audit: one("select count(*) n from company_audit_log").n,
    ibAudit: one("select count(*) n from company_audit_log where action like 'INTER_BRANCH_%'").n,
    sumDebit: one("select sum(cast(round(l.debit*100) as integer)) v from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.status in ('POSTED','REVERSED')").v,
    sumCredit: one("select sum(cast(round(l.credit*100) as integer)) v from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.status in ('POSTED','REVERSED')").v,
    txByStatus: Object.fromEntries(d.prepare("select status||'/'||reversal_state k, count(*) c from inter_branch_transactions group by 1").all().map((r) => [r.k, r.c])),
  };
  d.close();
  return snap;
}
export function delta(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before.bal), ...Object.keys(after.bal)])) {
    const dv = (after.bal[k] ?? 0) - (before.bal[k] ?? 0);
    if (dv !== 0) out[k] = dv;
  }
  return out;
}
export const sameDelta = (a, b) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).filter((k) => b[k] !== 0).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
/** Satu pemeriksaan dari DB: jurnal terkait transaksi (jumlah, seimbang per jurnal dalam sen, status, tanggal/periode). */
export function txJournals(txId) {
  const d = ro();
  const js = d.prepare(`select j.id, j.reference_no ref, j.status, j.branch_id, j.entry_date, j.period_id, j.inter_branch_leg leg, j.inter_branch_side side,
      (select sum(cast(round(debit*100) as integer)) from journal_entry_lines where journal_entry_id=j.id) dr,
      (select sum(cast(round(credit*100) as integer)) from journal_entry_lines where journal_entry_id=j.id) cr
    from journal_entries j where j.inter_branch_transaction_id = ? order by j.created_at`).all(txId);
  d.close();
  return js;
}
export function txRow(txId) {
  const d = ro();
  const r = d.prepare("select * from inter_branch_transactions where id = ?").get(txId);
  d.close();
  return r;
}
export function auditActions(txId) {
  const d = ro();
  const rows = d.prepare("select action, actor_label, after_json, reason from company_audit_log where entity_id = ? order by created_at, rowid").all(txId);
  d.close();
  return rows;
}
export const dbOne = (sql, ...args) => { const d = ro(); const r = d.prepare(sql).get(...args); d.close(); return r; };
export const dbAll = (sql, ...args) => { const d = ro(); const r = d.prepare(sql).all(...args); d.close(); return r; };

// ---------------------------------------------------------------- pencatatan hasil
export const results = [];
export function record(id, scenario, status, detail = "") {
  results.push({ id, scenario, status, detail });
  console.log(`${status} ${id} ${scenario}${detail ? " | " + detail : ""}`);
}
/** Kumpulkan beberapa pemeriksaan untuk satu skenario; gagal bila ada satu saja yang salah. */
export class Scenario {
  constructor(id, name) { this.id = id; this.name = name; this.checks = []; }
  ok(label, cond, detail = "") { this.checks.push({ label, pass: Boolean(cond), detail }); return Boolean(cond); }
  done() {
    const failed = this.checks.filter((c) => !c.pass);
    record(this.id, this.name, failed.length ? "FAIL" : "PASS", failed.length ? failed.map((c) => `${c.label}${c.detail ? " [" + c.detail + "]" : ""}`).join("; ") : `${this.checks.length} pemeriksaan`);
    return failed.length === 0;
  }
}
export function saveResults(name) {
  fs.writeFileSync(`${WORK}/${name}.json`, JSON.stringify(results, null, 1));
}
