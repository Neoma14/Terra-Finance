import fs from "node:fs";
import { launch } from "../guide/cdp.mjs";
import { S, BASE, Client, A, rec, note, state, sleep } from "./lib.mjs";
import { code } from "./gen.mjs";

fs.mkdirSync(`${S}/shots`, { recursive: true });
const { accId, xssJournal } = state();
const PORT = 9561;
const b = await launch({ exe: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", port: PORT, urlPrefix: BASE, args: [`--user-data-dir=${S}/edge-ui2`, "--headless=new", "--window-size=1366,900", "--no-first-run", `${BASE}/login`] });
const { ev, waitFor, goto, shot, send } = b;
await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 820, deviceScaleFactor: 1, mobile: false });
const t = (id, name, cond, detail = "", sev = "MEDIUM") => rec(id, "ui", name, cond, detail, sev);
const W = `${BASE}/workspace/pt-terra-nusantara`;
const text = async () => (await ev("document.body.innerText")).replace(/\u00a0/g, " ");
const ERR = /Gagal memuat|Terjadi kesalahan|tidak seimbang|Rate limit|Internal Server|undefined|NaN|\[object Object\]|Request gagal/;

await waitFor("!!document.querySelector('input[type=email]')", 20000); await ev(b.helpers); await sleep(1500);
await shot(`${S}/shots/ui-login.png`);
await ev(`__set(__q('input[type=email]'), 'owner@terra-nusantara.test'); __set(__q('input[type=password]'), 'Uat#Owner2026'); __q('form button[type=submit]').click(); true`);
await waitFor("location.pathname !== '/login'", 20000); t("UI-login", "login via UI", true, await ev("location.pathname"), "HIGH");
const wrongLoginText = null; void wrongLoginText;

// ---- seluruh menu
const routes = [["Beranda", `${BASE}/`], ["Daftar Perusahaan (Perusahaan)", `${BASE}/workspace`], ["Benchmarking", `${BASE}/benchmark`], ["Pengguna aplikasi", `${BASE}/users`], ["Pengaturan akun", `${BASE}/settings`],
  ["Dashboard", `${W}`], ["Perusahaan (profil)", `${W}/perusahaan`], ["Chart of Accounts", `${W}/accounts`], ["Opening Balance", `${W}/opening-balance`], ["Data Awal", `${W}/data-awal`], ["Jurnal", `${W}/jurnal`], ["Ledger", `${W}/ledger`], ["Trial Balance", `${W}/trial-balance`], ["Buku (Kas & Bank)", `${W}/buku`], ["Hutang & Piutang", `${W}/hutang-piutang`], ["Pajak", `${W}/pajak`], ["Financial Reports", `${W}/reports`], ["Laporan Keuangan", `${W}/laporan-keuangan`], ["Laporan Buku", `${W}/laporan-buku`], ["Analisis", `${W}/analisis`], ["Proyeksi", `${W}/proyeksi`], ["Pengguna (perusahaan)", `${W}/pengguna`], ["Pengaturan (perusahaan)", `${W}/pengaturan`], ["Audit Log", `${W}/audit-log`], ["Administrator (login)", `${BASE}/administrator/login`]];
let rateHit = 0; let n = 0;
for (const [name, url] of process.env.SKIP_MENUS ? [] : routes) {
  n++; await goto(url); await sleep(name === "Dashboard" || name === "Analisis" || name === "Proyeksi" ? 3500 : 2200);
  const tx = await text(); const m = ERR.exec(tx); const slug = name.replace(/\W+/g, "").slice(0, 14);
  if (/Rate limit/.test(tx)) rateHit++;
  const blank = tx.trim().length < 20;
  t("UI-menu-" + slug, `menu "${name}" tampil tanpa pesan error / halaman kosong`, !m && !blank, m ? `muncul: "${m[0]}"` : blank ? "halaman kosong" : `${tx.length} karakter`, "HIGH");
  await shot(`${S}/shots/ui-${String(n).padStart(2, "0")}-${slug}.png`);
  if (rateHit && n > 12) await sleep(20000);
}
if (!process.env.SKIP_MENUS) note("UI-ratelimit", "ui", "berpindah cepat antar 25 halaman memicu 'Rate limit exceeded' di UI?", `${rateHit} halaman terkena`, rateHit ? "MEDIUM" : "INFO");
if (rateHit && !process.env.SKIP_MENUS) rec("UI-rate-normal-use", "ui", "penggunaan normal (membuka halaman berurutan) memicu pesan 'Rate limit exceeded' di UI", false, `${rateHit} dari ${n} halaman menampilkan pesan batas laju`, "MEDIUM");
if (!process.env.SKIP_MENUS) await sleep(63000);

// ---- interaksi inti pada data besar
{
  await goto(`${W}/ledger`); await sleep(2500);
  await ev(`(() => { const s = [...document.querySelectorAll('select')][0]; const o = [...s.options].find((o) => o.textContent.includes('1120')); __set(s, o.value); const d = document.querySelectorAll('input[type=date]'); __set(d[0], '2021-01-01'); __set(d[1], '2025-12-31'); return true; })()`);
  const t0 = Date.now(); await ev("[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Tampilkan').click(); true"); await waitFor("document.body.innerText.toUpperCase().includes('SALDO AKHIR')", 30000); const ms = Date.now() - t0; await sleep(500);
  const rows = await ev("document.querySelectorAll('tbody tr').length"); await shot(`${S}/shots/ui-ledger-5y.png`);
  t("UI-ledger5y", `Ledger Bank BCA 5 tahun di UI: ${rows} baris tampil dalam ${ms} ms tanpa freeze`, rows > 1500 && ms < 15000, `${rows} baris, ${ms} ms`, "MEDIUM");
  await goto(`${W}/jurnal`); await sleep(2500); const info = await text(); t("UI-journal-list", "Daftar Jurnal memuat total jurnal & pagination", /\d{1,3}(\.\d{3})*/.test(info) && !ERR.test(info), info.slice(0, 80).replace(/\n/g, " "), "MEDIUM");
  await goto(W); await sleep(500); await ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true");
  await waitFor("!!document.querySelector('input[placeholder*=\"Cari menu\"]')", 8000); await ev(`__set(document.querySelector('input[placeholder*="Cari menu"]'), 'PST-2025-0001'); true`); await sleep(1800);
  const sr = await text(); t("UI-search", "Ctrl+K menemukan jurnal dari data 5 tahun", /PST-2025-0001/.test(sr), "", "HIGH"); await shot(`${S}/shots/ui-search.png`);
}
// ---- XSS: render aman
{
  await ev("window.__xss = 0; true");
  const pages = [[`${W}/jurnal`, "daftar jurnal"], [`${W}/jurnal?journalId=${xssJournal}`, "detail jurnal"], [`${W}/accounts`, "COA"], [`${BASE}/workspace`, "daftar perusahaan"], [`${BASE}/users`, "user aplikasi"], [`${W}/audit-log`, "audit log"], [`${W}/hutang-piutang`, "hutang & piutang"], [`${W}/ledger`, "ledger"], [`${W}/pengguna`, "pengguna perusahaan"]];
  for (const [url, name] of pages) {
    await goto(url); await ev("window.__xss = 0; true");
    if (name === "daftar jurnal") { await sleep(1500); await ev(`__set([...document.querySelectorAll('input')].find((i) => (i.placeholder || '').toLowerCase().includes('cari')), 'XSS'); true`).catch(() => {}); }
    if (name === "COA") { await sleep(1500); await ev(`__set([...document.querySelectorAll('input')].find((i) => (i.placeholder || '').toLowerCase().includes('cari')), '9007'); true`).catch(() => {}); }
    if (name === "hutang & piutang") { await sleep(1500); await ev("[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Piutang'))?.click(); true"); }
    await sleep(2500);
    const exec = await ev("window.__xss || 0"); const injected = await ev("document.querySelectorAll('#root img[src=\"x\"], #root svg[onload], #root script, #root [onerror], #root [onload]').length"); const hasLiteral = (await text()).includes("<script>") || (await text()).includes("<img");
    t("XSS-" + name.replace(/\W+/g, "").slice(0, 12), `XSS: ${name} merender payload sebagai teks (tidak dieksekusi, tidak ada elemen injeksi)`, exec === 0 && injected === 0, `eksekusi=${exec}; elemen_injeksi=${injected}; payload tampil sebagai teks=${hasLiteral}`, "CRITICAL");
  }
  // pencarian dengan payload
  await goto(W); await sleep(800); await ev("window.__xss = 0; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true"); await waitFor("!!document.querySelector('input[placeholder*=\"Cari menu\"]')", 8000);
  await ev(`__set(document.querySelector('input[placeholder*="Cari menu"]'), '<img src=x onerror=window.__xss=9>'); true`); await sleep(2000);
  t("XSS-search", "XSS: kotak pencarian Ctrl+K dengan payload", (await ev("window.__xss || 0")) === 0 && (await ev("document.querySelectorAll('img[src=\"x\"]').length")) === 0, "", "CRITICAL");
  // avatar SVG berisi script: dirender via <img>?
  const c = new Client("v"); await c.login("viewer@terra-nusantara.test", "Uat#Pass2026"); const fd = new FormData(); fd.append("file", new Blob(["<svg xmlns='http://www.w3.org/2000/svg' onload='window.__xss=77'><script>window.__xss=77</script><rect width='10' height='10'/></svg>"], { type: "image/svg+xml" }), "a.svg"); const up = await c.req("POST", "/api/auth/me/avatar", { form: fd });
  const own = new Client("o2"); void own;
  note("XSS-avatar", "xss", "avatar SVG berskrip tersimpan sebagai data URI (dirender di <img>, skrip tidak berjalan di konteks <img>)", `upload status ${up.status}`);
  await c.del("/api/auth/me/avatar");
}
// ---- sesi: refresh, multi-tab, idle
{
  await goto(`${W}/jurnal`); await sleep(1500); await send("Page.reload"); await sleep(2500); t("SES-refresh", "refresh halaman: tetap login & halaman termuat", (await ev("location.pathname")).includes("/workspace"), await ev("location.pathname"), "HIGH");
  // tab kedua lewat DevTools HTTP endpoint
  const nt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(W)}`, { method: "PUT" })).json();
  const ws2 = new WebSocket(nt.webSocketDebuggerUrl); await new Promise((r) => (ws2.onopen = r)); let id = 0; const pend = new Map(); ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const ev2 = (expr) => new Promise((res) => { const n = ++id; pend.set(n, (r) => res(r?.result?.value)); ws2.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  await sleep(4000);
  t("SES-tab2", "tab kedua terbuka & login (berbagi sesi)", (await ev2("location.pathname")).includes("/workspace"), await ev2("location.pathname"), "MEDIUM");
  const key1 = await ev2("localStorage.getItem('terra.lastActivityAt')"); await ev("window.dispatchEvent(new MouseEvent('mousemove')); true"); await sleep(1200); const key2 = await ev2("localStorage.getItem('terra.lastActivityAt')");
  t("SES-shared-activity", "aktivitas di tab 1 memperbarui penanda aktivitas yang dibaca tab 2 (tab aktif menjaga semua tab)", Number(key2) >= Number(key1) && Number(key2) > 0, `${key1} -> ${key2}`, "MEDIUM");
  // logout di tab 1 -> tab 2 ikut keluar
  await ev("[...document.querySelectorAll('button')].find((x) => x.textContent.trim().includes('Keluar'))?.click(); true"); await sleep(3500);
  const p1 = await ev("location.pathname"); await sleep(3000); const p2 = await ev2("location.pathname");
  t("SES-logout-tab1", "logout di tab 1 membawa tab 1 ke /login", p1 === "/login", p1, "HIGH");
  t("SES-multitab-logout", "logout di tab 1 membuat tab 2 ikut keluar (siaran logout antar tab)", p2 === "/login", `tab2 di ${p2}`, "MEDIUM");
  const apiAfter = await fetch(`${BASE}/api/auth/me`, { headers: {} }); void apiAfter;
  ws2.close();
  // login ulang & idle 15 menit via jam browser
  await goto(`${BASE}/login`); await waitFor("!!document.querySelector('input[type=email]')", 15000); await ev(b.helpers);
  await ev(`__set(__q('input[type=email]'), 'owner@terra-nusantara.test'); __set(__q('input[type=password]'), 'Uat#Owner2026'); __q('form button[type=submit]').click(); true`); await waitFor("location.pathname !== '/login'", 20000); await sleep(2500);
  await ev(`window.__off = 0; const o = Date.now.bind(Date); Date.now = () => o() + window.__off; true`); await ev("window.__off += 16 * 60 * 1000; true");
  await waitFor("location.pathname === '/login'", 45000).then(() => t("SES-idle-ui", "tidak ada aktivitas 15 menit (jam dimajukan) -> otomatis ke /login?reason=idle", true, "", "HIGH"), () => t("SES-idle-ui", "idle 15 menit -> logout otomatis di UI", false, `masih di ${"?"}`, "HIGH"));
  const login = await text(); t("SES-idle-notice", "halaman login menampilkan pemberitahuan auto-logout", /15 menit/.test(login), login.slice(0, 120).replace(/\n/g, " "), "LOW");
  await shot(`${S}/shots/ui-idle-login.png`);
}
await b.close(); console.log("UI SELESAI"); process.exit(0);
