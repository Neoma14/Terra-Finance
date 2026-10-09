// Harness UAT TERRA FINANCE. Semua dijalankan terhadap server UAT terisolasi (port 4500, data scratch).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";

export const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad/uat5";
export const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
export const PORT = 4500;
export const BASE = `http://127.0.0.1:${PORT}`;
export const DATA = `${S}/data`;
export const EXE = `${S}/ex1/TERRA FINANCE.exe`;
export const SERVER_JS = `${S}/ex1/resources/api/dist/server.js`;
export const req = createRequire(`${ROOT}/apps/api/package.json`);
export const ExcelJS = req("exceljs");
export const Database = req("better-sqlite3");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- hasil uji ----------
const RESULTS = `${S}/results.jsonl`;
export function rec(id, area, name, pass, detail = "", severity = "") {
  const row = { id, area, name, pass: Boolean(pass), detail: String(detail).slice(0, 400), severity: pass ? "" : severity || "MEDIUM", t: new Date().toISOString() };
  fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  console.log((pass ? "PASS " : "FAIL ") + `[${id}] ${name}` + (detail ? " | " + String(detail).slice(0, 160) : "") + (pass ? "" : ` <<${row.severity}>>`));
  return pass;
}
export function note(id, area, name, detail, severity = "INFO") {
  fs.appendFileSync(RESULTS, JSON.stringify({ id, area, name, pass: null, detail: String(detail).slice(0, 600), severity, t: new Date().toISOString() }) + "\n");
  console.log(`NOTE [${id}] ${name} | ${String(detail).slice(0, 200)}`);
}
const PERF = `${S}/perf.jsonl`;
export async function timed(label, fn) {
  const t0 = performance.now(); const res = await fn(); const ms = Math.round(performance.now() - t0);
  fs.appendFileSync(PERF, JSON.stringify({ label, ms }) + "\n"); return { ms, res };
}

// ---------- rate limiter adaptif (server membatasi 200 req/menit) ----------
const rl = { remaining: 200, resetAt: 0 };
async function throttle() { if (rl.remaining <= 3 && Date.now() < rl.resetAt) await sleep(rl.resetAt - Date.now() + 300); }
export class Client {
  constructor(name) { this.name = name; this.cookie = ""; }
  async req(method, p, o = {}) {
    if (!o.noLimit) await throttle();
    const headers = { ...(o.headers ?? {}) };
    if (this.cookie && !o.noCookie) headers.Cookie = this.cookie;
    if (o.cookie) headers.Cookie = o.cookie;
    let body = o.form ?? undefined;
    if (o.body !== undefined) { body = typeof o.body === "string" ? o.body : JSON.stringify(o.body); if (!headers["Content-Type"]) headers["Content-Type"] = "application/json"; }
    const r = await fetch(BASE + p, { method, headers, body, redirect: "manual" });
    const rem = r.headers.get("x-ratelimit-remaining"), rst = r.headers.get("x-ratelimit-reset");
    if (rem !== null) { rl.remaining = Number(rem); rl.resetAt = Date.now() + Number(rst ?? 60) * 1000; }
    const sc = r.headers.get("set-cookie"); if (sc && !o.noStore) this.cookie = sc.split(";")[0];
    if (o.raw) { return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers }; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    if (r.status === 429 && !o.noRetry && !o.noLimit && p !== "/api/auth/login") { await sleep(15000); return this.req(method, p, o); }
    return { status: r.status, json, text, headers: r.headers };
  }
  get(p, o) { return this.req("GET", p, o); }
  post(p, body, o = {}) { return this.req("POST", p, { ...o, body: body ?? undefined }); }
  put(p, body, o = {}) { return this.req("PUT", p, { ...o, body }); }
  patch(p, body, o = {}) { return this.req("PATCH", p, { ...o, body }); }
  del(p, o) { return this.req("DELETE", p, o); }
  async login(email, password) { const r = await this.post("/api/auth/login", { email, password }); return r; }
  async upload(p, filename, buf, extra = {}) {
    const fd = new FormData(); fd.append("file", new Blob([buf]), filename);
    return this.req("POST", p, { form: fd, ...extra });
  }
}

// ---------- server ----------
let srv = null;
export function startServer(tag = "run", extraEnv = {}) {
  const env = { ...process.env, NODE_ENV: "production", PORT: String(PORT), DB_FILE_PATH: `${DATA}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${DATA}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${DATA}/companies`, STATIC_WEB_DIR: `${S}/ex1/resources/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("uat5-secret").digest("hex"), ELECTRON_RUN_AS_NODE: "1", ...extraEnv };
  const log = fs.openSync(`${S}/server-${tag}.log`, "a");
  srv = spawn(EXE, [SERVER_JS], { env, stdio: ["ignore", log, log], detached: true }); srv.unref();
  fs.writeFileSync(`${S}/server.pid`, String(srv.pid));
  return srv;
}
export async function waitHealthy(ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {} await sleep(400); } return false; }
export async function stopServer(hard = false) {
  const pid = srv?.pid ?? Number(fs.existsSync(`${S}/server.pid`) ? fs.readFileSync(`${S}/server.pid`, "utf8") : 0);
  if (pid) { try { process.kill(pid, hard ? "SIGKILL" : "SIGTERM"); } catch {} }
  await sleep(2500);
}

// ---------- util ----------
export const state = () => JSON.parse(fs.readFileSync(`${S}/state.json`, "utf8"));
export const saveState = (patch) => { const cur = fs.existsSync(`${S}/state.json`) ? state() : {}; fs.writeFileSync(`${S}/state.json`, JSON.stringify({ ...cur, ...patch }, null, 1)); };
export const A = (slug = "pt-terra-nusantara") => `/api/company-db/${slug}`;
export function dbA(readonly = true) { return new Database(`${DATA}/companies/pt-terra-nusantara/company.db`, { readonly }); }
export const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
export const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// PRNG deterministik
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

