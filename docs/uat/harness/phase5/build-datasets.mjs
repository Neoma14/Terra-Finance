// PHASE 5.0 -- pembuat dataset benchmark/golden master (HANYA salinan scratch; bukan data produksi, bukan port 4000).
// Sumber: backup UAT 5 tahun (company.db pt-terra-nusantara). Hasil di <scratch>/p50/datasets/:
//   small   : 400 jurnal paling awal (himpunan jurnal seimbang yang konsisten), 1 cabang (Pusat)
//   uat-1   : seluruh 12.003 jurnal, 1 cabang (Pusat)  <- identik dengan perusahaan single-branch hari ini
//   uat-3   : seluruh jurnal disebar ke 3 cabang
//   uat-7   : seluruh jurnal disebar ke 7 cabang
// Penyebaran memindahkan JURNAL UTUH (tiap jurnal tetap seimbang) -- hanya untuk benchmark; trigger
// `branch_locked_after_post` dilepas sementara pada salinan scratch lalu dipasang kembali persis seperti aslinya.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const ROOT = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline";
export const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad";
export const OUT = `${S}/p50/datasets`;
const req = createRequire(`${ROOT}/apps/api/package.json`);
export const Database = req("better-sqlite3");
const knexLib = req("knex");
export const dist = (rel) => import(pathToFileURL(`${ROOT}/apps/api/dist/${rel}`).href);

const SRC_DIR = `${S}/uat5/backup/companies/pt-terra-nusantara`;
const BRANCHES = [
  ["METRO", "Cabang Metro"], ["BL", "Bandar Lampung"], ["KOTABUMI", "Cabang Kotabumi"],
  ["PRINGSEWU", "Cabang Pringsewu"], ["LIWA", "Cabang Liwa"], ["BALIK", "Cabang Balik Bukit"],
];
const actor = { actorType: "system", actorLabel: "p50-dataset" };

export async function build(name, nBranches, keepFirst = null) {
  const dir = `${OUT}/${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(SRC_DIR, fs.readdirSync(SRC_DIR).find((f) => f.endsWith(".db")));
  const dbPath = `${dir}/company.db`;
  fs.copyFileSync(src, dbPath);

  // migrasi ke skema terkini (jalur sama dengan upgrade produksi: knex migrate)
  const { default: knexfile } = await dist("db/company/knexfile.js");
  const m = knexLib({ ...knexfile, connection: { filename: dbPath } });
  await m.migrate.latest();
  await m.destroy();

  if (keepFirst) {
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = OFF");
    const trg = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('journal_entries','journal_entry_lines')").all();
    for (const t of trg) raw.exec(`DROP TRIGGER ${t.name}`);
    const keep = raw.prepare("SELECT id FROM journal_entries ORDER BY entry_date, created_at, id LIMIT ?").all(keepFirst).map((r) => r.id);
    raw.exec("CREATE TEMP TABLE keep_ids(id TEXT PRIMARY KEY)");
    const ins = raw.prepare("INSERT INTO keep_ids VALUES (?)");
    raw.transaction(() => keep.forEach((id) => ins.run(id)))();
    raw.exec("DELETE FROM journal_entry_lines WHERE journal_entry_id NOT IN (SELECT id FROM keep_ids)");
    raw.exec("UPDATE journal_entries SET reversal_of_journal_id = NULL WHERE reversal_of_journal_id IS NOT NULL AND reversal_of_journal_id NOT IN (SELECT id FROM keep_ids)");
    raw.exec("DELETE FROM journal_entries WHERE id NOT IN (SELECT id FROM keep_ids)");
    for (const t of trg) raw.exec(t.sql);
    raw.close();
  }

  const { createCompanyDb } = await dist("db/company/index.js");
  const { createBranch, setMultiBranchEnabled } = await dist("db/company/branch-service.js");
  const db = createCompanyDb(dbPath);
  const branchIds = [(await db("branches").where({ is_head_office: 1 }).first()).id];
  if (nBranches > 1) {
    await setMultiBranchEnabled(db, true, actor);
    for (const [code, label] of BRANCHES.slice(0, nBranches - 1)) branchIds.push((await createBranch(db, { code, name: label }, actor)).id);
  }
  await db.destroy();

  if (nBranches > 1) {
    const raw = new Database(dbPath);
    const lockTrg = raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='journal_entries_branch_locked_after_post'").get();
    raw.exec("DROP TRIGGER journal_entries_branch_locked_after_post");
    const ids = raw.prepare("SELECT id FROM journal_entries ORDER BY id").all().map((r) => r.id);
    const upd = raw.prepare("UPDATE journal_entries SET branch_id = ? WHERE id = ?");
    // bobot: Pusat 25%, sisanya merata (deterministik menurut urutan id)
    raw.transaction(() => ids.forEach((id, i) => {
      const slot = i % (nBranches + 1); // 0,1 -> Pusat; 2.. -> cabang lain
      upd.run(branchIds[slot <= 1 ? 0 : slot - 1], id);
    }))();
    raw.exec(lockTrg.sql);
    raw.close();
  }

  const raw = new Database(dbPath, { readonly: true });
  const info = {
    name,
    dbPath,
    branches: nBranches,
    branchIds,
    journals: raw.prepare("SELECT COUNT(*) FROM journal_entries").pluck().get(),
    lines: raw.prepare("SELECT COUNT(*) FROM journal_entry_lines").pluck().get(),
    accounts: raw.prepare("SELECT COUNT(*) FROM accounts").pluck().get(),
    perBranch: raw.prepare("SELECT branch_id b, COUNT(*) c FROM journal_entries GROUP BY branch_id").all(),
    integrity: raw.prepare("PRAGMA integrity_check").pluck().get(),
    fk: raw.prepare("PRAGMA foreign_key_check").all().length,
    sizeBytes: fs.statSync(dbPath).size,
  };
  raw.close();
  fs.writeFileSync(`${dir}/info.json`, JSON.stringify(info, null, 1));
  return info;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  for (const [name, n, keep] of [["small", 1, 400], ["uat-1", 1, null], ["uat-3", 3, null], ["uat-7", 7, null]]) {
    const i = await build(name, n, keep);
    console.log(`${name.padEnd(6)} branches=${i.branches} journals=${i.journals} lines=${i.lines} accounts=${i.accounts} integrity=${i.integrity} fk=${i.fk} size=${(i.sizeBytes / 1e6).toFixed(1)}MB perBranch=${JSON.stringify(i.perBranch.map((x) => x.c))}`);
  }
}
