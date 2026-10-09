// UI E2E Phase 5A/5B (laporan per cabang) di Chrome sungguhan terhadap server hasil build (data = salinan UAT, bukan produksi).
//   bash scripts/inter-branch-uat/reset-uat.sh $WORK <backup-uat>
//   node scripts/inter-branch-ui-e2e/server.cjs $WORK keep        (server port 4531)
//   node scripts/phase5-ui-e2e/ui-scope.cjs $WORK
// Prasyarat sama dengan scripts/inter-branch-ui-e2e (playwright-core di folder kerja atau PLAYWRIGHT_CORE, Chrome).
const fs = require("fs");
const path = require("path");
const WORK = path.resolve(process.argv[2]);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? path.resolve(WORK, "node_modules/playwright-core"));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const { personas: P, metro, bl, kotabumi } = JSON.parse(fs.readFileSync(WORK + "/personas.json", "utf8"));
const BASE = "http://127.0.0.1:4531";
const SLUG = "pt-terra-nusantara";
const SHOTS = path.join(WORK, "shots-p5");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const problems = [];
const check = (name, ok, detail = "") => {
  results.push([ok ? "PASS" : "FAIL", name, ok ? "" : detail]);
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
};
const txt = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ") : "");

async function api(persona, method, p, body, branch) {
  const r = await fetch(BASE + p, { method, headers: { Cookie: `konsultan_session=${persona.token}`, ...(branch ? { "x-branch-context": branch } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { status: r.status, json };
}

(async () => {
  // ---- data: satu transaksi Antar Cabang selesai (Metro -> BL) agar posisi antar-kantor tidak nol
  const accs = (await api(P.owner, "GET", `/api/company-db/${SLUG}/accounts?pageSize=1000`)).json.accounts;
  const acc = (code) => accs.find((a) => a.code === code).id;
  const prop = await api(P.owner, "POST", `/api/company-db/${SLUG}/inter-branch`, {
    type: "TRANSFER_KAS", toBranchId: bl, transactionDate: new Date().toISOString().slice(0, 10), amount: 1250000, fromAccountId: acc("1112"), toAccountSuggestedId: acc("1113"), description: "Setoran kas untuk uji laporan cabang", idempotencyKey: "p5-ui-" + Date.now(),
  }, metro);
  const txId = prop.json?.transaction?.id;
  const appr = await api(P.owner, "POST", `/api/company-db/${SLUG}/inter-branch/${txId}/approve`, {}, metro);
  check("persiapan: transaksi Antar Cabang selesai untuk data uji", prop.status === 201 && appr.status === 200, `${prop.status}/${appr.status}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  async function open(persona, { slug = SLUG, branch = null, route = "reports" } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies([{ name: "konsultan_session", value: persona.token, url: BASE }]);
    const page = await ctx.newPage();
    if (branch) await page.addInitScript(([k, v]) => { try { sessionStorage.setItem(k, v); } catch {} }, [`terra.activeBranch.${slug}`, branch]);
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(m.text())) problems.push(`${persona.label}: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`${persona.label}: pageerror ${e.message}`));
    page.on("response", (r) => { if (r.status() >= 500) problems.push(`${persona.label}: HTTP ${r.status()} ${r.url()}`); });
    await page.goto(`${BASE}/workspace/${slug}/${route}`);
    return { ctx, page };
  }
  const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
  const modeOptions = async (page) => page.getByTestId("scope-mode").locator("option").allInnerTexts();
  const apiIn = (page, url) => page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include" }); return { status: r.status, text: await r.text() }; }, url);

  // ================================================================ 1. LIMITED satu cabang (Metro)
  {
    const { ctx, page } = await open(P.makerM, { branch: metro });
    await page.getByTestId("report-scope-picker").waitFor({ timeout: 20000 });
    await page.getByText("Total Assets").first().waitFor({ timeout: 20000 });
    const banner = await txt(page.getByTestId("scope-banner"));
    check("LIMITED Metro: laporan terbuka (sebelumnya 403) dan banner menyebut cakupan Cabang Metro", /Cakupan: Cabang Metro/.test(banner), banner);
    const opts = await modeOptions(page);
    check("LIMITED satu cabang: tidak ada opsi gabungan/komparasi", !opts.some((o) => /Gabungan|Komparasi/.test(o)), opts.join(" | "));
    check("tab Cash Flow dan ekspor tersedia untuk satu cabang", (await page.getByRole("button", { name: "Download" }).isEnabled()));
    const outside = await apiIn(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:${bl}`);
    const ghost = await apiIn(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:00000000-0000-4000-8000-000000000000`);
    check("akses langsung API ke cabang lain dari sesi LIMITED: 404 identik dengan id palsu", outside.status === 404 && ghost.status === 404 && outside.text === ghost.text, `${outside.status}/${ghost.status}`);
    const all = await apiIn(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=all`);
    check("akses langsung scope=all dari sesi LIMITED: 403", all.status === 403, `${all.status}`);
    await shot(page, "01-limited-reports");

    // halaman lain: banner cakupan tampil dan tidak ada galat
    await page.goto(`${BASE}/workspace/${SLUG}`);
    await page.getByTestId("scope-banner").waitFor({ timeout: 20000 });
    check("Dashboard LIMITED terbuka dengan banner cakupan cabang", /Cabang Metro/.test(await txt(page.getByTestId("scope-banner"))));
    await page.goto(`${BASE}/workspace/${SLUG}/hutang-piutang`);
    await page.getByTestId("scope-banner").waitFor({ timeout: 20000 });
    check("Hutang & Piutang LIMITED: banner cakupan tampil", /Cabang Metro/.test(await txt(page.getByTestId("scope-banner"))));
    await page.goto(`${BASE}/workspace/${SLUG}/trial-balance`);
    await page.getByTestId("report-scope-picker").waitFor();
    const periodSelect = page.locator("select").filter({ hasText: "Pilih periode" });
    await periodSelect.selectOption({ label: "Okt 2026" });
    await page.getByTestId("scope-banner").waitFor({ timeout: 20000 });
    check("Trial Balance LIMITED: tabel dan banner cakupan tampil", (await page.locator("table").count()) > 0 && /Cabang Metro/.test(await txt(page.getByTestId("scope-banner"))));
    await shot(page, "02-limited-trial-balance");
    await ctx.close();
  }

  // ================================================================ 2. OWNER: gabungan berlabel + komparasi
  {
    const { ctx, page } = await open(P.owner, { branch: metro });
    await page.getByTestId("report-scope-picker").waitFor({ timeout: 20000 });
    await page.getByText("Total Assets").first().waitFor({ timeout: 20000 });
    const opts = await modeOptions(page);
    check("OWNER: opsi gabungan terpilih, komparasi, dan seluruh cabang tersedia", ["Gabungan cabang terpilih", "Komparasi per cabang", "Gabungan seluruh cabang"].every((o) => opts.some((x) => x.includes(o))), opts.join(" | "));
    await page.getByTestId("scope-mode").selectOption("all");
    await page.locator("[data-scope-mode=COMBINED_ALL]").waitFor({ timeout: 20000 });
    const b = await txt(page.getByTestId("scope-banner"));
    check("Gabungan seluruh cabang: judul + peringatan 'belum dieliminasi' dan 'bukan laporan konsolidasi final'", /Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi/.test(b) && /bukan laporan konsolidasi final/.test(b), b);
    const pos = await txt(page.getByTestId("inter-branch-position"));
    check("posisi antar-kantor ditampilkan dengan keterangan 'Belum dieliminasi' (aset bruto = liabilitas bruto, selisih 0)", /aset bruto/.test(pos) && /Belum dieliminasi/.test(pos) && /selisih Rp\s?0/.test(pos), pos);
    await shot(page, "03-owner-combined");
    // komparasi
    await page.getByTestId("scope-mode").selectOption("comparison");
    for (const code of ["PUSAT", "MTR", "BDL"]) await page.getByTestId(`scope-branch-${code}`).check();
    await page.getByTestId("scope-apply").click();
    await page.getByTestId("comparison-table").waitFor({ timeout: 30000 });
    const header = ((await page.getByTestId("comparison-table").locator("thead").first().textContent()) ?? "").replace(/\s+/g, " ");
    check("Komparasi: kolom per cabang + 'Gabungan (belum dieliminasi)' dan catatan rekonsiliasi server", /Cabang Metro/.test(header) && /Cabang Bandar Lampung/.test(header) && /Gabungan \(belum dieliminasi\)/.test(header) && (await page.getByTestId("reconciliation-note").count()) === 1, header);
    check("Komparasi: ekspor dinonaktifkan dengan penjelasan", (await page.getByRole("button", { name: "Download" }).isDisabled()) && /Ekspor komparasi per cabang belum tersedia/.test(await txt(page.locator("main"))));
    await shot(page, "04-owner-comparison");
    await page.getByRole("button", { name: "Cash Flow" }).click();
    await page.getByTestId("cashflow-comparison-unavailable").waitFor();
    check("Komparasi Arus Kas ditolak jelas (bukan angka palsu)", true);
    // Neraca Saldo komparasi
    await page.goto(`${BASE}/workspace/${SLUG}/trial-balance`);
    await page.locator("select").filter({ hasText: "Pilih periode" }).selectOption({ label: "Okt 2026" });
    await page.getByTestId("comparison-table").waitFor({ timeout: 30000 });
    check("Trial Balance komparasi: tampil dengan status BALANCED per kolom", (await page.getByTestId("comparison-table").getByText("BALANCED", { exact: true }).count()) >= 2);
    await ctx.close();
  }

  // ================================================================ 3. ACCOUNTANT dua cabang: gabungan terpilih, bukan seluruh cabang
  {
    const { ctx, page } = await open(P.acctBoth, { branch: metro });
    await page.getByTestId("report-scope-picker").waitFor({ timeout: 20000 });
    const opts = await modeOptions(page);
    check("LIMITED dua cabang: ada gabungan terpilih + komparasi, TIDAK ada gabungan seluruh cabang", opts.some((o) => o.includes("Gabungan cabang terpilih")) && opts.some((o) => o.includes("Komparasi")) && !opts.some((o) => o.includes("seluruh cabang")), opts.join(" | "));
    await page.getByTestId("scope-mode").selectOption("selected");
    await page.getByTestId("scope-branch-MTR").check();
    await page.getByTestId("scope-branch-BDL").check();
    await page.getByTestId("scope-apply").click();
    await page.locator("[data-scope-mode=COMBINED_SELECTED]").waitFor({ timeout: 20000 });
    const b = await txt(page.getByTestId("scope-banner"));
    check("Gabungan terpilih: judul GABUNGAN CABANG TERPILIH + 'tidak mencakup seluruh cabang' + 'belum dieliminasi'", /GABUNGAN CABANG TERPILIH: bukan laporan konsolidasi perusahaan/.test(b) && /tidak mencakup seluruh cabang/.test(b) && /belum dieliminasi/.test(b), b);
    await shot(page, "05-limited-two-selected");
    const kot = await apiIn(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=selected:${metro},${kotabumi}`);
    check("akses langsung ke gabungan yang memuat cabang di luar akses: 404", kot.status === 404, `${kot.status}`);
    await ctx.close();
  }

  // ================================================================ 4. VIEWER ALL (tanpa report.consolidated)
  {
    const { ctx, page } = await open(P.viewer, { branch: metro });
    await page.getByTestId("report-scope-picker").waitFor({ timeout: 20000 });
    const opts = await modeOptions(page);
    check("VIEWER (tanpa report.consolidated): hanya cabang aktif/satu cabang", !opts.some((o) => /Gabungan|Komparasi/.test(o)), opts.join(" | "));
    const r = await apiIn(page, `/api/company-db/${SLUG}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=all`);
    check("VIEWER memaksa scope=all lewat URL: 403", r.status === 403, `${r.status}`);
    await ctx.close();
  }

  // ================================================================ 5. dua tab, dua cabang (BC-1)
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies([{ name: "konsultan_session", value: P.owner.token, url: BASE }]);
    const mk = async (branch) => {
      const page = await ctx.newPage();
      await page.addInitScript(([k, v]) => { try { sessionStorage.setItem(k, v); } catch {} }, [`terra.activeBranch.${SLUG}`, branch]);
      await page.goto(`${BASE}/workspace/${SLUG}/reports`);
      await page.getByTestId("scope-banner").waitFor({ timeout: 20000 });
      return page;
    };
    const tabA = await mk(metro);
    const tabB = await mk(bl);
    await tabA.reload();
    await tabB.reload();
    await tabA.getByTestId("scope-banner").waitFor({ timeout: 20000 });
    await tabB.getByTestId("scope-banner").waitFor({ timeout: 20000 });
    const a = await txt(tabA.getByTestId("scope-banner")), b = await txt(tabB.getByTestId("scope-banner"));
    check("dua tab, dua cabang: masing-masing menampilkan cabangnya (sessionStorage per tab)", /Cabang Metro/.test(a) && /Bandar Lampung/.test(b), `${a} | ${b}`);
    await ctx.close();
  }

  // ================================================================ 6. perusahaan tanpa multi-cabang
  {
    const { ctx, page } = await open(P.otherOwner, { slug: "pt-pembanding", route: "reports" });
    await page.getByText("Total Assets").first().waitFor({ timeout: 20000 });
    check("flag OFF: tidak ada pemilih cakupan dan tidak ada banner (tampilan lama tidak berubah)", (await page.getByTestId("report-scope-picker").count()) === 0 && (await page.getByTestId("scope-banner").count()) === 0);
    await shot(page, "06-flag-off");
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} pemeriksaan lulus`);
  console.log("masalah konsol/jaringan:", problems.length ? problems : "tidak ada");
  process.exit(results.some((r) => r[0] === "FAIL") || problems.length ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT ERROR", e);
  process.exit(2);
});
