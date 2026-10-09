// UAT menu Lisensi / Perpanjang: banner peringatan, halaman lisensi, perpanjangan saat lisensi habis (lewat UI).
import fs from "node:fs";
import { createRequire } from "node:module";
import { launch } from "../guide/cdp.mjs";
import { S, BASE, DATA, Client, rec, sleep, Database } from "./lib.mjs";

const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
const lib = await import(`file:///${ROOT}/tools/license-generator/src/lib.mjs`);
// Lisensi UJI ditandatangani private key vendor di proses ini (tidak dicetak, tidak ditulis ke disk).
const priv = lib.loadPrivateKey(fs.readFileSync("C:/Users/fachr/TERRA-VENDOR/license-private.pem", "utf8"));
const mkKey = (client, expiry, devices = 1) => lib.createLicenseKey({ privateKey: priv, clientName: client, expiry, devices }).key;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const CLIENT = "PT TERRA NUSANTARA (UAT)";
const t = (id, name, cond, detail = "", sev = "HIGH") => rec(id, "license-ui", name, cond, detail, sev);

const owner = new Client("owner"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const setLicense = async (key) => { const r = await owner.post("/api/license/replace", { licenseKey: key }); return r; };
await setLicense(mkKey(CLIENT, null)); // mulai dari Lifetime
const forceLicenseInDb = (key) => { const d = new Database(`${DATA}/terra-finance.sqlite`); d.prepare("update license set license_key=?").run(key); d.close(); };

const PORT = 9572 + Math.floor(Math.random() * 50);
const b = await launch({ exe: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", port: PORT, urlPrefix: BASE, args: [`--user-data-dir=${S}/edge-lic-${Date.now()}`, "--headless=new", "--window-size=1366,900", "--no-first-run", `${BASE}/login`] });
const { ev, waitFor, goto, shot, send } = b;
await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 820, deviceScaleFactor: 1, mobile: false });
const text = async () => (await ev("document.body.innerText")).replace(/\u00a0/g, " ");
const login = async (email, pw) => {
  await goto(`${BASE}/login`);
  await waitFor("!!document.querySelector('input[type=email]')", 20000); await ev(b.helpers); await sleep(800);
  await ev(`__set(__q('input[type=email]'), ${JSON.stringify(email)}); __set(__q('input[type=password]'), ${JSON.stringify(pw)}); __q('form button[type=submit]').click(); true`);
  await waitFor("location.pathname !== '/login'", 20000);
};
const banner = async () => ev("(document.querySelector('[data-testid=license-banner]')||{}).innerText || ''");
const clickText = (sel, txt) => ev(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.innerText.includes(${JSON.stringify(txt)})); if(!el) return false; el.click(); return true; })()`);

try {
  // ---- 1) Lifetime: tidak ada banner; menu Lisensi ada; halaman menampilkan Aktif
  await login("owner@terra-nusantara.test", "Uat#Owner2026");
  await goto(`${BASE}/`); await sleep(1500);
  t("LIC-1", "Lifetime: tidak ada banner peringatan", (await banner()) === "");
  t("LIC-2", "menu 'Lisensi' ada di sidebar", /Lisensi/.test(await ev("document.querySelector('aside nav')?.innerText || ''")));
  await goto(`${BASE}/lisensi`); await waitFor("document.body.innerText.includes('Lisensi terpasang')", 15000); await sleep(800);
  let tx = await text();
  t("LIC-3", "halaman Lisensi: klien, status Aktif, Tanpa batas waktu", tx.includes(CLIENT) && /Aktif/.test(tx) && /Tanpa batas waktu/.test(tx), tx.slice(0, 160).replace(/\n/g, " "));
  await shot(`${S}/shots/lic-1-lifetime.png`);

  // ---- 2) Akan habis (10 hari): banner kuning, bisa ditutup
  let r = await setLicense(mkKey(CLIENT, day(10)));
  t("LIC-4", "API replace menerima lisensi bertanggal (10 hari)", r.status === 200 && r.json?.license?.daysRemaining >= 9 && r.json?.license?.daysRemaining <= 10, `${r.status} sisa=${r.json?.license?.daysRemaining}`);
  await goto(`${BASE}/workspace`); await waitFor("document.body.innerText.includes('Daftar Perusahaan')", 15000); await sleep(1500);
  let bn = await banner();
  t("LIC-5", "banner 'akan habis dalam 10 hari' muncul di halaman Perusahaan", /akan habis dalam (9|10) hari/.test(bn) && /Perpanjang lisensi/.test(bn), bn.replace(/\n/g, " "));
  await shot(`${S}/shots/lic-2-warning.png`);
  await ev("document.querySelector('[data-testid=license-banner] button[aria-label=\"Tutup peringatan\"]').click(); true"); await sleep(400);
  t("LIC-6", "banner kuning bisa ditutup (selama sesi)", (await banner()) === "");
  await goto(`${BASE}/workspace/pt-terra-nusantara`); await sleep(2500);
  bn = await banner();
  t("LIC-7", "setelah ditutup, banner tidak muncul lagi di halaman lain pada sesi yang sama", bn === "", bn);

  // ---- 3) 3 hari: banner merah (urgent) dan tidak bisa ditutup? (masih bisa ditutup karena aktif) -> cek peran alert
  await setLicense(mkKey(CLIENT, day(3)));
  await ev("sessionStorage.clear(); true");
  await goto(`${BASE}/workspace/pt-terra-nusantara`); await sleep(2500);
  bn = await banner();
  const role = await ev("document.querySelector('[data-testid=license-banner]')?.getAttribute('role')");
  t("LIC-8", "sisa <= 7 hari: banner mendesak (role=alert)", /akan habis dalam [23] hari/.test(bn) && role === "alert", `${role} | ${bn.replace(/\n/g, " ")}`);
  await shot(`${S}/shots/lic-3-urgent.png`);

  // ---- 4) Expired: data dikunci, banner merah tidak bisa ditutup, jalur ke halaman Lisensi tetap terbuka
  forceLicenseInDb(mkKey(CLIENT, day(-5)));
  const apiBlocked = await owner.get("/api/company-db");
  t("LIC-9", "lisensi expired: API perusahaan ditolak 403 LICENSE_INVALID", apiBlocked.status === 403 && apiBlocked.json?.code === "LICENSE_INVALID", `${apiBlocked.status} ${apiBlocked.json?.code}`);
  await goto(`${BASE}/workspace`); await sleep(2500);
  tx = await text(); bn = await banner();
  t("LIC-10", "expired: banner merah 'berakhir pada…' tanpa tombol tutup + tautan perpanjang", /Lisensi berakhir pada/.test(bn) && (await ev("!document.querySelector('[data-testid=license-banner] button')")) && /Perpanjang lisensi/.test(bn), bn.replace(/\n/g, " ").slice(0, 160));
  t("LIC-11", "expired: halaman Perusahaan menampilkan tautan 'Periksa / perpanjang lisensi' (bukan jalan buntu)", /Periksa \/ perpanjang lisensi/.test(tx), tx.slice(0, 200).replace(/\n/g, " "));
  await shot(`${S}/shots/lic-4-expired-workspace.png`);
  await clickText("a", "Periksa / perpanjang lisensi"); await waitFor("location.pathname === '/lisensi'", 8000); await waitFor("document.body.innerText.includes('Lisensi terpasang')", 10000); await sleep(800);
  tx = await text();
  t("LIC-12", "halaman Lisensi saat expired: status Kedaluwarsa + pesan 'Data Anda tidak hilang'", /Kedaluwarsa/.test(tx) && /Data Anda tidak hilang/.test(tx), tx.slice(0, 220).replace(/\n/g, " "));
  await shot(`${S}/shots/lic-5-expired-page.png`);

  // ---- 5) Perpanjang lewat UI
  const fill = (k) => ev(`__set(__q('textarea'), ${JSON.stringify(k)}); true`);
  // 5a) sampah
  await ev(b.helpers); await fill("TFO2-sampah.sampah"); await clickText("button", "Periksa kunci"); await sleep(1200);
  tx = await text();
  t("LIC-13", "kunci sampah: pesan 'tidak dapat dipakai', tombol Terapkan tidak muncul", /Kunci tidak dapat dipakai/.test(tx) && !(await ev("[...document.querySelectorAll('button')].some(e=>e.innerText.includes('Terapkan lisensi'))")), tx.match(/Kunci tidak dapat dipakai[^\n]*/)?.[0] ?? "");
  // 5b) kunci expired
  await fill(mkKey(CLIENT, day(-1))); await clickText("button", "Periksa kunci"); await sleep(1200);
  const applyDisabled = await ev("[...document.querySelectorAll('button')].find(e=>e.innerText.includes('Terapkan lisensi'))?.disabled");
  tx = await text();
  t("LIC-14", "kunci yang sudah expired: ditandai dan tombol Terapkan nonaktif", /sudah kedaluwarsa/.test(tx) && applyDisabled === true, `disabled=${applyDisabled}`);
  // 5c) klien berbeda -> peringatan + wajib centang
  await fill(mkKey("PT KLIEN LAIN", day(365))); await clickText("button", "Periksa kunci"); await sleep(1200);
  tx = await text();
  const dis1 = await ev("[...document.querySelectorAll('button')].find(e=>e.innerText.includes('Terapkan lisensi'))?.disabled");
  await ev("document.querySelector('input[type=checkbox]').click(); true"); await sleep(300);
  const dis2 = await ev("[...document.querySelectorAll('button')].find(e=>e.innerText.includes('Terapkan lisensi'))?.disabled");
  t("LIC-15", "klien berbeda: peringatan tampil, Terapkan terkunci sampai dicentang", /berbeda/.test(tx) && dis1 === true && dis2 === false, `sebelum=${dis1} sesudah=${dis2}`);
  await shot(`${S}/shots/lic-6-differs.png`);
  // 5d) kunci benar (klien sama, 1 tahun)
  const good = mkKey(CLIENT, day(365), 1);
  await fill(good); await clickText("button", "Periksa kunci"); await sleep(1200);
  tx = await text();
  const dis3 = await ev("[...document.querySelectorAll('button')].find(e=>e.innerText.includes('Terapkan lisensi'))?.disabled");
  t("LIC-16", "kunci benar (klien sama): isi kunci tampil, tanpa peringatan, Terapkan aktif", tx.includes(CLIENT) && !/berbeda/.test(tx) && dis3 === false, tx.match(/Isi kunci lisensi[\s\S]{0,200}/)?.[0]?.replace(/\n/g, " ") ?? "");
  await shot(`${S}/shots/lic-7-preview.png`);
  await clickText("button", "Terapkan lisensi"); await waitFor("document.body.innerText.includes('berhasil diterapkan')", 15000); await sleep(1200);
  tx = await text();
  t("LIC-17", "perpanjangan berhasil lewat UI: pesan sukses + status Aktif + banner hilang", /berhasil diterapkan/.test(tx) && /Aktif/.test(tx) && (await banner()) === "", tx.match(/Lisensi untuk[^\n]*/)?.[0] ?? "");
  await shot(`${S}/shots/lic-8-done.png`);
  const st = await owner.get("/api/license/status");
  t("LIC-18", "status server: active, sisa ~365 hari", st.json?.license?.status === "active" && st.json.license.daysRemaining >= 364, JSON.stringify({ s: st.json?.license?.status, d: st.json?.license?.daysRemaining }));
  const after = await owner.get("/api/company-db");
  t("LIC-19", "setelah perpanjangan: data perusahaan bisa diakses lagi (200, perusahaan tetap ada)", after.status === 200 && (after.json?.companies?.length ?? 0) >= 1, `${after.status} ${after.json?.companies?.length} perusahaan`);
  await goto(`${BASE}/workspace`); await waitFor("document.body.innerText.includes('Daftar Perusahaan')", 15000); await sleep(1500);
  t("LIC-20", "halaman Perusahaan pulih tanpa pesan error", !/Gagal memuat/.test(await text()));

  // ---- 5b) Pindah komputer: data disalin, lisensi tercatat untuk mesin lain (fingerprint beda)
  { const d = new Database(`${DATA}/terra-finance.sqlite`); d.prepare("update license set instance_fingerprint='komputer-lama-xyz'").run(); d.close(); }
  const mm = await owner.get("/api/license/status"); const blocked2 = await owner.get("/api/company-db");
  t("LIC-24", "data dipindah ke komputer baru: status device_mismatch dan data bisnis terkunci (403), data tidak dihapus", mm.json?.license?.status === "device_mismatch" && blocked2.status === 403, `${mm.json?.license?.status} / ${blocked2.status}`);
  await goto(`${BASE}/workspace`); await sleep(2500);
  bn = await banner();
  t("LIC-25", "banner terikat ke komputer lain punya tautan Aktifkan di komputer ini", /terikat ke komputer lain/.test(bn) && /Aktifkan di komputer ini/.test(bn), String(bn).split(String.fromCharCode(10)).join(" ").slice(0, 200));
  await clickText("a", "Aktifkan di komputer ini"); await waitFor("location.pathname === '/lisensi'", 8000); await waitFor("document.body.innerText.includes('Lisensi terpasang')", 10000); await sleep(800);
  tx = await text();
  t("LIC-26", "halaman Lisensi: status Terikat komputer lain + penjelasan pindah komputer + data tidak hilang", /Terikat komputer lain/.test(tx) && /memindahkan aplikasi/.test(tx) && /Data Anda tidak hilang/.test(tx), tx.slice(0, 200).split(String.fromCharCode(10)).join(" "));
  await shot(`${S}/shots/lic-9-device-mismatch.png`);
  await ev(b.helpers); await fill(mkKey(CLIENT, day(400), 1)); await clickText("button", "Periksa kunci"); await sleep(1200);
  await clickText("button", "Terapkan lisensi"); await waitFor("document.body.innerText.includes('berhasil diterapkan')", 15000); await sleep(1000);
  const st2 = await owner.get("/api/license/status"); const ok2 = await owner.get("/api/company-db");
  t("LIC-27", "kunci untuk komputer ini diterapkan lewat UI: lisensi terikat ke komputer ini, status active, data bisa diakses lagi", st2.json?.license?.status === "active" && st2.json.license.fingerprintMatches === true && ok2.status === 200 && (ok2.json?.companies?.length ?? 0) >= 1, `${st2.json?.license?.status} fp=${st2.json?.license?.fingerprintMatches} data=${ok2.status}`);

  // ---- 6) Audit & hak akses
  const d = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true });
  const aud = d.prepare("select actor_label, after_json from audit_log where action='license.replace' order by created_at desc limit 1").get(); d.close();
  t("LIC-21", "penggantian lisensi tercatat di audit (siapa, klien, expiry) tanpa kunci lisensi", Boolean(aud) && /"clientName"/.test(aud.after_json) && !/TFO2-/.test(aud.after_json), aud?.after_json?.slice(0, 160));
  // non-admin
  await ev("fetch('/api/auth/logout',{method:'POST',credentials:'include'}).then(()=>1)"); await sleep(500);
  await login("viewer@terra-nusantara.test", "Uat#Pass2026");
  await goto(`${BASE}/lisensi`); await waitFor("document.body.innerText.includes('Lisensi terpasang')", 15000); await sleep(800);
  tx = await text();
  const hasTextarea = await ev("!!document.querySelector('textarea')");
  t("LIC-22", "pengguna non-admin: melihat status, tidak ada form; ada keterangan 'Hanya admin'", /Hanya\s+admin/.test(tx) && hasTextarea === false, tx.match(/Hanya[^\n]*/)?.[0] ?? "");
  const staffC = new Client("viewer"); await staffC.login("viewer@terra-nusantara.test", "Uat#Pass2026");
  const sr = await staffC.post("/api/license/replace", { licenseKey: good }); const si = await staffC.post("/api/license/inspect", { licenseKey: good });
  t("LIC-23", "non-admin tidak bisa memanggil replace/inspect lewat API (403)", sr.status === 403 && si.status === 403, `${sr.status}/${si.status}`);
} catch (e) {
  rec("LIC-ERR", "license-ui", "skenario UI lisensi tanpa error", false, e.message, "HIGH");
} finally {
  try { await b.close(); } catch {}
}
console.log("DONE s14");
