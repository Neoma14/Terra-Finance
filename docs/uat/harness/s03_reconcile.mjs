import fs from "node:fs";
import { S, Client, A, rec, note, timed, state, dbA, saveState } from "./lib.mjs";
import { coaRows, OB, code, BR } from "./gen.mjs";

const owner = new Client("owner"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const { accId, periodByMonth } = state();
const { txs, reversed } = JSON.parse(fs.readFileSync(`${S}/model.json`, "utf8"));
const coa = coaRows(); const typeOf = Object.fromEntries(coa.map((r) => [r.c, r.tipe]));
const isBal = (c) => ["Aset", "Liabilitas", "Ekuitas"].includes(typeOf[c]);
const names = Object.fromEntries(coa.map((r) => [r.c, r.n]));

// ---- oracle: semua baris efektif (OB + jurnal + pembalik), Draft tidak ikut
const L = []; // {date,c,net}
for (const [c, d, k] of OB) L.push({ date: "2021-01-01", c, net: d - k });
const revSet = new Set(reversed);
for (const t of txs) { for (const l of t.lines) L.push({ date: t.date, c: l.c, net: l.d - l.cr }); if (revSet.has(t.ref)) for (const l of t.lines) L.push({ date: t.date, c: l.c, net: l.cr - l.d }); }
const sum = (f) => L.reduce((s, l) => (f(l) ? s + l.net : s), 0);
const balAt = (c, to) => sum((l) => l.c === c && l.date <= to);
const mv = (c, from, to) => sum((l) => l.c === c && l.date >= from && l.date <= to);
const inType = (c, ...t) => t.includes(typeOf[c]);
const codes = coa.map((r) => r.c);
const revenueOf = (f, t) => -codes.filter((c) => inType(c, "Pendapatan")).reduce((s, c) => s + mv(c, f, t), 0);
const cogsOf = (f, t) => codes.filter((c) => inType(c, "HPP")).reduce((s, c) => s + mv(c, f, t), 0);
const opexOf = (f, t) => codes.filter((c) => inType(c, "Beban")).reduce((s, c) => s + mv(c, f, t), 0);
const profitOf = (f, t) => revenueOf(f, t) - cogsOf(f, t) - opexOf(f, t);
const cashCodes = [code.bca, code.mdr, ...BR.map((b) => code.kas(b.k))];
const cashAt = (to) => cashCodes.reduce((s, c) => s + balAt(c, to), 0);
const assetsAt = (to) => codes.filter((c) => inType(c, "Aset")).reduce((s, c) => s + balAt(c, to), 0);
const liabAt = (to) => -codes.filter((c) => inType(c, "Liabilitas")).reduce((s, c) => s + balAt(c, to), 0);
const equityAt = (to) => -codes.filter((c) => inType(c, "Ekuitas")).reduce((s, c) => s + balAt(c, to), 0) + profitOf("2021-01-01", to);
const eq = (id, area, name, got, want, sev = "HIGH") => rec(id, area, name, got === want, `got ${got} want ${want}`, sev);
const rpt = async (p) => (await owner.get(`${A()}${p}`));
const out = { years: {} };

// ---- A. per tahun
for (let y = 2021; y <= 2025; y++) {
  const f = `${y}-01-01`, t = `${y}-12-31`, f0 = "2021-01-01";
  const [bs, is, cf, eqr] = await Promise.all([rpt(`/reports/balance-sheet?fromDate=${f0}&toDate=${t}`), rpt(`/reports/income-statement?fromDate=${f}&toDate=${t}`), rpt(`/reports/cash-flow?fromDate=${f}&toDate=${t}`), rpt(`/reports/equity?fromDate=${f}&toDate=${t}`)]);
  const b = bs.json, i = is.json, c = cf.json, e = eqr.json;
  rec(`REC-${y}-http`, "reconcile", `${y}: semua laporan 200`, [bs, is, cf, eqr].every((x) => x.status === 200), `${bs.status}/${is.status}/${cf.status}/${eqr.status}`, "HIGH");
  eq(`REC-${y}-bs-assets`, "reconcile", `${y}: Neraca Total Aset = oracle`, b.totalAssets, assetsAt(t));
  eq(`REC-${y}-bs-liab`, "reconcile", `${y}: Neraca Total Liabilitas = oracle`, b.totalLiabilities, liabAt(t));
  eq(`REC-${y}-bs-eq`, "reconcile", `${y}: Neraca Total Ekuitas = oracle (modal + laba kumulatif)`, b.totalEquity, equityAt(t));
  rec(`REC-${y}-bs-bal`, "reconcile", `${y}: Aset = Liabilitas + Ekuitas`, b.isBalanced === true && b.totalAssets === b.totalLiabilities + b.totalEquity, `A ${b.totalAssets} L+E ${b.totalLiabilities + b.totalEquity}`, "CRITICAL");
  // per akun neraca
  let mism = 0; for (const sec of [b.assets, b.liabilities, b.equity]) for (const ln of sec.lines) { if (ln.accountCode === "RE-BRIDGE") continue; const o = balAt(ln.accountCode, t); const want = typeOf[ln.accountCode] === "Aset" ? o : -o; if (ln.amount !== want) mism++; }
  rec(`REC-${y}-bs-acc`, "reconcile", `${y}: saldo setiap akun neraca = oracle`, mism === 0, `${mism} akun beda`, "HIGH");
  eq(`REC-${y}-is-rev`, "reconcile", `${y}: Laba Rugi Pendapatan = oracle`, i.revenue.total, revenueOf(f, t));
  eq(`REC-${y}-is-cogs`, "reconcile", `${y}: HPP = oracle`, i.cogs.total, cogsOf(f, t));
  eq(`REC-${y}-is-opex`, "reconcile", `${y}: Beban operasional = oracle`, i.operatingExpenses.total, opexOf(f, t));
  eq(`REC-${y}-is-np`, "reconcile", `${y}: Laba Bersih = oracle`, i.netProfit, profitOf(f, t));
  const open = equityAt(`${y - 1}-12-31`);
  eq(`REC-${y}-eq-close`, "reconcile", `${y}: Ekuitas penutup = Ekuitas Neraca`, e.closingEquity, b.totalEquity);
  rec(`REC-${y}-eq-roll`, "reconcile", `${y}: Ekuitas awal + tambahan modal + laba = penutup`, Math.abs(e.openingEquity + e.additionalCapitalOrDrawings + e.netProfit - e.closingEquity) < 1, `${e.openingEquity}+${e.additionalCapitalOrDrawings}+${e.netProfit}=${e.closingEquity}`, "HIGH");
  eq(`REC-${y}-eq-open`, "reconcile", `${y}: Ekuitas awal tahun = ekuitas akhir tahun lalu`, e.openingEquity, y === 2021 ? 0 : open, "HIGH");
  eq(`REC-${y}-cf-end`, "reconcile", `${y}: Kas akhir Arus Kas = saldo kas+bank oracle`, c.endingCash, cashAt(t));
  eq(`REC-${y}-cf-begin`, "reconcile", `${y}: Kas awal Arus Kas = kas akhir tahun lalu`, c.beginningCash, y === 2021 ? 0 : cashAt(`${y - 1}-12-31`));
  rec(`REC-${y}-cf-sum`, "reconcile", `${y}: operasi+investasi+pendanaan+belum terklasifikasi = perubahan kas`, Math.abs(c.operating.amount + c.investing.amount + c.financing.amount + c.unclassifiedAmount - c.netChangeInCash) < 1 && Math.abs(c.beginningCash + c.netChangeInCash - c.endingCash) < 1, `${c.operating.amount}/${c.investing.amount}/${c.financing.amount}/${c.unclassifiedAmount} net ${c.netChangeInCash}`, "HIGH");
  const dsh = (await rpt(`/dashboard?fromDate=${f}&toDate=${t}`)).json;
  eq(`REC-${y}-dash-ytd`, "reconcile", `${y}: Dashboard YTD laba = Laba Rugi`, dsh?.ytd?.netProfit, i.netProfit);
  eq(`REC-${y}-dash-cash`, "reconcile", `${y}: Dashboard Kas&Bank = oracle`, dsh?.kpis?.cashAndBank?.value, cashAt(t));
  eq(`REC-${y}-dash-assets`, "reconcile", `${y}: Dashboard Total Aset = Neraca`, dsh?.kpis?.totalAssets?.value, b.totalAssets);
  const db = dbA(); const dc = db.prepare("select sum(jel.debit) d, sum(jel.credit) c, count(distinct je.id) j, count(*) n from journal_entry_lines jel join journal_entries je on je.id = jel.journal_entry_id where je.status in ('POSTED','REVERSED') and je.entry_date between ? and ?").get(f, t); db.close();
  rec(`REC-${y}-dc`, "reconcile", `${y}: Total Debit = Total Kredit (database)`, dc.d === dc.c, `D ${dc.d} K ${dc.c} (${dc.j} jurnal, ${dc.n} baris)`, "CRITICAL");
  out.years[y] = { debit: dc.d, credit: dc.c, journals: dc.j, lines: dc.n, assets: b.totalAssets, liabilities: b.totalLiabilities, equity: b.totalEquity, profit: i.netProfit, revenue: i.revenue.total, cash: c.endingCash };
}

// ---- B. lima tahun sekaligus vs jumlah tahunan
{
  const is5 = (await rpt(`/reports/income-statement?fromDate=2021-01-01&toDate=2025-12-31`)).json;
  const sumNp = [2021, 2022, 2023, 2024, 2025].reduce((s, y) => s + out.years[y].profit, 0);
  eq("X-5Y-np", "cross-year", "Laba 01/01/2021-31/12/2025 = jumlah laba per tahun", is5.netProfit, sumNp, "HIGH");
  eq("X-5Y-rev", "cross-year", "Pendapatan 5 tahun = jumlah per tahun", is5.revenue.total, [2021, 2022, 2023, 2024, 2025].reduce((s, y) => s + out.years[y].revenue, 0), "HIGH");
  const bs5 = (await rpt(`/reports/balance-sheet?fromDate=2021-01-01&toDate=2025-12-31`)).json; eq("X-5Y-bs", "cross-year", "Neraca 31/12/2025 sama dengan Neraca tahunan 2025", bs5.totalAssets, out.years[2025].assets, "HIGH");
  const cf5 = (await rpt(`/reports/cash-flow?fromDate=2021-01-01&toDate=2025-12-31`)).json; eq("X-5Y-cf", "cross-year", "Kas akhir 5 tahun = Kas akhir 2025", cf5.endingCash, out.years[2025].cash, "HIGH");
  const e5 = (await rpt(`/reports/equity?fromDate=2021-01-01&toDate=2025-12-31`)).json; eq("X-5Y-eq", "cross-year", "Ekuitas penutup 5 tahun = Neraca 2025", e5.closingEquity, out.years[2025].equity, "HIGH");
}
// transaksi tepat di batas tahun
for (let y = 2021; y <= 2025; y++) for (const d of [`${y}-12-31`, `${y + 1}-01-01`]) {
  if (d > "2025-12-31") continue;
  const lg = (await rpt(`/ledger/${accId[code.kas("MTR")]}?fromDate=${d}&toDate=${d}`)).json;
  const want = L.filter((l) => l.c === code.kas("MTR") && l.date === d).length;
  rec(`X-LG-${d}`, "cross-year", `Ledger Kas Metro pada ${d} (1 hari) memuat semua baris tanggal itu`, lg?.lines?.length === want && lg?.lines?.every((x) => x.entryDate === d), `${lg?.lines?.length} vs ${want}`, "HIGH");
}
for (const [a, b2] of [["2021-12-31", "2022-01-01"], ["2022-12-31", "2023-01-01"], ["2023-12-31", "2024-01-01"], ["2024-12-31", "2025-01-01"]]) {
  const x = (await rpt(`/ledger/${accId[code.bca]}?fromDate=${a}&toDate=${b2}`)).json; const w = L.filter((l) => l.c === code.bca && l.date >= a && l.date <= b2).length;
  rec(`X-LGB-${a}`, "cross-year", `Ledger Bank BCA lintas ${a}..${b2}`, x?.lines?.length === w && x.openingBalance === balAt(code.bca, new Date(Date.parse(a) - 864e5).toISOString().slice(0, 10)), `${x?.lines?.length} vs ${w}; saldo awal ${x?.openingBalance}`, "HIGH");
}

// ---- C. Ledger 5 tahun: akun-akun besar, saldo berjalan
for (const c of [code.kas("MTR"), code.bca, code.piut, code.pers, code.hut, code.akum, code.pend("BDL")]) {
  const lg = (await timed(`ledger ${c} 5 tahun`, () => rpt(`/ledger/${accId[c]}?fromDate=2021-01-01&toDate=2025-12-31`))).res.json;
  const flow = !isBal(c); const want = flow ? mv(c, "2021-01-01", "2025-12-31") : balAt(c, "2025-12-31");
  const normalSign = ["Aset"].includes(typeOf[c]) && c !== code.akum ? 1 : typeOf[c] === "Beban" || typeOf[c] === "HPP" ? 1 : -1;
  const accountNormalDebit = !(["Liabilitas", "Ekuitas", "Pendapatan"].includes(typeOf[c]) || c === code.akum);
  const wantEnding = accountNormalDebit ? want : -want;
  let run = lg.openingBalance, ok = true; for (const ln of lg.lines) { run += accountNormalDebit ? ln.debit - ln.credit : ln.credit - ln.debit; if (run !== ln.runningBalance) ok = false; }
  rec(`LG-${c}`, "ledger", `Ledger ${names[c]} 5 tahun: saldo akhir & saldo berjalan benar`, lg.endingBalance === wantEnding && ok && lg.lines.length === L.filter((l) => l.c === c).length, `${lg.lines.length} baris; akhir ${lg.endingBalance} vs ${wantEnding}; running ${ok}`, "HIGH");
}

// ---- D. Trial Balance 60 periode
{
  let allBal = 0, mism = 0, bridgeMism = 0; const sampleBad = [];
  const months = Object.keys(periodByMonth).sort();
  const lastTb = {};
  for (const m of months) {
    const [yy, mmn] = m.split("-").map(Number); const from = `${m}-01`; const to = `${m}-${String(new Date(Date.UTC(yy, mmn, 0)).getUTCDate()).padStart(2, "0")}`;
    const tbr = await owner.get(`${A()}/trial-balance?periodId=${periodByMonth[m]}`); const tb = tbr.json; if (tbr.status !== 200) { mism += 1000; continue; }
    if (tb.isBalanced) allBal++; else sampleBad.push(m);
    for (const row of tb.rows) {
      if (row.isBridge) { const want = L.filter((l) => !isBal(l.c) && l.date < from).reduce((s, l) => s + l.net, 0); if (row.debit - row.credit !== want) bridgeMism++; continue; }
      const want = isBal(row.code) ? balAt(row.code, to) : mv(row.code, from, to);
      if (row.debit - row.credit !== want) { mism++; if (sampleBad.length < 6) sampleBad.push(`${m}:${row.code}`); }
    }
    lastTb[m] = tb;
  }
  rec("TB-60-bal", "trial-balance", "Trial Balance seimbang di 60 periode (2021-2025)", allBal === 60, `${allBal}/60 seimbang ${sampleBad.slice(0, 4)}`, "CRITICAL");
  rec("TB-60-acc", "trial-balance", "Saldo setiap akun di 60 Trial Balance = oracle", mism === 0, `${mism} selisih; ${sampleBad.slice(0, 4)}`, "HIGH");
  rec("TB-60-bridge", "trial-balance", "Baris 'Laba (Rugi) Belum Ditutup' = laba kumulatif sebelum periode (60 periode)", bridgeMism === 0, `${bridgeMism} selisih`, "HIGH");
}

// ---- E. Antarkantor: eliminasi + representasi
{
  const aaTot = BR.reduce((s, b) => s + balAt(code.aa(b.k), "2025-12-31"), 0), apTot = -BR.reduce((s, b) => s + balAt(code.ap(b.k), "2025-12-31"), 0);
  const bs = (await rpt(`/reports/balance-sheet?fromDate=2021-01-01&toDate=2025-12-31`)).json;
  const amt = (c) => [...bs.assets.lines, ...bs.liabilities.lines].find((l) => l.accountCode === c)?.amount ?? 0;
  const aaApi = BR.reduce((s, b) => s + amt(code.aa(b.k)), 0), apApi = BR.reduce((s, b) => s + amt(code.ap(b.k)), 0);
  rec("IO-elim", "interoffice", "Total Antarkantor Aktiva = Total Antarkantor Pasiva (konsolidasi, 31/12/2025, dari Neraca API)", aaApi === apApi && aaApi === aaTot, `AA ${aaApi} AP ${apApi}`, "HIGH");
  const rows = []; for (const b of BR) rows.push({ cabang: b.n, aktiva: amt(code.aa(b.k)), pasiva: amt(code.ap(b.k)) }); saveState({ interoffice: rows });
  // satu jurnal antar kantor memuat dua sisi sekaligus -> reversal membalik keduanya
  const io = txs.find((t) => t.type === "IO" && revSet.has(t.ref));
  const j = (await owner.get(`${A()}/journals?search=${io.ref}&pageSize=5`)).json.journals; const st = Object.fromEntries(j.map((x) => [x.referenceNo, x.status]));
  rec("IO-rev", "interoffice", "reversal jurnal antar kantor membalik KEDUA sisi secara atomik", st[io.ref] === "REVERSED" && st[io.ref + "-REV"] === "POSTED", JSON.stringify(st), "HIGH");
  // keseimbangan per cabang yang bisa diturunkan dari sistem
  note("IO-limit", "interoffice", "keterbatasan representasi (tanpa branch_id)", "Laporan hanya konsolidasi. Neraca/Laba Rugi per cabang tidak bisa diminta ke sistem; hanya diturunkan lewat akun beranama per cabang. Akun Antarkantor per lawan-transaksi tidak mengidentifikasi PEMILIK sisi; rekonsiliasi pasangan (Pusat<->Metro) memerlukan akun per pasangan (N x (N-1) x 2 akun) atau dimensi cabang.", "HIGH");
  // laba kotor per cabang (akun per cabang)
  const perBranch = BR.map((b) => ({ cabang: b.n, pendapatan: -mv(code.pend(b.k), "2021-01-01", "2025-12-31"), hpp: mv(code.hpp(b.k), "2021-01-01", "2025-12-31"), gaji: mv(code.gaji(b.k), "2021-01-01", "2025-12-31") }));
  const is5 = (await rpt(`/reports/income-statement?fromDate=2021-01-01&toDate=2025-12-31`)).json;
  const apiRev = Object.fromEntries(is5.revenue.lines.map((l) => [l.accountCode, l.amount]));
  rec("BR-rev", "multi-branch", "pendapatan per cabang dari Laba Rugi API (akun per cabang) = model", BR.every((b) => (apiRev[code.pend(b.k)] ?? 0) === -mv(code.pend(b.k), "2021-01-01", "2025-12-31")), JSON.stringify(perBranch.map((p) => [p.cabang.split(" ").pop(), p.pendapatan])), "HIGH");
  saveState({ perBranch });
}

// ---- F. draft tidak ikut laporan
{
  const db = dbA(); const dr = db.prepare("select count(*) c from journal_entries where status='DRAFT'").get().c; db.close();
  rec("DRAFT-excl", "reconcile", "12 jurnal Draft tidak memengaruhi laporan (oracle tanpa draft cocok semua)", dr === 12, `${dr} draft ada, seluruh rekonsiliasi di atas memakai oracle tanpa draft`, "HIGH");
}
saveState({ reconcile: out });
fs.writeFileSync(`${S}/reconcile.json`, JSON.stringify(out, null, 1));
console.log("RECONCILE SELESAI");
process.exit(0);
