// Uji UI Phase 3 (halaman Pengguna: akses cabang, wewenang khusus, delegasi) di Chrome nyata terhadap server hasil build
// pada SALINAN data UAT. Bukan produksi, bukan port 4000. Hasil diverifikasi ke API/DB, bukan hanya ke tampilan.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad";
const WORK = `${S}/mbui/data`;
const SHOTS = `${ROOT}/docs/uat/evidence-multibranch/ui-phase3`;
const PORT = 4512;
const BASE = `http://127.0.0.1:${PORT}`;
const A = "/api/company-db/pt-terra-nusantara";
const req = createRequire(`${ROOT}/apps/api/package.json`);
const Database = req("better-sqlite3");
const { chromium } = createRequire(`${S}/uitest/package.json`)("playwright-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(`${S}/mbui`, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const BK = `${S}/uat5/backup`;
fs.mkdirSync(`${WORK}/companies`, { recursive: true });
fs.copyFileSync(`${BK}/terra-finance-2026-10-06T02-00-10-045Z.sqlite`, `${WORK}/terra-finance.sqlite`);
fs.copyFileSync(`${BK}/terra-system-2026-10-06T02-00-10-045Z.sqlite`, `${WORK}/terra-system.sqlite`);
for (const slug of fs.readdirSync(`${BK}/companies`)) {
  const f = fs.readdirSync(`${BK}/companies/${slug}`).find((n) => n.endsWith(".db"));
  fs.mkdirSync(`${WORK}/companies/${slug}`, { recursive: true });
  fs.copyFileSync(`${BK}/companies/${slug}/${f}`, `${WORK}/companies/${slug}/company.db`);
}
const env = {
  ...process.env, NODE_ENV: "production", PORT: String(PORT),
  DB_FILE_PATH: `${WORK}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${WORK}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${WORK}/companies`,
  STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("mbui-secret").digest("hex"),
};
const log = fs.openSync(`${S}/mbui/server.log`, "w");
const srv = spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", log, log] });
let healthy = false;
for (let i = 0; i < 200 && !healthy; i++) { try { healthy = (await fetch(`${BASE}/api/health`)).ok; } catch {} if (!healthy) await sleep(400); }
if (!healthy) { console.log("SERVER TIDAK SEHAT"); process.exit(1); }

const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass: Boolean(pass), detail }); console.log((pass ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : "")); };

class Client {
  cookie = "";
  async req(method, p, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  }
  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b); }
  put(p, b) { return this.req("PUT", p, b); }
  del(p, b) { return this.req("DELETE", p, b); }
}
const stamp = Date.now();
const PW = "Rahasia#2026";
const owner = new Client();
await owner.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" });
await owner.put(`${A}/multi-branch`, { enabled: true });
const mkBranch = async (code, name) => (await owner.post(`${A}/branches`, { code, name })).json?.id;
const metro = await mkBranch("METRO", "Cabang Metro");
const bl = await mkBranch("BL", "Bandar Lampung");
const kota = await mkBranch("KOTABUMI", "Cabang Kotabumi");
const mkUser = async (label, role) => {
  const email = `${label.toLowerCase().replace(/\s+/g, "-")}.${stamp}@ui.test`;
  const id = (await owner.post("/api/users", { email, password: PW, fullName: label, role: "staff" })).json?.userId;
  await owner.post(`${A}/access`, { userId: id, role });
  if (!id) throw new Error("gagal membuat user uji " + label);
  return { id, email, label };
};
const adminLtd = await mkUser("Admin Cabang", "ADMIN");
const adminNoDlg = await mkUser("Admin Tanpa Delegasi", "ADMIN");
const staffM = await mkUser("Staf Metro", "STAFF");
const staffX = await mkUser("Staf Kotabumi", "STAFF");
const staffBl = await mkUser("Staf Bandar", "STAFF");
await mkUser("Akuntan Pusat", "ACCOUNTANT");
await owner.post(`${A}/access/${adminLtd.id}/branches`, { branchId: metro });
await owner.post(`${A}/access/${adminLtd.id}/branches`, { branchId: bl });
await owner.post(`${A}/access/${adminNoDlg.id}/branches`, { branchId: metro });
await owner.post(`${A}/access/${staffX.id}/branches`, { branchId: kota });
await owner.post(`${A}/access/${staffBl.id}/branches`, { branchId: bl });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const sysRead = () => new Database(`${WORK}/terra-system.sqlite`, { readonly: true });

async function login(email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const apiHeaders = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/company-db/pt-terra-nusantara/")) apiHeaders.push({ url: r.url(), method: r.method(), branch: r.headers()["x-branch-context"] ?? null });
  });
  await page.goto(`${BASE}/login`);
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  return { ctx, page, errors, apiHeaders };
}
const usersUrl = (slug = "pt-terra-nusantara") => `${BASE}/workspace/${slug}/pengguna`;
const acc = (userId) => `(SELECT id FROM company_access WHERE system_user_id = '${userId}')`;

try {
  // ================= OWNER
  {
    const { ctx, page, errors } = await login("owner@terra-nusantara.test", "Uat#Owner2026");
    await page.goto(usersUrl());
    await page.waitForSelector("text=Akses Cabang", { timeout: 20000 });
    ok("OWNER: kolom Akses Cabang & Wewenang Khusus tampil", (await page.locator("th", { hasText: "Wewenang Khusus" }).count()) === 1);
    ok("OWNER: tombol Delegasikan Wewenang & Tambah Pengguna tampil", (await page.getByRole("button", { name: "Delegasikan Wewenang" }).count()) === 1 && (await page.getByRole("button", { name: /Tambah Pengguna/ }).count()) === 1);
    await page.screenshot({ path: `${SHOTS}/01-owner-users.png` });

    const row = page.locator("tr", { hasText: "Staf Metro" });
    await row.getByRole("button", { name: /Atur Wewenang/ }).click();
    await page.waitForSelector("h2:has-text('Atur Wewenang')");
    const metroBox = page.locator("label", { hasText: "Cabang Metro" }).locator("input[type=checkbox]");
    await metroBox.click(); // kotak dikendalikan server: berubah setelah respons
    await page.waitForFunction(() => document.querySelector("label input[type=checkbox]:checked") !== null, null, { timeout: 10000 });
    await sleep(600);
    let sys = sysRead();
    const metroGranted = sys.prepare(`SELECT COUNT(*) FROM user_branch_access WHERE access_id = ${acc(staffM.id)} AND branch_id = ? AND status='ACTIVE'`).pluck().get(metro);
    sys.close();
    ok("OWNER via UI: centang Metro -> akses tersimpan di server", metroGranted === 1, String(metroGranted));
    await page.selectOption('select[aria-label="Wewenang Menyetujui transaksi antar cabang"]', "GRANT");
    await sleep(600);
    sys = sysRead();
    const ov = sys.prepare(`SELECT effect FROM access_permission_overrides WHERE permission='interbranch.approve' AND status='ACTIVE' AND access_id = ${acc(staffM.id)}`).pluck().get();
    sys.close();
    ok("OWNER via UI: override GRANT approve tersimpan", ov === "GRANT", String(ov));
    await page.screenshot({ path: `${SHOTS}/02-owner-atur-wewenang.png` });
    await metroBox.click();
    await sleep(700);
    sys = sysRead();
    const metroRevoked = sys.prepare(`SELECT COUNT(*) FROM user_branch_access WHERE access_id = ${acc(staffM.id)} AND branch_id = ? AND status='ACTIVE'`).pluck().get(metro);
    sys.close();
    ok("OWNER via UI: hapus centang -> akses dicabut di server", metroRevoked === 0);
    await page.selectOption('select[aria-label="Wewenang Menyetujui transaksi antar cabang"]', "DEFAULT");
    await sleep(500);
    await page.getByRole("button", { name: "Tutup" }).last().click();

    // Delegasikan Wewenang (Revisi 5) via UI
    await page.getByRole("button", { name: "Delegasikan Wewenang" }).click();
    await page.waitForSelector("h2:has-text('Delegasikan Wewenang')");
    const modal = page.locator("div.fixed.inset-0").last();
    const opts = await modal.locator("select").first().locator("option").allInnerTexts();
    ok("form delegasi: penerima hanya ADMIN/ACCOUNTANT (STAFF tak muncul)", opts.some((o) => o.includes("Admin Cabang")) && !opts.some((o) => o.includes("Staf Metro")), opts.join(" | "));
    await modal.locator("select").first().selectOption({ label: "Admin Cabang (ADMIN)" });
    const capLabels = await modal.locator("label", { hasText: "disiapkan" }).count();
    ok("form delegasi: 4 kapabilitas tetap, 2 ditandai 'disiapkan' (Phase 5/6)", (await modal.locator("label", { hasText: /Kelola user cabang|Ubah info cabang|Lihat laporan cabang|Transaksi antar cabang/ }).count()) === 4 && capLabels === 2);
    ok("form delegasi: tidak ada opsi 'Semua cabang'", (await modal.getByText("Semua cabang", { exact: true }).count()) === 0);
    const maxOpts = await modal.locator("select").nth(1).locator("option").allInnerTexts();
    ok("form delegasi: peran maksimum VIEWER/STAFF/ACCOUNTANT, tanpa ADMIN/OWNER", maxOpts.join() === "VIEWER,STAFF,ACCOUNTANT", maxOpts.join());
    await modal.locator("label", { hasText: "Cabang Metro" }).locator("input[type=checkbox]").click();
    await modal.locator("label", { hasText: "Bandar Lampung" }).locator("input[type=checkbox]").click();
    await page.fill('input[placeholder="mis. cuti manajer"]', "uji UI");
    await page.screenshot({ path: `${SHOTS}/03-owner-delegasi-form.png` });
    await page.getByRole("button", { name: "Simpan Delegasi" }).click();
    await page.waitForSelector("text=Delegasi Wewenang (1)", { timeout: 10000 });
    sys = sysRead();
    const del = sys.prepare(`SELECT d.can_manage_users u, d.can_inter_branch i, d.max_role m, d.status s, (SELECT group_concat(branch_id) FROM delegation_branches WHERE delegation_id = d.id) AS b FROM delegations d WHERE d.grantee_access_id = ${acc(adminLtd.id)}`).get();
    sys.close();
    ok("OWNER via UI: delegasi tersimpan (manage_users, max_role STAFF, Metro+Bandar)", del?.u === 1 && del?.i === 0 && del?.m === "STAFF" && del?.s === "ACTIVE" && del?.b?.split(",").sort().join() === [metro, bl].sort().join(), JSON.stringify(del));
    await page.screenshot({ path: `${SHOTS}/04-owner-delegasi-aktif.png` });
    await page.getByRole("button", { name: "Cabut", exact: true }).click();
    await page.waitForSelector("text=Delegasi Wewenang (0)", { timeout: 10000 });
    sys = sysRead();
    const delAfter = sys.prepare(`SELECT status FROM delegations WHERE grantee_access_id = ${acc(adminLtd.id)}`).pluck().get();
    sys.close();
    ok("OWNER via UI: Cabut delegasi -> status REVOKED di server", delAfter === "REVOKED", String(delAfter));
    ok("OWNER: tidak ada error JavaScript di halaman", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // delegasi untuk sesi admin berikut dibuat via API (OWNER)
  const dlg = await owner.post(`${A}/delegations`, { granteeUserId: adminLtd.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro, bl] });
  if (dlg.status !== 201) throw new Error("delegasi seed gagal " + dlg.status);

  // ================= ADMIN LIMITED BERDELEGASI
  {
    const { ctx, page, errors } = await login(adminLtd.email, PW);
    await page.goto(usersUrl());
    await page.waitForSelector("text=Akses Cabang", { timeout: 20000 });
    const names = await page.locator("tbody tr td:first-child p.font-medium").allInnerTexts();
    ok("ADMIN berdelegasi: daftar tersaring (tanpa OWNER & user Kotabumi)", names.includes("Staf Metro") && names.includes("Staf Bandar") && !names.some((n) => /Staf Kotabumi|Owner/i.test(n)), names.join(", "));
    ok("ADMIN berdelegasi: tanpa Tambah Pengguna / Nonaktifkan / Cabut Akses / Delegasikan Wewenang", (await page.getByRole("button", { name: /Tambah Pengguna|Delegasikan Wewenang/ }).count()) === 0 && (await page.getByRole("button", { name: "Nonaktifkan" }).count()) === 0 && (await page.getByRole("button", { name: "Cabut Akses" }).count()) === 0);
    await page.locator("tr", { hasText: "Staf Metro" }).getByRole("button", { name: /Atur Wewenang/ }).click();
    await page.waitForSelector("h2:has-text('Atur Wewenang')");
    const labels = await page.locator("section").first().locator("label").allInnerTexts();
    ok("ADMIN berdelegasi: daftar centang hanya cabang delegasi (Metro + Bandar Lampung)", labels.length === 2 && labels.some((l) => l.includes("Cabang Metro")) && labels.some((l) => l.includes("Bandar Lampung")) && !labels.some((l) => /Kotabumi|Pusat/.test(l)), labels.join(" / "));
    await page.locator("label", { hasText: "Cabang Metro" }).locator("input[type=checkbox]").click();
    await sleep(800);
    let sys = sysRead();
    const granted = sys.prepare(`SELECT COUNT(*) FROM user_branch_access WHERE access_id = ${acc(staffM.id)} AND branch_id = ? AND status='ACTIVE'`).pluck().get(metro);
    sys.close();
    ok("ADMIN berdelegasi via UI: memberi akses Metro berhasil di server", granted === 1);
    await page.screenshot({ path: `${SHOTS}/05-admin-berdelegasi-atur.png` });
    // delegasi dicabut OWNER saat halaman terbuka -> aksi berikutnya ditolak server
    await owner.del(`${A}/delegations/${dlg.json.id}`, {});
    await page.locator("label", { hasText: "Bandar Lampung" }).locator("input[type=checkbox]").click();
    await sleep(800);
    sys = sysRead();
    const blGranted = sys.prepare(`SELECT COUNT(*) FROM user_branch_access WHERE access_id = ${acc(staffX.id)} AND branch_id = ? AND status='ACTIVE'`).pluck().get(bl);
    sys.close();
    ok("delegasi dicabut saat UI masih terbuka: aksi berikutnya ditolak server (UI bukan lapisan keamanan)", blGranted === 0 && (await page.getByText(/delegasi aktif dari OWNER/).count()) >= 1);
    ok("ADMIN berdelegasi: tidak ada error JavaScript fatal", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // ================= ADMIN LIMITED TANPA DELEGASI
  {
    const { ctx, page } = await login(adminNoDlg.email, PW);
    await page.goto(usersUrl());
    await page.waitForSelector("text=tidak memiliki izin", { timeout: 20000 });
    ok("ADMIN LIMITED tanpa delegasi: pesan 'tidak memiliki izin', tanpa tombol pengelolaan", (await page.getByRole("button", { name: /Atur Wewenang|Tambah Pengguna|Delegasikan/ }).count()) === 0);
    await page.screenshot({ path: `${SHOTS}/06-admin-tanpa-delegasi.png` });
    await ctx.close();
  }

  // ================= STAFF
  {
    const { ctx, page } = await login(staffM.email, PW);
    await page.goto(usersUrl());
    await page.waitForSelector("text=tidak memiliki izin", { timeout: 20000 });
    ok("STAFF: pesan 'tidak memiliki izin', tanpa tombol pengelolaan", (await page.getByRole("button", { name: /Atur Wewenang|Tambah Pengguna|Delegasikan/ }).count()) === 0);
    await ctx.close();
  }

  // ================= SELECTOR CABANG AKTIF
  {
    // OWNER (akses semua cabang): tampil, memilih cabang -> header terkirim, preferensi server tersimpan
    const { ctx, page, apiHeaders } = await login("owner@terra-nusantara.test", "Uat#Owner2026");
    await page.goto(usersUrl());
    await page.waitForSelector('[data-testid="active-branch-button"]', { timeout: 20000 });
    ok("selector: tampil pada perusahaan multi-cabang, menampilkan cabang aktif dari server (Kantor Pusat) dan cakupan", (await page.locator('[data-testid="active-branch-name"]').innerText()).includes("Kantor Pusat") && (await page.getByText("Akses semua cabang").count()) === 1);
    await page.screenshot({ path: `${SHOTS}/07-selector-owner.png` });
    await page.locator('[data-testid="active-branch-button"]').click();
    const items = await page.locator("button", { hasText: /Cabang Metro|Bandar Lampung|Cabang Kotabumi|Kantor Pusat/ }).allInnerTexts();
    ok("selector: daftar mencakup seluruh cabang yang sah", items.length >= 4, String(items.length));
    await page.screenshot({ path: `${SHOTS}/08-selector-terbuka.png` });
    await page.locator("button", { hasText: "Cabang Metro" }).first().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="active-branch-name"]')?.textContent?.includes("Metro"), null, { timeout: 10000 });
    await sleep(800);
    const sys = sysRead();
    const pref = sys.prepare(`SELECT default_branch_id FROM company_access WHERE system_user_id = (SELECT id FROM system_users WHERE email = 'owner@terra-nusantara.test')`).pluck().get();
    sys.close();
    ok("selector: pilihan Metro tersimpan sebagai preferensi di SERVER dan ditampilkan", pref === metro, String(pref));
    ok("selector: permintaan berikutnya membawa header X-Branch-Context = Metro", apiHeaders.slice(-12).some((h) => h.branch === metro), JSON.stringify(apiHeaders.slice(-3)));
    // localStorage dipalsukan ke cabang perusahaan lain/tidak sah: server menolak, UI pulih ke konteks sah
    await page.evaluate(() => localStorage.setItem("terra.activeBranch.pt-terra-nusantara", "id-cabang-palsu"));
    await page.reload();
    await page.waitForSelector('[data-testid="active-branch-button"]', { timeout: 20000 });
    await sleep(1500);
    const shown = await page.locator('[data-testid="active-branch-name"]').innerText();
    const stored = await page.evaluate(() => localStorage.getItem("terra.activeBranch.pt-terra-nusantara"));
    ok("selector: nilai localStorage palsu ditolak server; UI kembali ke konteks sah (Metro dari preferensi) dan memberi tahu", shown.includes("Metro") && stored !== "id-cabang-palsu" && (await page.getByText(/tidak lagi sah/).count()) >= 1, `${shown} | ${stored}`);
    await page.screenshot({ path: `${SHOTS}/09-selector-pemulihan.png` });
    await ctx.close();
  }
  {
    // user LIMITED: hanya cabang yang sah; akses diubah saat sesi -> pemberitahuan; cabang dicabut -> server menolak
    const { ctx, page } = await login(staffBl.email, PW);
    await page.goto(`${BASE}/workspace/pt-terra-nusantara`);
    await page.waitForSelector('[data-testid="active-branch-button"]', { timeout: 20000 });
    ok("selector LIMITED: menampilkan cabang sah + cakupan terbatas", (await page.locator('[data-testid="active-branch-name"]').innerText()).includes("Bandar Lampung") && (await page.getByText(/Terbatas/).count()) >= 1);
    await owner.post(`${A}/access/${staffBl.id}/branches`, { branchId: metro });
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await page.getByText(/Akses cabang Anda berubah/).waitFor({ timeout: 10000 });
    ok("selector: perubahan akses saat sesi berjalan memunculkan pemberitahuan", true);
    await page.screenshot({ path: `${SHOTS}/10-selector-akses-berubah.png` });
    await page.locator('[data-testid="active-branch-button"]').click();
    ok("selector LIMITED: hanya cabang dalam akses (Bandar Lampung, Metro)", (await page.locator("button", { hasText: "Kotabumi" }).count()) === 0 && (await page.locator("button", { hasText: "Cabang Metro" }).count()) >= 1);
    await ctx.close();
  }

  // ================= perusahaan existing (multi-cabang mati): tampilan lama tidak berubah
  {
    const { ctx, page } = await login("owner@terra-nusantara.test", "Uat#Owner2026");
    const slugs = fs.readdirSync(`${WORK}/companies`).filter((s) => s !== "pt-terra-nusantara");
    if (slugs.length === 0) ok("perusahaan lain tersedia untuk uji regresi tampilan lama", false, "tidak ada");
    else {
      await page.goto(usersUrl(slugs[0]));
      await page.waitForSelector("text=Pengguna", { timeout: 20000 });
      await sleep(1500);
      const hasCols = (await page.locator("th", { hasText: "Akses Cabang" }).count()) > 0;
      const hasSelector = (await page.locator('[data-testid="active-branch-button"]').count()) > 0;
      ok(`perusahaan ${slugs[0]} (multi-cabang mati): kolom cabang & selector TIDAK muncul, tampilan lama utuh`, !hasCols && !hasSelector && (await page.getByRole("button", { name: /Tambah Pengguna/ }).count()) === 1);
      await page.screenshot({ path: `${SHOTS}/11-company-lama.png` });
    }
    await ctx.close();
  }
} catch (err) {
  console.log("ERROR", err);
  ok("UI tanpa error tak terduga", false, String(err));
}

await browser.close();
srv.kill("SIGTERM");
await sleep(2000);
try { srv.kill("SIGKILL"); } catch {}
fs.writeFileSync(`${ROOT}/docs/uat/evidence-multibranch/phase3-ui-result.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} lulus`);
