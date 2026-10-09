import { launch } from "../guide/cdp.mjs";
import { S, BASE, rec, sleep } from "./lib.mjs";
const b = await launch({ exe: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", port: 9541, urlPrefix: BASE, args: [`--user-data-dir=${S}/edge-inv7`, "--headless=new", "--window-size=1366,900", "--no-first-run", `${BASE}/login`] });
const { ev, waitFor, goto, shot, send } = b; await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 820, deviceScaleFactor: 1, mobile: false });
await waitFor("!!document.querySelector('input[type=email]')", 20000); await ev(b.helpers);
await ev(`__set(__q('input[type=email]'), 'owner@terra-nusantara.test'); __set(__q('input[type=password]'), 'Uat#Owner2026'); __q('form button[type=submit]').click(); true`); await waitFor("location.pathname !== '/login'", 20000);
await ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason))); true`);
for (let i = 0; i < 3; i++) { await goto(`${BASE}/workspace/pt-terra-nusantara/laporan-keuangan`); await sleep(3500); const tx = (await ev("document.body.innerText")).trim(); const n = await ev("document.getElementById('root')?.children.length"); const html = (await ev("document.documentElement.outerHTML.length")); console.log(i, "teks", tx.length, "root-children", n, "html", html, tx.slice(0, 80).replace(/\n/g, " ")); if (tx.length > 20) break; }
const res = await ev("fetch('/workspace/pt-terra-nusantara/laporan-keuangan').then(async (r) => r.status + ' ' + (await r.text()).slice(0, 100))"); console.log("fetch shell:", res);
await shot(`${S}/shots/ui-laporan-keuangan-retest.png`); await b.close(); process.exit(0);
