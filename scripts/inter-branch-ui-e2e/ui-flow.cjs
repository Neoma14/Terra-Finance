// UI E2E Inter-Branch di Chrome sungguhan terhadap server hasil build (data = salinan UAT, bukan produksi). Lihat README.md.
const fs = require("fs");
const WORK = process.argv[2];
// playwright-core bukan dependensi repo: pasang di folder kerja (npm i playwright-core) atau set PLAYWRIGHT_CORE.
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? require("path").resolve(WORK, "node_modules/playwright-core"));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const { personas, metro } = JSON.parse(fs.readFileSync(WORK + "/personas.json", "utf8"));
const BASE = "http://127.0.0.1:4531";
const SLUG = "pt-terra-nusantara";
const URL = `${BASE}/workspace/${SLUG}/antar-cabang`;
const SHOTS = WORK + "/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const problems = [];
const check = (name, ok, detail = "") => {
  results.push([ok ? "PASS" : "FAIL", name, ok ? "" : detail]);
  if (!ok) console.log("FAIL", name, detail);
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  async function open(persona, { slug = SLUG, branch = null, path = "/antar-cabang" } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies([{ name: "konsultan_session", value: persona.token, url: BASE }]);
    if (branch) await ctx.addInitScript(([k, v]) => { try { sessionStorage.setItem(k, v); } catch {} }, [`terra.activeBranch.${slug}`, branch]);
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(m.text())) problems.push(`${persona.label}: console ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`${persona.label}: pageerror ${e.message}`));
    page.on("response", (r) => { if (r.status() >= 500) problems.push(`${persona.label}: HTTP ${r.status()} ${r.url()}`); });
    await page.goto(`${BASE}/workspace/${slug}${path}`);
    return { ctx, page };
  }
  const menu = (page) => page.locator(`aside a[href$="/antar-cabang"]`);
  const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
  const txt = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ") : "");

  // ---------------------------------------------------------------- 1. maker mengajukan
  let txNo = "";
  {
    const { ctx, page } = await open(personas.maker);
    await page.getByRole("heading", { name: "Antar Cabang" }).waitFor();
    check("maker: menu Antar Cabang tampil di sidebar", (await menu(page).count()) === 1);
    await page.getByTestId("ib-new").click();
    await page.getByTestId("ib-from-branch").waitFor();
    check("form: cabang asal = cabang kerja aktif (Metro) dan tidak dapat diganti", /Metro/.test(await txt(page.getByTestId("ib-from-branch"))));
    await page.getByTestId("ib-to-branch").selectOption({ label: "Cabang Bandar Lampung" });
    await page.getByTestId("ib-amount").fill("1.500.000");
    await page.getByTestId("ib-from-account").selectOption({ label: "1112 - Kas Cabang Metro" });
    await page.getByTestId("ib-to-account").selectOption({ label: "1113 - Kas Cabang Bandar Lampung" });
    await page.getByTestId("ib-description").fill("Setoran kas Metro ke Bandar Lampung");
    check("form: pratinjau jurnal sisi sendiri tampil", /Debit Antarkantor/.test(await txt(page.getByTestId("ib-preview"))));
    await shot(page, "01-form");
    // validasi: nominal kosong ditolak di klien
    await page.getByTestId("ib-amount").fill("");
    await page.getByTestId("ib-submit").click();
    check("form: nominal kosong -> pesan validasi, tidak terkirim", /Nominal/.test(await txt(page.getByTestId("ib-error"))));
    await page.getByTestId("ib-amount").fill("1.500.000");
    await page.getByTestId("ib-submit").click();
    await page.getByTestId("ib-detail-no").waitFor();
    txNo = await txt(page.getByTestId("ib-detail-no"));
    const status = await txt(page.locator("[role=dialog]").getByTestId("ib-status"));
    check("pengajuan berhasil: nomor IB-, status Menunggu persetujuan, belum ada jurnal", /^IB-\d{4}-\d{6}$/.test(txNo) && /Menunggu persetujuan/.test(status) && /Belum ada jurnal/.test(status), `${txNo} | ${status}`);
    check("maker tidak melihat tombol Setujui/Tolak (bukan penerima), tetapi melihat Batalkan", (await page.getByTestId("ib-approve").count()) === 0 && (await page.getByTestId("ib-cancel").count()) === 1);
    await shot(page, "02-detail-menunggu");
    await page.keyboard.press("Escape");
    await page.getByTestId("ib-tab-out").click();
    check("tab Keluar menampilkan pengajuan", (await page.getByTestId("ib-row").filter({ hasText: txNo }).count()) === 1);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 2. approver menyetujui
  {
    const { ctx, page } = await open(personas.approver);
    await page.getByRole("heading", { name: "Antar Cabang" }).waitFor();
    await page.getByTestId("ib-nav-badge").waitFor({ timeout: 8000 }).catch(() => undefined);
    check("approver: lencana menu menunjukkan transaksi masuk menunggu", (await txt(page.getByTestId("ib-nav-badge"))) === "1", await txt(page.getByTestId("ib-nav-badge")));
    await page.getByTestId("ib-tab-in").click();
    await page.getByTestId("ib-row").filter({ hasText: txNo }).click();
    await page.getByTestId("ib-detail-no").waitFor();
    check("approver tidak melihat akun pemberi (sisi lawan)", !/Akun pemberi/.test(await txt(page.locator("[role=dialog]"))));
    await page.getByTestId("ib-approve").click();
    check("panel persetujuan memuat akun usulan terpilih", /1113/.test(await page.getByTestId("ib-confirm-account").evaluate((s) => s.options[s.selectedIndex].text)));
    await shot(page, "03-approve-panel");
    await page.getByTestId("ib-confirm-approve").click();
    await page.getByTestId("ib-journal").first().waitFor();
    const st = await txt(page.locator("[role=dialog]").getByTestId("ib-status"));
    check("setelah disetujui: Selesai + Jurnal diposting", /Selesai/.test(st) && /Jurnal diposting/.test(st), st);
    const journals = page.getByTestId("ib-journal");
    check("dua jurnal tampil; satu berisi baris, satu milik cabang lain tanpa isi", (await journals.count()) === 2 && (await page.getByText("Isi jurnal ini milik cabang lain").count()) === 1);
    check("riwayat memuat posting kedua cabang", /Jurnal kedua cabang diposting/.test(await txt(page.getByTestId("ib-history"))));
    await shot(page, "04-detail-selesai-approver");
    await page.keyboard.press("Escape");
    check("badge hilang setelah diputuskan", (await page.getByTestId("ib-nav-badge").count()) === 0 || (await txt(page.getByTestId("ib-nav-badge"))) !== "1");
    await ctx.close();
  }

  // ---------------------------------------------------------------- 3. pembalikan
  {
    const { ctx, page } = await open(personas.maker);
    await page.getByTestId("ib-row").filter({ hasText: txNo }).click();
    await page.getByTestId("ib-detail-no").waitFor();
    check("maker melihat Selesai dan jurnal sisinya", /Selesai/.test(await txt(page.locator("[role=dialog]").getByTestId("ib-status"))) && (await page.getByTestId("ib-journal").count()) === 2);
    await page.getByTestId("ib-reverse").click();
    await page.getByTestId("ib-reason").fill("Salah input nominal setoran");
    await page.getByTestId("ib-confirm-action").click();
    await page.getByTestId("ib-reversal-box").waitFor();
    check("permintaan pembalikan menunggu; maker tidak dapat menyetujui sendiri", (await page.getByTestId("ib-reversal-approve").count()) === 0);
    await ctx.close();
    const approver = await open(personas.approver);
    await approver.page.getByTestId("ib-row").filter({ hasText: txNo }).click();
    await approver.page.getByTestId("ib-reversal-approve").click();
    await approver.page.getByText("Sudah dibalik").first().waitFor();
    // Jurnal detail dimuat ulang setelah status berubah: tunggu (dengan batas waktu) sampai kondisi yang SAMA (4 jurnal) terpenuhi.
    const fourJournals = await approver.page.waitForFunction(() => document.querySelectorAll('[data-testid="ib-journal"]').length === 4, null, { timeout: 15000 }).then(() => true, () => false);
    check("approver menyetujui pembalikan: 4 jurnal, status Sudah dibalik", fourJournals && (await approver.page.getByTestId("ib-journal").count()) === 4);
    await shot(approver.page, "05-dibalik");
    await approver.ctx.close();
  }

  // ---------------------------------------------------------------- 4. SoD: ADMIN dua cabang tidak dapat menyetujui miliknya sendiri
  {
    const { ctx, page } = await open(personas.adminBoth, { branch: metro });
    await page.getByTestId("ib-new").click();
    await page.getByTestId("ib-to-branch").selectOption({ label: "Cabang Bandar Lampung" });
    await page.getByTestId("ib-amount").fill("250000");
    await page.getByTestId("ib-from-account").selectOption({ label: "1112 - Kas Cabang Metro" });
    await page.getByTestId("ib-to-account").selectOption({ label: "1113 - Kas Cabang Bandar Lampung" });
    await page.getByTestId("ib-description").fill("Uji pemisahan tugas");
    await page.getByTestId("ib-submit").click();
    await page.getByTestId("ib-detail-no").waitFor();
    check("ADMIN dua cabang: tidak ada tombol Setujui, ada penjelasan pemisahan tugas", (await page.getByTestId("ib-approve").count()) === 0 && (await page.getByTestId("ib-self-blocked").count()) === 1);
    await shot(page, "06-self-blocked");
    await page.getByTestId("ib-cancel").click();
    await page.getByTestId("ib-confirm-action").click();
    await page.locator("[role=dialog]").getByTestId("ib-status").filter({ hasText: "Dibatalkan" }).waitFor();
    check("pengaju dapat membatalkan: status Dibatalkan", true);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 5. OWNER: tanpa akun siap -> arahan; lalu approve sendiri
  {
    const { ctx, page } = await open(personas.owner); // konteks default = Kantor Pusat (belum punya akun antarkantor ke BDL)
    await page.getByTestId("ib-new").click();
    await page.getByTestId("ib-to-branch").selectOption({ label: "Cabang Bandar Lampung (akun belum siap)" });
    check("OWNER dari Kantor Pusat: tujuan tanpa akun antarkantor ditandai belum siap", /belum dibuat/.test(await txt(page.locator("[role=dialog]"))));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(personas.owner, { branch: metro });
    await page.getByTestId("ib-new").click();
    await page.getByTestId("ib-to-branch").selectOption({ label: "Cabang Bandar Lampung" });
    await page.getByTestId("ib-amount").fill("75000");
    await page.getByTestId("ib-from-account").selectOption({ label: "1112 - Kas Cabang Metro" });
    await page.getByTestId("ib-to-account").selectOption({ label: "1113 - Kas Cabang Bandar Lampung" });
    await page.getByTestId("ib-description").fill("OWNER menyelesaikan sendiri");
    await page.getByTestId("ib-submit").click();
    await page.getByTestId("ib-detail-no").waitFor();
    await page.getByTestId("ib-approve").click();
    await page.getByTestId("ib-confirm-approve").click();
    await page.getByTestId("ib-journal").first().waitFor();
    const body = await txt(page.locator("[role=dialog]"));
    check("OWNER menyetujui transaksinya sendiri tanpa user lain: Selesai + penanda pengaju sendiri", /Selesai/.test(body) && /pengaju sendiri/.test(body));
    await shot(page, "07-owner-selesai");
    await ctx.close();
  }

  // ---------------------------------------------------------------- 6. peran lain
  {
    const { ctx, page } = await open(personas.viewer);
    await page.getByTestId("ib-disabled").waitFor();
    check("VIEWER: menu tidak tampil dan halaman langsung menolak dengan penjelasan", (await menu(page).count()) === 0 && (await page.getByTestId("ib-disabled").count()) === 1);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(personas.staffBl);
    await page.getByRole("heading", { name: "Antar Cabang" }).waitFor();
    check("STAF BDL: melihat daftar tetapi tombol Transaksi Baru tersedia (boleh mengajukan)", (await page.getByTestId("ib-new").count()) === 1);
    await page.getByTestId("ib-row").first().click();
    await page.getByTestId("ib-detail-no").waitFor();
    check("STAF tidak punya tombol Setujui/Tolak", (await page.getByTestId("ib-approve").count()) === 0 && (await page.getByTestId("ib-reject").count()) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(personas.noBranch);
    await page.waitForTimeout(1500);
    check("pengguna tanpa akses cabang: menu tersembunyi", (await menu(page).count()) === 0);
    check("pengguna tanpa akses cabang: halaman tidak menampilkan data transaksi", (await page.getByTestId("ib-row").count()) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(personas.offOwner, { slug: "pt-pembanding" });
    await page.waitForTimeout(1500);
    check("multi-cabang OFF (OWNER perusahaan lain): menu tersembunyi dan URL langsung menampilkan penjelasan", (await menu(page).count()) === 0 && (await page.getByTestId("ib-disabled").count()) === 1);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 7. filter & pencarian
  {
    const { ctx, page } = await open(personas.owner);
    await page.getByTestId("ib-row").first().waitFor();
    const total = await page.getByTestId("ib-row").count();
    await page.getByTestId("ib-filter-status").selectOption("COMPLETED");
    await page.waitForTimeout(600);
    const done = await page.getByTestId("ib-row").count();
    check("filter status Selesai mempersempit daftar", done >= 1 && done <= total, `${done}/${total}`);
    await page.getByTestId("ib-search").fill("tidak-ada-kata-ini");
    await page.getByTestId("ib-empty").waitFor();
    check("pencarian tanpa hasil menampilkan keadaan kosong", true);
    await shot(page, "08-list");
    await ctx.close();
  }

  await browser.close();
  for (const [s, n, d] of results) console.log(s, n, d);
  console.log(results.filter((r) => r[0] === "FAIL").length, "FAIL dari", results.length);
  console.log("masalah konsol/jaringan:", problems.length ? problems : "tidak ada");
  process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT ERROR", e);
  process.exit(2);
});
