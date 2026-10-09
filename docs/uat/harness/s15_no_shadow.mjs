// Memindai SELURUH elemen pada setiap halaman: tidak boleh ada box-shadow / text-shadow / drop-shadow efektif.
import fs from "node:fs";
import { launch } from "../guide/cdp.mjs";
import { S, BASE, rec, sleep } from "./lib.mjs";

const W = `${BASE}/workspace/pt-terra-nusantara`;
const pages = [
  ["Login", `${BASE}/login`, false],
  ["Beranda", `${BASE}/`, true], ["Perusahaan (daftar)", `${BASE}/workspace`, true], ["Benchmarking", `${BASE}/benchmark`, true], ["Pengguna", `${BASE}/users`, true], ["Lisensi", `${BASE}/lisensi`, true], ["Pengaturan", `${BASE}/settings`, true],
  ["Dashboard", W, true], ["Perusahaan", `${W}/perusahaan`, true], ["Chart of Accounts", `${W}/accounts`, true], ["Opening Balance", `${W}/opening-balance`, true], ["Data Awal", `${W}/data-awal`, true],
  ["Jurnal", `${W}/jurnal`, true], ["Ledger", `${W}/ledger`, true], ["Trial Balance", `${W}/trial-balance`, true], ["Buku", `${W}/buku`, true], ["Hutang & Piutang", `${W}/hutang-piutang`, true],
  ["Pajak", `${W}/pajak`, true], ["Financial Reports", `${W}/reports`, true], ["Laporan Buku", `${W}/laporan-buku`, true], ["Analisis", `${W}/analisis`, true], ["Proyeksi", `${W}/proyeksi`, true],
  ["Pengguna perusahaan", `${W}/pengguna`, true], ["Pengaturan perusahaan", `${W}/pengaturan`, true], ["Audit Log", `${W}/audit-log`, true],
];
const b = await launch({ exe: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", port: 9590 + Math.floor(Math.random() * 40), urlPrefix: BASE, args: [`--user-data-dir=${S}/edge-ns-${Date.now()}`, "--headless=new", "--window-size=1366,900", "--no-first-run", `${BASE}/login`] });
const { ev, waitFor, goto, shot, send } = b;
await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 820, deviceScaleFactor: 1, mobile: false });
const SCAN = `(() => { const bad = []; for (const el of document.querySelectorAll('*')) { const c = getComputedStyle(el); const bs = c.boxShadow, ts = c.textShadow, f = c.filter || ''; const hasBox = bs && bs !== 'none' && !/^(rgba\\(0, 0, 0, 0\\) 0px 0px 0px 0px)(, rgba\\(0, 0, 0, 0\\) 0px 0px 0px 0px)*$/.test(bs); if (hasBox || (ts && ts !== 'none') || /drop-shadow/.test(f)) bad.push((el.tagName + '.' + String(el.className).slice(0, 50)) + ' :: ' + (hasBox ? 'box=' + bs.slice(0, 60) : '') + (ts && ts !== 'none' ? ' text=' + ts : '') + (/drop-shadow/.test(f) ? ' filter=' + f : '')); } return JSON.stringify({ n: document.querySelectorAll('*').length, bad: bad.slice(0, 8), total: bad.length }); })()`;
let loggedIn = false;
const login = async () => {
  await goto(`${BASE}/login`); await waitFor("!!document.querySelector('input[type=email]')", 20000); await ev(b.helpers); await sleep(600);
  await ev(`__set(__q('input[type=email]'), 'owner@terra-nusantara.test'); __set(__q('input[type=password]'), 'Uat#Owner2026'); __q('form button[type=submit]').click(); true`);
  await waitFor("location.pathname !== '/login'", 20000); loggedIn = true;
};
let allBad = 0, scanned = 0; const details = [];
try {
  for (const [name, url, auth] of pages) {
    if (auth && !loggedIn) await login();
    await goto(url); await sleep(name === "Dashboard" || name === "Analisis" || name === "Proyeksi" ? 3500 : 2000);
    const r = JSON.parse(await ev(SCAN)); scanned += r.n; allBad += r.total;
    if (r.total) details.push(`${name}: ${r.bad.join(" | ")}`);
    if (name === "Login" || name === "Dashboard" || name === "Jurnal" || name === "Lisensi") await shot(`${S}/shots/ns-${name}.png`);
  }
  // modal / dropdown: buka beberapa yang biasanya berbayang
  await goto(`${BASE}/workspace`); await sleep(1500);
  await ev("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.innerText.includes('Tambah Perusahaan')); b&&b.click(); return !!b; })()"); await sleep(800);
  let r = JSON.parse(await ev(SCAN)); allBad += r.total; scanned += r.n; if (r.total) details.push("Modal Tambah Perusahaan: " + r.bad.join(" | "));
  await goto(`${W}`); await sleep(2500);
  await ev("(() => { const b=document.querySelector('header button'); b&&b.click(); return !!b; })()"); await sleep(600);
  r = JSON.parse(await ev(SCAN)); allBad += r.total; scanned += r.n; if (r.total) details.push("Dropdown pemilih perusahaan: " + r.bad.join(" | "));
  await goto(`${W}/jurnal`); await sleep(2500);
  await ev("(() => { const b=[...document.querySelectorAll('button')].find(e=>/Tambah|Buat|Baru/.test(e.innerText)); b&&b.click(); return !!b; })()"); await sleep(900);
  r = JSON.parse(await ev(SCAN)); allBad += r.total; scanned += r.n; if (r.total) details.push("Form Jurnal baru: " + r.bad.join(" | "));
  await shot(`${S}/shots/ns-jurnal-form.png`);
  for (const th of ["light", "dark"]) {
    await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(th)}); document.documentElement.classList.toggle('dark', ${th === "dark"}); true`); await sleep(400);
    r = JSON.parse(await ev(SCAN)); allBad += r.total; scanned += r.n; if (r.total) details.push(`tema ${th}: ` + r.bad.join(" | "));
  }
} catch (e) { details.push("ERROR " + e.message); allBad += 1; }
finally { try { await b.close(); } catch {} }
rec("NS-1", "ui", `tidak ada bayangan (box/text/drop-shadow) pada ${pages.length} halaman + modal + dropdown + tema terang/gelap (${scanned} elemen dipindai)`, allBad === 0, details.join(" || ").slice(0, 380), "MEDIUM");
console.log("DONE s15");
