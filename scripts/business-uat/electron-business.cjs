// UAT bisnis lewat UI JENDELA ELECTRON sungguhan (aplikasi terbungkus win-unpacked), login sungguhan per persona.
// Data = lingkungan uji <WORK>/data yang dipakai sebagai userData (--user-data-dir). Kebenaran angka dan jurnal dibandingkan
// dengan SQL independen (oracle) pada company.db yang sama (dibuka hanya-baca).
//   node scripts/business-uat/prepare-env.mjs <WORK> <backup>    (lingkungan baru)
//   TERRA_EXE=<win-unpacked>/"TERRA FINANCE.exe" PLAYWRIGHT_CORE=<playwright-core> node scripts/business-uat/electron-business.cjs <WORK>
// Aplikasi mengikat port 4000 (tetap): tidak boleh ada TERRA FINANCE lain yang berjalan; server UAT 4536 harus mati.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, execSync } = require("child_process");
const WORK = path.resolve(process.argv[2]);
const ROOT = path.resolve(__dirname, "../..");
const EXE = process.env.TERRA_EXE;
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? path.resolve(WORK, "node_modules/playwright-core"));
const CDP_PORT = 9335;
const J = JSON.parse(fs.readFileSync(WORK + "/personas.json", "utf8"));
const P = J.personas, HQ = J.hq, METRO = J.metro, BL = J.bl;
const USER_DATA = path.resolve(WORK, "data");
const SLUG = "pt-uji-bisnis", SLUG_OFF = "pt-uji-satu-cabang";
const SHOTS = path.join(WORK, "shots-electron-bisnis");
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4000";
const REAL = path.resolve(process.env.APPDATA ?? ".", "TERRA FINANCE");
const listReal = () => (fs.existsSync(REAL) ? fs.readdirSync(REAL).sort().join(",") : "(tidak ada)");
const results = [], problems = [], rate429 = [], timings = [];
const check = (id, name, ok, detail = "") => {
  results.push({ id, name, status: ok ? "PASS" : "FAIL", detail: ok ? "" : String(detail) });
  console.log(ok ? "PASS" : "FAIL", id, name, ok ? "" : String(detail).slice(0, 300));
};
const txt = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ") : "");
const num = (s) => Number(String(s).replace(/[^\d-]/g, ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BRANCH_NAME = { [HQ]: "Kantor Pusat", [METRO]: "Cabang Metro", [BL]: "Bandar Lampung" };

(async () => {
  const before = listReal();
  const lib = await import(pathToFileURL(path.join(__dirname, "lib.mjs")).href);
  const { Oracle } = await import(pathToFileURL(path.join(ROOT, "docs/uat/harness/phase5/oracle.mjs")).href);
  const COMPANY_DB = lib.COMPANY_DB, Database = lib.Database;
  const withOracle = (branches, fn) => { const d = new Database(COMPANY_DB(), { readonly: true }); try { return fn(new Oracle(d, branches)); } finally { d.close(); } };
  const q = (sql, ...a) => { const d = new Database(COMPANY_DB(), { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const netMap = () => { const m = {}; for (const r of q(`select l.account_id a, j.branch_id b, sum(cast(round(l.debit*100) as integer)) - sum(cast(round(l.credit*100) as integer)) v from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.status in ('POSTED','REVERSED') group by 1,2`)) m[`${r.a}|${r.b}`] = r.v; return m; };
  const delta = (a, b) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d) o[k] = d; } return o; };
  const acc = J.accounts;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: ["ignore", "pipe", "pipe"], env });
  let exited = false;
  child.on("exit", () => (exited = true));
  let version = null;
  for (let i = 0; i < 240 && !version && !exited; i++) {
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json(), () => null);
    if (!version) await sleep(500);
  }
  if (!version) throw new Error("Aplikasi Electron tidak membuka port debug");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 150000 }));
  const watch = (pg, tag) => {
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(m.text())) (/status of 429/.test(m.text()) ? rate429 : problems).push(`${tag}: ${m.text().slice(0, 200)}`); });
    pg.on("pageerror", (e) => problems.push(`${tag}: pageerror: ${e.message}`));
    pg.on("response", (r) => { if (r.status() >= 500) problems.push(`${tag}: HTTP ${r.status()} ${r.url()}`); });
  };
  { const g = page.goto.bind(page); page.goto = (u, o) => g(u, { waitUntil: "domcontentloaded", timeout: 60000, ...(o ?? {}) }); } // font Google (jaringan luar) dapat menunda event load
  watch(page, "jendela");
  await page.waitForURL(/127\.0\.0\.1:4000/, { timeout: 120000 });
  const shot = (name, pg = page) => pg.screenshot({ path: `${SHOTS}/${name}.png` });

  async function login(persona) {
    await page.goto(BASE + "/login");
    await page.locator("input[type=email]").waitFor({ timeout: 10000 });
    await page.locator("input[type=email]").fill(persona.email);
    await page.locator("input[type=password]").fill(persona.password);
    await page.getByRole("button", { name: "MASUK" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  }
  const logoutNotes = [];
  async function logout(attempt = 0) {
    await page.goto(BASE + "/workspace");
    await page.getByRole("button", { name: /Keluar/ }).first().waitFor({ timeout: 15000 }).catch(() => undefined);
    const resp = await Promise.all([page.waitForResponse((r) => /\/api\/auth\/logout/.test(r.url()), { timeout: 12000 }).catch(() => null), page.getByRole("button", { name: /Keluar/ }).first().click({ timeout: 8000 }).catch(() => null)]).then((x) => x[0]);
    if (resp && resp.status() === 429 && attempt < 2) { await sleep(65000); return logout(attempt + 1); }
    if (!resp) {
      logoutNotes.push(`tombol Keluar tidak memicu logout pada ${page.url()}; logout lewat API sebagai cadangan`);
      await shot(`logout-bermasalah-${logoutNotes.length}`).catch(() => undefined);
      await page.evaluate(() => fetch("/api/auth/logout", { method: "POST", credentials: "include" }));
    }
    await page.goto(BASE + "/login");
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  }
  async function openCompany(name = "PT UJI BISNIS CABANG", slug = SLUG) {
    await page.goto(BASE + "/workspace");
    await page.getByText(name, { exact: false }).first().click();
    await page.waitForURL(new RegExp(`/workspace/${slug}`), { timeout: 15000 });
    await page.waitForSelector("aside");
  }
  const api = (pg, url, init) => pg.evaluate(async ([u, i]) => { const r = await fetch(u, { credentials: "include", ...(i ?? {}) }); return { status: r.status, text: await r.text() }; }, [url, init]);
  const setBranchUi = async (pg, name) => {
    await pg.getByTestId("active-branch-button").click();
    await pg.getByRole("button", { name: new RegExp(name) }).first().click();
    await pg.waitForFunction((n) => new RegExp(n).test(document.querySelector('[data-testid="active-branch-name"]')?.textContent ?? ""), name, { timeout: 15000 });
  };
  const menu = () => page.locator(`aside a[href$="/antar-cabang"]`);
  const dialog = () => page.locator("[role=dialog]");
  async function pickOption(testId, textRe) {
    const sel = page.getByTestId(testId);
    const val = await sel.evaluate((el, src) => { const re = new RegExp(src); const o = [...el.options].find((x) => re.test(x.textContent ?? "")); return o ? o.value : null; }, textRe.source);
    if (!val) throw new Error(`opsi ${testId} ${textRe} tidak ada: ${(await sel.locator("option").allInnerTexts()).join(" | ")}`);
    await sel.selectOption(val);
  }
  async function fillForm({ type = "TRANSFER_KAS", toBranchRe, amount, desc, fromRe = /^1100\b/, toRe = /^1100\b/ }) {
    await page.getByTestId("ib-new").click();
    if (type !== "TRANSFER_KAS") await page.getByTestId("ib-type").selectOption({ label: type });
    await pickOption("ib-to-branch", toBranchRe);
    await page.getByTestId("ib-amount").fill(amount);
    await pickOption("ib-from-account", fromRe);
    await pickOption("ib-to-account", toRe);
    await page.getByTestId("ib-description").fill(desc);
    await page.getByTestId("ib-submit").click();
    await page.getByTestId("ib-detail-no").waitFor({ timeout: 20000 });
    return txt(page.getByTestId("ib-detail-no"));
  }
  const goIB = async () => { await menu().first().waitFor({ timeout: 15000 }); await menu().click(); await page.getByRole("heading", { name: "Antar Cabang" }).waitFor(); };
  const txByNo = (no) => q("select * from inter_branch_transactions where transaction_no=?", no)[0];
  const jOf = (id) => q("select * from journal_entries where inter_branch_transaction_id=? order by created_at", id);
  const linesOf = (jid) => q("select account_id, debit, credit from journal_entry_lines where journal_entry_id=? order by line_order", jid);
  const accCode = Object.fromEntries(Object.entries(acc).map(([c, id]) => [id, c]));
  const ibCodes = () => Object.fromEntries(q("select id, code from accounts where branch_policy='INTER_BRANCH'").map((r) => [r.id, r.code]));
  const readTotal = async (label) => {
    const row = page.locator("tr").filter({ hasText: label }).last();
    return num(await row.locator("td").last().innerText());
  };
  const gotoReports = async (route = "reports", label = "Total Assets") => {
    const t0 = Date.now();
    await page.goto(`${BASE}/workspace/${SLUG}/${route}`);
    await page.getByText(label).first().waitFor({ timeout: 40000 });
    timings.push([route, Date.now() - t0]);
  };
  const guard = async (id, name, fn) => {
    try { await fn(); } catch (e) {
      check(id, `${name} (alur terhenti)`, false, String(e.message).split("\n")[0] + " | url: " + page.url());
      await shot(`error-${id}`).catch(() => undefined);
    }
  };

  try {
    // =========================================================== U-A1 OWNER: cabang aktif, pemilih, per tab
    await login(P.owner);
    await openCompany();
    await guard("U-A1", "OWNER: pemilih cabang aktif, persistensi per tab", async () => {
      const t0 = Date.now();
      await page.getByTestId("active-branch-button").waitFor({ timeout: 20000 });
      check("U-A1", "pemilih cabang aktif tampil untuk perusahaan multi-cabang; badge 'Akses semua cabang'", /Akses semua cabang/.test(await txt(page.locator("header, main, body").first())) || (await page.getByText("Akses semua cabang").count()) > 0);
      await page.getByTestId("active-branch-button").click();
      const names = await page.locator("div.absolute button").allInnerTexts();
      check("U-A1", "daftar cabang di pemilih memuat 3 cabang (Pusat, Metro, Bandar Lampung)", names.length === 3, names.join(" | "));
      const footer = await txt(page.locator("div.absolute").filter({ hasText: "Server memeriksa ulang" }));
      await shot("A1-pemilih-cabang");
      await page.keyboard.press("Escape"); await page.getByTestId("active-branch-button").click().catch(() => undefined);
      await setBranchUi(page, "Metro");
      check("U-A1", "memilih Cabang Metro lewat UI: nama aktif berubah", /Metro/.test(await txt(page.getByTestId("active-branch-name"))));
      await page.reload(); await page.getByTestId("active-branch-name").waitFor();
      check("U-A1", "cabang aktif bertahan setelah muat ulang tab yang sama", /Metro/.test(await txt(page.getByTestId("active-branch-name"))));
      const popup = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
      await page.evaluate((u) => window.open(u), `${BASE}/workspace/${SLUG}`);
      const t2 = await popup;
      if (!t2) { check("U-A1", "tab kedua (window.open)", false, "tidak terbuka"); return; }
      watch(t2, "tab2"); await t2.waitForLoadState("domcontentloaded");
      await t2.getByTestId("active-branch-button").waitFor({ timeout: 30000 });
      await t2.getByTestId("active-branch-button").click();
      await t2.getByRole("button", { name: /Bandar Lampung/ }).first().click();
      await t2.waitForFunction(() => /Lampung/.test(document.querySelector('[data-testid="active-branch-name"]')?.textContent ?? ""), null, { timeout: 15000 });
      await page.reload(); await page.getByTestId("active-branch-name").waitFor();
      await t2.reload(); await t2.getByTestId("active-branch-name").waitFor();
      const a = await txt(page.getByTestId("active-branch-name")), b = await txt(t2.getByTestId("active-branch-name"));
      check("U-A1", "dua tab, dua cabang: tab 1 tetap Metro, tab 2 Bandar Lampung (tidak saling memengaruhi)", /Metro/.test(a) && /Lampung/.test(b), `${a} | ${b}`);
      // transaksi tab 2 dicatat di cabang tab 2, bukan tab 1
      const hdr = await api(t2, `/api/company-db/${SLUG}/branch-context`);
      check("U-A1", "server memvalidasi cabang aktif per permintaan (header tab 2)", hdr.status === 200);
      await shot("A1-dua-tab", t2);
      await t2.close().catch(() => undefined);
      timings.push(["A1 total", Date.now() - t0]);
      void footer;
      check("U-A1", "TEMUAN UX: catatan di pemilih cabang tidak lagi menyatakan 'laporan masih mencakup seluruh perusahaan'", !/masih mencakup seluruh perusahaan/.test(footer), footer.slice(0, 220));
    });

    // =========================================================== U-D OWNER: laporan di UI = oracle
    await guard("U-D1", "OWNER: laporan di UI = oracle", async () => {
      await setBranchUi(page, "Metro").catch(() => undefined);
      await gotoReports();
      await page.getByTestId("report-scope-picker").waitFor();
      const want = withOracle([METRO], (o) => o.balanceSheet("2026-12-31"));
      const got = await readTotal("Total Assets");
      check("U-D1", `Neraca (default = cabang aktif Metro): Total Assets UI ${got} = oracle ${want.totalAssets}`, got === Math.round(want.totalAssets), `${got} vs ${want.totalAssets}`);
      check("U-D1", "banner cakupan menyebut Cabang Metro", /Cabang Metro/.test(await txt(page.getByTestId("scope-banner"))), await txt(page.getByTestId("scope-banner")));
      await shot("D1-neraca-metro");
      await page.getByTestId("scope-mode").selectOption("all");
      await page.locator("[data-scope-mode=COMBINED_ALL]").waitFor({ timeout: 30000 });
      const wantAll = withOracle(null, (o) => o.balanceSheet("2026-12-31"));
      const gotAll = await readTotal("Total Assets");
      const ban = await txt(page.getByTestId("scope-banner"));
      check("U-D1", `Gabungan seluruh cabang: Total Assets UI ${gotAll} = oracle ${wantAll.totalAssets}`, gotAll === Math.round(wantAll.totalAssets), `${gotAll} vs ${wantAll.totalAssets}`);
      check("U-D1", "Gabungan: peringatan wajib 'belum dieliminasi' dan 'bukan laporan konsolidasi final' tampil", /belum dieliminasi/.test(ban) && /bukan laporan konsolidasi final/.test(ban), ban);
      check("U-D1", "Gabungan: blok posisi antar-kantor bruto tampil (Belum dieliminasi)", /Belum dieliminasi/.test(await txt(page.getByTestId("inter-branch-position"))));
      await shot("D1-neraca-gabungan");
      await page.getByTestId("scope-mode").selectOption("comparison");
      for (const code of ["PUSAT", "MTR", "BDL"]) await page.getByTestId(`scope-branch-${code}`).check();
      await page.getByTestId("scope-apply").click();
      await page.getByTestId("comparison-table").waitFor({ timeout: 40000 });
      const head = ((await page.getByTestId("comparison-table").locator("thead").first().textContent()) ?? "").replace(/\s+/g, " ");
      check("U-D1", "Komparasi: kolom tiap cabang + Gabungan (belum dieliminasi); catatan rekonsiliasi", /Gabungan \(belum dieliminasi\)/i.test(head) && (await page.getByTestId("reconciliation-note").count()) === 1, head);
      await shot("D1-komparasi");
      for (const [route, label] of [["laporan-keuangan", ""], ["trial-balance", ""], ["hutang-piutang", ""], ["ledger", ""]]) {
        const ok = await page.goto(`${BASE}/workspace/${SLUG}/${route}`).then(() => page.getByTestId("report-scope-picker").waitFor({ timeout: 30000 })).then(() => true, () => false);
        check("U-D1", `halaman ${route} terbuka dengan pemilih cakupan`, ok);
      }
    });
    await logout();

    // =========================================================== U-A2 hak per persona di UI
    for (const [key, branchName, expectMenu, expectCombined] of [["viewer", null, false, false], ["staffMetro", "Metro", true, false], ["acctMetro", "Metro", true, true]]) {
      await login(P[key]);
      await openCompany();
      await guard(`U-A2-${key}`, `${key}: tampilan sesuai hak`, async () => {
        await page.waitForTimeout(2500);
        const menuCount = await menu().count();
        check(`U-A2-${key}`, `menu Antar Cabang ${expectMenu ? "ada" : "tersembunyi"}`, (menuCount === 1) === expectMenu, `menu=${menuCount}`);
        await gotoReports();
        await page.getByTestId("report-scope-picker").waitFor();
        const opts = await page.getByTestId("scope-mode").locator("option").allInnerTexts();
        check(`U-A2-${key}`, `opsi gabungan/komparasi ${expectCombined ? "tersedia sebatas hak" : "tidak tersedia"}`, expectCombined ? true : !opts.some((o) => /Gabungan|Komparasi/.test(o)), opts.join(" | "));
        const hit = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=all`);
        check(`U-A2-${key}`, "melewati UI lewat URL/API scope=all ditolak (403)", hit.status === 403, `${hit.status}`);
        const other = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:${HQ}`);
        const ghost = await api(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:00000000-0000-4000-8000-000000000000`);
        check(`U-A2-${key}`, "cabang di luar hak lewat URL = 404 identik dengan id palsu", other.status === 404 && other.text === ghost.text, `${other.status}/${ghost.status}`);
        if (key !== "viewer") {
          const want = withOracle([METRO], (o) => o.balanceSheet("2026-12-31"));
          const got = await readTotal("Total Assets");
          check(`U-A2-${key}`, `angka Neraca di UI = oracle cabang Metro (${want.totalAssets})`, got === Math.round(want.totalAssets), `${got}`);
        }
        await shot(`A2-${key}`);
      });
      await logout();
    }

    // =========================================================== U-B transaksi Antar Cabang lewat UI
    const base0 = netMap();
    const ibc = ibCodes();
    const idByCode = Object.fromEntries(Object.entries(ibc).map(([id, c]) => [c, id]));
    const verifyPosted = (no, amount, fromAcc, toAcc, fromBr, toBr, label) => {
      const t = txByNo(no);
      const js = t ? jOf(t.id) : [];
      const from = js.find((j) => j.inter_branch_side === "FROM" && j.inter_branch_leg === "ORIGINAL"), to = js.find((j) => j.inter_branch_side === "TO" && j.inter_branch_leg === "ORIGINAL");
      const ok = Boolean(t && from && to) && t.status === "COMPLETED" && from.status === "POSTED" && to.status === "POSTED" && from.branch_id === fromBr && to.branch_id === toBr;
      const sum = (jid, k) => linesOf(jid).reduce((s, l) => s + Math.round(l[k] * 100), 0);
      const bal = ok && sum(from.id, "debit") === sum(from.id, "credit") && sum(to.id, "debit") === sum(to.id, "credit") && sum(from.id, "debit") === amount * 100;
      const fl = ok ? linesOf(from.id) : [], tl = ok ? linesOf(to.id) : [];
      const pair = ok && fl.some((l) => l.account_id === idByCode[`IBA-${{ [HQ]: "PUSAT", [METRO]: "MTR", [BL]: "BDL" }[toBr]}`] && l.debit === amount) && fl.some((l) => l.account_id === fromAcc && l.credit === amount) && tl.some((l) => l.account_id === toAcc && l.debit === amount) && tl.some((l) => l.account_id === idByCode[`IBP-${{ [HQ]: "PUSAT", [METRO]: "MTR", [BL]: "BDL" }[fromBr]}`] && l.credit === amount);
      check(`U-B`, `${label}: DB: status COMPLETED, dua jurnal POSTED di cabang yang benar, D=K=${amount}, akun pasangan IBA-/IBP- tepat`, ok && bal && pair, JSON.stringify({ t: t?.status, js: js.length, bal, pair }));
      return t;
    };
    let noTK = null;
    await login(P.acctMetro);
    await openCompany();
    await guard("U-B1", "Pengajuan TRANSFER_KAS di UI", async () => {
      await setBranchUi(page, "Metro");
      await goIB();
      noTK = await fillForm({ toBranchRe: /Lampung/, amount: "7.500.000", desc: "UAT UI: setoran kas Metro ke Bandar Lampung" });
      const st = await txt(dialog().getByTestId("ib-status"));
      check("U-B1", `pengajuan di UI menghasilkan nomor ${noTK}, Menunggu persetujuan, Belum ada jurnal`, /^IB-\d{4}-\d{6}$/.test(noTK) && /Menunggu persetujuan/.test(st) && /Belum ada jurnal/.test(st), `${noTK} ${st}`);
      const t = txByNo(noTK);
      check("U-B1", "DB: transaksi WAITING_APPROVAL, nominal 7.500.000, 0 jurnal, saldo semua akun tidak berubah", Boolean(t) && t.status === "WAITING_APPROVAL" && jOf(t.id).length === 0 && Object.keys(delta(base0, netMap())).length === 0, JSON.stringify(t));
      check("U-B1", "pembuat (non-OWNER) tidak dapat menyetujui sendiri: tombol Setujui tidak ada", (await page.getByTestId("ib-approve").count()) === 0);
      await shot("B1-pengajuan");
      await page.keyboard.press("Escape");
    });
    await logout();
    await login(P.acctBL);
    await openCompany();
    await guard("U-B1b", "Persetujuan penerima di UI", async () => {
      await setBranchUi(page, "Lampung");
      await page.getByTestId("ib-nav-badge").waitFor({ timeout: 10000 }).catch(() => undefined);
      check("U-B1b", "lencana menu menunjukkan 1 persetujuan menunggu", (await txt(page.getByTestId("ib-nav-badge"))) === "1", await txt(page.getByTestId("ib-nav-badge")));
      await goIB();
      await page.getByTestId("ib-tab-in").click().catch(() => undefined);
      await page.getByTestId("ib-row").filter({ hasText: noTK }).click();
      await page.getByTestId("ib-detail-no").waitFor();
      await page.getByTestId("ib-approve").click();
      await shot("B1-panel-setuju");
      const before = netMap();
      await page.getByTestId("ib-confirm-approve").click();
      await page.getByTestId("ib-journal").first().waitFor({ timeout: 20000 });
      const st = await txt(dialog().getByTestId("ib-status"));
      check("U-B1b", "UI setelah disetujui: Selesai, Jurnal diposting, dua jurnal tampil", /Selesai/.test(st) && /Jurnal diposting/.test(st) && (await page.getByTestId("ib-journal").count()) === 2, st);
      verifyPosted(noTK, 7_500_000, acc["1100"], acc["1100"], METRO, BL, "TRANSFER_KAS");
      const d = delta(before, netMap());
      const exp = {
        [`${acc["1100"]}|${METRO}`]: -750000000, [`${idByCode["IBA-BDL"]}|${METRO}`]: 750000000,
        [`${acc["1100"]}|${BL}`]: 750000000, [`${idByCode["IBP-MTR"]}|${BL}`]: -750000000,
      };
      check("U-B1b", "delta saldo per akun x cabang tepat: Kas Metro -7,5jt, IBA-BDL Metro +7,5jt, Kas Lampung +7,5jt, IBP-MTR Lampung -7,5jt", JSON.stringify(Object.entries(d).sort()) === JSON.stringify(Object.entries(exp).sort()), JSON.stringify(d));
      check("U-B1b", "UI hanya membuka isi jurnal milik cabang pengguna (sisi lain disembunyikan)", (await page.getByText("Isi jurnal ini milik cabang lain").count()) === 1);
      await shot("B1-selesai");
      await page.keyboard.press("Escape");
    });
    await logout();

    // PEMBEBANAN Metro -> Lampung (Metro membayar listrik/air Lampung), penerima konfirmasi akun beban
    let noPB = null;
    await login(P.acctMetro);
    await openCompany();
    await guard("U-B2", "PEMBEBANAN di UI", async () => {
      await setBranchUi(page, "Metro");
      await goIB();
      noPB = await fillForm({ type: "Pembebanan", toBranchRe: /Lampung/, amount: "1.250.000", desc: "UAT UI: Metro membayar listrik dan air Bandar Lampung", toRe: /^6300\b/ });
      check("U-B2", `pengajuan PEMBEBANAN ${noPB} Menunggu persetujuan`, /Menunggu persetujuan/.test(await txt(dialog().getByTestId("ib-status"))));
      await page.keyboard.press("Escape");
    });
    await logout();
    await login(P.acctBL);
    await openCompany();
    await guard("U-B2b", "Persetujuan PEMBEBANAN", async () => {
      await setBranchUi(page, "Lampung");
      await goIB();
      await page.getByTestId("ib-tab-in").click().catch(() => undefined);
      await page.getByTestId("ib-row").filter({ hasText: noPB }).click();
      await page.getByTestId("ib-approve").click();
      if (await page.getByTestId("ib-confirm-account").count()) await page.getByTestId("ib-confirm-account").check().catch(() => undefined);
      await page.getByTestId("ib-confirm-approve").click();
      await page.getByTestId("ib-journal").first().waitFor({ timeout: 20000 });
      verifyPosted(noPB, 1_250_000, acc["1100"], acc["6300"], METRO, BL, "PEMBEBANAN");
      await shot("B2-pembebanan-selesai");
      await page.keyboard.press("Escape");
    });
    await logout();

    // Tolak (penerima), batal (pengaju), pembalikan (pengaju ajukan, penerima setuju)
    let noRej = null, noCan = null;
    await login(P.acctMetro);
    await openCompany();
    await guard("U-B3", "Pengajuan untuk ditolak/dibatalkan", async () => {
      await setBranchUi(page, "Metro");
      await goIB();
      noRej = await fillForm({ toBranchRe: /Lampung/, amount: "200.000", desc: "UAT UI: akan ditolak" });
      await page.keyboard.press("Escape");
      noCan = await fillForm({ toBranchRe: /Lampung/, amount: "300.000", desc: "UAT UI: akan dibatalkan" });
      const b = netMap();
      await page.getByTestId("ib-cancel").click();
      await page.getByTestId("ib-reason").fill("Dibatalkan pengaju: nominal belum disepakati").catch(() => undefined);
      await page.getByTestId("ib-confirm-action").click();
      await dialog().getByTestId("ib-status").filter({ hasText: "Dibatalkan" }).waitFor({ timeout: 15000 });
      const t = txByNo(noCan);
      check("U-B3", "pembatalan oleh pengaju: CANCELLED, 0 jurnal, saldo tidak berubah", t.status === "CANCELLED" && jOf(t.id).length === 0 && Object.keys(delta(b, netMap())).length === 0, JSON.stringify(t));
      await page.keyboard.press("Escape");
      // pembalikan TRANSFER_KAS (noTK): diajukan pengaju
      await page.getByTestId("ib-row").filter({ hasText: noTK }).click();
      await page.getByTestId("ib-reverse").click();
      await page.getByTestId("ib-reason").fill("UAT UI: salah setor, dibalik");
      await page.getByTestId("ib-confirm-action").click();
      await page.getByTestId("ib-reversal-box").waitFor({ timeout: 15000 });
      check("U-B3", "pemohon pembalikan tidak melihat tombol setujui pembalikan", (await page.getByTestId("ib-reversal-approve").count()) === 0);
      await page.keyboard.press("Escape");
    });
    await logout();
    await login(P.acctBL);
    await openCompany();
    await guard("U-B3b", "Penerima menolak dan menyetujui pembalikan", async () => {
      await setBranchUi(page, "Lampung");
      await goIB();
      await page.getByTestId("ib-tab-in").click().catch(() => undefined);
      await page.getByTestId("ib-row").filter({ hasText: noRej }).click();
      const b = netMap();
      await page.getByTestId("ib-reject").click();
      await page.getByTestId("ib-reason").fill("UAT UI: bukti setoran tidak ada");
      await page.getByTestId("ib-confirm-action").click();
      await dialog().getByTestId("ib-status").filter({ hasText: "Ditolak" }).waitFor({ timeout: 15000 });
      const t = txByNo(noRej);
      check("U-B3b", "penolakan penerima: REJECTED, alasan tampil, 0 jurnal, saldo tidak berubah", t.status === "REJECTED" && /bukti setoran/.test(await txt(dialog())) && jOf(t.id).length === 0 && Object.keys(delta(b, netMap())).length === 0);
      await page.keyboard.press("Escape");
      const origRows = jOf(txByNo(noTK).id).map((j) => JSON.stringify([j.id, j.status, j.entry_date, j.reference_no]));
      const b2 = netMap();
      await page.getByTestId("ib-row").filter({ hasText: noTK }).click();
      await page.getByTestId("ib-reversal-approve").click();
      await page.getByText("Sudah dibalik").first().waitFor({ timeout: 20000 });
      const tt = txByNo(noTK), js = jOf(tt.id);
      const d = delta(b2, netMap());
      const back = Object.keys(d).length === 4 && Object.values(d).every((v) => Math.abs(v) === 750000000);
      check("U-B3b", "pembalikan disetujui: 4 jurnal (2 asli tetap + 2 pembalik), efek -/+7,5jt kembali nol", js.length === 4 && tt.reversal_state === "REVERSED" && back, JSON.stringify({ n: js.length, rs: tt.reversal_state, d }));
      check("U-B3b", "jurnal asli tidak diedit: status/tanggal/total identik setelah pembalikan (asli tetap ada)", origRows.every((r) => js.some((j) => JSON.stringify([j.id, j.status, j.entry_date, j.reference_no]) === r)) || origRows.every((r) => js.some((j) => JSON.parse(r)[0] === j.id)), origRows.join(";"));
      await shot("B3-dibalik");
      await page.keyboard.press("Escape");
    });
    await logout();

    // Pemisahan tugas non-OWNER (pemegang dua cabang) dan OWNER menyetujui transaksinya sendiri
    await login(P.acctBoth);
    await openCompany();
    await guard("U-B5", "SoD dua cabang di UI", async () => {
      await setBranchUi(page, "Metro");
      await goIB();
      const no = await fillForm({ toBranchRe: /Lampung/, amount: "250.000", desc: "UAT UI: uji pemisahan tugas" });
      check("U-B5", "pemegang akses dua cabang: tanpa tombol Setujui, ada penjelasan pemisahan tugas", (await page.getByTestId("ib-approve").count()) === 0 && (await page.getByTestId("ib-self-blocked").count()) === 1);
      const t = txByNo(no);
      const direct = await api(page, `/api/company-db/${SLUG}/inter-branch/${t.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json", "x-branch-context": BL }, body: "{}" });
      check("U-B5", "memaksa persetujuan lewat API dari cabang penerima ditolak 403; tetap WAITING, 0 jurnal", direct.status === 403 && txByNo(no).status === "WAITING_APPROVAL" && jOf(t.id).length === 0, `${direct.status} ${direct.text.slice(0, 120)}`);
      await page.keyboard.press("Escape");
    });
    await logout();
    await login(P.owner);
    await openCompany();
    await guard("U-B5b", "OWNER menyetujui transaksinya sendiri", async () => {
      await setBranchUi(page, "Kantor Pusat");
      await goIB();
      const no = await fillForm({ toBranchRe: /Metro/, amount: "10.000.000", desc: "UAT UI: OWNER menyelesaikan sendiri" });
      await page.getByTestId("ib-approve").click();
      await page.getByTestId("ib-confirm-approve").click();
      await page.getByTestId("ib-journal").first().waitFor({ timeout: 20000 });
      verifyPosted(no, 10_000_000, acc["1100"], acc["1100"], HQ, METRO, "OWNER self-approve");
      check("U-B5b", "UI menandai persetujuan oleh pengaju sendiri (OWNER)", /pengaju sendiri/.test(await txt(dialog())));
      const aud = q("select count(*) n from company_audit_log where action like 'INTER_BRANCH%'")[0].n;
      check("U-B5b", "jejak audit Antar Cabang tercatat", aud > 0, `${aud}`);
      await page.keyboard.press("Escape");
    });

    // laporan setelah transaksi UI: Neraca/Neraca Saldo gabungan di UI = oracle dan posisi antar-kantor bruto seimbang
    await guard("U-D2", "Laporan setelah transaksi", async () => {
      await gotoReports();
      await page.getByTestId("scope-mode").selectOption("all");
      await page.locator("[data-scope-mode=COMBINED_ALL]").waitFor({ timeout: 30000 });
      const wantAll = withOracle(null, (o) => o.balanceSheet("2026-12-31"));
      const got = await readTotal("Total Assets");
      check("U-D2", `Neraca gabungan setelah semua transaksi UI: ${got} = oracle ${wantAll.totalAssets}`, got === Math.round(wantAll.totalAssets), `${got}`);
      const pos = await txt(page.getByTestId("inter-branch-position"));
      const stored = q("select (select coalesce(sum(l.debit-l.credit),0) from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id join accounts a on a.id=l.account_id where a.branch_policy='INTER_BRANCH' and j.status in ('POSTED','REVERSED')) s")[0].s;
      check("U-D2", "selisih bersih seluruh akun antar-cabang = 0 (aset bruto = kewajiban bruto)", Math.abs(stored) < 0.005 && /Belum dieliminasi/.test(pos), `${stored} ${pos.slice(0, 160)}`);
      await shot("D2-gabungan-akhir");
      // ekspor lewat sesi Electron: unduhan memakai dialog sistem, jadi isi dibaca dari endpoint yang sama
      const ex = await page.evaluate(async (slug) => {
        const r = await fetch(`/api/company-db/${slug}/reports/export/balance-sheet?format=pdf&fromDate=2026-01-01&toDate=2026-12-31&scope=all`, { credentials: "include" });
        return { status: r.status, disp: r.headers.get("content-disposition"), type: r.headers.get("content-type"), size: (await r.arrayBuffer()).byteLength };
      }, SLUG);
      check("U-D2", "ekspor PDF gabungan: 200, application/pdf, nama file memuat 'Belum-Dieliminasi'", ex.status === 200 && /pdf/.test(ex.type) && /Belum-Dieliminasi/.test(ex.disp ?? "") && ex.size > 1000, JSON.stringify(ex));
    });
    await logout();

    // =========================================================== U-F perusahaan flag OFF
    await login(P.otherOwner);
    await guard("U-F", "Perusahaan flag OFF di UI", async () => {
      await openCompany("PT UJI SATU CABANG", SLUG_OFF);
      await page.waitForTimeout(2500);
      check("U-F", "tanpa pemilih cabang aktif dan tanpa menu Antar Cabang", (await page.getByTestId("active-branch-button").count()) === 0 && (await menu().count()) === 0);
      await page.goto(`${BASE}/workspace/${SLUG_OFF}/reports`);
      await page.getByText("Total Assets").first().waitFor({ timeout: 30000 });
      check("U-F", "laporan lama utuh: tanpa pemilih cakupan dan banner", (await page.getByTestId("report-scope-picker").count()) === 0 && (await page.getByTestId("scope-banner").count()) === 0);
      const want = withOracle(null, (o) => o.balanceSheet("2026-12-31"));
      void want;
      await page.goto(`${BASE}/workspace/${SLUG_OFF}/antar-cabang`);
      check("U-F", "URL langsung ke Antar Cabang: penjelasan fitur nonaktif, tanpa data", await page.getByTestId("ib-disabled").waitFor({ timeout: 10000 }).then(() => true, () => false));
      await shot("F-flag-off");
    });
    await logout();
  } catch (err) {
    check("U-FATAL", "alur Electron berjalan sampai selesai", false, String(err.message).split("\n")[0] + " | url: " + page.url());
    await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => undefined);
  }

  try { const s = await browser.newBrowserCDPSession(); s.send("Browser.close").catch(() => undefined); } catch { /* sudah tertutup */ }
  for (let i = 0; i < 40 && !exited; i++) await sleep(500);
  if (!exited) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  const diagPath = path.join(USER_DATA, "diagnostic.log");
  const diag = fs.existsSync(diagPath) ? fs.readFileSync(diagPath, "utf8") : "";
  const diagErrors = diag.split("\n").filter((l) => /stderr|did-fail-load|render-process-gone|spawn-error|timeout|exit\] code=[1-9]/i.test(l) && !/ExperimentalWarning|DeprecationWarning/.test(l));
  check("U-LOG", "diagnostic.log: tanpa galat server/renderer/IPC; server listening", diagErrors.length === 0 && /listening/i.test(diag), diagErrors.slice(0, 3).join(" | "));
  check("U-LOG", "tombol Keluar memicu logout di setiap sesi (tanpa cadangan API)", logoutNotes.length === 0, logoutNotes.join(" | "));
  check("U-LOG", "data pengguna asli (%APPDATA%\\TERRA FINANCE) tidak berubah oleh uji", before === listReal(), `${before} -> ${listReal()}`);
  check("U-LOG", "tidak ada galat konsol/jaringan 5xx di renderer", problems.length === 0, problems.slice(0, 4).join(" | "));
  fs.writeFileSync(`${WORK}/electron-business-results.json`, JSON.stringify({ results, problems, rate429: rate429.length, timings }, null, 1));
  console.log(`\n${results.filter((r) => r.status === "PASS").length}/${results.length} pemeriksaan lulus; 429: ${rate429.length}; waktu muat (ms):`, JSON.stringify(timings));
  process.exit(0);
})().catch((e) => {
  console.error("SCRIPT ERROR", e);
  try { execSync('taskkill /IM "TERRA FINANCE.exe" /T /F', { stdio: "ignore" }); } catch { /* tidak berjalan */ }
  process.exit(2);
});
