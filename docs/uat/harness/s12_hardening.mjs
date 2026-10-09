// Verifikasi HTTP security hardening: UAT-006 brute force, UAT-007 audit, UAT-008 CORS, UAT-009 avatar, UAT-010 rate limit.
import fs from "node:fs";
import { A, S, DATA, BASE, Client, rec, note, Database, sleep, startServer, stopServer, waitHealthy } from "./lib.mjs";

const t = (id, area, name, cond, detail = "", sev = "MEDIUM") => rec(id, area, name, cond, detail, sev);
const OWNER = ["owner@terra-nusantara.test", "Uat#Owner2026"];
const STAFF = ["staf@terra-nusantara.test", "Uat#Pass2026"];
const VIEWER = ["viewer@terra-nusantara.test", "Uat#Pass2026"];
const ADMINU = ["admin@terra-nusantara.test", "Uat#Pass2026"];
const masterDbRO = () => new Database(`${DATA}/terra-finance.sqlite`, { readonly: true });
const rawPost = (path, body, headers = {}) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

// ============ UAT-006 brute force
{
  const c = new Client("bf");
  const bad = [];
  for (let i = 0; i < 6; i++) bad.push((await c.post("/api/auth/login", { email: STAFF[0], password: "Salah#Pass" + i + "xx" }, { noRetry: true, noLimit: true })).status);
  t("BF-1", "UAT-006", "password salah 1-5x -> 401 generik, percobaan ke-6 -> 429", bad.slice(0, 5).every((s) => s === 401) && bad[5] === 429, `statuses=${bad.join(",")}`, "MEDIUM");
  const ok = await c.post("/api/auth/login", { email: STAFF[0], password: STAFF[1] }, { noRetry: true, noLimit: true });
  t("BF-2", "UAT-006", "password BENAR saat akun sedang diblokir tetap ditolak (429, bukan oracle)", ok.status === 429, `status ${ok.status}; Retry-After=${ok.headers.get("retry-after")}`, "MEDIUM");
  const r1 = await c.post("/api/auth/login", { email: STAFF[0], password: "x" + "Salah#Pass1" }, { noRetry: true, noLimit: true });
  const ghost = await c.post("/api/auth/login", { email: "tidak.ada@terra-nusantara.test", password: "x" + "Salah#Pass1" }, { noRetry: true, noLimit: true });
  const gh = [];
  for (let i = 0; i < 6; i++) gh.push((await c.post("/api/auth/login", { email: "tidak.ada@terra-nusantara.test", password: "Salah#Pass" + i }, { noRetry: true, noLimit: true })));
  t("BF-3", "UAT-006", "username tidak ada diperlakukan identik (401 lalu 429) -- tidak membocorkan keberadaan akun", gh[0].status === 401 && gh[5].status === 429 && r1.status === 429 && gh[5].text === r1.text, `ghost=${gh.map((g) => g.status).join(",")} pesan429 sama=${gh[5].text === r1.text}`, "MEDIUM");
  const other = new Client("other"); const lo = await other.post("/api/auth/login", { email: OWNER[0], password: OWNER[1] }, { noRetry: true, noLimit: true });
  t("BF-4", "UAT-006", "user lain (identifier berbeda) tetap bisa login saat akun staf diblokir", lo.status === 200, `status ${lo.status}`, "HIGH");
  // restart server -> tidak ada kunci permanen
  await stopServer(false); await sleep(1500); startServer("hardening-restart"); const up = await waitHealthy();
  const c2 = new Client("after"); const rr = await c2.post("/api/auth/login", { email: STAFF[0], password: STAFF[1] }, { noRetry: true, noLimit: true });
  t("BF-5", "UAT-006", "setelah server restart akun yang tadi diblokir bisa login (blokir sementara, tidak permanen)", up && rr.status === 200, `healthy=${up} status ${rr.status}`, "HIGH");
  // false positive: salah ketik 3x lalu benar, dua kali
  const fp = new Client("fp"); let fpOk = true;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 3; i++) await fp.post("/api/auth/login", { email: VIEWER[0], password: "Salah#Typo" + i }, { noRetry: true, noLimit: true });
    const s = await fp.post("/api/auth/login", { email: VIEWER[0], password: VIEWER[1] }, { noRetry: true, noLimit: true }); if (s.status !== 200) fpOk = false;
  }
  t("BF-6", "UAT-006", "login normal (3x salah ketik lalu benar, 2 putaran) tidak terkena false positive", fpOk, "", "HIGH");
}

// ============ UAT-007 audit
{
  const owner = new Client("own"); await owner.login(...OWNER);
  const adm = new Client("adm"); await adm.login(...ADMINU);
  const ev = await owner.get("/api/auth/audit?limit=300");
  const events = ev.json?.events ?? [];
  const actions = new Set(events.map((e) => e.action));
  t("AUD-1", "UAT-007", "audit mencatat LOGIN_SUCCESS dan LOGIN_FAILED (OWNER dapat membaca, ber-status 200)", ev.status === 200 && actions.has("auth.login_success") && actions.has("auth.login_failed"), `status ${ev.status} actions=${[...actions].join(",")}`, "MEDIUM");
  const failed = events.filter((e) => e.action === "auth.login_failed");
  t("AUD-2", "UAT-007", "event gagal berisi reason, ip, success=false; ada kategori THROTTLED dan INVALID_CREDENTIALS", failed.some((e) => e.detail?.reason === "THROTTLED") && failed.some((e) => e.detail?.reason === "INVALID_CREDENTIALS") && failed.every((e) => e.detail?.success === false && "ip" in e.detail), `n=${failed.length}`, "MEDIUM");
  const dumpAll = JSON.stringify(events);
  const leaked = ["Salah#Pass", "Salah#Typo", STAFF[1], OWNER[1], "konsultan_session", "password_hash", "token_hash"].filter((s) => dumpAll.includes(s));
  t("AUD-3", "UAT-007", "tidak ada password/token/secret di audit (API)", leaked.length === 0, leaked.join(","), "HIGH");
  { const d = masterDbRO(); const rows = JSON.stringify(d.prepare("select * from audit_log where action like 'auth.%'").all()); d.close();
    const l2 = ["Salah#Pass", "Salah#Typo", STAFF[1], OWNER[1], "konsultan_session"].filter((s) => rows.includes(s));
    t("AUD-3b", "UAT-007", "tidak ada password/token/secret di tabel audit_log (inspeksi langsung)", l2.length === 0, l2.join(","), "HIGH"); }
  // logout dicatat
  const lc = new Client("lo"); await lc.login(...VIEWER); const lo = await lc.post("/api/auth/logout"); const ev2 = (await owner.get("/api/auth/audit?limit=100")).json.events;
  t("AUD-4", "UAT-007", "LOGOUT tercatat", lo.status === 200 && ev2.some((e) => e.action === "auth.logout" && e.identifier === VIEWER[0]), "", "MEDIUM");
  // session expired (idle 16 menit) via manipulasi sesi di DB scratch
  const evBefore = (await owner.get("/api/auth/audit?limit=500")).json.events.filter((e) => e.action === "auth.session_expired" && e.identifier === VIEWER[0]).length;
  const ic = new Client("idle"); await ic.login(...VIEWER);
  { const { Database: D } = await import("./lib.mjs"); const w = new D(`${DATA}/terra-finance.sqlite`); const old = new Date(Date.now() - 16 * 60000).toISOString();
    w.prepare("update sessions set last_activity_at=? where user_id=(select id from users where email=?)").run(old, VIEWER[0]); w.close(); }
  const me1 = await ic.get("/api/auth/me"); const me2 = await ic.get("/api/auth/me");
  const ev3all = (await owner.get("/api/auth/audit?limit=500")).json.events.filter((e) => e.action === "auth.session_expired" && e.identifier === VIEWER[0]); const ev3 = ev3all.slice(0, ev3all.length - evBefore);
  t("AUD-5", "UAT-007", "sesi idle >15 menit -> 401 dan SESSION_EXPIRED tercatat tepat sekali (reason IDLE_TIMEOUT)", me1.status === 401 && me2.status === 401 && ev3.length === 1 && ev3[0].detail.reason === "IDLE_TIMEOUT", `me=${me1.status}/${me2.status} new events=${ev3.length} (before=${evBefore})`, "MEDIUM");
  // hak akses audit
  const vw = new Client("vw"); await vw.login(...VIEWER); const sf = new Client("sf"); await sf.login(...STAFF);
  const ar = await vw.get("/api/auth/audit"); t("AUD-6", "UAT-007", "pembacaan audit auth hanya admin sistem: VIEWER/STAFF ditolak, anonim 401", ar.status === 403 && (await sf.get("/api/auth/audit")).status === 403 && (await new Client("an").get("/api/auth/audit")).status === 401, `viewer=${ar.status}`, "HIGH");
  const writes = []; for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { writes.push((await owner.req(m, "/api/auth/audit", { body: m === "DELETE" ? undefined : {} })).status); }
  t("AUD-7", "UAT-007", "tidak ada endpoint ubah/hapus audit (404/405) -- bahkan untuk OWNER/admin", writes.every((s) => s === 404 || s === 405), writes.join(","), "HIGH");
  // trigger DB
  { const w = new Database(`${DATA}/terra-finance.sqlite`); let e1 = "", e2 = "";
    try { w.prepare("update audit_log set action='x' where action like 'auth.%'").run(); } catch (e) { e1 = e.message; }
    try { w.prepare("delete from audit_log where action like 'auth.%'").run(); } catch (e) { e2 = e.message; }
    w.close(); t("AUD-8", "UAT-007", "UPDATE/DELETE audit_log ditolak trigger database (append-only)", /append-only/.test(e1) && /append-only/.test(e2), `${e1.slice(0, 60)} | ${e2.slice(0, 60)}`, "HIGH"); }
}

// ============ UAT-008 CORS
{
  const o = new Client("cors"); await o.login(...OWNER);
  const tryOrigin = async (origin, extra = {}) => { const h = { Cookie: o.cookie, ...(origin === undefined ? {} : { Origin: origin }), ...extra }; const r = await fetch(`${BASE}/api/auth/me`, { headers: h }); return { s: r.status, acao: r.headers.get("access-control-allow-origin"), acac: r.headers.get("access-control-allow-credentials"), body: await r.text() }; };
  const none = await tryOrigin(undefined); t("CORS-1", "UAT-008", "tanpa header Origin (same-origin/non-browser): 200 tanpa header CORS", none.s === 200 && !none.acao, `s=${none.s} acao=${none.acao}`, "MEDIUM");
  const self = await tryOrigin(BASE); t("CORS-2", "UAT-008", "origin aplikasi sendiri (http://127.0.0.1:4500) diterima, dipantulkan persis, bukan *", self.s === 200 && self.acao === BASE && self.acao !== "*", `s=${self.s} acao=${self.acao}`, "HIGH");
  const bad = [];
  for (const origin of ["http://evil.example", "https://evil.example", "null", "not a url", "javascript:alert(1)", "http://localhost", "http://127.0.0.1", "http://localhost:9999", "http://127.0.0.1:4500.evil.io", "file://"]) {
    const r = await tryOrigin(origin); if (r.s !== 403 || r.acao || r.acac || r.body.includes("user")) bad.push(`${origin}=>${r.s}/${r.acao}`);
  }
  t("CORS-3", "UAT-008", "origin sembarang, null, malformed, localhost/127.0.0.1 tanpa port, port lain: 403, tanpa header CORS, tanpa data user", bad.length === 0, bad.join("; "), "HIGH");
  const pre = await fetch(`${BASE}/api/auth/me`, { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
  t("CORS-4", "UAT-008", "preflight dari origin asing tidak memperoleh izin", !pre.headers.get("access-control-allow-origin"), `status ${pre.status}`, "MEDIUM");
  const mut = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { Cookie: o.cookie, Origin: "http://evil.example" } });
  const still = await o.get("/api/auth/me"); t("CORS-5", "UAT-008", "POST lintas-origin (CSRF) ditolak dan sesi korban tetap hidup", mut.status === 403 && still.status === 200, `logout=${mut.status} me=${still.status}`, "HIGH");
  const html = await fetch(`${BASE}/`, { headers: { Origin: "http://evil.example" } }); t("CORS-6", "UAT-008", "aset SPA (non-API) tetap dilayani normal", html.status === 200, `status ${html.status}`, "HIGH");
}

// ============ UAT-009 avatar
{
  const u = new Client("av"); await u.login(...OWNER);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
  const up = (buf, name, type) => { const fd = new FormData(); fd.append("file", new Blob([buf], { type }), name); return u.req("POST", "/api/auth/me/avatar", { form: fd }); };
  const rej = [];
  const cases = [["a.svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")], ["a.html", "text/html", Buffer.from("<html><script>alert(1)</script></html>")], ["a.js", "application/javascript", Buffer.from("alert(1)")], ["a.php", "application/x-php", Buffer.from("<?php system($_GET[1]); ?>")], ["a.exe", "application/x-msdownload", Buffer.from("MZ\x90\x00\x03")], ["a.png", "image/png", Buffer.from("<svg onload=alert(1)></svg>")], ["a.png", "image/png", Buffer.from("<html><script>x</script></html>")], ["a.svg", "image/png", png], ["a.png.exe", "image/png", png], ["avatar", "image/png", png], ["a.png", "image/svg+xml", png], ["a.png", "image/png", Buffer.concat([png, Buffer.from("<script>alert(1)</script>")])], ["besar.png", "image/png", Buffer.concat([png, Buffer.alloc(600 * 1024, 1)])]];
  for (const [n, ty, b] of cases) { const r = await up(b, n, ty); if (r.status !== 400 && r.status !== 413) rej.push(`${n}/${ty}=>${r.status}`); }
  const me0 = await u.get("/api/auth/me");
  t("AV-1", "UAT-009", "SVG, HTML, JS, PHP, EXE, penyamaran (ekstensi/MIME/magic bytes tidak sepakat), polyglot, >500KB: semua ditolak (400/413)", rej.length === 0, rej.join("; "), "MEDIUM");
  t("AV-2", "UAT-009", "setelah semua penolakan avatar user tidak berubah/berisi konten berbahaya", !String(me0.json?.user?.avatarUrl ?? "").includes("svg"), "", "HIGH");
  const ok = await up(png, "a.png", "image/png"); const me = await u.get("/api/auth/me");
  t("AV-3", "UAT-009", "PNG valid diterima dan tersimpan sebagai data:image/png", ok.status === 200 && String(me.json?.user?.avatarUrl).startsWith("data:image/png;base64,"), `status ${ok.status}`, "MEDIUM");
  await u.del("/api/auth/me/avatar");
}

// ============ UAT-010 rate limit
{
  const c = new Client("rl"); await c.login(...OWNER);
  let statics = 0, static429 = 0, health429 = 0;
  const idx = await (await fetch(`${BASE}/`)).text(); const asset = (/\/assets\/[^"']+\.js/.exec(idx) ?? ["/index.html"])[0];
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) { const r = await fetch(BASE + asset); statics++; if (r.status === 429) static429++; const h = await fetch(`${BASE}/api/health`); if (h.status === 429) health429++; }
  t("RL-1", "UAT-010", `400x aset SPA + 400x /api/health dalam ${Math.round((Date.now() - t0) / 1000)} dtk tidak pernah 429`, static429 === 0 && health429 === 0, `static429=${static429} health429=${health429}`, "HIGH");
  let read429 = 0; for (let i = 0; i < 450; i++) { const r = await c.get("/api/auth/me", { noLimit: true, noRetry: true }); if (r.status === 429) read429++; }
  t("RL-2", "UAT-010", "450 GET API beruntun (simulasi navigasi sangat cepat) tidak kena 429", read429 === 0, `read429=${read429}`, "HIGH");
  let mut429 = 0, first429 = -1; for (let i = 0; i < 140; i++) { const r = await c.post(`${A()}/journal`, { x: 1 }, { noLimit: true, noRetry: true }); if (r.status === 429) { mut429++; if (first429 < 0) first429 = i; } }
  t("RL-3", "UAT-010", "mutasi tetap dibatasi (429 setelah ~120/menit) -- proteksi tidak dihapus", mut429 > 0 && first429 >= 100, `first429 pada ke-${first429}, total ${mut429}`, "MEDIUM");
  const readAfter = await c.get("/api/auth/me", { noLimit: true, noRetry: true }); t("RL-4", "UAT-010", "saat jatah mutasi habis, baca (GET) tetap berjalan -- bucket terpisah", readAfter.status === 200, `status ${readAfter.status}`, "HIGH");
  const r429 = await c.post(`${A()}/journal`, { x: 1 }, { noLimit: true, noRetry: true });
  t("RL-5", "UAT-010", "pesan 429 berbahasa Indonesia dan ada Retry-After", r429.status === 429 && /Terlalu banyak permintaan/.test(r429.text) && r429.headers.get("retry-after") !== null, r429.text.slice(0, 120), "LOW");
}
console.log("DONE s12");
