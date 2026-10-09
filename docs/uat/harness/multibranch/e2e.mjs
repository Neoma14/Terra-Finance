// E2E keamanan Multi-Branch terhadap SERVER HASIL BUILD (HTTP sungguhan: CORS/origin guard, rate limit, static) pada salinan data UAT.
// Memakai data hasil migrasi di mbverify/data (salinan; bukan produksi, bukan port 4000).
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad";
const WORK = `${S}/mbverify/data`;
const PORT = 4510;
const BASE = `http://127.0.0.1:${PORT}`;
const A = "/api/company-db/pt-terra-nusantara";
const B = "/api/company-db/pt-pembanding";
const req = createRequire(`${ROOT}/apps/api/package.json`);
const Database = req("better-sqlite3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = {
  ...process.env, NODE_ENV: "production", PORT: String(PORT),
  DB_FILE_PATH: `${WORK}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${WORK}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${WORK}/companies`,
  STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("mbverify-secret").digest("hex"),
};
const log = fs.openSync(`${S}/mbverify/server-e2e.log`, "w");
// PACKAGED=1: jalankan server DARI INSTALLER (runtime Electron + better-sqlite3 hasil rebuild), bukan node dev.
const PKG = `${ROOT}/apps/desktop/dist/win-unpacked`;
if (process.env.PACKAGED === "1") { env.ELECTRON_RUN_AS_NODE = "1"; env.STATIC_WEB_DIR = `${PKG}/resources/web/dist`; }
const srv = process.env.PACKAGED === "1"
  ? spawn(`${PKG}/TERRA FINANCE.exe`, [`${PKG}/resources/api/dist/server.js`], { env, stdio: ["ignore", log, log] })
  : spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", log, log] });
let healthy = false;
for (let i = 0; i < 150 && !healthy; i++) { try { healthy = (await fetch(`${BASE}/api/health`)).ok; } catch {} if (!healthy) await sleep(400); }
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
    for (let attempt = 0; attempt < 3; attempt++) {
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
  del(p, body, o = {}) { return this.req("DELETE", p, { ...o, body }); }
}

try {
  const owner = new Client();
  ok("login pemilik", (await owner.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" })).status === 200);

  // aktifkan multi-cabang & buat cabang
  ok("hanya OWNER: multi-cabang menyala", (await owner.put(`${A}/multi-branch`, { enabled: true })).json?.multiBranchEnabled === true);
  const mk = async (code, name) => (await owner.post(`${A}/branches`, { code, name })).json?.id;
  const metro = await mk("METRO", "Cabang Metro");
  const bl = await mk("BL", "Bandar Lampung");
  const kotabumi = await mk("KOTABUMI", "Cabang Kotabumi");
  ok("3 cabang dibuat", metro && bl && kotabumi);

  // user staf (LIMITED) + user lain perusahaan
  const email = (n) => `${n}.${Date.now()}@mb.test`;
  const staffEmail = email("staf");
  const mkUser = async (e, name) => (await owner.post("/api/users", { email: e, password: "Rahasia#2026", fullName: name, role: "staff" })).json?.userId;
  const staffId = await mkUser(staffEmail, "Staf Metro");
  const grant = await owner.post(`${A}/access`, { userId: staffId, role: "ACCOUNTANT" });
  ok("user baru diberi akses perusahaan", grant.status === 201);
  const dbSys = new Database(`${WORK}/terra-system.sqlite`, { readonly: true });
  const scope = dbSys.prepare("SELECT branch_scope FROM company_access WHERE system_user_id = ?").pluck().get(staffId);
  dbSys.close();
  ok("user baru otomatis LIMITED saat multi-cabang aktif (fail-closed)", scope === "LIMITED", scope);

  const staff = new Client();
  ok("login staf", (await staff.post("/api/auth/login", { email: staffEmail, password: "Rahasia#2026" })).status === 200);
  const noAccess = await staff.get(`${A}/branch-context`);
  ok("staf tanpa cabang: tidak ada konteks", noAccess.json?.context === null && noAccess.json?.branches.length === 0);
  const writeNoCtx = await staff.post(`${A}/journal`, { referenceNo: "E2E-0", periodId: "x", entryDate: "2026-01-02", lines: [{ accountId: "a", debit: 1, credit: 0 }, { accountId: "b", debit: 0, credit: 1 }] });
  ok("staf tanpa cabang: tulis jurnal ditolak 403 BRANCH_CONTEXT_INVALID", writeNoCtx.status === 403 && writeNoCtx.json?.code === "BRANCH_CONTEXT_INVALID");

  ok("pemilik memberi akses Metro", (await owner.post(`${A}/access/${staffId}/branches`, { branchId: metro })).status === 201);
  const ctx = await staff.get(`${A}/branch-context`);
  ok("staf kini punya konteks Metro dan hanya melihat Metro", ctx.json?.context?.code === "METRO" && ctx.json?.branches.length === 1);

  // data nyata: ambil dua akun & periode dari company
  const accounts = (await owner.get(`${A}/accounts?pageSize=10&isActive=true`)).json?.accounts ?? [];
  const periods = (await owner.get(`${A}/periods`)).json?.periods ?? [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const startOf = (p) => String(p.start_date ?? p.startDate).slice(0, 10);
  const open = periods.filter((p) => p.status === "OPEN" && startOf(p) <= todayIso).pop() ?? periods.filter((p) => startOf(p) <= todayIso).pop();
  const dateIn = String(open.start_date ?? open.startDate).slice(0, 10);
  const [a1, a2] = accounts.filter((a) => a.branchPolicy === "ALL_BRANCH");
  const body = (extra = {}) => ({ referenceNo: `E2E-${crypto.randomUUID().slice(0, 8)}`, periodId: open.id, entryDate: dateIn, lines: [{ accountId: a1.id, debit: 1000, credit: 0 }, { accountId: a2.id, debit: 0, credit: 1000 }], ...extra });

  const created = await staff.post(`${A}/journal`, body());
  ok("staf membuat jurnal -> masuk cabang Metro", created.status === 201, created.status + " " + created.text.slice(0, 200));
  const dbA = new Database(`${WORK}/companies/pt-terra-nusantara/company.db`, { readonly: true });
  const row = dbA.prepare("SELECT branch_id, origin FROM journal_entries WHERE id = ?").get(created.json?.journalId);
  ok("jurnal tersimpan dengan branch_id Metro, origin manual", row?.branch_id === metro && row?.origin === "manual");

  // tampering
  const t1 = await staff.post(`${A}/journal`, body({ branchId: kotabumi }));
  ok("TAMPERING branchId (cabang di luar akses) -> 404", t1.status === 404, String(t1.status));
  const t2 = await staff.post(`${A}/journal`, body(), { headers: { "X-Branch-Context": kotabumi } });
  ok("TAMPERING header konteks -> 403 BRANCH_CONTEXT_INVALID", t2.status === 403 && t2.json?.code === "BRANCH_CONTEXT_INVALID");
  const hqId = (await owner.get(`${A}/branch-context`)).json?.headOfficeBranchId;
  const t3 = await staff.post(`${A}/journal`, body({ branchId: hqId }));
  ok("TAMPERING ke Kantor Pusat -> 404", t3.status === 404);
  const t4 = await staff.get(`${A}/branches/${kotabumi}`);
  const t5 = await staff.get(`${A}/branches/tidak-ada`);
  ok("IDOR cabang: cabang lain & tidak-ada tak terbedakan (404 identik)", t4.status === 404 && t5.status === 404 && t4.text === t5.text);

  // IDOR jurnal cabang lain: ambil satu jurnal Pusat dari data UAT
  const hqJournal = (await owner.get(`${A}/journals?pageSize=1`)).json?.journals?.[0];
  const i1 = await staff.get(`${A}/journals/${hqJournal.id}`);
  const i2 = await staff.post(`${A}/journal/${hqJournal.id}/post`);
  const i3 = await staff.post(`${A}/journal/${hqJournal.id}/reverse`, { reason: "uji idor" });
  ok("IDOR jurnal Pusat oleh staf Metro: baca/post/reverse -> 404", i1.status === 404 && i2.status === 404 && i3.status === 404, `${i1.status}/${i2.status}/${i3.status}`);
  const q = await staff.get(`${A}/journals?branchId=${hqId}`);
  ok("daftar jurnal ?branchId=Pusat oleh staf Metro -> 404", q.status === 404);

  // Phase 5A/5B: laporan/dashboard/pencarian/ledger/ekspor/saldo counterparty kini SADAR-CABANG untuk LIMITED (disaring server);
  // route level perusahaan (audit log, analisis, proyeksi, pajak) tetap ditolak (deny by default).
  const denied = [];
  for (const p of ["/audit-log", "/analysis?fromDate=2026-01-01&toDate=2026-12-31", "/projection", "/tax-summary?fromDate=2026-01-01&toDate=2026-12-31"]) {
    const r = await staff.get(A + p);
    if (r.status !== 403 || r.json?.code !== "BRANCH_SCOPE_UNSUPPORTED") denied.push(`${p} -> ${r.status}`);
  }
  ok("LIMITED ditolak di route level perusahaan (audit log, analisis, proyeksi, pajak) -- deny by default", denied.length === 0, denied.join(" | "));
  const scopedUrls = ["/reports/balance-sheet?fromDate=2021-01-01&toDate=2026-12-31", "/dashboard?fromDate=2026-01-01&toDate=2026-12-31", "/counterparties/balances?type=vendor", `/ledger/${a1.id}?fromDate=2021-01-01&toDate=2026-12-31`, "/reports/export/balance-sheet?format=xlsx&fromDate=2021-01-01&toDate=2026-12-31"];
  const scopedBad = [];
  for (const p of scopedUrls) {
    const own = await staff.get(A + p);
    if (own.status !== 200) scopedBad.push(`${p} (cabang sendiri) -> ${own.status}`);
    const other = await staff.get(`${A}${p}${p.includes("?") ? "&" : "?"}scope=branch:${hqId}`);
    if (other.status !== 404) scopedBad.push(`${p}&scope=Pusat -> ${other.status}`);
    const all = await staff.get(`${A}${p}${p.includes("?") ? "&" : "?"}scope=all`);
    if (all.status !== 403) scopedBad.push(`${p}&scope=all -> ${all.status}`);
  }
  ok("LIMITED: laporan/dashboard/counterparty/ledger/ekspor hanya cabang sendiri (200); cabang lain 404; gabungan seluruh 403", scopedBad.length === 0, scopedBad.join(" | "));
  const srch = await staff.get(`${A}/search?q=kas`);
  ok("LIMITED: pencarian terbuka dan tidak memuat jurnal cabang lain", srch.status === 200 && !JSON.stringify(srch.json).includes(hqJournal.id), `${srch.status}`);

  // lintas perusahaan
  const x1 = await staff.get(`${B}/branches`);
  const x2 = await staff.get(`${B}/journals`);
  ok("staf tidak punya akses perusahaan lain (pt-pembanding) -> 404", x1.status === 404 && x2.status === 404);
  const ownerOther = new Client();
  const crossBranch = await owner.post(`${B}/journal`, body({ branchId: metro }));
  ok("id cabang perusahaan A dipakai di perusahaan B -> ditolak (tidak 201)", crossBranch.status >= 400 && crossBranch.status !== 500, String(crossBranch.status));

  // kebijakan akun
  const modal = accounts.find((a) => /modal/i.test(a.name)) ?? a1;
  const staffPolicy = await staff.put(`${A}/accounts/${modal.id}/branch-policy`, { policy: "CENTRAL_ONLY", reason: "coba-coba" });
  ok("staf tidak dapat mengubah kebijakan akun (403)", staffPolicy.status === 403);
  const setPol = await owner.put(`${A}/accounts/${a2.id}/branch-policy`, { policy: "CENTRAL_ONLY", reason: "uji e2e" });
  ok("OWNER mengubah kebijakan akun menjadi CENTRAL_ONLY", setPol.status === 200);
  const violate = await staff.post(`${A}/journal`, body());
  ok("jurnal staf Metro ke akun CENTRAL_ONLY ditolak 400 ACCOUNT_POLICY_VIOLATION", violate.status === 400 && violate.json?.code === "ACCOUNT_POLICY_VIOLATION", violate.status + " " + violate.text.slice(0, 200));
  const hqOk = await owner.post(`${A}/journal`, body());
  ok("jurnal Kantor Pusat ke akun CENTRAL_ONLY diterima", hqOk.status === 201);
  await owner.put(`${A}/accounts/${a2.id}/branch-policy`, { policy: "ALL_BRANCH", reason: "kembalikan" });

  // akun antar-cabang: counterpart palsu & penyalahgunaan
  const forged = await owner.put(`${A}/accounts/${a1.id}/branch-policy`, { policy: "INTER_BRANCH", counterpartBranchId: "cabang-perusahaan-lain", reason: "uji" });
  ok("INTER_BRANCH dengan counterpart palsu/lintas perusahaan ditolak 400", forged.status === 400);
  const preview = await owner.post(`${A}/accounts/inter-branch/preview`, { branchAId: metro, branchBId: bl, accountTypeCode: "LIABILITY", codeCounterpartB: "IBP-BL", codeCounterpartA: "IBP-METRO" });
  ok("pembuatan terpandu: preview tidak membuat akun", preview.status === 200 && preview.json?.canConfirm === true);
  const noConfirm = await owner.post(`${A}/accounts/inter-branch`, { branchAId: metro, branchBId: bl, accountTypeCode: "LIABILITY", confirm: false });
  ok("tanpa konfirmasi ditolak", noConfirm.status === 400);
  const confirmed = await owner.post(`${A}/accounts/inter-branch`, { branchAId: metro, branchBId: bl, accountTypeCode: "LIABILITY", codeCounterpartB: "IBP-BL", codeCounterpartA: "IBP-METRO", confirm: true });
  ok("dengan konfirmasi: 2 akun INTER_BRANCH dibuat", confirmed.status === 201 && confirmed.json?.created?.length === 2);
  const ibAcc = dbA.prepare("SELECT id, counterpart_branch_id FROM accounts WHERE code = 'IBP-BL'").get();
  ok("akun IBP-BL menunjuk Bandar Lampung sebagai cabang lawan (dari kolom, bukan nama)", ibAcc?.counterpart_branch_id === bl);
  const manualIb = await owner.post(`${A}/journal`, body({ lines: [{ accountId: a1.id, debit: 500, credit: 0 }, { accountId: ibAcc.id, debit: 0, credit: 500 }] }));
  ok("jurnal manual ke akun INTER_BRANCH ditolak 400", manualIb.status === 400 && manualIb.json?.code === "ACCOUNT_POLICY_VIOLATION");

  // pencabutan akses -> seketika
  await owner.del(`${A}/access/${staffId}/branches/${metro}`, { reason: "uji pencabutan" });
  const afterRevoke = await staff.post(`${A}/journal`, body(), { headers: { "X-Branch-Context": metro } });
  ok("akses dicabut -> request berikutnya ditolak seketika (sesi masih hidup)", afterRevoke.status === 403 && afterRevoke.json?.code === "BRANCH_CONTEXT_INVALID");

  // cabang CLOSED
  await owner.post(`${A}/access/${staffId}/branches`, { branchId: kotabumi });
  const closeRes = await owner.post(`${A}/branches/${kotabumi}/status`, { to: "CLOSED", reason: "uji penutupan" });
  ok("cabang kosong dapat ditutup dengan alasan", closeRes.status === 200);
  const closedWrite = await staff.post(`${A}/journal`, body(), { headers: { "X-Branch-Context": kotabumi } });
  ok("cabang CLOSED menolak jurnal manual (403)", closedWrite.status === 403);
  ok("historis cabang CLOSED tetap dapat dibaca (200)", (await staff.get(`${A}/journals?branchId=${kotabumi}`)).status === 200);
  ok("hard delete cabang CLOSED tidak ada: soft delete OWNER hanya cabang tak terpakai (akses aktif -> 409)", (await owner.del(`${A}/branches/${kotabumi}`)).status === 409);
  dbA.close();

  // header origin guard & rate limit tetap berlaku untuk route baru
  const foreign = await fetch(BASE + `${A}/branches`, { headers: { Cookie: owner.cookie, Origin: "http://evil.example" } });
  ok("origin guard: Origin asing ke route cabang ditolak 403", foreign.status === 403, String(foreign.status));
} catch (err) {
  console.log("ERROR", err);
  ok("e2e tanpa error tak terduga", false, String(err));
}

srv.kill("SIGTERM");
await sleep(2000);
try { srv.kill("SIGKILL"); } catch {}
fs.writeFileSync(`${S}/mbverify/e2e-result.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} lulus`);
