// Pustaka UAT bisnis terkontrol (Phase 5 + Antar Cabang): lingkungan terisolasi, klien HTTP per persona, verifikasi independen dari DB.
// SEMUA terhadap folder kerja UAT (data/, bukan port 4000 aplikasi nyata, bukan %APPDATA%). Jangan diarahkan ke data pengguna nyata.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORK = path.resolve(process.argv[2] ?? ".");
export const DATA = `${WORK}/data`;
export const SLUG = "pt-uji-bisnis"; // perusahaan uji MULTI-CABANG
export const SLUG_OFF = "pt-uji-satu-cabang"; // perusahaan uji terpisah, multi-cabang TIDAK pernah dinyalakan
export const COMPANY_DB = (slug = SLUG) => `${DATA}/companies/${slug}/company.db`;
export const PORT = 4536;
const req = createRequire(`${ROOT}/apps/api/package.json`);
export const Database = req("better-sqlite3");
export const ExcelJS = req("exceljs");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => crypto.randomUUID();
export const dist = (p) => import(pathToFileURL(`${ROOT}/apps/api/dist/${p}`).href);
export const personasFile = `${WORK}/personas.json`;
export const loadPersonas = () => JSON.parse(fs.readFileSync(personasFile, "utf8"));

export function serverEnv(port = PORT, offsetDays = 0) {
  return {
    ...process.env, NODE_ENV: "production", PORT: String(port), UAT_CLOCK_OFFSET_DAYS: String(offsetDays),
    DB_FILE_PATH: `${DATA}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${DATA}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${DATA}/companies`,
    STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("uat-bisnis").digest("hex"),
  };
}
export async function startServer(port = PORT, offsetDays = 0, tag = "srv") {
  const env = serverEnv(port, offsetDays);
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(`${WORK}/${tag}-${port}.log`, "a");
  const args = offsetDays ? ["--import", pathToFileURL(`${ROOT}/scripts/inter-branch-uat/clock.mjs`).href] : [];
  const child = spawn(process.execPath, [...args, `${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base, stop: async () => { child.kill(); await sleep(1500); } }; } catch { /* belum siap */ }
    await sleep(400);
  }
  child.kill();
  throw new Error(`server uji port ${port} tidak sehat`);
}

export class Client {
  constructor(base, token, label) { this.base = base; this.cookie = token ? `konsultan_session=${token}` : ""; this.label = label; this.branch = null; this.rate429 = 0; }
  async req(method, p, { body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.branch && !h["x-branch-context"]) h["x-branch-context"] = this.branch;
    if (body !== undefined) h["Content-Type"] = "application/json";
    let r, buf;
    for (let attempt = 0; attempt < 5; attempt++) {
      r = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      buf = Buffer.from(await r.arrayBuffer());
      if (r.status !== 429) break;
      this.rate429++;
      await sleep((Number(r.headers.get("retry-after") ?? 5) + 1) * 1000);
    }
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    if (raw) return { status: r.status, headers: r.headers, buf };
    const text = buf.toString("utf8");
    let json = null; try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { status: r.status, json, text };
  }
  get(p, o) { return this.req("GET", p, o); }
  post(p, body, o = {}) { return this.req("POST", p, { ...o, body }); }
  put(p, body, o = {}) { return this.req("PUT", p, { ...o, body }); }
  del(p, body, o = {}) { return this.req("DELETE", p, { ...o, body }); }
}

// ---------------------------------------------------------------- akses DB baca-saja (verifikasi independen)
export const ro = (file = COMPANY_DB()) => new Database(file, { readonly: true });
export const dbAll = (sql, ...args) => { const d = ro(); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
export const dbOne = (sql, ...args) => { const d = ro(); try { return d.prepare(sql).get(...args); } finally { d.close(); } };
export const cents = (v) => Math.round(Number(v) * 100);

/** Saldo bersih (sen, debit - kredit) per akun x cabang dari jurnal efektif (POSTED/REVERSED): sumber kebenaran independen. */
export function netByAccountBranch(file = COMPANY_DB()) {
  const d = ro(file);
  try {
    const out = {};
    for (const r of d.prepare(`select l.account_id a, j.branch_id b, sum(cast(round(l.debit*100) as integer)) - sum(cast(round(l.credit*100) as integer)) v
      from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.status in ('POSTED','REVERSED') group by 1,2`).all()) out[`${r.a}|${r.b}`] = r.v;
    return out;
  } finally { d.close(); }
}

// ---------------------------------------------------------------- hasil
export const results = [];
export function record(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  console.log(`${status} ${id} ${name}${detail ? " | " + detail : ""}`);
}
export class Check {
  constructor(id, name) { this.id = id; this.name = name; this.items = []; }
  ok(label, cond, detail = "") { this.items.push({ label, pass: Boolean(cond), detail: String(detail ?? "") }); return Boolean(cond); }
  done() {
    const bad = this.items.filter((i) => !i.pass);
    record(this.id, this.name, bad.length ? "FAIL" : "PASS", bad.length ? bad.map((b) => `${b.label}${b.detail ? " [" + b.detail.slice(0, 160) + "]" : ""}`).join("; ") : `${this.items.length} pemeriksaan`);
    return !bad.length;
  }
}
export async function run(id, name, fn) {
  const c = new Check(id, name);
  try { await fn(c); c.done(); } catch (e) { record(id, name, "SCRIPT-ERROR", String(e?.stack ?? e).split("\n").slice(0, 3).join(" / ")); }
}
export const saveResults = (name) => fs.writeFileSync(`${WORK}/${name}.json`, JSON.stringify(results, null, 1));

// ---------------------------------------------------------------- ekstraksi teks PDF (pdfkit; stream Flate) dan sel XLSX
export function pdfText(buf) {
  const raw = buf.toString("latin1");
  const parts = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body = Buffer.from(m[1], "latin1");
    try { body = zlib.inflateSync(body); } catch { /* bukan Flate */ }
    const text = body.toString("latin1");
    for (const tj of text.matchAll(/\[([^\]]*)\]\s*TJ/g)) parts.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
  }
  return parts.join("\n");
}
export async function xlsxCells(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const rows = [];
  wb.worksheets[0].eachRow((row) => rows.push(row.values.slice(1)));
  return rows;
}
