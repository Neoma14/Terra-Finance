// E2E Phase 3 (otorisasi & delegasi multi-cabang) terhadap SERVER HASIL BUILD pada SALINAN data UAT 5 tahun.
// Bukan data produksi, bukan port 4000. PACKAGED=1 menjalankan server dari runtime Electron hasil installer.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad";
const WORK = `${S}/mbp3/data`;
const PORT = 4511;
const BASE = `http://127.0.0.1:${PORT}`;
const A = "/api/company-db/pt-terra-nusantara";
const B = "/api/company-db/pt-pembanding";
const req = createRequire(`${ROOT}/apps/api/package.json`);
const Database = req("better-sqlite3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- salinan data UAT (backup 5 tahun) ke folder kerja terpisah
fs.rmSync(`${S}/mbp3`, { recursive: true, force: true });
const BK = `${S}/uat5/backup`;
fs.mkdirSync(`${WORK}/companies`, { recursive: true });
fs.copyFileSync(`${BK}/terra-finance-2026-10-06T02-00-10-045Z.sqlite`, `${WORK}/terra-finance.sqlite`);
fs.copyFileSync(`${BK}/terra-system-2026-10-06T02-00-10-045Z.sqlite`, `${WORK}/terra-system.sqlite`);
for (const slug of fs.readdirSync(`${BK}/companies`)) {
  const f = fs.readdirSync(`${BK}/companies/${slug}`).find((n) => n.endsWith(".db"));
  fs.mkdirSync(`${WORK}/companies/${slug}`, { recursive: true });
  fs.copyFileSync(`${BK}/companies/${slug}/${f}`, `${WORK}/companies/${slug}/company.db`);
}
const countsOf = (file) => {
  const db = new Database(file, { readonly: true });
  const c = (t) => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get();
  const r = { journals: c("journal_entries"), lines: c("journal_entry_lines"), accounts: c("accounts") };
  db.close();
  return r;
};
const before = countsOf(`${WORK}/companies/pt-terra-nusantara/company.db`);
const sysBefore = new Database(`${WORK}/terra-system.sqlite`, { readonly: true });
const accessBefore = sysBefore.prepare("SELECT id, role, status FROM company_access ORDER BY id").all();
sysBefore.close();

const env = {
  ...process.env, NODE_ENV: "production", PORT: String(PORT),
  DB_FILE_PATH: `${WORK}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${WORK}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${WORK}/companies`,
  STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("mbp3-secret").digest("hex"),
};
const log = fs.openSync(`${S}/mbp3/server.log`, "w");
const PKG = `${ROOT}/apps/desktop/dist/win-unpacked`;
if (process.env.PACKAGED === "1") { env.ELECTRON_RUN_AS_NODE = "1"; env.STATIC_WEB_DIR = `${PKG}/resources/web/dist`; }
const srv = process.env.PACKAGED === "1"
  ? spawn(`${PKG}/TERRA FINANCE.exe`, [`${PKG}/resources/api/dist/server.js`], { env, stdio: ["ignore", log, log] })
  : spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", log, log] });
let healthy = false;
for (let i = 0; i < 200 && !healthy; i++) { try { healthy = (await fetch(`${BASE}/api/health`)).ok; } catch {} if (!healthy) await sleep(400); }
if (!healthy) { console.log("SERVER TIDAK SEHAT"); process.exit(1); }

const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: Boolean(pass), detail }); console.log((pass ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : "")); };

class Client {
  cookie = "";
  async req(method, p, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h["Content-Type"] = "application/json";
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status !== 429 || p === "/api/auth/login") break;
      await sleep(Number(r.headers.get("retry-after") ?? 5) * 1000 + 300);
    }
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
  get(p, o) { return this.req("GET", p, o); }
  post(p, body, o = {}) { return this.req("POST", p, { ...o, body }); }
  put(p, body, o = {}) { return this.req("PUT", p, { ...o, body }); }
  patch(p, body, o = {}) { return this.req("PATCH", p, { ...o, body }); }
  del(p, body, o = {}) { return this.req("DELETE", p, { ...o, body }); }
}
const stamp = Date.now();
const PW = "Rahasia#2026";

try {
  const owner = new Client();
  ok("login pemilik", (await owner.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" })).status === 200);

  // ---------------- migrasi sistem: tabel baru ada, akses lama utuh
  const sys = new Database(`${WORK}/terra-system.sqlite`, { readonly: true });
  const tables = sys.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
  ok("S0014-S0016: tabel override & delegasi (Revisi 5) dibuat, model lama diarsipkan", ["access_permission_overrides", "delegations", "delegation_branches", "delegations_p3_archive"].every((t) => tables.includes(t)));
  const accessNow = sys.prepare("SELECT id, role, status, branch_scope FROM company_access ORDER BY id").all();
  sys.close();
  const sameAccess = accessBefore.every((b) => accessNow.some((n) => n.id === b.id && n.role === b.role && n.status === b.status && n.branch_scope === "ALL"));
  ok("akses perusahaan lama tidak berubah (role/status sama, scope ALL)", sameAccess, `${accessBefore.length} baris`);

  // ---------------- persiapan: multi-cabang, cabang, user
  ok("OWNER menyalakan multi-cabang (pada salinan)", (await owner.put(`${A}/multi-branch`, { enabled: true })).json?.multiBranchEnabled === true);
  const mk = async (code, name) => (await owner.post(`${A}/branches`, { code, name })).json?.id;
  const metro = await mk("METRO", "Cabang Metro");
  const bl = await mk("BL", "Bandar Lampung");
  const kotabumi = await mk("KOTABUMI", "Cabang Kotabumi");
  const hq = (await owner.get(`${A}/branch-context`)).json?.headOfficeBranchId;
  const foreignBranch = (await owner.get(`${B}/branch-context`)).json?.headOfficeBranchId; // id cabang milik perusahaan LAIN
  ok("3 cabang dibuat; id cabang perusahaan lain tersedia untuk uji pemalsuan", metro && bl && kotabumi && hq && foreignBranch && foreignBranch !== hq);

  const mkUser = async (label, companyRole, company = A) => {
    const email = `${label}.${stamp}@p3.test`;
    const id = (await owner.post("/api/users", { email, password: PW, fullName: label, role: "staff" })).json?.userId;
    const g = await owner.post(`${company}/access`, { userId: id, role: companyRole });
    const c = new Client();
    const login = await c.post("/api/auth/login", { email, password: PW });
    return { id, email, c, grantStatus: g.status, loginStatus: login.status };
  };
  const adminLtd = await mkUser("admin-ltd", "ADMIN");
  const adminInfo = await mkUser("admin-info", "ADMIN");
  const adminAll = await mkUser("admin-semua", "ADMIN");
  const staffM = await mkUser("staf-metro", "STAFF");
  const staffBl = await mkUser("staf-bl", "STAFF");
  const viewer = await mkUser("viewer", "VIEWER");
  const accountantK = await mkUser("akuntan-kota", "ACCOUNTANT");
  const outsiderB = await mkUser("orang-b", "STAFF", B);
  ok("user uji dibuat & login", [adminLtd, adminInfo, adminAll, staffM, staffBl, viewer, accountantK].every((u) => u.grantStatus === 201 && u.loginStatus === 200), outsiderB.grantStatus + "/" + outsiderB.loginStatus);
  ok("OWNER menetapkan admin pusat scope ALL (perilaku ADMIN lama)", (await owner.put(`${A}/access/${adminAll.id}/branch-scope`, { scope: "ALL" })).status === 200);

  for (const b of [metro, bl]) await owner.post(`${A}/access/${adminLtd.id}/branches`, { branchId: b });
  await owner.post(`${A}/access/${adminInfo.id}/branches`, { branchId: metro });
  await owner.post(`${A}/access/${accountantK.id}/branches`, { branchId: kotabumi });
  const adminCtx = await adminLtd.c.get(`${A}/branch-context`);
  ok("admin LIMITED hanya melihat Metro + Bandar Lampung", adminCtx.json?.branches?.map((b) => b.code).sort().join() === "BL,METRO");

  // ---------------- koreksi Revisi 5: tanpa delegasi, ADMIN LIMITED tidak punya kewenangan administratif
  const noDlg = await adminLtd.c.post(`${A}/access/${staffM.id}/branches`, { branchId: metro });
  ok("ADMIN LIMITED tanpa delegasi: mengelola akses cabang ditolak 403 DELEGATION_REQUIRED", noDlg.status === 403 && noDlg.json?.code === "DELEGATION_REQUIRED", `${noDlg.status} ${noDlg.json?.code}`);
  ok("ADMIN LIMITED tanpa delegasi: override & daftar pengelolaan & info cabang ditolak", (await adminLtd.c.put(`${A}/access/${staffM.id}/permission-overrides/interbranch.read`, { effect: "GRANT" })).json?.code === "DELEGATION_REQUIRED" && (await adminLtd.c.get(`${A}/authorization/users`)).status === 403 && (await adminLtd.c.patch(`${A}/branches/${metro}`, { name: "X" })).status === 403);
  const meAdminAll = (await adminAll.c.get(`${A}/authorization/me`)).json;
  const meOwner = (await owner.get(`${A}/authorization/me`)).json;
  ok("delegation.manage hanya OWNER: ADMIN (scope ALL pun) tidak memilikinya", !meAdminAll?.permissions.includes("delegation.manage") && meOwner?.permissions.includes("delegation.manage") && meOwner?.canDelegate === true);
  const allDelegate = await adminAll.c.post(`${A}/delegations`, { granteeUserId: adminInfo.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] });
  const ltdDelegate = await adminLtd.c.post(`${A}/delegations`, { granteeUserId: adminInfo.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] });
  ok("ADMIN ALL maupun ADMIN LIMITED tidak dapat membuat delegasi (403)", allDelegate.status === 403 && ltdDelegate.status === 403, `${allDelegate.status}/${ltdDelegate.status}`);
  ok("ADMIN ALL tetap mengelola akses cabang tanpa delegasi (perilaku lama)", (await adminAll.c.post(`${A}/access/${staffBl.id}/branches`, { branchId: bl })).status === 201);
  await adminAll.c.del(`${A}/access/${staffBl.id}/branches/${bl}`, { reason: "reset uji" });

  // ---------------- delegasi Revisi 5 oleh OWNER
  const dOk = await owner.post(`${A}/delegations`, { granteeUserId: adminLtd.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro, bl], reason: "pengelola cabang" });
  ok("OWNER mendelegasikan manage_users (Metro+Bandar Lampung, max_role STAFF)", dOk.status === 201, dOk.text.slice(0, 100));
  const meD = (await adminLtd.c.get(`${A}/authorization/me`)).json;
  ok("delegasi terbaca: kapabilitas, max_role, cabang efektif; role tetap ADMIN dan tak punya delegation.manage", meD?.role === "ADMIN" && meD.delegation?.maxRole === "STAFF" && meD.delegation.capabilities.join() === "manage_users" && meD.delegation.effectiveBranchIds.manage_users.sort().join() === [metro, bl].sort().join() && !meD.permissions.includes("delegation.manage"));
  ok("admin LIMITED berdelegasi menambah staf ke Metro", (await adminLtd.c.post(`${A}/access/${staffM.id}/branches`, { branchId: metro })).status === 201);
  ok("admin LIMITED berdelegasi menambah staf ke Bandar Lampung", (await adminLtd.c.post(`${A}/access/${staffBl.id}/branches`, { branchId: bl })).status === 201);
  const kRes = await adminLtd.c.post(`${A}/access/${staffM.id}/branches`, { branchId: kotabumi });
  const hRes = await adminLtd.c.post(`${A}/access/${staffM.id}/branches`, { branchId: hq });
  ok("cabang di luar delegasi (Kotabumi, Pusat) ditolak 404 seragam", kRes.status === 404 && hRes.status === 404, `${kRes.status}/${hRes.status}`);
  ok("tidak dapat mengubah akses diri sendiri / memberi scope ALL", (await adminLtd.c.post(`${A}/access/${adminLtd.id}/branches`, { branchId: metro })).status === 403 && (await adminLtd.c.put(`${A}/access/${staffM.id}/branch-scope`, { scope: "ALL" })).status === 403);
  const exceed = await adminLtd.c.post(`${A}/access/${accountantK.id}/branches`, { branchId: metro });
  ok("peran target di atas max_role (ACCOUNTANT > STAFF) ditolak ROLE_EXCEEDS_DELEGATION", exceed.status === 403 && exceed.json?.code === "ROLE_EXCEEDS_DELEGATION", `${exceed.status} ${exceed.json?.code}`);

  // ---------------- pencabutan akses saat sesi hidup
  const sBefore = await staffM.c.get(`${A}/branches`, { headers: { "X-Branch-Context": metro } });
  ok("staf Metro: akses aktif sebelum dicabut", sBefore.status === 200);
  await adminLtd.c.del(`${A}/access/${staffM.id}/branches/${metro}`, { reason: "uji e2e" });
  const sAfter = await staffM.c.get(`${A}/branches`, { headers: { "X-Branch-Context": metro } });
  ok("akses dicabut -> request berikutnya (sesi sama) 403 BRANCH_CONTEXT_INVALID", sAfter.status === 403 && sAfter.json?.code === "BRANCH_CONTEXT_INVALID");
  ok("akses dicabut -> cabang itu 404 pada URL", (await staffM.c.get(`${A}/branches/${metro}`)).status === 404);
  await owner.post(`${A}/access/${staffM.id}/branches`, { branchId: metro });

  // ---------------- override permission
  const me0 = (await staffM.c.get(`${A}/authorization/me`)).json;
  ok("STAFF bawaan: tidak punya interbranch.approve", me0.permissions && !me0.permissions.includes("interbranch.approve"));
  ok("OWNER GRANT interbranch.approve ke staf", (await owner.put(`${A}/access/${staffM.id}/permission-overrides/interbranch.approve`, { effect: "GRANT", reason: "e2e" })).status === 201);
  const meG = (await staffM.c.get(`${A}/authorization/me`)).json;
  ok("override berlaku di sesi yang sama; peran tetap STAFF", meG?.permissions.includes("interbranch.approve") && meG?.role === "STAFF");
  ok("OWNER DENY interbranch.approve pada akuntan", (await owner.put(`${A}/access/${accountantK.id}/permission-overrides/interbranch.approve`, { effect: "DENY" })).status === 201 && !(await accountantK.c.get(`${A}/authorization/me`)).json?.permissions.includes("interbranch.approve"));
  const adm = await owner.put(`${A}/access/${staffM.id}/permission-overrides/backup.restore`, { effect: "GRANT" });
  ok("permission administratif tidak dapat di-override (403 PERMISSION_NOT_OVERRIDABLE)", adm.status === 403 && adm.json?.code === "PERMISSION_NOT_OVERRIDABLE");
  const ownerUserId = (await owner.get("/api/auth/me")).json?.user?.id ?? (await owner.get("/api/auth/me")).json?.id;
  const oDeny = await adminAll.c.put(`${A}/access/${ownerUserId}/permission-overrides/interbranch.approve`, { effect: "DENY" });
  ok("tidak dapat DENY pada OWNER", oDeny.status === 403 && oDeny.json?.code === "OWNER_PROTECTED", `${oDeny.status} ${oDeny.json?.code}`);
  ok("STAFF tanpa users.manage tidak dapat mengatur override (403)", (await staffM.c.put(`${A}/access/${staffBl.id}/permission-overrides/interbranch.read`, { effect: "GRANT" })).status === 403);
  const vOv = await owner.put(`${A}/access/${viewer.id}/permission-overrides/interbranch.approve`, { effect: "GRANT" });
  ok("VIEWER tidak dapat menerima permission tulis (403 READ_ONLY_ROLE)", vOv.status === 403 && vOv.json?.code === "READ_ONLY_ROLE");
  ok("admin berdelegasi mengatur override user dalam cakupannya", (await adminLtd.c.put(`${A}/access/${staffBl.id}/permission-overrides/interbranch.create`, { effect: "DENY" })).status === 201);
  const ovOut = await adminLtd.c.put(`${A}/access/${accountantK.id}/permission-overrides/interbranch.read`, { effect: "GRANT" });
  ok("admin berdelegasi: override user di luar cakupan/peran ditolak", ovOut.status === 403, `${ovOut.status} ${ovOut.json?.code}`);
  ok("pencabutan override berlaku seketika", (await owner.del(`${A}/access/${staffM.id}/permission-overrides/interbranch.approve`, { reason: "selesai" })).status === 200 && !(await staffM.c.get(`${A}/authorization/me`)).json?.permissions.includes("interbranch.approve"));

  // ---------------- pelanggaran batas delegasi (oleh OWNER: validasi dasar tetap berlaku)
  const viol = [
    ["ALL_BRANCH (scopeAll)", { capabilities: ["manage_users"], maxRole: "STAFF", scopeAll: true, branchIds: [] }, "SCOPE_ALL_NOT_ALLOWED"],
    ["cabang tidak ada", { capabilities: ["manage_users"], maxRole: "STAFF", branchIds: ["tidak-ada"] }, "BRANCH_OUT_OF_SCOPE"],
    ["cabang perusahaan lain", { capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [foreignBranch] }, "BRANCH_OUT_OF_SCOPE"],
    ["kapabilitas = permission (users.manage)", { capabilities: ["users.manage"], maxRole: "STAFF", branchIds: [metro] }, "CAPABILITY_INVALID"],
    ["kapabilitas backup.restore", { capabilities: ["backup.restore"], maxRole: "STAFF", branchIds: [metro] }, "CAPABILITY_INVALID"],
    ["max_role ADMIN", { capabilities: ["manage_users"], maxRole: "ADMIN", branchIds: [metro] }, "MAX_ROLE_INVALID"],
    ["max_role OWNER", { capabilities: ["manage_users"], maxRole: "OWNER", branchIds: [metro] }, "MAX_ROLE_INVALID"],
  ];
  for (const [label, payload, code] of viol) {
    const r = await owner.post(`${A}/delegations`, { granteeUserId: adminInfo.id, ...payload });
    ok(`pelanggaran batas ditolak: ${label}`, r.status === 403 && r.json?.code === code, `${r.status} ${r.json?.code}`);
  }
  const toStaff = await owner.post(`${A}/delegations`, { granteeUserId: staffM.id, capabilities: ["inter_branch"], maxRole: "VIEWER", branchIds: [metro] });
  ok("penerima STAFF ditolak ROLE_NOT_ELIGIBLE", toStaff.status === 403 && toStaff.json?.code === "ROLE_NOT_ELIGIBLE");
  const toAcct = await owner.post(`${A}/delegations`, { granteeUserId: accountantK.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [kotabumi] });
  ok("ACCOUNTANT + manage_users ditolak CAPABILITY_NOT_APPLICABLE (irisan dengan permission peran)", toAcct.status === 403 && toAcct.json?.code === "CAPABILITY_NOT_APPLICABLE");
  const toOwner = await owner.post(`${A}/delegations`, { granteeUserId: ownerUserId, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] });
  ok("delegasi ke OWNER / diri sendiri ditolak", toOwner.status === 403);
  ok("delegasi ke user perusahaan lain ditolak (404)", (await owner.post(`${A}/delegations`, { granteeUserId: outsiderB.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] })).status === 404);
  ok("akses cabang & override ke user perusahaan lain ditolak (404)", (await owner.post(`${A}/access/${outsiderB.id}/branches`, { branchId: metro })).status === 404 && (await owner.put(`${A}/access/${outsiderB.id}/permission-overrides/interbranch.read`, { effect: "GRANT" })).status === 404);
  ok("cabang perusahaan A tidak sah dipakai pada delegasi perusahaan B", [403, 404].includes((await owner.post(`${B}/delegations`, { granteeUserId: outsiderB.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] })).status));
  ok("delegasi aktif ganda untuk penerima yang sama ditolak (409)", (await owner.post(`${A}/delegations`, { granteeUserId: adminLtd.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] })).status === 409);

  // ---------------- manage_branch_info
  const dInfo = await owner.post(`${A}/delegations`, { granteeUserId: adminInfo.id, capabilities: ["manage_branch_info"], maxRole: "STAFF", branchIds: [metro] });
  ok("OWNER mendelegasikan manage_branch_info untuk Metro", dInfo.status === 201);
  ok("manage_branch_info: ubah info Metro berhasil", (await adminInfo.c.patch(`${A}/branches/${metro}`, { address: "Jl. Uji 1" })).status === 200);
  ok("manage_branch_info: cabang lain 404, urutan 403, kelola user 403", (await adminInfo.c.patch(`${A}/branches/${bl}`, { address: "x" })).status === 404 && (await adminInfo.c.patch(`${A}/branches/${metro}`, { sortOrder: 5 })).status === 403 && (await adminInfo.c.post(`${A}/access/${staffM.id}/branches`, { branchId: metro })).status === 403);

  // ---------------- kedalaman 1 dan eskalasi peran
  const chain = await adminLtd.c.post(`${A}/delegations`, { granteeUserId: accountantK.id, capabilities: ["inter_branch"], maxRole: "STAFF", branchIds: [metro] });
  ok("rantai delegasi: penerima delegasi tidak dapat mendelegasikan lagi (403)", chain.status === 403);
  const esc1 = await staffM.c.patch(`${A}/access/${staffM.id}`, { role: "ADMIN" });
  const esc2 = await adminLtd.c.patch(`${A}/access/${ownerUserId}`, { role: "STAFF" });
  const esc3 = await adminLtd.c.post(`${A}/access`, { userId: outsiderB.id, role: "OWNER" });
  const esc4 = await adminAll.c.patch(`${A}/access/${staffM.id}`, { role: "OWNER" });
  ok("eskalasi peran ditolak: STAFF->ADMIN, ADMIN mengubah OWNER, admin berdelegasi memberi akses OWNER, ADMIN->OWNER", [esc1, esc2, esc3, esc4].every((r) => r.status === 403), `${esc1.status}/${esc2.status}/${esc3.status}/${esc4.status}`);
  ok("peran tidak berubah setelah percobaan eskalasi", (await staffM.c.get(`${A}/authorization/me`)).json?.role === "STAFF" && (await adminLtd.c.get(`${A}/authorization/me`)).json?.role === "ADMIN");

  // ---------------- pencabutan delegasi saat sesi hidup
  const delId = dOk.json?.id;
  ok("pihak tak berwenang tidak dapat mencabut delegasi orang lain (404)", (await accountantK.c.del(`${A}/delegations/${delId}`)).status === 404 && (await adminAll.c.del(`${A}/delegations/${delId}`)).status === 404);
  ok("OWNER mencabut delegasi", (await owner.del(`${A}/delegations/${delId}`, { reason: "kembali dari cuti" })).status === 200);
  const afterRevoke = await adminLtd.c.post(`${A}/access/${staffBl.id}/branches`, { branchId: bl });
  ok("delegasi dicabut -> kewenangan hilang pada request berikutnya (sesi sama): 403 DELEGATION_REQUIRED", afterRevoke.status === 403 && afterRevoke.json?.code === "DELEGATION_REQUIRED", `${afterRevoke.status} ${afterRevoke.json?.code}`);
  ok("delegasi yang sudah dicabut tidak dapat dicabut lagi (404)", (await owner.del(`${A}/delegations/${delId}`)).status === 404);

  // ---------------- delegasi tidak memperluas cakupan: akses penerima dikurangi -> cakupan efektif menyusut
  await owner.post(`${A}/delegations`, { granteeUserId: adminLtd.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro, bl] });
  await owner.del(`${A}/access/${adminLtd.id}/branches/${bl}`);
  const shrunk = (await adminLtd.c.get(`${A}/authorization/me`)).json;
  const shrunkTry = await adminLtd.c.post(`${A}/access/${staffBl.id}/branches`, { branchId: bl });
  ok("akses cabang penerima dikurangi -> cakupan delegasi menyusut otomatis (Bandar Lampung tertutup)", shrunk?.delegation?.effectiveBranchIds.manage_users.join() === metro && shrunkTry.status === 404, `${shrunkTry.status}`);

  // ---------------- daftar user tersaring
  const listLtd = (await adminLtd.c.get(`${A}/authorization/users`)).json?.users ?? [];
  const ids = listLtd.map((u) => u.userId);
  ok("daftar user admin berdelegasi tersaring (tanpa OWNER/ACCOUNTANT Kotabumi/ALL)", !ids.includes(ownerUserId) && !ids.includes(accountantK.id) && !ids.includes(adminAll.id), `${ids.length} user`);
  ok("STAFF tidak dapat membuka daftar pengelolaan (403)", (await staffM.c.get(`${A}/authorization/users`)).status === 403);
  ok("pemilik perusahaan B tidak dapat membaca otorisasi A", (await outsiderB.c.get(`${A}/authorization/me`)).status === 404);

  // ---------------- regresi endpoint lama
  const reports = await owner.get(`${A}/reports/balance-sheet?fromDate=2021-01-01&toDate=2026-12-31`);
  ok("regresi: Neraca (akun ALL) tetap berfungsi", reports.status === 200);
  const denied = await staffM.c.get(`${A}/reports/balance-sheet?fromDate=2021-01-01&toDate=2026-12-31`);
  ok("regresi: LIMITED tetap ditolak di laporan (deny-by-default)", denied.status === 403 && denied.json?.code === "BRANCH_SCOPE_UNSUPPORTED");

  // ---------------- selector cabang aktif: kontrak server (dipakai UI)
  const ctxOwner = (await owner.get(`${A}/branch-context`)).json;
  ok("branch-context: daftar cabang + status operasional + konteks tervalidasi server", ctxOwner?.branches.length === 4 && ctxOwner.context?.id === hq && ctxOwner.branches.every((b) => typeof b.operational === "boolean"));
  const sw = await adminLtd.c.put(`${A}/branch-context`, { branchId: metro });
  ok("memilih cabang aktif yang sah berhasil dan tersimpan sebagai preferensi server", sw.status === 200 && (await adminLtd.c.get(`${A}/branch-context`)).json?.context?.id === metro);
  ok("memilih cabang di luar akses ditolak (404) walau UI mengirim id-nya", (await adminLtd.c.put(`${A}/branch-context`, { branchId: kotabumi })).status === 404);

  // ---------------- latensi guard (pembacaan override+delegasi tiap request)
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await staffM.c.get(`${A}/authorization/me`);
  const avg = (Date.now() - t0) / 60;
  ok("latensi rata-rata /authorization/me < 100 ms (tanpa cache, 60 panggilan)", avg < 100, `${avg.toFixed(1)} ms`);

  // ---------------- audit trail di System DB
  const sys2 = new Database(`${WORK}/terra-system.sqlite`, { readonly: true });
  const cnt = (a) => sys2.prepare("SELECT COUNT(*) FROM system_audit_log WHERE action = ?").pluck().get(a);
  for (const a of ["user_branch.access_granted", "user_branch.access_revoked", "permission_override.created", "permission_override.revoked", "delegation.created", "delegation.revoked"]) {
    ok(`audit tercatat: ${a}`, cnt(a) >= 1, `${cnt(a)} baris`);
  }
  await sleep(300);
  ok("audit pelanggaran batas tercatat (security.authorization_boundary_denied)", cnt("security.authorization_boundary_denied") >= 3, `${cnt("security.authorization_boundary_denied")} baris`);
  const sample = sys2.prepare("SELECT actor_id, target_user_id, action, after_json, reason, created_at FROM system_audit_log WHERE action = 'delegation.created' ORDER BY created_at LIMIT 1").get();
  ok("audit delegasi memuat aktor, target, kapabilitas, max_role, cabang, waktu, alasan", sample?.actor_id && sample?.target_user_id && /manage_users/.test(sample.after_json) && /maxRole/.test(sample.after_json) && /branchIds/.test(sample.after_json) && sample.created_at && sample.reason);
  const allAudit = sys2.prepare("SELECT group_concat(COALESCE(before_json,'') || COALESCE(after_json,'') || COALESCE(reason,'')) FROM system_audit_log WHERE action LIKE 'delegation.%' OR action LIKE 'permission_override.%' OR action LIKE 'user_branch.%'").pluck().get() ?? "";
  ok("audit tanpa password/token/secret", !/password|token|secret|cookie|Rahasia#2026/i.test(allAudit));
  const flag = new Database(`${WORK}/companies/pt-terra-nusantara/company.db`, { readonly: true }).prepare("SELECT multi_branch_enabled FROM company_profile").pluck().get();
  ok("multi_branch_enabled hanya menyala pada SALINAN uji ini (data produksi tidak disentuh)", flag === 1);
  sys2.close();

  // header origin guard tetap berlaku untuk route baru
  const foreign = await fetch(BASE + `${A}/delegations`, { method: "POST", headers: { Cookie: owner.cookie, Origin: "http://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ granteeUserId: staffM.id, capabilities: ["inter_branch"], maxRole: "VIEWER", branchIds: [metro] }) });
  ok("origin guard: Origin asing ke POST /delegations ditolak 403", foreign.status === 403, String(foreign.status));
} catch (err) {
  console.log("ERROR", err);
  ok("e2e tanpa error tak terduga", false, String(err));
}

srv.kill("SIGTERM");
await sleep(2500);
try { srv.kill("SIGKILL"); } catch {}
await sleep(500);

// ---------------- integritas setelah server berhenti
const integ = (file) => {
  const db = new Database(file, { readonly: true });
  const r = { integrity: db.prepare("PRAGMA integrity_check").pluck().get(), fk: db.prepare("PRAGMA foreign_key_check").all().length };
  db.close();
  return r;
};
const iSys = integ(`${WORK}/terra-system.sqlite`);
const iCo = integ(`${WORK}/companies/pt-terra-nusantara/company.db`);
ok("PRAGMA integrity_check & foreign_key_check: system DB", iSys.integrity === "ok" && iSys.fk === 0, JSON.stringify(iSys));
ok("PRAGMA integrity_check & foreign_key_check: company.db", iCo.integrity === "ok" && iCo.fk === 0, JSON.stringify(iCo));
const after = countsOf(`${WORK}/companies/pt-terra-nusantara/company.db`);
ok("data akuntansi tidak berubah oleh Phase 3 (jurnal & baris identik, akun +0)", after.journals === before.journals && after.lines === before.lines && after.accounts === before.accounts, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

fs.writeFileSync(`${ROOT}/docs/uat/evidence-multibranch/phase3-e2e-result${process.env.PACKAGED === "1" ? "-electron" : ""}.json`, JSON.stringify({ runtime: process.env.PACKAGED === "1" ? "electron-packaged" : "node", before, after, results }, null, 1));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} lulus`);
