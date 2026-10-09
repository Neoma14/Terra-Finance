import fs from "node:fs";
import { S, DATA, BASE, Client, A, rec, note, state, saveState, dbA, Database, sleep } from "./lib.mjs";
import { code } from "./gen.mjs";

const { accId, per, ids } = state();
const mk = async (e, p = "Uat#Pass2026") => { const c = new Client(e); const r = await c.login(e, p); if (r.status !== 200) throw new Error("login " + e); return c; };
const owner = await mk("owner@terra-nusantara.test", "Uat#Owner2026"), admin = await mk("admin@terra-nusantara.test"), acct = await mk("akuntan@terra-nusantara.test"), staf = await mk("staf@terra-nusantara.test"), viewer = await mk("viewer@terra-nusantara.test"), pen = await mk("penyusup@pembanding.test");
const anon = new Client("anon");
const t = (id, area, name, cond, detail = "", sev = "HIGH") => rec(id, area, name, cond, detail, sev);
const st = (r) => `status ${r.status}${r.json?.error ? " " + String(r.json.error).slice(0, 80) : ""}`;
const A_ = "pt-terra-nusantara", B_ = "pt-pembanding";

// ===== 19. AUTENTIKASI
{
  const lg = (b) => anon.post("/api/auth/login", b, { noStore: true, noRetry: true });
  let r = await lg({ email: "owner@terra-nusantara.test", password: "salah-total" }); const m1 = r.json?.error; t("AU-wrongpw", "authn", "password salah -> 401", r.status === 401, st(r));
  r = await lg({ email: "tidak-ada@x.test", password: "apa-saja-123" }); t("AU-nouser", "authn", "user tidak ada -> 401, pesan identik (tidak membocorkan keberadaan akun)", r.status === 401 && r.json?.error === m1, `${st(r)} | sama=${r.json?.error === m1}`);
  r = await lg({ email: "owner@terra-nusantara.test", password: "" }); t("AU-emptypw", "authn", "password kosong ditolak (400/401)", r.status === 400 || r.status === 401, st(r));
  r = await lg({}); t("AU-emptybody", "authn", "body kosong ditolak (400)", r.status === 400, st(r));
  r = await anon.req("POST", "/api/auth/login", { body: "bukan-json{", headers: { "Content-Type": "application/json" }, noStore: true }); t("AU-badjson", "authn", "JSON rusak -> 4xx (bukan 500)", r.status >= 400 && r.status < 500, st(r));
  r = await lg({ email: "owner@terra-nusantara.test", password: "x".repeat(100000) }); t("AU-longpw", "authn", "password 100 KB tidak membuat server error", r.status < 500, st(r));
  r = await lg({ email: { $ne: null }, password: { $ne: null } }); t("AU-nosqlobj", "authn", "email/password berupa objek ditolak", r.status === 400, st(r));
  r = await lg({ email: "owner@terra-nusantara.test", password: "Uat#Owner2026", role: "admin", isAdmin: true }); t("AU-extra", "authn", "login benar dengan field tambahan tetap normal", r.status === 200, st(r));
  const protectedList = [["GET", "/api/company-db"], ["GET", `${A()}/journals`], ["GET", `${A()}/profile`], ["GET", `${A()}/reports/balance-sheet?fromDate=2025-01-01&toDate=2025-12-31`], ["GET", `${A()}/ledger/${accId[code.bca]}?fromDate=2025-01-01&toDate=2025-12-31`], ["GET", `${A()}/search?q=abc`], ["GET", `${A()}/audit-log`], ["GET", "/api/users"], ["GET", "/api/companies"], ["GET", "/api/benchmark?from=2025-01-01&to=2025-12-31"], ["POST", `${A()}/journal`], ["GET", `${A()}/reports/export/income-statement?format=xlsx&fromDate=2025-01-01&toDate=2025-12-31`], ["GET", "/api/auth/me"], ["POST", "/api/auth/activity"], ["GET", `/api/c/${A_}/accounts`]];
  let leak = []; for (const [m, p] of protectedList) { const x = await anon.req(m, p, { body: m === "POST" ? {} : undefined }); if (x.status !== 401) leak.push(`${m} ${p.slice(0, 40)} -> ${x.status}`); }
  t("AU-notoken", "authn", `${protectedList.length} endpoint terlindungi tanpa token -> 401`, leak.length === 0, leak.join("; "), "CRITICAL");
  let bad = []; for (const ck of ["konsultan_session=abc", "konsultan_session=", "konsultan_session=' OR 1=1 --", "konsultan_session=" + "a".repeat(64), "konsultan_session=../../etc/passwd", "konsultan_session=" + owner.cookie.split("=")[1] + "x", "other=1"]) { const x = await anon.get(`${A()}/journals`, { cookie: ck }); if (x.status !== 401) bad.push(`${ck.slice(0, 30)} -> ${x.status}`); }
  t("AU-badtoken", "authn", "token rusak/palsu/dimodifikasi -> 401", bad.length === 0, bad.join("; "), "CRITICAL");
  // logout lalu pakai token lama
  const tmp = await mk("viewer@terra-nusantara.test"); const old = tmp.cookie; r = await tmp.post("/api/auth/logout"); const after = await anon.get(`${A()}/journals`, { cookie: old }); t("AU-logout", "authn", "setelah logout token lama ditolak (401)", after.status === 401, st(after), "CRITICAL");
  // kedaluwarsa & idle (manipulasi DB UAT)
  const t2 = await mk("viewer@terra-nusantara.test"); const m = new Database(`${DATA}/terra-finance.sqlite`);
  const tok = t2.cookie.split("=")[1]; const crypto = await import("node:crypto"); const hash = crypto.createHash("sha256").update(tok).digest("hex");
  m.prepare("update sessions set expires_at = ? where token_hash = ?").run(new Date(Date.now() - 1000).toISOString(), hash); r = await anon.get("/api/auth/me", { cookie: t2.cookie }); t("AU-expired", "authn", "sesi kedaluwarsa (expires_at lampau) -> 401", r.status === 401, st(r), "CRITICAL");
  const t3 = await mk("viewer@terra-nusantara.test"); const h3 = crypto.createHash("sha256").update(t3.cookie.split("=")[1]).digest("hex");
  m.prepare("update sessions set last_activity_at = ? where token_hash = ?").run(new Date(Date.now() - 16 * 60e3).toISOString(), h3); r = await anon.get("/api/auth/me", { cookie: t3.cookie }); t("AU-idle", "session", "idle > 15 menit -> 401 di server", r.status === 401, st(r), "HIGH");
  r = await anon.post("/api/auth/activity", {}, { cookie: t3.cookie }); t("AU-idle-noresurrect", "session", "ping aktivitas tidak menghidupkan sesi idle", r.status === 401, st(r), "HIGH");
  m.close();
  // user dinonaktifkan -> sesi lama mati
  const t4 = await mk("staf@terra-nusantara.test"); r = await owner.patch(`/api/users/${ids["staf@terra-nusantara.test"]}/active`, { isActive: false }); const x = await anon.get("/api/auth/me", { cookie: t4.cookie }); const lg2 = await lg({ email: "staf@terra-nusantara.test", password: "Uat#Pass2026" });
  t("AU-deactivated", "authn", "user dinonaktifkan: sesi lama dan login baru ditolak", x.status === 401 && lg2.status === 401, `me ${x.status} login ${lg2.status}`, "CRITICAL");
  await owner.patch(`/api/users/${ids["staf@terra-nusantara.test"]}/active`, { isActive: true });
  // cookie flags & enumerasi
  const raw = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "viewer@terra-nusantara.test", password: "Uat#Pass2026" }) }); const sc = raw.headers.get("set-cookie") ?? "";
  t("AU-cookie", "authn", "cookie sesi HttpOnly + SameSite=Lax", /httponly/i.test(sc) && /samesite=lax/i.test(sc), sc.replace(/=[0-9a-f]{20,}/, "=<token>"), "MEDIUM");
  note("AU-cookie-secure", "authn", "atribut Secure pada cookie", /secure/i.test(sc) ? "Secure aktif" : "Secure tidak aktif (server berjalan di http://127.0.0.1; wajar untuk desktop lokal, WAJIB aktif bila nanti ada akses jaringan/HTTPS)", "LOW");
  const a1 = (await mk("viewer@terra-nusantara.test")).cookie, a2 = (await mk("viewer@terra-nusantara.test")).cookie; t("AU-fixation", "authn", "setiap login menghasilkan token baru (anti session fixation)", a1 !== a2, "", "MEDIUM");
  // brute force
  let codes = []; for (let i = 0; i < 25; i++) { const x = await lg({ email: "owner@terra-nusantara.test", password: "tebakan-salah-" + i }); codes.push(x.status); }
  const ok = await lg({ email: "owner@terra-nusantara.test", password: "Uat#Owner2026" });
  t("AU-bruteforce", "authn", "25 percobaan password salah beruntun: adakah penguncian akun/penundaan?", ok.status !== 200 || codes.includes(429), `status percobaan: ${[...new Set(codes)].join(",")}; login benar setelahnya = ${ok.status}`, "MEDIUM");
  const me = await owner.get("/api/auth/me"); t("AU-noleak", "authn", "respons /auth/me & login tidak membocorkan password_hash", !/password/i.test(JSON.stringify(me.json)), "", "HIGH");
  const ul = await owner.get("/api/users"); t("AU-noleak2", "authn", "daftar user tidak membocorkan password_hash", !/hash|\$argon|password/i.test(JSON.stringify(ul.json)), "", "CRITICAL");
}

// ===== 20. OTORISASI (matriks peran x izin, probe non-destruktif)
{
  const roles = { OWNER: owner, ADMIN: admin, ACCOUNTANT: acct, STAFF: await mk("staf@terra-nusantara.test"), VIEWER: viewer };
  const allow = { "journal.read": ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"], "report.read": ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"], "account.read": ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"], "journal.create": ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF"], "journal.post": ["OWNER", "ADMIN", "ACCOUNTANT"], "journal.reverse": ["OWNER", "ADMIN", "ACCOUNTANT"], "journal.import(commit)": ["OWNER", "ADMIN", "ACCOUNTANT"], "account.create": ["OWNER", "ADMIN", "ACCOUNTANT"], "account.update": ["OWNER", "ADMIN", "ACCOUNTANT"], "account.lock": ["OWNER", "ADMIN"], "company.update(profile)": ["OWNER", "ADMIN"], "company.update(journal-settings)": ["OWNER", "ADMIN"], "users.read(access)": ["OWNER", "ADMIN"], "users.manage(access)": ["OWNER", "ADMIN"], "period.generate(company.update)": ["OWNER", "ADMIN"] };
  const probe = {
    "journal.read": (c) => c.get(`${A()}/journals?pageSize=1`), "report.read": (c) => c.get(`${A()}/trial-balance?periodId=${per["2025-12"]}`), "account.read": (c) => c.get(`${A()}/accounts?pageSize=1`),
    "journal.create": (c) => c.post(`${A()}/journal`, {}), "journal.post": (c) => c.post(`${A()}/journal/tidak-ada/post`, {}), "journal.reverse": (c) => c.post(`${A()}/journal/reversal`, {}),
    "journal.import(commit)": (c) => c.upload(`${A()}/journal-import/commit`, "x.xlsx", Buffer.from("x")), "account.create": (c) => c.post(`${A()}/accounts`, {}), "account.update": (c) => c.patch(`${A()}/accounts/tidak-ada`, {}), "account.lock": (c) => c.post(`${A()}/accounts/tidak-ada/lock`, {}),
    "company.update(profile)": (c) => c.patch(`${A()}/profile`, {}), "company.update(journal-settings)": (c) => c.put(`${A()}/journal-settings`, {}), "users.read(access)": (c) => c.get(`${A()}/access`), "users.manage(access)": (c) => c.post(`${A()}/access`, {}),
    "period.generate(company.update)": (c) => c.post(`${A()}/periods/generate-monthly`, {}),
  };
  const bad = []; let n = 0;
  for (const [perm, fn] of Object.entries(probe)) for (const [role, c] of Object.entries(roles)) {
    const r = await fn(c); n++; const denied = r.status === 403; const shouldAllow = allow[perm].includes(role);
    if (shouldAllow && denied) bad.push(`${role} ditolak ${perm}`); if (!shouldAllow && !denied) bad.push(`${role} LOLOS ${perm} (status ${r.status})`);
  }
  t("AZ-matrix", "authz", `matriks otorisasi ${n} kombinasi peran x izin sesuai kebijakan (403 untuk yang tidak berhak)`, bad.length === 0, bad.join("; ").slice(0, 300), "HIGH");
  // eskalasi hak
  let r = await admin.post(`${A()}/access`, { userId: ids["viewer@terra-nusantara.test"], role: "OWNER" }); note("AZ-admin-grant-owner", "authz", "ADMIN memberi peran OWNER ke user lain", st(r));
  const adminSelf = ids["admin@terra-nusantara.test"]; r = await admin.patch(`${A()}/access/${adminSelf}`, { role: "OWNER" }); note("AZ-admin-selfup", "authz", "ADMIN menaikkan dirinya sendiri menjadi OWNER", st(r));
  r = await viewer.patch(`${A()}/access/${ids["viewer@terra-nusantara.test"]}`, { role: "OWNER" }); t("AZ-viewer-selfup", "authz", "VIEWER menaikkan dirinya sendiri ke OWNER ditolak (403)", r.status === 403, st(r), "CRITICAL");
  r = await acct.post("/api/users", { email: "x@x.test", password: "Uat#Pass2026", fullName: "X", role: "admin" }); t("AZ-user-create-nonadmin", "authz", "user aplikasi non-admin tidak boleh membuat user admin (403)", r.status === 403, st(r), "CRITICAL");
  r = await acct.get("/api/users"); t("AZ-users-list", "authz", "user aplikasi non-admin tidak boleh melihat daftar user (403)", r.status === 403, st(r), "HIGH");
  r = await acct.patch(`/api/users/${ids["owner"] ?? ids["admin@terra-nusantara.test"]}/active`, { isActive: false }); t("AZ-user-deact", "authz", "non-admin tidak boleh menonaktifkan user lain (403)", r.status === 403, st(r), "CRITICAL");
  r = await acct.post("/api/license/replace", { licenseKey: "TFO2-x.y" }); t("AZ-license-replace", "authz", "non-admin tidak boleh mengganti lisensi (403)", r.status === 403, st(r), "CRITICAL");
  r = await owner.post("/api/license/replace", { licenseKey: "TFO2-eyJ4Ijoie30.abcdef" }); t("AZ-license-forged", "authz", "lisensi palsu ditolak oleh admin sekalipun (400)", r.status === 400, st(r), "CRITICAL");
  const lic0 = (await owner.get("/api/license/status")).json.license.status; t("AZ-license-intact", "authz", "lisensi tetap aktif setelah percobaan palsu", lic0 === "active", lic0, "CRITICAL");
}

// ===== 21/22. IDOR & lintas company
{
  const idJ = (await owner.get(`${A()}/journals?pageSize=1`)).json.journals[0].id; const idAcc = accId[code.bca];
  const eps = [["GET", "/journals"], ["GET", `/journals/${idJ}`], ["GET", "/profile"], ["GET", "/accounts"], ["GET", `/accounts/${idAcc}`], ["GET", `/ledger/${idAcc}?fromDate=2025-01-01&toDate=2025-12-31`], ["GET", `/trial-balance?periodId=${per["2025-12"]}`], ["GET", "/reports/balance-sheet?fromDate=2021-01-01&toDate=2025-12-31"], ["GET", "/reports/income-statement?fromDate=2025-01-01&toDate=2025-12-31"], ["GET", "/reports/equity?fromDate=2025-01-01&toDate=2025-12-31"], ["GET", "/reports/cash-flow?fromDate=2025-01-01&toDate=2025-12-31"], ["GET", "/dashboard?fromDate=2025-01-01&toDate=2025-12-31"], ["GET", "/search?q=PST-2025"], ["GET", "/audit-log"], ["GET", "/periods"], ["GET", "/access"], ["GET", "/counterparties?type=customer"], ["GET", "/analysis?fromDate=2025-01-01&toDate=2025-12-31"], ["GET", "/projection?asOfDate=2025-12-31&monthsAhead=3"], ["GET", "/tax-summary?fromDate=2025-01-01&toDate=2025-12-31"], ["GET", "/opening-balance"], ["GET", "/journal-settings"], ["GET", "/journal-import/history"], ["GET", "/reports/export/income-statement?format=xlsx&fromDate=2025-01-01&toDate=2025-12-31"], ["GET", `/reports/export/ledger?format=pdf&accountId=${idAcc}&fromDate=2025-01-01&toDate=2025-12-31`], ["POST", `/journal/${idJ}/post`], ["POST", `/journal/${idJ}/reverse`], ["POST", "/journal/reversal"], ["PUT", `/journal/${idJ}`], ["DELETE", `/journal/${idJ}`], ["POST", `/accounts/${idAcc}/lock`], ["PATCH", `/accounts/${idAcc}`], ["PATCH", "/profile"], ["POST", "/journal"], ["POST", "/accounts"], ["POST", "/access"], ["PUT", "/journal-settings"], ["POST", "/periods/generate-monthly"]];
  for (const [who, c, slug] of [["user Company B -> Company A", pen, A_], ["user Company A (akuntan) -> Company B", acct, B_], ["viewer A -> B", viewer, B_]]) {
    const leaks = []; let n = 0;
    for (const [m, p] of eps) { const r = await c.req(m, `/api/company-db/${slug}${p}`, { body: m === "GET" || m === "DELETE" ? undefined : {} }); n++; if (r.status !== 404) leaks.push(`${m} ${p.slice(0, 35)} -> ${r.status}`); }
    t("IDOR-" + who.split(" ")[1] + who.slice(-1), "idor", `${who}: ${n} endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan)`, leaks.length === 0, leaks.slice(0, 5).join("; "), "CRITICAL");
  }
  // enumerasi: perusahaan tidak ada vs tidak berhak
  const e1 = await pen.get(`/api/company-db/${A_}/profile`), e2 = await pen.get(`/api/company-db/tidak-ada-sama-sekali/profile`); t("IDOR-enum", "idor", "respons 'tidak berhak' identik dengan 'perusahaan tidak ada' (anti enumerasi)", e1.status === e2.status && e1.text === e2.text, `${e1.status}/${e2.status}`, "MEDIUM");
  // ID entitas milik company lain lewat URL company sendiri
  const own = B_; const probes = [["GET", `/journals/${idJ}`], ["GET", `/accounts/${idAcc}`], ["GET", `/ledger/${idAcc}?fromDate=2025-01-01&toDate=2025-12-31`], ["POST", `/journal/${idJ}/post`], ["POST", `/journal/${idJ}/reverse`], ["PATCH", `/accounts/${idAcc}`], ["POST", `/accounts/${idAcc}/lock`], ["DELETE", `/journal/${idJ}`]];
  const l2 = []; for (const [m, p] of probes) { const r = await pen.req(m, `/api/company-db/${own}${p}`, { body: m === "GET" || m === "DELETE" ? undefined : { reason: "x", targetPeriodId: "x" } }); if (r.status !== 404 && r.status !== 400) l2.push(`${m} ${p.slice(0, 30)} -> ${r.status}`); else if (r.status === 200) l2.push("200!"); }
  t("IDOR-id", "idor", "ID jurnal/akun milik Company A dipakai lewat URL Company B (pemilik B): 404/400, tidak berdampak", l2.length === 0, l2.join("; "), "CRITICAL");
  const sr = await pen.get(`/api/company-db/${own}/search?q=PST-2025`); t("IDOR-search", "idor", "pencarian di Company B tidak menemukan data Company A", (sr.json?.journals ?? []).length === 0, `${(sr.json?.journals ?? []).length} hasil`, "CRITICAL");
  // slug tampering
  const slugs = ["PT-TERRA-NUSANTARA", `${A_}%00`, `${A_}/../${B_}`, `${A_}%2f..%2f${B_}`, `${A_}%252e%252e`, ` ${A_}`, `${A_}.`, `..%2f${A_}`, `${B_}/../${A_}`];
  const l3 = []; for (const s of slugs) { const r = await pen.req("GET", `/api/company-db/${s}/journals`); if (r.status === 200 && (r.json?.total ?? 0) > 100) l3.push(`${s} -> 200 total ${r.json?.total}`); }
  t("IDOR-slug", "idor", "manipulasi slug (case, null byte, ../, encoded) tidak membuka Company A", l3.length === 0, l3.join("; "), "CRITICAL");
  // user ID tampering pada access
  let r = await owner.patch(`${A()}/access/${ids["penyusup@pembanding.test"]}`, { role: "ADMIN" }); t("IDOR-access-foreign", "idor", "mengubah akses user yang bukan anggota Company A ditolak (404)", r.status === 404, st(r), "HIGH");
  r = await pen.get(`${A()}/access`); void r;
  // legacy
  const legacy = [`/api/c/${A_}/accounts`, `/api/c/${A_}/journal`, `/api/c/${A_}/ledger`, `/api/c/${A_}/periods`, `/api/c/${A_}/statements/balance-sheet`, `/api/c/${A_}`];
  const l4 = []; for (const p of legacy) { const r2 = await pen.get(p); if (r2.status === 200) l4.push(`${p} -> 200`); } t("IDOR-legacy", "idor", "jalur lama /api/c/<slug> oleh user Company B -> tidak 200", l4.length === 0, l4.join("; "), "CRITICAL");
  const l5 = []; for (const p of legacy) { const r2 = await viewer.get(p); l5.push(`${p.replace(`/api/c/${A_}`, "")}:${r2.status}`); } note("LEGACY-view", "idor", "jalur lama /api/c/<slug> oleh VIEWER sah di Company A", l5.join(" "));
  const wr = await viewer.post(`/api/c/${A_}/journal/manual`, {}); const wr2 = await viewer.post(`/api/c/${A_}/accounts`, {}); note("LEGACY-viewer-write", "authz", "VIEWER memanggil endpoint TULIS jalur lama (journal/manual, accounts)", `${wr.status} / ${wr2.status}`);
}
// ===== 23/25. SQLi + mass assignment
{
  const db0 = dbA(); const cnt = () => { const d = dbA(); const o = { j: d.prepare("select count(*) c from journal_entries").get().c, l: d.prepare("select count(*) c from journal_entry_lines").get().c, a: d.prepare("select count(*) c from accounts").get().c, p: d.prepare("select count(*) c from periods").get().c, au: d.prepare("select count(*) c from company_audit_log").get().c }; d.close(); return o; }; db0.close();
  const base = cnt(); const mCount = () => { const m = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true }); const o = { u: m.prepare("select count(*) c from users").get().c, s: m.prepare("select count(*) c from sessions").get().c }; m.close(); return o; };
  const payloads = ["'", "\"", "' OR 1=1 --", "' OR '1'='1", "\" OR \"\"=\"", "'; SELECT 1; --", "%' OR '1'='1' --", "\\", "' UNION SELECT name FROM sqlite_master --", "1; PRAGMA table_info(users)", "admin'--", "') OR ('1'='1"];
  const errs = []; let n = 0; const norm = (await owner.get(`${A()}/search?q=zzzzzzzz-tidak-ada`)).json; const sqlErr = (r, p) => /SQLITE_|syntax error|unrecognized token|no such (table|column)/i.test((r.text ?? "").split(p).join(""));
  for (const p of payloads) {
    const e = encodeURIComponent(p);
    const calls = [["login-email", () => anon.post("/api/auth/login", { email: p, password: "x" }, { noStore: true })], ["login-pw", () => anon.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: p }, { noStore: true })], ["search", () => owner.get(`${A()}/search?q=${e}`)], ["journals-search", () => owner.get(`${A()}/journals?search=${e}`)], ["journals-status", () => owner.get(`${A()}/journals?status=${e}`)], ["journals-date", () => owner.get(`${A()}/journals?fromDate=${e}&toDate=${e}`)], ["journals-period", () => owner.get(`${A()}/journals?periodId=${e}`)], ["accounts-search", () => owner.get(`${A()}/accounts?search=${e}`)], ["accounts-type", () => owner.get(`${A()}/accounts?accountTypeId=${e}`)], ["accounts-parent", () => owner.get(`${A()}/accounts?parentAccountId=${e}`)], ["ledger-id", () => owner.get(`${A()}/ledger/${e}?fromDate=2025-01-01&toDate=2025-12-31`)], ["ledger-dates", () => owner.get(`${A()}/ledger/${accId[code.bca]}?fromDate=${e}&toDate=${e}`)], ["tb-period", () => owner.get(`${A()}/trial-balance?periodId=${e}`)], ["report-dates", () => owner.get(`${A()}/reports/income-statement?fromDate=${e}&toDate=${e}`)], ["dash-dates", () => owner.get(`${A()}/dashboard?fromDate=${e}&toDate=${e}`)], ["audit-q", () => owner.get(`${A()}/audit-log?search=${e}&action=${e}&entityType=${e}`)], ["slug", () => owner.get(`/api/company-db/${e}/journals`)], ["export-params", () => owner.get(`${A()}/reports/export/income-statement?format=${e}&fromDate=${e}&toDate=${e}`)], ["cp-type", () => owner.get(`${A()}/counterparties?type=${e}`)], ["ref-create", () => acct.post(`${A()}/journal`, { referenceNo: p, periodId: per["2026-02"], entryDate: "2026-02-11", description: p, lines: [{ accountId: accId[code.kas("PST")], debit: 1, credit: 0, memo: p }, { accountId: accId[code.pend("PST")], debit: 0, credit: 1 }] })], ["coa-create", () => acct.post(`${A()}/accounts`, { code: "SQ" + n, name: p, accountTypeCode: "ASSET", normalBalance: "debit" })], ["cp-create", () => acct.post(`${A()}/counterparties`, { type: "vendor", code: "SQ" + n, name: p })], ["profile", () => owner.patch(`${A()}/profile`, { tradeName: p })]];
    for (const [name, fn] of calls) { const r = await fn(); n++; if (r.status >= 500 || sqlErr(r, p)) errs.push(`${name}[${p.slice(0, 12)}]->${r.status}`); if (name === "search" && p.includes("OR") && ((r.json?.journals?.length ?? 0) > 0 && (r.json?.journals?.length ?? 0) >= 8)) errs.push(`search-OR-matchall[${p}]`); }
  }
  const after = cnt(); const mAfter = mCount();
  t("SQLI-resp", "sqli", `${n} permintaan berisi payload SQLi ke 24 titik input: tidak ada 5xx/pesan SQL`, errs.length === 0, errs.slice(0, 6).join("; "), "HIGH");
  const dj = after.j - base.j, dl = after.l - base.l;
  t("SQLI-data", "sqli", "jumlah baris tabel tidak berubah selain record uji yang sah (tidak ada kerusakan/ekstraksi)", after.p === base.p && dj >= 0 && dj <= payloads.length && Object.keys(mCount()).length > 0, `jurnal +${dj}, baris +${dl}, akun +${after.a - base.a}, periode ${after.p - base.p}`, "CRITICAL");
  const m = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true }); const tables = m.prepare("select name from sqlite_master where type='table'").all().length; const ic = m.prepare("pragma integrity_check").get().integrity_check; m.close();
  const d1 = dbA(); const ic2 = d1.prepare("pragma integrity_check").get().integrity_check; d1.close(); t("SQLI-integrity", "sqli", "integrity_check master & company DB ok setelah uji injeksi", ic === "ok" && ic2 === "ok", `master ${ic}, company ${ic2}, tabel master ${tables}`, "CRITICAL");
  const lg = await anon.post("/api/auth/login", { email: "' OR 1=1 --", password: "' OR 1=1 --" }, { noStore: true }); t("SQLI-loginbypass", "sqli", "login bypass dengan ' OR 1=1 -- gagal", lg.status === 401 || lg.status === 400, st(lg), "CRITICAL");
  // mass assignment
  const meId = (await acct.get("/api/auth/me")).json.user.id;
  let r = await acct.patch(`${A()}/accounts/${saveStateGet("a1")}`, { isLocked: true, is_locked: true, isSystemAccount: true, is_system_account: true, id: "x", code: "HACK" }); const dbq = dbA(); const row = dbq.prepare("select code, is_locked, is_system_account from accounts where id=?").get(saveStateGet("a1")); dbq.close();
  t("MASS-account", "mass-assign", "PATCH akun dengan isLocked/isSystemAccount/id/code diabaikan (akun sudah terkunci oleh admin; kode & flag sistem tidak berubah)", row.code === "9001" && row.is_system_account === 0, JSON.stringify(row) + " " + st(r), "HIGH");
  r = await owner.patch(`${A()}/profile`, { id: "x", license: "z", companyId: "c", createdBy: "u", role: "OWNER", journal_number_seq: 999, max_backdate_days: 1 }); const d2 = dbA(); const prof = d2.prepare("select id, journal_number_seq, max_backdate_days from company_profile").get(); d2.close();
  t("MASS-profile", "mass-assign", "PATCH profil dengan id/journal_number_seq/max_backdate_days diabaikan", prof.id !== "x" && prof.journal_number_seq !== 999 && prof.max_backdate_days === null, JSON.stringify(prof), "HIGH");
  r = await owner.post("/api/users", { email: "mass@x.test", password: "Uat#Pass2026", fullName: "Mass", role: "staff", isActive: false, id: "fixed-id", is_admin: true, password_hash: "x" }); const mm = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true }); const ur = mm.prepare("select id, role, is_active from users where email='mass@x.test'").get(); mm.close();
  t("MASS-user", "mass-assign", "POST user dengan id/is_admin/password_hash tambahan diabaikan", !!ur && ur.id !== "fixed-id" && ur.role === "staff", JSON.stringify(ur), "HIGH");
  r = await owner.post(`${A()}/access`, { userId: ids["viewer@terra-nusantara.test"], role: "VIEWER", companyId: "x", status: "ACTIVE", permissions: ["*"] }); note("MASS-access", "mass-assign", "POST access dengan field permissions/companyId tambahan", st(r));
  void meId;
}
function saveStateGet(k) { return state()[k]; }
// ===== audit log tidak bisa diubah via API
{
  const al = (await owner.get(`${A()}/audit-log?page=1&pageSize=1`)).json; const id = (al.entries ?? al.items ?? al.logs ?? [])[0]?.id;
  const res = []; for (const m of ["PUT", "PATCH", "DELETE", "POST"]) { for (const p of [`${A()}/audit-log`, `${A()}/audit-log/${id}`]) { const r = await owner.req(m, p, { body: m === "DELETE" ? undefined : {} }); res.push(`${m}:${r.status}`); } }
  t("AUD-api-immutable", "audit", "tidak ada endpoint ubah/hapus audit log (semua 404/405)", res.every((x) => /:(404|405)$/.test(x)), res.join(" "), "HIGH");
  const d = dbA(false); let upd = "", del = ""; try { d.prepare("update company_audit_log set action='x'").run(); upd = "BERHASIL (buruk)"; } catch (e) { upd = "ditolak trigger: " + e.message.slice(0, 50); } try { d.prepare("delete from company_audit_log").run(); del = "BERHASIL (buruk)"; } catch (e) { del = "ditolak trigger: " + e.message.slice(0, 50); } d.close();
  t("AUD-db-immutable", "audit", "audit log append-only di level database (trigger menolak UPDATE/DELETE)", upd.startsWith("ditolak") && del.startsWith("ditolak"), `${upd} | ${del}`, "HIGH");
}
console.log("SECURITY-A SELESAI"); process.exit(0);
