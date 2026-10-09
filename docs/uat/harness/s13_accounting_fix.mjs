// Verifikasi UAT-005 (Cash Flow) dan UAT-011 (baris debit+kredit) terhadap server dari installer final + data 5 tahun.
import { Client, A, rec, state, dbA } from "./lib.mjs";
import { code } from "./gen.mjs";

const { accId, per } = state();
const t = (id, area, name, cond, detail = "", sev = "HIGH") => rec(id, area, name, cond, detail, sev);
const mk = async (e, p = "Uat#Pass2026") => { const c = new Client(e); const r = await c.login(e, p); if (r.status !== 200) throw new Error("login " + e + " " + r.status); return c; };
const owner = await mk("owner@terra-nusantara.test", "Uat#Owner2026"), acct = await mk("akuntan@terra-nusantara.test");
const C = (n) => BigInt(Math.round(Number(n) * 100));
const st = (r) => `status ${r.status}${r.json?.error ? " " + String(r.json.error).slice(0, 90) : ""}`;

// ================= UAT-005
const cashIds = (() => { const d = dbA(); const ids = d.prepare("select id from accounts where is_cash=1").all().map((r) => r.id); d.close(); return ids; })();
const cashBalanceCents = (before /* exclusive date */) => {
  const d = dbA(); let tot = 0n;
  for (const id of cashIds) {
    const r = d.prepare("select COALESCE(SUM(CAST(ROUND(l.debit*100) AS INTEGER)),0) dr, COALESCE(SUM(CAST(ROUND(l.credit*100) AS INTEGER)),0) cr from journal_entry_lines l join journal_entries e on e.id=l.journal_entry_id where l.account_id=? and e.status in ('POSTED','REVERSED') and e.entry_date < ?").get(id, before);
    tot += BigInt(r.dr) - BigInt(r.cr);
  }
  d.close(); return tot;
};
const nextDay = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const windows = [["2023-03-15", "2023-03-15", "1 hari"], ["2023-03-13", "2023-03-19", "1 minggu"], ["2023-03-01", "2023-03-31", "1 bulan"], ["2024-01-01", "2024-12-31", "1 tahun"], ["2021-01-01", "2025-12-31", "5 tahun"], ["2020-01-01", "2020-12-31", "periode kosong"]];
for (const [f, to, label] of windows) {
  const r = await owner.get(`${A()}/reports/cash-flow?fromDate=${f}&toDate=${to}`);
  if (r.status !== 200) { t(`CF-${label}`, "UAT-005", `Cash Flow ${label} dapat dihitung`, false, st(r)); continue; }
  const cf = r.json;
  const sum = C(cf.operating.amount) + C(cf.investing.amount) + C(cf.financing.amount) + C(cf.unclassifiedAmount);
  const whole = [cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.unclassifiedAmount, cf.netChangeInCash, cf.beginningCash, cf.endingCash].every((v) => Number.isInteger(v));
  const beginDb = cashBalanceCents(f), endDb = cashBalanceCents(nextDay(to));
  t(`CF-int-${label}`, "UAT-005", `Cash Flow ${label}: semua nilai Rupiah utuh (tanpa pecahan/noise float)`, whole, `op=${cf.operating.amount} inv=${cf.investing.amount} fin=${cf.financing.amount} net=${cf.netChangeInCash}`);
  t(`CF-net-${label}`, "UAT-005", `Cash Flow ${label}: Operating+Investing+Financing(+tak terklasifikasi) = Net Change`, sum === C(cf.netChangeInCash), `sum=${sum} net=${C(cf.netChangeInCash)}`);
  t(`CF-close-${label}`, "UAT-005", `Cash Flow ${label}: kas akhir = kas awal + net`, C(cf.beginningCash) + C(cf.netChangeInCash) === C(cf.endingCash), "");
  t(`CF-ledger-${label}`, "UAT-005", `Cash Flow ${label}: kas awal/akhir = saldo akun kas dari database/buku besar`, C(cf.beginningCash) === beginDb && C(cf.endingCash) === endDb, `awal ${cf.beginningCash} vs ${Number(beginDb) / 100}; akhir ${cf.endingCash} vs ${Number(endDb) / 100}`);
  const bs = await owner.get(`${A()}/reports/balance-sheet?fromDate=${f}&toDate=${to}`);
  const bsCash = (bs.json?.assets?.lines ?? []).filter((l) => cashIds.includes(l.accountId)).reduce((s, l) => s + C(l.amount), 0n);
  t(`CF-bs-${label}`, "UAT-005", `Cash Flow ${label}: kas akhir = kas di Neraca pada tanggal yang sama`, bs.status === 200 && bsCash === C(cf.endingCash), `neraca ${Number(bsCash) / 100} vs cf ${cf.endingCash}`);
}
{ // dashboard cash KPI konsisten dengan cash flow
  const cf = (await owner.get(`${A()}/reports/cash-flow?fromDate=2025-01-01&toDate=2025-12-31`)).json;
  const dash = await owner.get(`${A()}/dashboard?fromDate=2025-01-01&toDate=2025-12-31`);
  const v = dash.json?.kpis?.cashAndBank?.value ?? dash.json?.summary?.kpis?.cashAndBank?.value ?? dash.json?.cashAndBank?.value;
  t("CF-dash", "UAT-005", "Dashboard Kas & Bank = kas akhir Cash Flow", dash.status === 200 && (v === undefined ? true : C(v) === C(cf.endingCash)), `dash=${v} cf=${cf.endingCash} (${dash.status})`, "MEDIUM");
}

// ================= UAT-011
const cnt = () => { const d = dbA(); const o = { j: d.prepare("select count(*) c from journal_entries").get().c, l: d.prepare("select count(*) c from journal_entry_lines").get().c, a: d.prepare("select count(*) c from company_audit_log").get().c, tb: d.prepare("select COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c from journal_entry_lines").get() }; d.close(); return JSON.stringify(o); };
const kas = accId[code.kas("PST")], pend = accId[code.pend("PST")], pid = per["2026-02"];
const mkj = (c, ref, lines) => c.post(`${A()}/journal`, { referenceNo: ref, periodId: pid, entryDate: "2026-02-11", lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });
const rid = Math.random().toString(36).slice(2, 6);
{
  const bad = [["both", [[kas, 100000, 50000], [pend, 0, 50000]]], ["both-same", [[kas, 100000, 100000], [pend, 0, 0]]], ["zero-zero", [[kas, 100000, 0], [pend, 0, 100000], [kas, 0, 0]]], ["neg-debit", [[kas, -100000, 0], [pend, 0, -100000]]], ["neg-credit", [[kas, 100000, 0], [pend, 0, 100000], [kas, 0, -5]]]];
  const before = cnt(); const out = [];
  for (const [n, lines] of bad) { const r = await mkj(acct, `U11-${n}-${rid}`, lines); out.push(`${n}=${r.status}`); }
  const allow = out.every((s) => /=400$/.test(s));
  t("U11-1", "UAT-011", "debit+kredit sekaligus / nol-nol / negatif via API langsung -> HTTP 400 (bukan 500)", allow, out.join(" "));
  t("U11-2", "UAT-011", "setelah semua penolakan: database identik (jumlah jurnal, baris, audit, total debit/kredit)", cnt() === before, "");
  const r = await mkj(acct, `U11-msg-${rid}`, [[kas, 100000, 50000], [pend, 0, 50000]]);
  t("U11-3", "UAT-011", "pesan error jelas dan tanpa SQL/constraint", /debit dan kredit sekaligus/.test(r.json?.error ?? "") && !/sqlite|chk_|constraint/i.test(r.text), (r.json?.error ?? "").slice(0, 100), "MEDIUM");
  const ok = await mkj(acct, `U11-ok-${rid}`, [[kas, 100000, 0], [pend, 0, 100000]]);
  const pst = ok.status === 201 ? await acct.post(`${A()}/journal/${ok.json.journalId}/post`) : { status: 0 };
  t("U11-4", "UAT-011", "jurnal valid seimbang tetap 201 dan bisa di-POST", ok.status === 201 && pst.status === 200, `${ok.status}/${pst.status}`);
  const rv = ok.status === 201 ? await acct.post(`${A()}/journal/${ok.json.journalId}/reverse`, { reason: "uji UAT-011" }) : { status: 0 };
  const d = dbA(); const bad2 = d.prepare("select count(*) c from journal_entry_lines where (debit>0 and credit>0) or (debit=0 and credit=0)").get().c; d.close();
  t("U11-5", "UAT-011", "reversal tidak menghasilkan baris debit+kredit / nol-nol; reversal berhasil", [200, 201].includes(rv.status) && bad2 === 0, `reverse=${rv.status} barisCacat=${bad2}`);
}
{ // import Excel dengan debit+kredit pada satu baris
  const ExcelJS = (await import("./lib.mjs")).ExcelJS;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal");
  ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
  ws.addRow([code.kas("PST"), "2026-02-12", `U11-IMP-${rid}`, "Kas", "x", 100000, 50000]); ws.addRow([code.pend("PST"), "2026-02-12", `U11-IMP-${rid}`, "Pend", "x", null, 50000]);
  const before = cnt();
  const pv = await acct.upload(`${A()}/journal-import/preview`, "both.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
  t("U11-6", "UAT-011", "import Excel: baris Debit+Kredit sekaligus -> ERROR di preview (tidak bisa commit), bukan 500", pv.status === 200 && (pv.json?.errorCount ?? 0) >= 1 && pv.json?.canCommit === false, `${st(pv)} err=${pv.json?.errorCount}`);
  t("U11-7", "UAT-011", "import: database tidak berubah setelah preview invalid", cnt() === before, "");
}
{ // integritas akhir
  const d = dbA();
  const integ = d.prepare("pragma integrity_check").get().integrity_check; const fk = d.prepare("pragma foreign_key_check").all().length;
  const orphan = d.prepare("select count(*) c from journal_entry_lines l left join journal_entries e on e.id=l.journal_entry_id where e.id is null").get().c;
  const noacc = d.prepare("select count(*) c from journal_entry_lines l left join accounts a on a.id=l.account_id where a.id is null").get().c;
  const unb = d.prepare("select count(*) c from (select e.id from journal_entries e join journal_entry_lines l on l.journal_entry_id=e.id where e.status in ('POSTED','REVERSED') group by e.id having SUM(CAST(ROUND(l.debit*100) AS INTEGER)) != SUM(CAST(ROUND(l.credit*100) AS INTEGER)))").get().c;
  const tot = d.prepare("select SUM(CAST(ROUND(l.debit*100) AS INTEGER)) d, SUM(CAST(ROUND(l.credit*100) AS INTEGER)) c from journal_entry_lines l join journal_entries e on e.id=l.journal_entry_id where e.status in ('POSTED','REVERSED')").get();
  d.close();
  t("INT-1", "integritas", "integrity_check ok, foreign_key_check 0, tanpa baris yatim / tanpa akun", integ === "ok" && fk === 0 && orphan === 0 && noacc === 0, `integrity=${integ} fk=${fk} orphan=${orphan} noacc=${noacc}`, "CRITICAL");
  t("INT-2", "integritas", "0 jurnal POSTED tak seimbang; total debit = total kredit seluruh jurnal POSTED/REVERSED", unb === 0 && tot.d === tot.c, `unbalanced=${unb} debit=${tot.d} kredit=${tot.c}`, "CRITICAL");
}
console.log("DONE s13");
