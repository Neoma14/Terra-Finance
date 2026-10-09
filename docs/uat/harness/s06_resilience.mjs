import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { S, ROOT, DATA, EXE, SERVER_JS, BASE, Client, A, ExcelJS, rec, note, state, saveState, dbA, Database, startServer, stopServer, waitHealthy, sleep, timed } from "./lib.mjs";
import { code, coaRows } from "./gen.mjs";

const backup = createRequire(import.meta.url)(`${ROOT}/apps/desktop/src/backup.js`);
const { accId } = state(); const names = Object.fromEntries(coaRows().map((r) => [r.c, r.n]));
const t = (id, area, name, cond, detail = "", sev = "HIGH") => rec(id, area, name, cond, detail, sev);
const login = async (base = BASE) => { const c = new Client("o"); c.base = base; const r = await c.login("owner@terra-nusantara.test", "Uat#Owner2026"); return c; };
const jcount = (p = `${DATA}/companies/pt-terra-nusantara/company.db`) => { const d = new Database(p, { readonly: true }); const o = d.prepare("select count(*) c from journal_entries").get().c; d.close(); return o; };

// ===== A. crash saat commit besar
{
  const c = await login();
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal"); ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
  for (let i = 0; i < 4000; i++) { const d = `2026-0${7 + (i % 3)}-${String(1 + (i % 27)).padStart(2, "0")}`; ws.addRow([code.kas("TBS"), d, `CRASH-${i}`, "x", "uji crash", 5000 + i, null]); ws.addRow([code.pend("TBS"), d, `CRASH-${i}`, "x", "uji crash", null, 5000 + i]); ws.addRow([]); }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const pv = await c.upload(`${A()}/journal-import/preview`, "crash.xlsx", buf); t("CR-preview", "resilience", "preview file 4.000 transaksi", pv.status === 200 && pv.json.validCount === 4000, `status ${pv.status} valid ${pv.json?.validCount}`);
  const before = jcount();
  const pending = c.upload(`${A()}/journal-import/commit`, "crash.xlsx", buf, { noRetry: true }).catch((e) => ({ status: 0, err: String(e.message) }));
  await sleep(900); await stopServer(true); // kill -9 di tengah commit
  const res = await pending;
  const after1 = jcount(); const d = new Database(`${DATA}/companies/pt-terra-nusantara/company.db`, { readonly: true }); const ic = d.prepare("pragma integrity_check").get().integrity_check; const orphan = d.prepare("select count(*) c from journal_entry_lines jel left join journal_entries je on je.id = jel.journal_entry_id where je.id is null").get().c; const unb = d.prepare("select count(*) c from (select je.id from journal_entries je join journal_entry_lines l on l.journal_entry_id = je.id where je.status in ('POSTED','REVERSED') group by je.id having abs(sum(l.debit)-sum(l.credit)) > 1)").get().c; d.close();
  t("CR-atomic", "resilience", "kill -9 di tengah commit 4.000 jurnal: hasil atomic (semua atau tidak sama sekali), tidak ada baris yatim / jurnal tak seimbang", (after1 === before || after1 === before + 4000) && orphan === 0 && unb === 0, `jurnal ${before} -> ${after1}; yatim ${orphan}; tak seimbang ${unb}; respons klien: ${res.status ?? res.err}`, "CRITICAL");
  t("CR-integrity", "resilience", "integrity_check company.db ok setelah kill -9", ic === "ok", ic, "CRITICAL");
  const m = new Database(`${DATA}/terra-finance.sqlite`, { readonly: true }); const icm = m.prepare("pragma integrity_check").get().integrity_check; m.close(); const sy = new Database(`${DATA}/terra-system.sqlite`, { readonly: true }); const ics = sy.prepare("pragma integrity_check").get().integrity_check; sy.close();
  t("CR-integrity2", "resilience", "integrity_check master & system DB ok setelah kill -9", icm === "ok" && ics === "ok", `${icm}/${ics}`, "CRITICAL");
  startServer("after-crash"); t("CR-restart", "resilience", "server hidup lagi setelah kill -9", await waitHealthy(), "", "CRITICAL");
  const c2 = await login(); const total = (await c2.get(`${A()}/journals?pageSize=1`)).json.total; t("CR-count", "resilience", "jumlah jurnal via API = database setelah pulih", total === after1, `${total} vs ${after1}`, "HIGH");
  const lic = (await c2.get("/api/license/status")).json.license.status; t("CR-license", "resilience", "lisensi tetap aktif setelah kill -9", lic === "active", lic, "CRITICAL");
  // ulang commit -> sukses penuh bila sebelumnya rollback
  if (after1 === before) { const rr = await c2.upload(`${A()}/journal-import/commit`, "crash.xlsx", buf); t("CR-retry", "resilience", "commit ulang setelah crash berhasil penuh (4.000 jurnal)", rr.status === 200 && jcount() === before + 4000, `status ${rr.status}; ${jcount()}`, "HIGH"); } else note("CR-retry", "resilience", "commit selesai sebelum kill (4.000 jurnal tersimpan penuh)", `${after1 - before} jurnal`);
  // restart anggun
  await stopServer(false); startServer("graceful"); t("CR-graceful", "resilience", "restart anggun: server & data normal", await waitHealthy() && (await (await login()).get(`${A()}/journals?pageSize=1`)).status === 200, "", "HIGH");
  note("CR-electron", "resilience", "close/reopen jendela Electron", "TIDAK diuji di jendela Electron karena aplikasi production milik pengguna berjalan di port 4000 (port tetap). Yang diuji: proses server dari installer final (kill -9, restart anggun, restart ulang).");
}

// ===== B. backup & restore data besar
{
  const c = await login(); const jTotal = (await c.get(`${A()}/journals?pageSize=1`)).json.total;
  await stopServer(false); // hentikan agar salinan konsisten
  const BK = `${S}/backup`; fs.rmSync(BK, { recursive: true, force: true }); const RS = `${S}/restored`; fs.rmSync(RS, { recursive: true, force: true });
  const b = await timed("backup", async () => backup.runBackup(DATA, { backupDir: BK }));
  t("BK-files", "backup", "backup memuat master, system, dan company.db Company A + B (+ perusahaan uji lain)", b.res.copied.length >= 4 && b.res.copied.some((f) => /pt-terra-nusantara[\\/]company-/.test(f)) && b.res.copied.some((f) => /pt-pembanding[\\/]company-/.test(f)), `${b.res.copied.length} file, ${b.ms} ms`);
  // verifikasi backup
  let allOk = true, detail = [];
  for (const f of b.res.copied) { const full = path.join(BK, f); const d = new Database(full, { readonly: true }); const ic = d.prepare("pragma integrity_check").get().integrity_check; if (ic !== "ok") allOk = false; d.close(); }
  const src = new Database(`${DATA}/companies/pt-terra-nusantara/company.db`, { readonly: true }); const bkFile = b.res.copied.find((f) => /pt-terra-nusantara[\\/]company-/.test(f)); const bd = new Database(path.join(BK, bkFile), { readonly: true });
  const q = "select (select count(*) from journal_entries) j, (select count(*) from journal_entry_lines) l, (select sum(debit) from journal_entry_lines) d, (select sum(credit) from journal_entry_lines) c, (select count(*) from company_audit_log) a, (select count(*) from accounts) ac";
  const s1 = src.prepare(q).get(), s2 = bd.prepare(q).get(); src.close(); bd.close();
  t("BK-verify", "backup", "verifikasi backup: integrity_check semua file ok & isi sama dengan sumber (jurnal, baris, total debit/kredit, audit, akun)", allOk && JSON.stringify(s1) === JSON.stringify(s2), `sumber ${JSON.stringify(s1)} backup ${JSON.stringify(s2)}`, "CRITICAL");
  const rs = backup.restoreBackup(BK, RS); t("BK-restore", "backup", "restore ke folder UAT baru", rs.restored.length >= 4, rs.restored.join(", ").slice(0, 150));
  // jalankan 2 server: asli (4500) & hasil restore (4501), bandingkan
  startServer("orig"); await waitHealthy();
  const env2 = { ...process.env, NODE_ENV: "production", PORT: "4501", DB_FILE_PATH: `${RS}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${RS}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${RS}/companies`, STATIC_WEB_DIR: `${S}/ex1/resources/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("uat5-restored").digest("hex"), ELECTRON_RUN_AS_NODE: "1" };
  const log2 = fs.openSync(`${S}/server-restored.log`, "w"); const p2 = spawn(EXE, [SERVER_JS], { env: env2, stdio: ["ignore", log2, log2], detached: true }); p2.unref();
  let up = false; for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:4501/api/health")).ok) { up = true; break; } } catch {} await sleep(500); } t("BK-restored-up", "backup", "aplikasi berjalan dengan data hasil restore (port 4501)", up, "", "CRITICAL");
  const orig = await login(); const restored = new Client("r"); const origReq = orig.req.bind(orig);
  const R = async (path) => { const url = "http://127.0.0.1:4501" + path; const rc = await fetch(url, { headers: { Cookie: restored.cookie } }); return { status: rc.status, json: await rc.json().catch(() => null) }; };
  { const lg = await fetch("http://127.0.0.1:4501/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@terra-nusantara.test", password: "Uat#Owner2026" }) }); restored.cookie = (lg.headers.get("set-cookie") ?? "").split(";")[0]; t("BK-restored-login", "backup", "login ke instance hasil restore (user & hash ikut)", lg.status === 200, `status ${lg.status}`, "CRITICAL"); }
  const ls = await R("/api/license/status"); t("BK-restored-license", "backup", "lisensi pada instance restore tetap aktif", ls.json?.license?.status === "active", ls.json?.license?.status, "HIGH");
  const strip = (o) => JSON.stringify(o, (k, v) => (["generatedAt", "createdAt"].includes(k) ? undefined : v));
  const cmp = async (id, name, path) => { const a = await orig.get(`${A()}${path}`); const bb = await R(`${A()}${path}`); t(id, "backup", `restore = asli: ${name}`, a.status === 200 && bb.status === 200 && strip(a.json) === strip(bb.json), `${a.status}/${bb.status}${strip(a.json) === strip(bb.json) ? "" : " BEDA"}`, "CRITICAL"); };
  const jb = (await R(`${A()}/journals?pageSize=1`)).json; t("BK-journals", "backup", "jumlah jurnal sama persis (asli vs restore)", jb?.total === jTotal || jb?.total === (await orig.get(`${A()}/journals?pageSize=1`)).json.total, `${jb?.total} vs ${(await orig.get(`${A()}/journals?pageSize=1`)).json.total}`, "CRITICAL");
  for (let y = 2021; y <= 2025; y++) { await cmp(`BK-IS-${y}`, `Laba Rugi ${y}`, `/reports/income-statement?fromDate=${y}-01-01&toDate=${y}-12-31`); await cmp(`BK-BS-${y}`, `Neraca ${y}`, `/reports/balance-sheet?fromDate=2021-01-01&toDate=${y}-12-31`); await cmp(`BK-CF-${y}`, `Arus Kas ${y}`, `/reports/cash-flow?fromDate=${y}-01-01&toDate=${y}-12-31`); await cmp(`BK-EQ-${y}`, `Ekuitas ${y}`, `/reports/equity?fromDate=${y}-01-01&toDate=${y}-12-31`); await cmp(`BK-DB-${y}`, `Dashboard ${y}`, `/dashboard?fromDate=${y}-01-01&toDate=${y}-12-31`); }
  await cmp("BK-LED", "Ledger Bank BCA 5 tahun", `/ledger/${accId[code.bca]}?fromDate=2021-01-01&toDate=2025-12-31`); await cmp("BK-LED2", "Ledger Piutang 5 tahun", `/ledger/${accId[code.piut]}?fromDate=2021-01-01&toDate=2025-12-31`);
  // 60 TB
  const per = state().periodByMonth; let tbDiff = 0; for (const m of Object.keys(per)) { const a = await orig.get(`${A()}/trial-balance?periodId=${per[m]}`); const bb = await R(`${A()}/trial-balance?periodId=${per[m]}`); if (strip(a.json) !== strip(bb.json)) tbDiff++; }
  t("BK-TB60", "backup", "60 Trial Balance identik (asli vs restore)", tbDiff === 0, `${tbDiff} beda`, "CRITICAL");
  const aa = (await orig.get(`${A()}/audit-log?page=1&pageSize=1`)).json, ab = (await R(`${A()}/audit-log?page=1&pageSize=1`)).json; t("BK-audit", "backup", "jumlah audit log sama", aa?.total === ab?.total, `${aa?.total} vs ${ab?.total}`, "HIGH");
  const ac = (await orig.get(`${A()}/accounts?pageSize=500`)).json, ad = (await R(`${A()}/accounts?pageSize=500`)).json; t("BK-accounts", "backup", "COA identik", strip(ac.accounts.map((x) => [x.id, x.code, x.name, x.isLocked])) === strip(ad.accounts.map((x) => [x.id, x.code, x.name, x.isLocked])), `${ac.total} akun`, "HIGH");
  const pb = (await R(`/api/company-db/pt-pembanding/profile`)).status; t("BK-companyB", "backup", "Company B ikut ter-restore", pb === 200, `status ${pb}`, "HIGH");
  // tulis di restore tidak memengaruhi asli
  const wr = await fetch("http://127.0.0.1:4501" + `${A()}/journal-settings`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: restored.cookie }, body: JSON.stringify({ maxBackdateDays: 5 }) }); const o1 = (await orig.get(`${A()}/journal-settings`)).json.maxBackdateDays; t("BK-isolated", "backup", "perubahan di instance restore tidak memengaruhi data asli (folder terpisah)", wr.status === 200 && o1 === null, `restore ${wr.status}, asli ${o1}`, "MEDIUM");
  try { process.kill(p2.pid); } catch {} await sleep(2000);
  saveState({ backupDone: true });
}
console.log("RESILIENCE SELESAI"); process.exit(0);
