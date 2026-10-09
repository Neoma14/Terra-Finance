// Uji alur Antar Cabang di JENDELA ELECTRON sungguhan (aplikasi hasil installer, win-unpacked), dengan login sungguhan.
// Data = salinan UAT di <WORK>/data yang dipakai sebagai userData (--user-data-dir) sehingga data produksi/klien tidak tersentuh.
// Aplikasi mengikat port 4000 (tetap, dalam main.js): pastikan tidak ada TERRA FINANCE lain yang berjalan. Lihat README.md.
const fs = require("fs");
const path = require("path");
const WORK = path.resolve(process.argv[2]);
const EXE = process.env.TERRA_EXE ?? path.resolve(__dirname, "../../apps/desktop/dist/win-unpacked/TERRA FINANCE.exe");
const { spawn, execSync } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? path.resolve(WORK, "node_modules/playwright-core"));
const CDP_PORT = 9333;
const { personas, metro } = JSON.parse(fs.readFileSync(WORK + "/personas.json", "utf8"));
const USER_DATA = path.resolve(WORK, "data");
const SHOTS = path.join(WORK, "shots-electron");
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4000";
const SLUG = "pt-terra-nusantara";

const REAL = path.resolve(process.env.APPDATA ?? ".", "TERRA FINANCE");
const listReal = () => (fs.existsSync(REAL) ? fs.readdirSync(REAL).sort().join(",") : "(tidak ada)");
const results = [];
const problems = [];
const check = (name, ok, detail = "") => {
  results.push([ok ? "PASS" : "FAIL", name, ok ? "" : detail]);
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
};
const txt = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ") : "");

(async () => {
  const before = listReal();
  // Aplikasi terbungkus tidak menerima --inspect dari Playwright (_electron.launch), jadi dijalankan langsung dan
  // jendelanya dikendalikan lewat Chrome DevTools Protocol (--remote-debugging-port), tanpa mengubah aplikasi.
  // ELECTRON_RUN_AS_NODE (diwariskan mis. dari VS Code/Claude Code) membuat exe berjalan sebagai Node biasa ("bad option"): wajib dibuang.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: ["ignore", "pipe", "pipe"], env });
  const mainOut = [];
  child.stdout.on("data", (d) => mainOut.push(String(d)));
  child.stderr.on("data", (d) => mainOut.push(String(d)));
  let exited = false;
  child.on("exit", () => (exited = true));
  let version = null;
  for (let i = 0; i < 240 && !version && !exited; i++) {
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json(), () => null);
    if (!version) await new Promise((r) => setTimeout(r, 500));
  }
  if (!version) throw new Error("Aplikasi Electron tidak membuka port debug: " + mainOut.join("").slice(0, 400));
  check("Electron: aplikasi terbungkus (win-unpacked) berjalan", /Electron\/33/.test(version["User-Agent"]) && /win-unpacked/.test(EXE), version["User-Agent"]);
  console.log("Browser", version.Browser, "|", (/Electron\/[\d.]+/.exec(version["User-Agent"]) ?? [])[0], "| userData", USER_DATA);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  const app = {
    async close() {
      try {
        const session = await browser.newBrowserCDPSession();
        session.send("Browser.close").catch(() => undefined); // koneksi putus saat menutup; jangan ditunggu
      } catch {}
      for (let i = 0; i < 40 && !exited; i++) await new Promise((r) => setTimeout(r, 500));
      if (!exited) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    },
  };
  const rate429 = []; // 429 = batas laju bucket auth akibat lalu lintas uji yang rapat; dilaporkan terpisah, bukan disembunyikan
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(m.text())) (/status of 429/.test(m.text()) ? rate429 : problems).push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.waitForURL(/127\.0\.0\.1:4000/, { timeout: 120000 });
  const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

  async function login(persona) {
    await page.goto(BASE + "/login");
    if (!(await page.locator("input[type=email]").waitFor({ timeout: 8000 }).then(() => true, () => false))) {
      throw new Error(`form login tidak muncul untuk ${persona.label} (sesi sebelumnya belum keluar?) url=${page.url()}`);
    }
    await page.locator("input[type=email]").fill(persona.email);
    await page.locator("input[type=password]").fill(persona.password);
    await page.getByRole("button", { name: "MASUK" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  }
  async function logout(attempt = 0) {
    await page.goto(BASE + "/workspace");
    const [logoutResponse] = await Promise.all([
      page.waitForResponse((r) => /\/api\/auth\/logout/.test(r.url()), { timeout: 15000 }),
      page.getByRole("button", { name: /Keluar/ }).first().click(),
    ]);
    if (logoutResponse.status() === 429 && attempt < 2) {
      // Bucket "auth" 30/menit dipakai bersama login+logout+ping aktivitas; lalu lintas uji yang rapat
      // dapat menghabiskannya (bukan pola pemakaian nyata). Tunggu jendela berganti lalu ulangi.
      console.log("CATATAN logout kena batas laju (429); menunggu 65 dtk lalu mengulang");
      await new Promise((r) => setTimeout(r, 65000));
      return logout(attempt + 1);
    }
    await page.waitForURL(/\/login/, { timeout: 15000 });
    const me = await page.evaluate(() => fetch("/api/auth/me", { credentials: "include" }).then((r) => r.status));
    if (me !== 401) throw new Error(`sesi masih aktif setelah logout (logout=${logoutResponse.status()}, me=${me})`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  }
  async function openWorkspace(slugText = "PT TERRA NUSANTARA") {
    await page.goto(BASE + "/workspace");
    await page.getByText(slugText, { exact: false }).first().click();
    await page.waitForURL(new RegExp(`/workspace/${SLUG}`), { timeout: 15000 }).catch(() => undefined);
  }
  const menu = () => page.locator(`aside a[href$="/antar-cabang"]`);
  // Menu bergantung pada data izin/cabang yang dimuat asinkron: tunggu dulu sebelum menyimpulkan "ada" atau "tidak ada".
  const menuPresent = async () => {
    await menu().first().waitFor({ timeout: 15000 }).catch(() => undefined);
    return (await menu().count()) === 1;
  };
  const menuAbsent = async () => {
    await page.waitForTimeout(3000);
    return (await menu().count()) === 0;
  };
  const dialog = () => page.locator("[role=dialog]");
  async function fillForm({ amount, desc, from = "1112 - Kas Cabang Metro", to = "1113 - Kas Cabang Bandar Lampung" }) {
    await page.getByTestId("ib-new").click();
    await page.getByTestId("ib-to-branch").selectOption({ label: "Cabang Bandar Lampung" });
    await page.getByTestId("ib-amount").fill(amount);
    await page.getByTestId("ib-from-account").selectOption({ label: from });
    await page.getByTestId("ib-to-account").selectOption({ label: to });
    await page.getByTestId("ib-description").fill(desc);
    await page.getByTestId("ib-submit").click();
    await page.getByTestId("ib-detail-no").waitFor();
    return txt(page.getByTestId("ib-detail-no"));
  }

  try {
  // ------------------------------------------------------------------ 1. login + pemilihan perusahaan/cabang + pengajuan
  await login(personas.maker);
  check("login sungguhan (maker) berhasil di jendela Electron", !/\/login/.test(page.url()));
  await openWorkspace();
  await page.waitForSelector("aside");
  check("pemilihan perusahaan: workspace PT TERRA NUSANTARA terbuka; cabang aktif = Metro", /Metro/.test(await txt(page.getByTestId("active-branch-name"))), await txt(page.getByTestId("active-branch-name")));
  check("menu Antar Cabang tampil di sidebar (maker)", await menuPresent());
  await menu().click();
  await page.getByRole("heading", { name: "Antar Cabang" }).waitFor();
  const txNo = await fillForm({ amount: "1.500.000", desc: "Setoran kas Metro ke Bandar Lampung (Electron)" });
  check("pengajuan: nomor IB-, Menunggu persetujuan, belum ada jurnal", /^IB-\d{4}-\d{6}$/.test(txNo) && /Menunggu persetujuan/.test(await txt(dialog().getByTestId("ib-status"))) && /Belum ada jurnal/.test(await txt(dialog().getByTestId("ib-status"))));
  await shot("01-pengajuan");
  await page.keyboard.press("Escape");
  await logout();

  // ------------------------------------------------------------------ 2. persetujuan + posting + jurnal kedua cabang
  await login(personas.approver);
  await openWorkspace();
  await page.getByTestId("ib-nav-badge").waitFor({ timeout: 10000 }).catch(() => undefined);
  check("approver: lencana menu = 1", (await txt(page.getByTestId("ib-nav-badge"))) === "1", await txt(page.getByTestId("ib-nav-badge")));
  await menu().click();
  await page.getByTestId("ib-tab-in").click();
  await page.getByTestId("ib-row").filter({ hasText: txNo }).click();
  await page.getByTestId("ib-detail-no").waitFor();
  await page.getByTestId("ib-approve").click();
  await shot("02-panel-setuju");
  await page.getByTestId("ib-confirm-approve").click(); // tombol dekat bagian bawah modal: tidak boleh terhalang elemen lain
  await page.getByTestId("ib-journal").first().waitFor();
  const st = await txt(dialog().getByTestId("ib-status"));
  check("setelah disetujui: Selesai + Jurnal diposting; dua jurnal tampil", /Selesai/.test(st) && /Jurnal diposting/.test(st) && (await page.getByTestId("ib-journal").count()) === 2, st);
  check("jurnal sisi penerima berisi baris; sisi pemberi tidak dibuka", (await page.getByText("Isi jurnal ini milik cabang lain").count()) === 1);
  await shot("03-selesai");
  await page.keyboard.press("Escape");
  await logout();

  // ------------------------------------------------------------------ 3. pembalikan
  await login(personas.maker);
  await openWorkspace();
  await menu().click();
  await page.getByTestId("ib-row").filter({ hasText: txNo }).click();
  await page.getByTestId("ib-reverse").click();
  await page.getByTestId("ib-reason").fill("Salah input nominal setoran");
  await page.getByTestId("ib-confirm-action").click();
  await page.getByTestId("ib-reversal-box").waitFor();
  check("maker meminta pembalikan; tidak ada tombol setujui pembalikan untuk pemohon", (await page.getByTestId("ib-reversal-approve").count()) === 0);
  await page.keyboard.press("Escape");
  await logout();
  await login(personas.approver);
  await openWorkspace();
  await menu().click();
  await page.getByTestId("ib-row").filter({ hasText: txNo }).click();
  await page.getByTestId("ib-reversal-approve").click();
  await page.getByText("Sudah dibalik").first().waitFor();
  check("pembalikan disetujui: empat jurnal, Sudah dibalik", (await page.getByTestId("ib-journal").count()) === 4);
  await shot("04-dibalik");
  await page.keyboard.press("Escape");
  await logout();

  // ------------------------------------------------------------------ 4. penolakan dan pembatalan
  await login(personas.maker);
  await openWorkspace();
  await menu().click();
  const rejNo = await fillForm({ amount: "200000", desc: "Akan ditolak (Electron)" });
  await page.keyboard.press("Escape");
  const cancelNo = await fillForm({ amount: "300000", desc: "Akan dibatalkan (Electron)" });
  await page.getByTestId("ib-cancel").click();
  await page.getByTestId("ib-confirm-action").click();
  await dialog().getByTestId("ib-status").filter({ hasText: "Dibatalkan" }).waitFor();
  check("pembatalan oleh pengaju: status Dibatalkan, tanpa jurnal", /Belum ada jurnal/.test(await txt(dialog().getByTestId("ib-status"))));
  await page.keyboard.press("Escape");
  await logout();
  await login(personas.approver);
  await openWorkspace();
  await menu().click();
  await page.getByTestId("ib-row").filter({ hasText: rejNo }).click();
  await page.getByTestId("ib-reject").click();
  await page.getByTestId("ib-reason").fill("Bukti setoran tidak ada");
  await page.getByTestId("ib-confirm-action").click();
  await dialog().getByTestId("ib-status").filter({ hasText: "Ditolak" }).waitFor();
  check("penolakan oleh penerima: status Ditolak + alasan tampil, tanpa jurnal", /Bukti setoran tidak ada/.test(await txt(dialog())) && /Belum ada jurnal/.test(await txt(dialog().getByTestId("ib-status"))));
  await page.keyboard.press("Escape");
  await logout();
  void cancelNo;

  // ------------------------------------------------------------------ 5. pemisahan tugas dan OWNER
  await login(personas.adminBoth);
  await openWorkspace();
  await page.evaluate((id) => sessionStorage.setItem("terra.activeBranch.pt-terra-nusantara", id), metro);
  await page.reload();
  await menu().click();
  await fillForm({ amount: "250000", desc: "Uji pemisahan tugas (Electron)" });
  check("ADMIN dua cabang: tanpa tombol Setujui, ada penjelasan pemisahan tugas", (await page.getByTestId("ib-approve").count()) === 0 && (await page.getByTestId("ib-self-blocked").count()) === 1);
  await page.keyboard.press("Escape");
  await logout();
  await login(personas.owner);
  await openWorkspace();
  await page.evaluate((id) => sessionStorage.setItem("terra.activeBranch.pt-terra-nusantara", id), metro);
  await page.reload();
  await menu().click();
  await fillForm({ amount: "75000", desc: "OWNER menyelesaikan sendiri (Electron)" });
  await page.getByTestId("ib-approve").click();
  await page.getByTestId("ib-confirm-approve").click();
  await page.getByTestId("ib-journal").first().waitFor();
  check("OWNER menyetujui transaksinya sendiri: Selesai", /Selesai/.test(await txt(dialog().getByTestId("ib-status"))) && /pengaju sendiri/.test(await txt(dialog())));
  await page.keyboard.press("Escape");

  // ------------------------------------------------------------------ 5b. (UAT_EXTRA=1) pembebanan lewat UI + kegagalan posting terlihat jelas di UI lalu pulih
  if (process.env.UAT_EXTRA === "1") {
    const Database = require(path.resolve(__dirname, "../../node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3"));
    const dbFile = path.join(USER_DATA, "companies", SLUG, "company.db");
    const readJournals = () => { const d = new Database(dbFile, { readonly: true }); const n = d.prepare("select count(*) n from journal_entries where inter_branch_transaction_id is not null").get().n; d.close(); return n; };
    await page.getByTestId("ib-new").click();
    await page.getByTestId("ib-type").selectOption({ label: "Pembebanan" });
    await page.getByTestId("ib-to-branch").selectOption({ label: "Cabang Bandar Lampung" });
    await page.getByTestId("ib-amount").fill("125000");
    await page.getByTestId("ib-from-account").selectOption({ label: "1112 - Kas Cabang Metro" });
    await page.getByTestId("ib-to-account").selectOption({ label: "6113 - Beban Gaji Cabang Bandar Lampung" });
    await page.getByTestId("ib-description").fill("Metro membayar beban gaji BL (Electron UAT)");
    await shot("uat-form-pembebanan");
    await page.getByTestId("ib-submit").click();
    await page.getByTestId("ib-detail-no").waitFor();
    check("UAT UI: pengajuan jenis Pembebanan (beban cabang tujuan) berhasil", /Menunggu persetujuan/.test(await txt(dialog().getByTestId("ib-status"))));
    const jBefore = readJournals();
    const w = new Database(dbFile); w.exec("create trigger uat_ui_fail before insert on journal_entry_lines when (select inter_branch_side from journal_entries where id=new.journal_entry_id)='TO' begin select raise(abort,'UAT injeksi'); end;"); w.close();
    await page.getByTestId("ib-approve").click();
    await page.getByTestId("ib-confirm-approve").click();
    await page.getByTestId("ib-action-error").waitFor({ timeout: 15000 });
    const errText = await txt(page.getByTestId("ib-action-error"));
    await shot("uat-gagal-posting");
    check("UAT UI: posting gagal menampilkan pesan galat di modal; status tetap Menunggu persetujuan; tidak ada jurnal baru", errText.length > 0 && !/SQLITE|UAT injeksi|select |at \w+\./i.test(errText) && /Menunggu persetujuan/.test(await txt(dialog().getByTestId("ib-status"))) && readJournals() === jBefore, errText);
    const d = new Database(dbFile); d.exec("drop trigger uat_ui_fail"); d.close();
    await page.getByTestId("ib-confirm-approve").click();
    await page.getByTestId("ib-journal").first().waitFor({ timeout: 15000 });
    check("UAT UI: setelah pulih, mencoba lagi dari modal yang sama berhasil (Selesai, 2 jurnal baru)", /Selesai/.test(await txt(dialog().getByTestId("ib-status"))) && readJournals() === jBefore + 2);
    await shot("uat-pulih-selesai");
    await page.keyboard.press("Escape");
  }

  // ------------------------------------------------------------------ 6. fitur lama tetap berjalan; jurnal Antar Cabang muncul di Jurnal biasa
  await page.goto(`${BASE}/workspace/${SLUG}`);
  await page.waitForSelector("aside");
  check("fitur lama: Dashboard terbuka tanpa galat", (await page.locator("main").count()) === 1);
  await page.goto(`${BASE}/workspace/${SLUG}/jurnal`);
  await page.getByPlaceholder("Cari nomor/keterangan...").fill("IB-");
  await page.waitForTimeout(1200);
  check("fitur lama: daftar Jurnal memuat jurnal Antar Cabang (referensi IB-)", (await page.locator("tbody tr").filter({ hasText: "IB-" }).count()) >= 2);
  await page.goto(`${BASE}/workspace/${SLUG}/accounts`);
  await page.waitForTimeout(800);
  check("fitur lama: Chart of Accounts terbuka", (await page.locator("tbody tr").count()) > 3);
  await page.goto(`${BASE}/workspace/${SLUG}/trial-balance`);
  await page.waitForTimeout(800);
  check("fitur lama: Trial Balance terbuka", (await page.locator("main").innerText()).length > 50);
  await shot("05-jurnal-biasa");
  await logout();

  // ------------------------------------------------------------------ 7. peran/perusahaan tanpa hak atau flag OFF
  await login(personas.viewer);
  await openWorkspace();
  check("VIEWER: menu Antar Cabang tersembunyi", await menuAbsent());
  await logout();
  await login(personas.offOwner);
  await page.goto(BASE + "/workspace");
  await page.getByText("PT PEMBANDING", { exact: false }).first().click();
  await page.waitForSelector("aside");
  check("perusahaan dengan multi_branch_enabled=OFF: menu tersembunyi dan fitur lama berjalan", (await menuAbsent()) && (await page.locator("main").count()) === 1);
  await page.goto(`${BASE}/workspace/pt-pembanding/antar-cabang`);
  await page.getByTestId("ib-disabled").waitFor();
  check("URL langsung ke Antar Cabang pada perusahaan flag OFF: penjelasan, tanpa data", true);
  await logout();

  } catch (err) {
    const firstLine = String(err.message).split(String.fromCharCode(10))[0];
    console.log("GALAT di tengah alur:", firstLine, "| url:", page.url());
    await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => undefined);
    results.push(["FAIL", "alur terhenti: " + firstLine, ""]);
  }
  // ------------------------------------------------------------------ penutup: log aplikasi
  await app.close();
  const diagPath = path.join(USER_DATA, "diagnostic.log");
  const diag = fs.existsSync(diagPath) ? fs.readFileSync(diagPath, "utf8") : "";
  const diagErrors = diag.split("\n").filter((l) => /stderr|did-fail-load|render-process-gone|spawn-error|timeout|exit\] code=[1-9]/i.test(l) && !/ExperimentalWarning|DeprecationWarning/.test(l));
  check("diagnostic.log: tidak ada galat server/renderer/IPC; server melaporkan listening", diagErrors.length === 0 && /Server listening|listening/i.test(diag), diagErrors.slice(0, 3).join(" | "));
  const after = listReal();
  check("data pengguna asli (%APPDATA%\\TERRA FINANCE) tidak berubah oleh uji", before === after, `${before} -> ${after}`);

  for (const [s, n, d] of results) console.log(s, n, d);
  console.log(results.filter((r) => r[0] === "FAIL").length, "FAIL dari", results.length);
  console.log("respons 429 (batas laju, lalu lintas uji):", rate429.length);
  console.log("masalah konsol/jaringan (renderer):", problems.length ? problems : "tidak ada");
  console.log("keluaran proses utama:", mainOut.join("").split("\n").filter((l) => l.trim() && !/ExperimentalWarning/.test(l)).slice(0, 8));
  process.exit(results.some((r) => r[0] === "FAIL") || problems.length ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT ERROR", e);
  process.exit(2);
});
