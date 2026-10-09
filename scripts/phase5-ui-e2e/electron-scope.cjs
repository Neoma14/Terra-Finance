// UI E2E Phase 5A/5B di JENDELA ELECTRON sungguhan (aplikasi terbungkus win-unpacked) dengan login sungguhan.
// Data = salinan UAT di <WORK>/data yang dipakai sebagai userData (--user-data-dir); data pengguna nyata tidak tersentuh.
//   bash scripts/inter-branch-uat/reset-uat.sh $WORK <backup-uat>
//   TERRA_EXE=<path win-unpacked>/"TERRA FINANCE.exe" PLAYWRIGHT_CORE=<playwright-core> node scripts/phase5-ui-e2e/electron-scope.cjs $WORK
// Aplikasi mengikat port 4000 (tetap, dalam main.js): pastikan tidak ada TERRA FINANCE lain yang berjalan.
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const WORK = path.resolve(process.argv[2]);
const EXE = process.env.TERRA_EXE ?? path.resolve(__dirname, "../../apps/desktop/dist/win-unpacked/TERRA FINANCE.exe");
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? path.resolve(WORK, "node_modules/playwright-core"));
const CDP_PORT = 9334;
const { personas: P, metro, bl } = JSON.parse(fs.readFileSync(WORK + "/personas.json", "utf8"));
const USER_DATA = path.resolve(WORK, "data");
const SHOTS = path.join(WORK, "shots-electron-p5");
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4000";
const SLUG = "pt-terra-nusantara";
const REAL = path.resolve(process.env.APPDATA ?? ".", "TERRA FINANCE");
const listReal = () => (fs.existsSync(REAL) ? fs.readdirSync(REAL).sort().join(",") : "(tidak ada)");
const results = [];
const problems = [];
const rate429 = [];
const check = (name, ok, detail = "") => {
  results.push([ok ? "PASS" : "FAIL", name, ok ? "" : detail]);
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
};
const txt = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ") : "");

(async () => {
  const before = listReal();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // diwariskan dari VS Code/Claude Code: membuat exe berjalan sebagai Node biasa
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
  check("Electron: aplikasi terbungkus berjalan (profil dan data terisolasi)", /Electron\/33/.test(version["User-Agent"]), version["User-Agent"]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 150000 }));
  const watch = (pg, tag) => {
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(m.text())) (/status of 429/.test(m.text()) ? rate429 : problems).push(`${tag}: console: ${m.text()}`); });
    pg.on("pageerror", (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    pg.on("response", (r) => { if (r.status() >= 500) problems.push(`${tag}: HTTP ${r.status()} ${r.url()}`); });
  };
  watch(page, "jendela");
  await page.waitForURL(/127\.0\.0\.1:4000/, { timeout: 120000 });
  const shot = (pg, name) => pg.screenshot({ path: `${SHOTS}/${name}.png` });

  async function login(persona) {
    await page.goto(BASE + "/login");
    if (!(await page.locator("input[type=email]").waitFor({ timeout: 8000 }).then(() => true, () => false))) throw new Error(`form login tidak muncul untuk ${persona.label} url=${page.url()}`);
    await page.locator("input[type=email]").fill(persona.email);
    await page.locator("input[type=password]").fill(persona.password);
    await page.getByRole("button", { name: "MASUK" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  }
  async function logout(attempt = 0) {
    await page.goto(BASE + "/workspace");
    const [resp] = await Promise.all([page.waitForResponse((r) => /\/api\/auth\/logout/.test(r.url()), { timeout: 15000 }), page.getByRole("button", { name: /Keluar/ }).first().click()]);
    if (resp.status() === 429 && attempt < 2) {
      console.log("CATATAN logout kena batas laju (429); menunggu 65 dtk lalu mengulang");
      await new Promise((r) => setTimeout(r, 65000));
      return logout(attempt + 1);
    }
    await page.waitForURL(/\/login/, { timeout: 15000 });
    const me = await page.evaluate(() => fetch("/api/auth/me", { credentials: "include" }).then((r) => r.status));
    if (me !== 401) throw new Error(`sesi masih aktif setelah logout (logout=${resp.status()}, me=${me})`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  }
  const api = (pg, url, init) => pg.evaluate(async ([u, i]) => { const r = await fetch(u, { credentials: "include", ...(i ?? {}) }); return { status: r.status, text: await r.text() }; }, [url, init]);
  const modeOptions = (pg) => pg.getByTestId("scope-mode").locator("option").allInnerTexts();
  const setBranch = (pg, id) => pg.evaluate(([slug, v]) => sessionStorage.setItem(`terra.activeBranch.${slug}`, v), [SLUG, id]);
  const gotoReports = async (pg) => { await pg.goto(`${BASE}/workspace/${SLUG}/reports`); await pg.getByText("Total Assets").first().waitFor({ timeout: 30000 }); };

  try {
    // ============================================================ 1. LIMITED satu cabang (Metro)
    await login(P.makerM);
    await page.goto(`${BASE}/workspace`);
    await page.getByText("PT TERRA NUSANTARA", { exact: false }).first().click();
    await page.waitForURL(new RegExp(`/workspace/${SLUG}`), { timeout: 15000 });
    await setBranch(page, metro);
    await gotoReports(page);
    await page.getByTestId("report-scope-picker").waitFor();
    const banner = await txt(page.getByTestId("scope-banner"));
    check("Electron LIMITED: laporan terbuka dan banner menyebut Cabang Metro", /Cakupan: Cabang Metro/.test(banner), banner);
    const opts = await modeOptions(page);
    check("Electron LIMITED satu cabang: tidak ada opsi gabungan/komparasi", !opts.some((o) => /Gabungan|Komparasi/.test(o)), opts.join(" | "));
    const outside = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:${bl}`);
    const ghost = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:00000000-0000-4000-8000-000000000000`);
    const all = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=all`);
    check("Electron LIMITED: API langsung ke cabang lain 404 identik id palsu; scope=all 403", outside.status === 404 && ghost.status === 404 && outside.text === ghost.text && all.status === 403, `${outside.status}/${ghost.status}/${all.status}`);
    await shot(page, "01-limited-reports");
    // persistensi per tab: muat ulang jendela yang sama mempertahankan cabang; tab baru tidak mewarisi
    await page.reload();
    await page.getByTestId("scope-banner").waitFor({ timeout: 30000 });
    check("cabang aktif bertahan setelah muat ulang pada tab yang sama (sessionStorage)", /Cabang Metro/.test(await txt(page.getByTestId("scope-banner"))));
    for (const [route, label] of [["", "Dashboard"], ["hutang-piutang", "Hutang & Piutang"], ["ledger", "Ledger"], ["trial-balance", "Trial Balance"]]) {
      await page.goto(`${BASE}/workspace/${SLUG}/${route}`);
      await page.getByTestId("report-scope-picker").waitFor({ timeout: 30000 });
      check(`Electron LIMITED: ${label} terbuka dengan pemilih cakupan`, true);
    }
    await shot(page, "02-limited-trial-balance");
    await logout();

    // ============================================================ 2. OWNER: gabungan berlabel, komparasi, ekspor, dua tab
    await login(P.owner);
    await page.goto(`${BASE}/workspace`);
    await page.getByText("PT TERRA NUSANTARA", { exact: false }).first().click();
    await page.waitForURL(new RegExp(`/workspace/${SLUG}`), { timeout: 15000 });
    const acc = JSON.parse((await api(page, `/api/company-db/${SLUG}/accounts?pageSize=1000`)).text).accounts;
    const idOf = (c) => acc.find((a) => a.code === c).id;
    const prop = await api(page, `/api/company-db/${SLUG}/inter-branch`, { method: "POST", headers: { "Content-Type": "application/json", "x-branch-context": metro }, body: JSON.stringify({ type: "TRANSFER_KAS", toBranchId: bl, transactionDate: new Date().toISOString().slice(0, 10), amount: 1250000, fromAccountId: idOf("1112"), toAccountSuggestedId: idOf("1113"), description: "Setoran kas untuk uji Electron Phase 5", idempotencyKey: "p5-el-" + Date.now() }) });
    const txId = JSON.parse(prop.text).transaction?.id;
    const appr = await api(page, `/api/company-db/${SLUG}/inter-branch/${txId}/approve`, { method: "POST", headers: { "Content-Type": "application/json", "x-branch-context": metro }, body: "{}" });
    check("persiapan: transaksi Antar Cabang selesai (OWNER) untuk data laporan", prop.status === 201 && appr.status === 200, `${prop.status}/${appr.status}`);
    await setBranch(page, metro);
    await gotoReports(page);
    const oOpts = await modeOptions(page);
    check("Electron OWNER: opsi gabungan terpilih, komparasi, seluruh cabang tersedia", ["Gabungan cabang terpilih", "Komparasi per cabang", "Gabungan seluruh cabang"].every((o) => oOpts.some((x) => x.includes(o))), oOpts.join(" | "));
    await page.getByTestId("scope-mode").selectOption("all");
    await page.locator("[data-scope-mode=COMBINED_ALL]").waitFor({ timeout: 30000 });
    const b = await txt(page.getByTestId("scope-banner"));
    check("Electron gabungan seluruh cabang: judul + 'belum dieliminasi' + 'bukan laporan konsolidasi final'", /Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi/.test(b) && /bukan laporan konsolidasi final/.test(b), b);
    const pos = await txt(page.getByTestId("inter-branch-position"));
    check("Electron: posisi antar-kantor bruto tampil dengan 'Belum dieliminasi'", /aset bruto/.test(pos) && /Belum dieliminasi/.test(pos), pos);
    await shot(page, "03-owner-combined");
    // komparasi
    await page.getByTestId("scope-mode").selectOption("comparison");
    for (const code of ["PUSAT", "MTR", "BDL"]) await page.getByTestId(`scope-branch-${code}`).check();
    await page.getByTestId("scope-apply").click();
    await page.getByTestId("comparison-table").waitFor({ timeout: 40000 });
    const header = ((await page.getByTestId("comparison-table").locator("thead").first().textContent()) ?? "").replace(/\s+/g, " ");
    check("Electron komparasi: kolom per cabang + Gabungan (belum dieliminasi) + rekonsiliasi server", /Cabang Metro/i.test(header) && /Gabungan \(belum dieliminasi\)/i.test(header) && (await page.getByTestId("reconciliation-note").count()) === 1, header);
    check("Electron komparasi: ekspor dinonaktifkan dengan penjelasan", (await page.getByRole("button", { name: "Download" }).isDisabled()) && /Ekspor komparasi per cabang belum tersedia/.test(await txt(page.locator("main"))));
    await shot(page, "04-owner-comparison");
    // ekspor melalui sesi Electron (isi XLSX diperiksa; unduhan via dialog sistem tidak diotomasi)
    const exp = await page.evaluate(async ([slug]) => {
      const out = {};
      for (const [k, q] of [["single", `scope=branch:${slug.metro}`], ["combined", "scope=all"]]) {
        const r = await fetch(`/api/company-db/${slug.slug}/reports/export/balance-sheet?format=xlsx&fromDate=2026-01-01&toDate=2026-12-31&${q}`, { credentials: "include" });
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = ""; for (const x of buf) bin += String.fromCharCode(x);
        out[k] = { status: r.status, disposition: r.headers.get("content-disposition"), b64: btoa(bin) };
      }
      return out;
    }, [{ slug: SLUG, metro }]);
    const ExcelJS = require(require.resolve("exceljs", { paths: [path.resolve(__dirname, "../../apps/api")] }));
    const cellsOf = async (b64) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(b64, "base64")); const t = []; wb.worksheets[0].eachRow((row) => row.eachCell((c) => t.push(String(c.value ?? "")))); return t; };
    const singleCells = await cellsOf(exp.single.b64), combinedCells = await cellsOf(exp.combined.b64);
    check("Electron ekspor XLSX satu cabang: nama file berlabel cabang, baris Cakupan, periode berformat hyphen, tanpa em/en dash", exp.single.status === 200 && /Cabang-Cabang-Metro/.test(exp.single.disposition) && singleCells.some((c) => /^Cakupan: Cabang Metro/.test(c)) && singleCells.some((c) => /^Periode: 01 Januari 2026 - 31 Desember 2026$/.test(c)) && !singleCells.join(" ").match(/[–—]/), exp.single.disposition);
    check("Electron ekspor XLSX gabungan: nama file 'Belum-Dieliminasi' + label bruto di isi dokumen", exp.combined.status === 200 && /Gabungan-Seluruh-Cabang-Belum-Dieliminasi/.test(exp.combined.disposition) && combinedCells.some((c) => /belum dieliminasi/i.test(c)) && combinedCells.some((c) => /bukan laporan konsolidasi final/i.test(c)), exp.combined.disposition);
    // jendela/tab kedua (window.open, satu-satunya cara membuka tab kedua di Electron): sessionStorage disalin saat dibuka lalu TERPISAH;
    // mengubah cabang aktif di tab kedua tidak boleh memengaruhi tab pertama.
    const popupPromise = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
    await page.evaluate((u) => { window.open(u); }, `${BASE}/workspace/${SLUG}/reports`);
    const secondTab = await popupPromise;
    if (!secondTab) check("tab kedua di jendela Electron (window.open)", false, "tidak dapat membuka tab kedua");
    else {
      watch(secondTab, "tab2");
      await secondTab.waitForLoadState("domcontentloaded");
      await secondTab.getByTestId("scope-banner").waitFor({ timeout: 40000 });
      await setBranch(secondTab, bl);
      await secondTab.reload();
      await secondTab.getByTestId("scope-banner").waitFor({ timeout: 30000 });
      await page.reload();
      await page.getByTestId("scope-banner").waitFor({ timeout: 30000 });
      const t1 = await txt(page.getByTestId("scope-banner")), t2 = await txt(secondTab.getByTestId("scope-banner"));
      check("Electron dua tab, dua cabang: tab pertama tetap Metro, tab kedua Bandar Lampung (sessionStorage terpisah)", /Cabang Metro/.test(t1) && /Bandar Lampung/.test(t2), `${t1} | ${t2}`);
      await secondTab.close().catch(() => undefined);
    }
    await logout();

    // ============================================================ 3. VIEWER (tanpa report.consolidated) dan perusahaan tanpa multi-cabang
    await login(P.viewer);
    await page.goto(`${BASE}/workspace`);
    await page.getByText("PT TERRA NUSANTARA", { exact: false }).first().click();
    await page.waitForURL(new RegExp(`/workspace/${SLUG}`), { timeout: 15000 });
    await setBranch(page, metro);
    await gotoReports(page);
    const vOpts = await modeOptions(page);
    const vAll = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=all`);
    check("Electron VIEWER: tanpa opsi gabungan/komparasi; scope=all lewat URL 403", !vOpts.some((o) => /Gabungan|Komparasi/.test(o)) && vAll.status === 403, `${vOpts.join(" | ")} ${vAll.status}`);
    await logout();
    await login(P.otherOwner);
    await page.goto(`${BASE}/workspace`);
    await page.getByText("PT PEMBANDING", { exact: false }).first().click();
    await page.waitForURL(/\/workspace\/pt-pembanding/, { timeout: 15000 });
    await page.goto(`${BASE}/workspace/pt-pembanding/reports`);
    await page.getByText("Total Assets").first().waitFor({ timeout: 30000 });
    check("Electron perusahaan tanpa multi-cabang: tidak ada pemilih cakupan dan banner", (await page.getByTestId("report-scope-picker").count()) === 0 && (await page.getByTestId("scope-banner").count()) === 0);
    await shot(page, "05-flag-off");
    await logout();
  } catch (err) {
    check("alur Electron berjalan sampai selesai", false, String(err.message).split("\n")[0] + " | url: " + page.url());
    await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => undefined);
  }

  try { const s = await browser.newBrowserCDPSession(); s.send("Browser.close").catch(() => undefined); } catch {}
  for (let i = 0; i < 40 && !exited; i++) await new Promise((r) => setTimeout(r, 500));
  if (!exited) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  const diagPath = path.join(USER_DATA, "diagnostic.log");
  const diag = fs.existsSync(diagPath) ? fs.readFileSync(diagPath, "utf8") : "";
  const diagErrors = diag.split("\n").filter((l) => /stderr|did-fail-load|render-process-gone|spawn-error|timeout|exit\] code=[1-9]/i.test(l) && !/ExperimentalWarning|DeprecationWarning/.test(l));
  check("diagnostic.log: tanpa galat server/renderer/IPC; server listening", diagErrors.length === 0 && /listening/i.test(diag), diagErrors.slice(0, 3).join(" | "));
  check("data pengguna asli (%APPDATA%\\TERRA FINANCE) tidak berubah oleh uji", before === listReal(), `${before} -> ${listReal()}`);
  console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} pemeriksaan lulus; respons 429 (batas laju, lalu lintas uji): ${rate429.length}`);
  console.log("masalah konsol/jaringan:", problems.length ? problems : "tidak ada");
  process.exit(results.some((r) => r[0] === "FAIL") || problems.length ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT ERROR", e);
  try { execSync('taskkill /IM "TERRA FINANCE.exe" /T /F', { stdio: "ignore" }); } catch {}
  process.exit(2);
});
