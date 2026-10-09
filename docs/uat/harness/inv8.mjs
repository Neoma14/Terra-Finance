import { launch } from "../guide/cdp.mjs";
import { S, BASE, rec, state, sleep } from "./lib.mjs";
const { xssJournal } = state(); const W = `${BASE}/workspace/pt-terra-nusantara`;
const b = await launch({ exe: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", port: 9571, urlPrefix: BASE, args: [`--user-data-dir=${S}/edge-xss`, "--headless=new", "--window-size=1366,900", "--no-first-run", `${BASE}/login`] });
const { ev, waitFor, goto, shot, send } = b; await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 820, deviceScaleFactor: 1, mobile: false });
await waitFor("!!document.querySelector('input[type=email]')", 20000); await ev(b.helpers);
await ev(`__set(__q('input[type=email]'), 'owner@terra-nusantara.test'); __set(__q('input[type=password]'), 'Uat#Owner2026'); __q('form button[type=submit]').click(); true`); await waitFor("location.pathname !== '/login'", 20000);
const base0 = await ev("document.querySelectorAll('script:not([src])').length"); console.log("skrip inline sah di halaman dasar:", base0);
const pages = [[`${W}/jurnal`, "daftar jurnal", "XSS"], [`${W}/jurnal?journalId=${xssJournal}`, "detail jurnal"], [`${W}/accounts`, "COA", "9007"], [`${BASE}/workspace`, "daftar perusahaan"], [`${BASE}/users`, "user aplikasi"], [`${W}/audit-log`, "audit log"], [`${W}/hutang-piutang`, "hutang & piutang"], [`${W}/pengguna`, "pengguna perusahaan"]];
let k = 0;
for (const [url, name, q] of pages) {
  await goto(url); await ev("window.__xss = 0; true"); await sleep(1800);
  if (q) await ev(`__set([...document.querySelectorAll('input')].find((i) => (i.placeholder || '').toLowerCase().includes('cari')), ${JSON.stringify(q)}); true`).catch(() => {});
  if (name === "hutang & piutang") await ev("[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Piutang'))?.click(); true");
  await sleep(2600);
  const exec = await ev("window.__xss || 0"); const inj = await ev("document.querySelectorAll('#root img[src=\"x\"], #root svg[onload], #root script, #root [onerror], #root [onload]').length");
  const tx = (await ev("document.body.innerText")); const shown = /<script>|<img |onerror|onload/.test(tx);
  rec("XSS2-" + name.replace(/\W+/g, "").slice(0, 12), "xss", `XSS: ${name}: payload tidak dieksekusi dan tidak menjadi elemen DOM`, exec === 0 && inj === 0, `eksekusi=${exec}; elemen_injeksi_di_root=${inj}; payload tampil sebagai teks=${shown}`, "CRITICAL"); k++;
  if (name === "detail jurnal" || name === "daftar jurnal") await shot(`${S}/shots/xss-${k}.png`);
}
await b.close(); process.exit(0);
