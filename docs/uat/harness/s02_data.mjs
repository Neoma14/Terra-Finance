import fs from "node:fs";
import { S, Client, A, ExcelJS, rec, note, timed, saveState, state, rng } from "./lib.mjs";
import { generate, coaRows, OB, code, BR } from "./gen.mjs";

const owner = new Client("owner"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const slug = "pt-terra-nusantara";
async function loadTemplate(p) { const r = await owner.get(`${A()}/${p}`, { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf); return wb; }
const toBuf = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());

// ---- 1. COA import
{
  const wb = await loadTemplate("accounts-import/template"); const ws = wb.getWorksheet("Akun");
  for (let i = ws.rowCount; i >= 13; i--) { ws.getRow(i).values = []; }
  const rows = coaRows(); rows.forEach((r, i) => { ws.getRow(13 + i).values = [r.c, r.n, r.tipe, "", r.normal, "Ya", r.kas, r.arus, r.kartu]; });
  const buf = await toBuf(wb);
  const pv = await timed("COA import preview", () => owner.upload(`${A()}/accounts-import/preview`, "coa.xlsx", buf));
  rec("IMP-COA-1", "import", "COA import: preview (tanpa menyimpan)", pv.res.status === 200 && pv.res.json?.canCommit !== false, `${rows.length} akun; status ${pv.res.status}; ${JSON.stringify(pv.res.json).slice(0, 160)}`);
  const before = (await owner.get(`${A()}/accounts?pageSize=1`)).json.total;
  rec("IMP-COA-2", "import", "preview belum menyimpan akun apa pun", before === 0, `total akun sebelum commit = ${before}`);
  const cm = await timed("COA import commit", () => owner.upload(`${A()}/accounts-import/commit`, "coa.xlsx", buf));
  const after = (await owner.get(`${A()}/accounts?pageSize=1`)).json.total;
  rec("IMP-COA-3", "import", "COA import: commit", cm.res.status === 200 && after === rows.length, `status ${cm.res.status}; akun ${after}/${rows.length}; ${JSON.stringify(cm.res.json).slice(0, 120)}`);
}
const accs = (await owner.get(`${A()}/accounts?pageSize=500`)).json.accounts; const accId = Object.fromEntries(accs.map((a) => [a.code, a.id]));
saveState({ accId });

// ---- 2. Opening balance import + post
{
  const wb = await loadTemplate("opening-balance-import/template"); const ws = wb.getWorksheet("Saldo Awal");
  ws.getCell("B3").value = "2021-01-01";
  for (let i = ws.rowCount; i >= 13; i--) { ws.getRow(i).values = []; }
  const names = Object.fromEntries(coaRows().map((r) => [r.c, r.n]));
  OB.forEach(([c, d, k], i) => { ws.getRow(13 + i).values = [c, names[c], d || null, k || null, "Saldo awal 1 Januari 2021"]; });
  const buf = await toBuf(wb);
  const pv = await owner.upload(`${A()}/opening-balance-import/preview`, "ob.xlsx", buf);
  rec("IMP-OB-1", "import", "Opening Balance import: preview", pv.status === 200, `status ${pv.status}; ${JSON.stringify(pv.json).slice(0, 200)}`);
  const cm = await owner.upload(`${A()}/opening-balance-import/commit`, "ob.xlsx", buf);
  rec("IMP-OB-2", "import", "Opening Balance import: commit (jadi Draft)", cm.status === 200, `status ${cm.status}; ${JSON.stringify(cm.json).slice(0, 160)}`);
  const po = await owner.post(`${A()}/opening-balance/post`, {});
  rec("OB-POST", "opening-balance", "Saldo Awal hasil import sudah otomatis Posted (Post kedua = 409)", po.status === 409, `status ${po.status} ${JSON.stringify(po.json).slice(0, 100)}`);
}

// ---- 3. Import jurnal 5 tahun (batch)
const txs = generate();
const batches = []; for (let i = 0; i < txs.length; i += 500) batches.push(txs.slice(i, i + 500));
const names = Object.fromEntries(coaRows().map((r) => [r.c, r.n]));
let totalCommitted = 0;
for (let bi = 0; bi < batches.length; bi++) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal");
  ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
  for (const t of batches[bi]) { for (const l of t.lines) ws.addRow([l.c, t.date, t.ref, names[l.c], t.desc, l.d || null, l.cr || null]); ws.addRow([]); }
  const buf = await toBuf(wb);
  const pv = await timed(`journal import preview batch${bi + 1} (${batches[bi].length} jurnal)`, () => owner.upload(`${A()}/journal-import/preview`, `jurnal-${bi + 1}.xlsx`, buf));
  const j = pv.res.json;
  const ok = pv.res.status === 200 && j?.errorCount === 0 && j?.totalTransactions === batches[bi].length;
  rec(`IMP-J${bi + 1}-pv`, "import", `jurnal batch ${bi + 1}: preview ${batches[bi][0].date}..${batches[bi].at(-1).date}`, ok, `status ${pv.res.status}; trx ${j?.totalTransactions}/${batches[bi].length}; error ${j?.errorCount}; ${pv.ms} ms`);
  if (!ok) { fs.writeFileSync(`${S}/fail-batch-${bi + 1}.json`, JSON.stringify(j?.transactions?.filter((x) => x.status === "ERROR").slice(0, 5) ?? pv.res.text)); break; }
  const cm = await timed(`journal import commit batch${bi + 1}`, () => owner.upload(`${A()}/journal-import/commit`, `jurnal-${bi + 1}.xlsx`, buf));
  const c = cm.res.json; totalCommitted += c?.committedCount ?? 0;
  rec(`IMP-J${bi + 1}-cm`, "import", `jurnal batch ${bi + 1}: commit`, cm.res.status === 200 && c?.committedCount === batches[bi].length, `status ${cm.res.status}; committed ${c?.committedCount}; ${cm.ms} ms`);
}
// model/oracle
fs.writeFileSync(`${S}/model.json`, JSON.stringify({ txs }));
const total = (await owner.get(`${A()}/journals?pageSize=1`)).json.total;
rec("DATA-1", "data", "jumlah jurnal di sistem = OB + 5.907 jurnal impor", total === txs.length + 1, `sistem ${total}, diharapkan ${txs.length + 1}`);

// ---- 4. reversal (45) + draft (12)
const R = rng(77); const pick = (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(R() * a.length), 1)[0]); return out; };
const byYear = (y) => txs.filter((t) => t.date.startsWith(String(y)) && ["SC", "EX", "PU", "VP", "RC", "BT"].includes(t.type));
const chosen = [...pick(byYear(2021), 4), ...pick(byYear(2022), 4), ...pick(byYear(2023), 5), ...pick(byYear(2024), 6), ...pick(byYear(2025), 24), ...pick(txs.filter((t) => t.type === "IO" && t.date.startsWith("2025")), 2)];
const accountant = new Client("akuntan"); await accountant.login("akuntan@terra-nusantara.test", "Uat#Pass2026");
let revOk = 0; const reversed = [];
for (const t of chosen) {
  const r = await accountant.post(`${A()}/journal/reversal`, { referenceNo: t.ref, entryDate: t.date, reason: "UAT: koreksi transaksi " + t.ref });
  if (r.status === 200) { revOk++; reversed.push(t.ref); } else console.log("reversal gagal", t.ref, r.status, JSON.stringify(r.json));
}
rec("REV-bulk", "journal", `reversal ${chosen.length} jurnal lintas tahun (termasuk antar kantor)`, revOk === chosen.length, `${revOk}/${chosen.length}`);
const staff = new Client("staf"); await staff.login("staf@terra-nusantara.test", "Uat#Pass2026");
let draftOk = 0;
for (let i = 0; i < 12; i++) { const r = await staff.post(`${A()}/journal`, { referenceNo: `DRAFT-UAT-${i + 1}`, entryDate: "2025-12-15", periodId: state().periodByMonth["2025-12"], description: "draft uji", lines: [{ accountId: accId[code.kas("MTR")], debit: 111000 + i, credit: 0 }, { accountId: accId[code.pend("MTR")], debit: 0, credit: 111000 + i }] }); if (r.status === 201) draftOk++; }
rec("DRAFT-bulk", "journal", "12 jurnal Draft oleh STAFF (tidak boleh masuk laporan)", draftOk === 12, `${draftOk}/12`);
fs.writeFileSync(`${S}/model.json`, JSON.stringify({ txs, reversed }));
const db = new (await import("./lib.mjs")).Database(`${(await import("./lib.mjs")).DATA}/companies/${slug}/company.db`, { readonly: true });
const cnt = db.prepare("select status, count(*) c from journal_entries group by status").all(); const lines = db.prepare("select count(*) c from journal_entry_lines").get().c; db.close();
note("DATA-2", "data", "komposisi jurnal & baris", JSON.stringify(cnt) + " baris=" + lines);
saveState({ journalCount: total + reversed.length + draftOk, lines, reversedCount: reversed.length });
console.log("DATA SELESAI");
process.exit(0);
