import fs from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { S, DATA, BASE, ROOT, PORT, Client, A, rec, note, state, saveState, dbA, Database, sleep, ExcelJS } from "./lib.mjs";
import { code } from "./gen.mjs";

const { accId, per, ids } = state();
const mk = async (e, p = "Uat#Pass2026") => { const c = new Client(e); const r = await c.login(e, p); if (r.status !== 200) throw new Error("login " + e + " " + r.status); return c; };
const owner = await mk("owner@terra-nusantara.test", "Uat#Owner2026"), admin = await mk("admin@terra-nusantara.test"), acct = await mk("akuntan@terra-nusantara.test"), viewer = await mk("viewer@terra-nusantara.test"), pen = await mk("penyusup@pembanding.test");
const anon = new Client("anon");
const t = (id, area, name, cond, detail = "", sev = "HIGH") => rec(id, area, name, cond, detail, sev);
const st = (r) => `status ${r.status}${r.json?.error ? " " + String(r.json.error).slice(0, 80) : ""}`;
const rawGet = (p, headers = {}) => new Promise((res) => { const rq = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET", headers }, (r) => { const ch = []; r.on("data", (c) => ch.push(c)); r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(ch).toString("latin1") })); }); rq.on("error", (e) => res({ status: 0, headers: {}, body: String(e) })); rq.end(); });

// ===== path traversal pada file statis
{
  const bad = []; const paths = ["/../../../../../../Windows/win.ini", "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini", "/..%5c..%5c..%5cWindows%5cwin.ini", "/assets/../../package.json", "/assets/..%2f..%2f..%2fpackage.json", "/%252e%252e/%252e%252e/Windows/win.ini", "/index.html%00.js", "/.env", "/server.js", "/package.json", "/../api/dist/server.js", "/assets/", "/..", "/api/../../Windows/win.ini"];
  for (const p of paths) { const r = await rawGet(p); const leaked = /\[fonts\]|\[extensions\]|"dependencies"|require\(|SESSION_SECRET|process\.env/.test(r.body); const isHtmlShell = r.body.includes("<div id=\"root\">") || r.body.includes("<!doctype html") || r.body.includes("<!DOCTYPE html"); if (leaked) bad.push(`${p} -> berisi data sensitif (${r.status})`); else if (r.status === 200 && !isHtmlShell && p !== "/") bad.push(`${p} -> 200 non-HTML`); }
  t("PT-static", "path-traversal", `${paths.length} pola traversal ke file statis (../, %2e%2e, %5c, %00, ganda-encode): tidak ada file di luar web dist yang terbaca`, bad.length === 0, bad.join("; "), "CRITICAL");
  const r = await rawGet("/assets/"); note("PT-listing", "path-traversal", "listing direktori /assets/", `status ${r.status}`);
  const api = await rawGet("/api/company-db/..%2f..%2fhealth"); t("PT-api", "path-traversal", "traversal di path API ditangani (tidak 5xx)", api.status < 500, `status ${api.status}`, "MEDIUM");
}
// ===== header keamanan & CORS
{
  const r = await rawGet("/"); const h = r.headers; const miss = ["x-content-type-options", "content-security-policy", "x-frame-options", "referrer-policy"].filter((k) => !h[k]);
  note("HDR-missing", "headers", "header keamanan HTTP yang tidak dikirim server", miss.join(", ") || "lengkap", miss.length ? "LOW" : "INFO");
  rec("HDR-clickjack", "headers", "halaman bisa di-iframe (tanpa X-Frame-Options/CSP frame-ancestors)", !!h["x-frame-options"] || /frame-ancestors/.test(h["content-security-policy"] ?? ""), "tanpa perlindungan clickjacking (aplikasi desktop lokal; risiko rendah)", "LOW");
  const cors = await rawGet("/api/health", { Origin: "http://evil.example" }); const acao = cors.headers["access-control-allow-origin"], acac = cors.headers["access-control-allow-credentials"];
  rec("CORS-reflect", "headers", "CORS tidak memantulkan origin sembarang dengan credentials", !(acao === "http://evil.example" && acac === "true"), `ACAO=${acao} ACAC=${acac} (cookie SameSite=Lax membatasi dampak lintas-situs, tetapi kebijakan terlalu longgar)`, "MEDIUM");
  const pre = await new Promise((res) => { const rq = http.request({ host: "127.0.0.1", port: PORT, path: `/api/company-db/pt-terra-nusantara/journal`, method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } }, (x) => { x.resume(); x.on("end", () => res({ s: x.statusCode, h: x.headers })); }); rq.end(); });
  note("CORS-preflight", "headers", "preflight dari origin asing", `status ${pre.s} ACAO=${pre.h["access-control-allow-origin"]} methods=${pre.h["access-control-allow-methods"]}`);
  // CSRF: POST lintas-situs memakai Content-Type form (tanpa JSON)
  const csrf = await owner.req("POST", `${A()}/journal-settings`, { body: "maxBackdateDays=1", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://evil.example" } }); t("CSRF-form", "csrf", "POST mengubah data dengan form-urlencoded dari origin asing ditolak", csrf.status >= 400, st(csrf), "HIGH");
  const csrf2 = await owner.req("POST", `${A()}/profile`, { body: "name=x", headers: { "Content-Type": "text/plain", Origin: "http://evil.example" } }); t("CSRF-text", "csrf", "text/plain dari origin asing ditolak", csrf2.status >= 400, st(csrf2), "HIGH");
}
// ===== upload avatar
{
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const up = (buf, name, type) => { const fd = new FormData(); fd.append("file", new Blob([buf], { type }), name); return viewer.req("POST", "/api/auth/me/avatar", { form: fd }); };
  let r = await up(png, "a.png", "image/png"); t("UP-png", "upload", "avatar PNG valid diterima", r.status === 200, st(r), "LOW");
  r = await up(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), "x.svg", "image/svg+xml"); t("UP-svg", "upload", "avatar SVG (bisa memuat script) ditolak", r.status === 400, st(r), "HIGH");
  r = await up(Buffer.from("<html><script>alert(1)</script></html>"), "x.png", "image/png"); t("UP-spoof", "upload", "file HTML bermasker image/png (isi bukan gambar) ditolak", r.status === 400, st(r), "HIGH");
  r = await up(Buffer.from("teks biasa"), "x.txt", "text/plain"); t("UP-text", "upload", "avatar bertipe text/plain ditolak", r.status === 400, st(r), "MEDIUM");
  r = await up(Buffer.alloc(8 * 1024 * 1024, 1), "besar.png", "image/png"); t("UP-big", "upload", "avatar 8 MB ditolak", r.status === 400 || r.status === 413, st(r), "MEDIUM");
  r = await up(png, "../../../evil.png", "image/png"); t("UP-name", "upload", "nama file traversal pada avatar tidak berbahaya", r.status < 500, st(r), "HIGH");
  await viewer.del("/api/auth/me/avatar");
  const wb = new ExcelJS.Workbook(); wb.addWorksheet("x").addRow(["a"]); const xl = Buffer.from(await wb.xlsx.writeBuffer());
  const zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(200, 0x41)]); r = await acct.upload(`${A()}/journal-import/preview`, "bom.xlsx", zip); t("UP-zipbomb-ish", "upload", "ZIP/XLSX rusak (header PK tapi isi sampah) tidak crash server (<500)", r.status < 500, st(r), "HIGH");
  const alive = await fetch(`${BASE}/api/health`).then((x) => x.ok).catch(() => false); t("UP-alive", "upload", "server tetap hidup setelah seluruh uji upload", alive, "", "CRITICAL");
  void xl;
}
// ===== rate limit / abuse (terbatas)
{
  let c429 = 0, ok = 0; const t0 = Date.now(); for (let i = 0; i < 230; i++) { const r = await anon.req("GET", "/api/health", { noLimit: true, noRetry: true }); if (r.status === 429) c429++; else ok++; }
  rec("RL-global", "abuse", "pembatas laju per kategori: 230 GET cepat (navigasi normal) TIDAK memicu 429 (baca 1200/menit; mutasi/auth dibatasi, diuji di s12)", c429 === 0, `${ok} OK, ${c429} x 429 dalam ${Date.now() - t0} ms`, "LOW");
  const ex = await anon.get(`/api/health`, { noLimit: true, noRetry: true }); note("RL-limit-body", "abuse", "respons saat dibatasi", `${ex.status} ${ex.text.slice(0, 80)}`);
  await sleep(63000);
  const rec2 = await anon.get("/api/health", { noLimit: true, noRetry: true }); t("RL-recover", "abuse", "layanan pulih setelah jendela 1 menit", rec2.status === 200, st(rec2), "MEDIUM");
  note("RL-scope", "abuse", "pembatas laju bersifat GLOBAL per IP dan menghitung berkas statis + semua API", "satu pengguna yang membuka beberapa halaman berat dapat memicu 'Rate limit exceeded' (dilaporkan juga di panduan). Tidak ada pembatas khusus untuk login (percobaan password) atau export.", "MEDIUM");
  // permintaan berat paralel (10 export PDF 5 tahun bersamaan) -> server tetap responsif
  const t1 = Date.now(); const rs = await Promise.all(Array.from({ length: 8 }, () => acct.get(`${A()}/reports/export/ledger?format=pdf&accountId=${accId[code.bca]}&fromDate=2021-01-01&toDate=2025-12-31`, { raw: true, noLimit: true })));
  const h = await fetch(`${BASE}/api/health`).then((x) => x.ok).catch(() => false); t("RL-heavy", "abuse", "8 export PDF Ledger 5 tahun paralel: semua 200/429 dan server tetap hidup", rs.every((x) => x.status === 200 || x.status === 429) && h, `${rs.map((x) => x.status).join(",")} dalam ${Date.now() - t1} ms`, "HIGH");
  await sleep(61000);
}
// ===== manajemen user & akses
{
  const al = await mk("owner@terra-nusantara.test", "Uat#Owner2026");
  let r = await al.post("/api/users", { email: "owner@terra-nusantara.test", password: "Uat#Pass2026", fullName: "Dup", role: "staff" }); t("US-dupemail", "users", "email user duplikat ditolak", r.status === 409 || r.status === 400, st(r), "MEDIUM");
  r = await al.post("/api/users", { email: "bukan-email", password: "Uat#Pass2026", fullName: "X", role: "staff" }); t("US-badmail", "users", "email tidak valid ditolak", r.status === 400, st(r), "MEDIUM");
  r = await al.post("/api/users", { email: "pendek@x.test", password: "123", fullName: "X", role: "staff" }); t("US-shortpw", "users", "password < 8 ditolak", r.status === 400, st(r), "MEDIUM");
  r = await al.post("/api/users", { email: "role@x.test", password: "Uat#Pass2026", fullName: "X", role: "superadmin" }); t("US-badrole", "users", "role aplikasi tidak valid ditolak", r.status === 400, st(r), "HIGH");
  r = await al.post("/api/users", { email: "xss@x.test", password: "Uat#Pass2026", fullName: "<img src=x onerror=alert(1)>Nama", role: "staff" }); t("US-xss-store", "users", "nama user berisi HTML disimpan (render aman di tahap browser)", r.status === 201, st(r), "LOW");
  r = await al.post("/api/users", { email: "weak@x.test", password: "aaaaaaaa", fullName: "Weak", role: "staff" }); note("US-weakpw", "users", "password lemah 'aaaaaaaa' diterima", st(r));
  // akses perusahaan
  r = await al.patch(`${A()}/access/${ids["viewer@terra-nusantara.test"]}`, { role: "SUPERUSER" }); t("AC-badrole", "access", "role perusahaan tidak valid ditolak", r.status === 400, st(r), "HIGH");
  r = await al.patch(`${A()}/access/${ids["viewer@terra-nusantara.test"]}/status`, { status: "SUSPENDED" }); t("AC-suspend", "access", "suspend akses", r.status === 200, st(r), "MEDIUM");
  const sus = await viewer.get(`${A()}/journals?pageSize=1`); t("AC-suspend-effect", "access", "user ter-suspend langsung kehilangan akses (404)", sus.status === 404, st(sus), "CRITICAL");
  r = await al.patch(`${A()}/access/${ids["viewer@terra-nusantara.test"]}/status`, { status: "ACTIVE" }); const back = await viewer.get(`${A()}/journals?pageSize=1`); t("AC-reactivate", "access", "aktifkan kembali memulihkan akses", back.status === 200, st(back), "MEDIUM");
  r = await al.del(`${A()}/access/${ids["viewer@terra-nusantara.test"]}`); const gone = await viewer.get(`${A()}/journals?pageSize=1`); t("AC-revoke", "access", "cabut akses -> user kehilangan akses", (r.status === 200 || r.status === 204) && gone.status === 404, `${st(r)} lalu ${gone.status}`, "CRITICAL");
  r = await al.post(`${A()}/access`, { userId: ids["viewer@terra-nusantara.test"], role: "VIEWER" }); t("AC-regrant", "access", "beri akses kembali", r.status === 201 || r.status === 200, st(r), "MEDIUM");
  const me = (await al.get("/api/auth/me")).json.user.id; r = await al.del(`${A()}/access/${me}`); t("AC-lastowner", "access", "OWNER terakhir tidak bisa dicabut sendiri", r.status === 409, st(r), "HIGH");
  r = await al.post(`${A()}/access`, { userId: "tidak-ada", role: "VIEWER" }); t("AC-nouser", "access", "beri akses ke user yang tidak ada ditolak (404)", r.status === 404, st(r), "MEDIUM");
}
// ===== lisensi & panel Administrator
{
  const key = fs.readFileSync(`${S}/uat.key`, "utf8").trim();
  const tok = execFileSync("node", [`${ROOT}/tools/license-generator/src/cli.mjs`, "admin-token", key], { env: { ...process.env, TERRA_VENDOR_DIR: S, TERRA_LICENSE_PRIVATE_KEY: "C:/Users/fachr/TERRA-VENDOR/license-private.pem", TERRA_LICENSE_PUBLIC_KEY: "C:/Users/fachr/TERRA-VENDOR/license-public.pem" } }).toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  const ad = new Client("adm");
  let r = await ad.post("/api/administrator/login", { licenseKey: key, token: "token-palsu" }); t("ADM-badtoken", "admin-panel", "token Administrator palsu ditolak", r.status === 401 || r.status === 403, st(r), "CRITICAL");
  r = await ad.post("/api/administrator/login", { licenseKey: key + "x", token: tok }); t("ADM-badkey", "admin-panel", "license key dimodifikasi + token asli ditolak", r.status === 401 || r.status === 403, st(r), "CRITICAL");
  r = await ad.post("/api/administrator/login", { licenseKey: "' OR 1=1 --", token: "' OR 1=1 --" }); t("ADM-sqli", "admin-panel", "login Administrator dengan payload SQLi ditolak", r.status === 400 || r.status === 401 || r.status === 403, st(r), "CRITICAL");
  r = await ad.get("/api/administrator/me"); t("ADM-noauth", "admin-panel", "endpoint Administrator tanpa login ditolak", r.status === 401 || r.status === 403, st(r), "CRITICAL");
  r = await owner.get("/api/administrator/diagnostics"); t("ADM-userasadmin", "admin-panel", "Owner aplikasi biasa TIDAK otomatis jadi Administrator (panel butuh token vendor)", r.status === 401 || r.status === 403, st(r), "HIGH");
  r = await ad.post("/api/administrator/login", { licenseKey: key, token: tok }); t("ADM-login", "admin-panel", "login Administrator dengan token vendor valid", r.status === 200, st(r), "MEDIUM");
  for (const [id, p] of [["me", "/api/administrator/me"], ["diag", "/api/administrator/diagnostics"], ["err", "/api/administrator/error-log"], ["dev", "/api/administrator/devices"]]) { const x = await ad.get(p); t("ADM-" + id, "admin-panel", `panel Administrator ${id} 200`, x.status === 200, st(x), "MEDIUM"); }
  const diag = (await ad.get("/api/administrator/diagnostics")).json; t("ADM-noleak", "admin-panel", "diagnostik tidak membocorkan secret/hash/private key", !/PRIVATE KEY|password_hash|SESSION_SECRET|\$argon/.test(JSON.stringify(diag)), "", "HIGH");
  r = await ad.post("/api/administrator/logout", {}); const after = await ad.get("/api/administrator/me"); t("ADM-logout", "admin-panel", "logout Administrator mencabut akses", after.status === 401 || after.status === 403, st(after), "HIGH");
  const ls = (await owner.get("/api/license/status")).json.license; t("LIC-active", "license", "lisensi UAT aktif (lifetime) & terikat perangkat", ls.status === "active" && ls.fingerprintMatches !== false, JSON.stringify({ s: ls.status, client: ls.clientName, expiry: ls.expiry ?? ls.expiresAt }).slice(0, 100), "HIGH");
  const m = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true }); const lrow = m.prepare("select * from license").get(); m.close();
  t("LIC-noprivate", "license", "tabel lisensi tidak menyimpan private key", !/PRIVATE/.test(JSON.stringify(lrow)), "", "CRITICAL");
  // lisensi rusak -> data ditolak, login tetap (diuji lalu dipulihkan di salinan DB UAT)
  const mw = new Database(`${DATA}/terra-finance.sqlite`); const orig = mw.prepare("select license_key k from license").get().k; mw.prepare("update license set license_key = ?").run(orig.slice(0, -6) + "AAAAAA"); mw.close();
  const lr = await owner.get(`${A()}/journals?pageSize=1`); const lg = await new Client("z").login("owner@terra-nusantara.test", "Uat#Owner2026"); const lcs = (await anon.get("/api/license/status")).json.license.status;
  const mw2 = new Database(`${DATA}/terra-finance.sqlite`); mw2.prepare("update license set license_key = ?").run(orig); mw2.close();
  const lr2 = await owner.get(`${A()}/journals?pageSize=1`);
  t("LIC-tamper", "license", "kunci lisensi dimodifikasi di DB -> data ditolak (403) walau login bisa; dipulihkan -> normal", lr.status === 403 && lg.status === 200 && lr2.status === 200, `data ${lr.status}, login ${lg.status}, status ${lcs}; setelah pulih ${lr2.status}`, "CRITICAL");
}
// ===== close periode & audit
{
  const closeTarget = per["2026-05"]; let r = await owner.post(`${A()}/periods/${closeTarget}/closing-check`, {}); const cc = await owner.get(`${A()}/periods/${closeTarget}/closing-check`); note("PE-closecheck", "periods", "closing-check periode Mei 2026", `${cc.status} ${JSON.stringify(cc.json).slice(0, 160)}`);
  await owner.post(`${A()}/periods/${closeTarget}/lock`, {}); r = await owner.post(`${A()}/periods/${closeTarget}/close`, {}); t("PE-close", "periods", "periode LOCKED -> CLOSED", r.status === 200, st(r), "MEDIUM");
  const j = await acct.post(`${A()}/journal`, { referenceNo: "AFTER-CLOSE", periodId: closeTarget, entryDate: "2026-05-20", lines: [{ accountId: accId[code.kas("PST")], debit: 1, credit: 0 }, { accountId: accId[code.pend("PST")], debit: 0, credit: 1 }] });
  t("PE-closed-journal", "business-logic", "jurnal ke periode yang sudah ditutup/dikunci ditolak (409)", j.status === 409, st(j), "HIGH");
  const rv = await acct.post(`${A()}/journal/reversal`, { referenceNo: "BIG-1", entryDate: "2026-04-02", reason: "uji" }); void rv;
}
{
  { const a1 = state().a1; await admin.post(`${A()}/accounts/${a1}/lock`); await admin.post(`${A()}/accounts/${a1}/unlock`); }
  const d = dbA(); const acts = d.prepare("select action, count(*) c from company_audit_log group by action").all(); d.close();
  const have = Object.fromEntries(acts.map((a) => [a.action, a.c])); const m = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true }); const mact = m.prepare("select action, count(*) c from audit_log group by action").all(); m.close();
  const sys = new Database(`${DATA}/terra-system.sqlite`, { readonly: true }); let sact = []; try { sact = sys.prepare("select action, count(*) c from system_audit_log group by action").all(); } catch {} sys.close();
  const allActs = new Set([...Object.keys(have), ...mact.map((x) => x.action), ...sact.map((x) => x.action)]);
  const expected = { "journal.create": ["journal.create"], "journal.post": ["journal.post"], "journal.reverse": ["journal.reverse"], "journal.import": ["journal.import"], "account.lock": ["account.lock"], "account.unlock": ["account.unlock"], "settings change": ["journal_settings.change", "company_profile.change"], "company change": ["company_profile.change"], "account.create": ["account.create"], "period.lock": ["period.lock"] };
  for (const [k, alt] of Object.entries(expected)) t("AUDIT-" + k.replace(/\W+/g, "_"), "audit", `audit log mencatat: ${k}`, alt.some((a) => allActs.has(a)), alt.join("|"), "MEDIUM");
  const hasLogin = [...allActs].some((a) => /login/i.test(a) && !/administrator/i.test(a)); const hasLogout = [...allActs].some((a) => /logout/i.test(a)); const userChg = [...allActs].some((a) => /user\.(create|active|deactivate|update)|users\./i.test(a)); const accChg = [...allActs].some((a) => /access|company_access/i.test(a));
  t("AUDIT-login", "audit", "login pengguna biasa tercatat di audit", hasLogin, `aksi login pengguna biasa: ${[...allActs].filter((a) => /login/i.test(a) && !/administrator/i.test(a)).join(",") || "tidak ada (hanya administrator.login)"}`, "MEDIUM");
  t("AUDIT-logout", "audit", "logout tercatat di audit", hasLogout, [...allActs].filter((a) => /logout/i.test(a)).join(",") || "tidak ada", "LOW");
  t("AUDIT-user", "audit", "perubahan user tercatat di audit", userChg, [...allActs].filter((a) => /user/i.test(a)).join(",") || "tidak ada", "MEDIUM");
  t("AUDIT-access", "audit", "perubahan akses perusahaan (grant/role/suspend/revoke) tercatat di audit", accChg, [...allActs].filter((a) => /access/i.test(a)).join(",") || "tidak ada", "HIGH");
  note("AUDIT-actions", "audit", "seluruh aksi audit yang ada", [...allActs].sort().join(", "));
}
// ===== fixture XSS untuk uji browser
{
  const XS = ["<script>window.__xss=(window.__xss||0)+1</script>", "<img src=x onerror=\"window.__xss=(window.__xss||0)+1\">", "\"><svg onload=window.__xss=(window.__xss||0)+1>"];
  const c1 = await acct.post(`${A()}/counterparties`, { type: "customer", code: "XSS-C", name: XS[1] });
  const j = await acct.post(`${A()}/journal`, { referenceNo: "XSS-" + XS[0], periodId: per["2026-02"], entryDate: "2026-02-12", description: XS[1], lines: [{ accountId: accId[code.kas("PST")], debit: 77, credit: 0, memo: XS[2] }, { accountId: accId[code.pend("PST")], debit: 0, credit: 77 }] });
  const jid = j.json?.journalId; await acct.post(`${A()}/journal/${jid}/post`);
  const rv = await acct.post(`${A()}/journal/reversal`, { referenceNo: "XSS-" + XS[0], entryDate: "2026-02-12", reason: XS[2] });
  note("XSS-fixture", "xss", "fixture XSS dibuat (jurnal, memo, alasan reversal, customer, nama akun, nama user, nama perusahaan)", `jurnal ${j.status}, reversal ${rv.status}, customer ${c1.status}`);
  saveState({ xssJournal: jid });
}
console.log("SECURITY-B SELESAI"); process.exit(0);
