// E0: identitas dan isolasi lingkungan; backup resmi + pemulihan ke folder TERPISAH dengan verifikasi integritas dan angka (sebelum dan sesudah UAT).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { ROOT, WORK, DATA, Database, run, sleep } from "./lib.mjs";

const req = createRequire(import.meta.url);
const backup = req(`${ROOT}/apps/desktop/src/backup.js`);
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const REAL = path.resolve(process.env.APPDATA ?? ".", "TERRA FINANCE");
const listReal = () => (fs.existsSync(REAL) ? fs.readdirSync(REAL).sort().join(",") : "(tidak ada)");
export const realBefore = listReal();

function dbFacts(file) {
  const d = new Database(file, { readonly: true });
  try {
    const net = {};
    for (const r of d.prepare(`select l.account_id a, j.branch_id b, sum(cast(round(l.debit*100) as integer)) - sum(cast(round(l.credit*100) as integer)) v from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.status in ('POSTED','REVERSED') group by 1,2`).all()) net[`${r.a}|${r.b}`] = r.v;
    return {
      integrity: d.pragma("integrity_check", { simple: true }), fk: d.pragma("foreign_key_check").length,
      journals: d.prepare("select count(*) n from journal_entries").get().n, lines: d.prepare("select count(*) n from journal_entry_lines").get().n,
      accounts: d.prepare("select count(*) n from accounts").get().n, tx: d.prepare("select count(*) n from inter_branch_transactions").get().n, audit: d.prepare("select count(*) n from company_audit_log").get().n,
      flag: d.prepare("select multi_branch_enabled m from company_profile").get().m, netHash: crypto.createHash("sha256").update(JSON.stringify(Object.entries(net).sort())).digest("hex"),
    };
  } finally { d.close(); }
}

/** Backup resmi (modul desktop/src/backup.js) lalu pemulihan ke folder BARU; membandingkan fakta kedua company.db dan menjalankan server di data pulihan. */
export async function backupRestoreProof(ctx, tag, c) {
  const bdir = `${WORK}/backups-${tag}`, rdir = `${WORK}/restore-${tag}`;
  fs.rmSync(bdir, { recursive: true, force: true }); fs.rmSync(rdir, { recursive: true, force: true });
  const b = backup.runBackup(DATA, { backupDir: bdir });
  c.ok(`[${tag}] backup resmi menyalin system, master, dan kedua company.db`, b.copied.length >= 4, b.copied.join(", "));
  const r = backup.restoreBackup(bdir, rdir);
  c.ok(`[${tag}] pemulihan ke folder TERPISAH (${path.basename(rdir)}) berhasil`, r.restored.length >= 4 && rdir !== DATA, r.restored.join(", "));
  for (const slug of [ctx.SLUG, ctx.SLUG_OFF]) {
    const src = dbFacts(`${DATA}/companies/${slug}/company.db`), dst = dbFacts(`${rdir}/companies/${slug}/company.db`);
    c.ok(`[${tag}] ${slug}: integrity_check ok dan foreign_key_check 0 pada hasil pemulihan`, dst.integrity === "ok" && dst.fk === 0, JSON.stringify(dst));
    c.ok(`[${tag}] ${slug}: jumlah jurnal/baris/akun/transaksi/audit dan saldo per akun x cabang identik dengan sumber`, JSON.stringify(src) === JSON.stringify(dst), `${JSON.stringify(src)} vs ${JSON.stringify(dst)}`);
  }
  // server di atas data pulihan (port terpisah): laporan harus sama dengan sumber
  const env = { ...process.env, NODE_ENV: "production", PORT: "4537", DB_FILE_PATH: `${rdir}/terra-finance.sqlite`, SYSTEM_DB_FILE_PATH: `${rdir}/terra-system.sqlite`, COMPANY_DATA_ROOT: `${rdir}/companies`, STATIC_WEB_DIR: `${ROOT}/apps/web/dist`, SESSION_SECRET: crypto.createHash("sha256").update("uat-bisnis").digest("hex") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [`${ROOT}/apps/api/dist/server.js`], { env, cwd: `${ROOT}/apps/api`, stdio: ["ignore", fs.openSync(`${WORK}/restore-${tag}-4537.log`, "w"), fs.openSync(`${WORK}/restore-${tag}-4537.log`, "a")] });
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch("http://127.0.0.1:4537/api/health")).ok) break; } catch { /* belum siap */ } await sleep(400); }
    const own = ctx.as("owner", null, "http://127.0.0.1:4537"), orig = ctx.as("owner");
    const q = "fromDate=2026-01-01&toDate=2026-12-31&scope=all";
    const a = await orig.get(`${ctx.A}/reports/balance-sheet?${q}`), z = await own.get(`${ctx.A}/reports/balance-sheet?${q}`);
    c.ok(`[${tag}] server di atas data pulihan menjawab laporan yang SAMA (Neraca gabungan: aset, kewajiban, ekuitas)`, a.status === 200 && z.status === 200 && a.json.totalAssets === z.json.totalAssets && a.json.totalLiabilities === z.json.totalLiabilities && a.json.totalEquity === z.json.totalEquity, `${a.status}/${z.status}`);
    const tb = await own.get(`${ctx.A}/trial-balance?periodId=${ctx.OKT}&scope=all`);
    c.ok(`[${tag}] Neraca Saldo di data pulihan seimbang`, tb.status === 200 && tb.json.isBalanced === true, `${tb.status}`);
  } finally { child.kill(); await sleep(1500); }
}

export async function envScenarios(ctx) {
  await run("E0", "Identitas dan isolasi lingkungan UAT; backup resmi dan pemulihan awal (sebelum transaksi UAT)", async (c) => {
    const reg = (() => { const d = new Database(`${DATA}/terra-system.sqlite`, { readonly: true }); try { return d.prepare("select id, slug, name, database_path p, status from companies_registry").all(); } finally { d.close(); } })();
    c.ok("folder data UAT berada di folder kerja terisolasi (scratch), BUKAN di %APPDATA%\\TERRA FINANCE", DATA.replace(/\\/g, "/").includes("/scratchpad/") && !DATA.toLowerCase().startsWith(REAL.toLowerCase().replace(/\\/g, "/")), DATA);
    c.ok("registri system DB hanya memuat dua perusahaan uji (bukan perusahaan operasional)", reg.length === 2 && reg.map((r) => r.slug).sort().join() === [ctx.SLUG, ctx.SLUG_OFF].sort().join(), JSON.stringify(reg.map((r) => [r.slug, r.name])));
    c.ok("file company.db setiap perusahaan berada di folder data UAT", reg.every((r) => path.resolve(r.p).replace(/\\/g, "/").startsWith(DATA.replace(/\\/g, "/"))), reg.map((r) => r.p).join(" | "));
    c.ok("nama perusahaan menandai UAT; data sintetis (tanpa NPWP/alamat)", reg.every((r) => /\(UAT\)/.test(r.name)), reg.map((r) => r.name).join(" | "));
    const f1 = dbFacts(ctx.COMPANY_DB(ctx.SLUG)), f2 = dbFacts(ctx.COMPANY_DB(ctx.SLUG_OFF));
    c.ok("feature flag: perusahaan uji multi-cabang = ON (dinyalakan OWNER), perusahaan uji kedua = OFF", f1.flag === 1 && f2.flag === 0, `${f1.flag}/${f2.flag}`);
    const prod = await fetch("http://127.0.0.1:4000/api/health").then(() => true, () => false);
    c.ok("port 4000 (aplikasi nyata) tidak sedang melayani selama UAT; server UAT memakai port 4536", !prod && ctx.srv.base.endsWith(":4536"), `4000 hidup=${prod}`);
    const cnt = ctx.counts();
    c.ok("keadaan awal tercatat (jurnal sintetis 3 bulan, belum ada transaksi Antar Cabang)", cnt.journals === 210 && cnt.tx === 0, JSON.stringify(cnt));
    await backupRestoreProof(ctx, "awal", c);
    const real = listReal();
    c.ok("%APPDATA%\\TERRA FINANCE tidak berubah", real === realBefore, `${realBefore} -> ${real}`);
  });
}
export const realCheck = () => ({ before: realBefore, after: listReal() });
