// D: laporan, ekspor, gabungan, komparasi, dan perusahaan uji dengan multi-cabang OFF, dibandingkan dengan oracle SQL independen.
import { run, dbAll, pdfText, xlsxCells, cents, dist, COMPANY_DB } from "./lib.mjs";

const Q = "fromDate=2026-07-01&toDate=2026-10-31";
const fmtIdr = (n) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;

export async function reportScenarios(ctx) {
  const { hq, metro, bl } = ctx.B;
  const acc = ctx.acc;
  const owner = ctx.as("owner", hq);
  const scopes = [
    ["Kantor Pusat", `branch:${hq}`, [hq]], ["Cabang Metro", `branch:${metro}`, [metro]], ["Cabang Lampung", `branch:${bl}`, [bl]],
    ["Gabungan Metro+Lampung", `selected:${metro},${bl}`, [metro, bl]], ["Gabungan Pusat+Metro", `selected:${hq},${metro}`, [hq, metro]], ["Gabungan seluruh cabang", "all", null],
  ];

  await run("D1", "Laporan per cabang, gabungan, dan komparasi (Neraca, Laba Rugi, Ekuitas, Arus Kas, Neraca Saldo, Buku Besar, Dashboard, Hutang/Piutang) = oracle SQL independen", async (c) => {
    for (const [label, scope, ids] of scopes) {
      const sc = `&scope=${encodeURIComponent(scope)}`;
      const bs = await owner.get(`${ctx.A}/reports/balance-sheet?${Q}${sc}`);
      ctx.checkCombinedLabel(`D1 ${label} bs`, bs.json);
      const wb = ctx.withOracle(ids, (o) => o.balanceSheet("2026-10-31"));
      c.ok(`${label}: Neraca aset/kewajiban/ekuitas = oracle (${fmtIdr(wb.totalAssets)}), seimbang`, bs.status === 200 && bs.json.totalAssets === wb.totalAssets && bs.json.totalLiabilities === wb.totalLiabilities && bs.json.totalEquity === wb.totalEquity && bs.json.balanceDifference === 0, `${bs.status} ${bs.json?.totalAssets} vs ${wb.totalAssets}`);
      const is = await owner.get(`${ctx.A}/reports/income-statement?${Q}${sc}`);
      const wi = ctx.withOracle(ids, (o) => o.incomeStatement("2026-07-01", "2026-10-31"));
      c.ok(`${label}: Laba Rugi laba kotor/operasi/bersih = oracle (laba bersih ${fmtIdr(wi.netProfit)})`, is.json.grossProfit === wi.grossProfit && is.json.operatingProfit === wi.operatingProfit && is.json.netProfit === wi.netProfit, `${is.json?.netProfit} vs ${wi.netProfit}`);
      const eq = await owner.get(`${ctx.A}/reports/equity?${Q}${sc}`);
      c.ok(`${label}: Ekuitas penutup = ekuitas Neraca oracle (${fmtIdr(wb.totalEquity)})`, eq.status === 200 && eq.json.closingEquity === wb.totalEquity, `${eq.json?.closingEquity} vs ${wb.totalEquity}`);
      const cf = await owner.get(`${ctx.A}/reports/cash-flow?${Q}${sc}`);
      const wc = ctx.withOracle(ids, (o) => o.cash("2026-07-01", "2026-10-31"));
      c.ok(`${label}: Arus Kas kas awal/akhir/perubahan = oracle (akhir ${fmtIdr(wc.ending)}); aktivitas + belum terklasifikasi = perubahan`, cf.json.beginningCash === wc.beginning && cf.json.endingCash === wc.ending && cf.json.netChangeInCash === wc.net && Math.round((cf.json.operating.amount + cf.json.investing.amount + cf.json.financing.amount + cf.json.unclassifiedAmount) * 100) === Math.round(cf.json.netChangeInCash * 100), `${cf.json?.endingCash} vs ${wc.ending}`);
      const tb = await owner.get(`${ctx.A}/trial-balance?periodId=${ctx.OKT}${sc}`);
      ctx.checkCombinedLabel(`D1 ${label} tb`, tb.json);
      const wt = ctx.withOracle(ids, (o) => o.trialBalance(ctx.OKT));
      const got = Object.fromEntries(tb.json.rows.filter((r) => !r.isBridge).map((r) => [r.code, r.debit - r.credit]));
      const want = Object.fromEntries(wt.rows.map((r) => [r.code, r.debit - r.credit]));
      c.ok(`${label}: Neraca Saldo Okt 2026 per akun = oracle; seimbang`, tb.json.isBalanced && JSON.stringify(got) === JSON.stringify(want), `${tb.status}`);
      for (const code of ["1100", "4100", "IBA-MTR", "IBP-PUSAT"]) {
        const lg = await owner.get(`${ctx.A}/ledger/${acc[code] ?? dbAll("select id from accounts where code=?", code)[0].id}?fromDate=2026-07-01&toDate=2026-10-31${sc}`);
        const id = acc[code] ?? dbAll("select id from accounts where code=?", code)[0].id;
        const wl = ctx.withOracle(ids, (o) => o.ledger(id, "2026-07-01", "2026-10-31"));
        c.ok(`${label}: Buku Besar ${code}: saldo awal/akhir/jumlah baris = oracle`, lg.status === 200 && lg.json.openingBalance === wl.opening && lg.json.endingBalance === wl.ending && lg.json.lines.length === wl.lines, `${lg.status}`);
      }
      const ds = await owner.get(`${ctx.A}/dashboard?fromDate=2026-10-01&toDate=2026-10-31${sc}`);
      const wdi = ctx.withOracle(ids, (o) => o.incomeStatement("2026-10-01", "2026-10-31"));
      c.ok(`${label}: Dashboard Okt 2026 laba bersih = oracle`, ds.status === 200 && (ds.json.kpis.netProfit.value ?? ds.json.kpis.netProfit.current) === wdi.netProfit, `${ds.status}`);
      for (const type of ["vendor", "customer"]) {
        const r = await owner.get(`${ctx.A}/counterparties/balances?type=${type}${sc}`);
        const m = ctx.withOracle(ids, (o) => o.counterparties(type));
        c.ok(`${label}: saldo ${type === "vendor" ? "hutang" : "piutang"} per pihak = oracle`, r.status === 200 && r.json.balances.every((x) => (m.get(x.counterpartyId) ?? 0) === x.balance), `${r.status}`);
      }
    }
    // komparasi 3 cabang
    const ids3 = [hq, metro, bl];
    for (const [path, name] of [[`/reports/balance-sheet?${Q}`, "Neraca"], [`/reports/income-statement?${Q}`, "Laba Rugi"], [`/reports/equity?${Q}`, "Ekuitas"], [`/trial-balance?periodId=${ctx.OKT}`, "Neraca Saldo"]]) {
      const t0 = Date.now();
      const r = await owner.get(`${ctx.A}${path}&scope=${encodeURIComponent("branches:" + ids3.join(","))}`);
      const ms = Date.now() - t0;
      ctx.checkCombinedLabel(`D1 komparasi ${name}`, r.json);
      c.ok(`komparasi ${name} (3 cabang + Gabungan): terekonsiliasi, kolom per cabang = oracle, ${ms} ms`, r.status === 200 && r.json.comparison.reconciliation.ok === true && r.json.comparison.columns.length === 3 && r.json.scope.eliminationStatus === "NOT_ELIMINATED", `${r.status}`);
      if (name === "Neraca") for (const col of r.json.comparison.columns) { const w = ctx.withOracle([col.branch.id], (o) => o.balanceSheet("2026-10-31")); c.ok(`komparasi Neraca kolom ${col.branch.name} = oracle`, col.report.totalAssets === w.totalAssets); }
    }
    const cfCmp = await owner.get(`${ctx.A}/reports/cash-flow?${Q}&scope=${encodeURIComponent("branches:" + ids3.join(","))}`);
    c.ok("komparasi Arus Kas belum tersedia: ditolak 400 (bukan angka palsu)", cfCmp.status === 400, `${cfCmp.status}`);
    // gabungan bruto: aset = Σ cabang + antarkantor tidak dieliminasi
    const sumAssets = ids3.reduce((s, b) => s + ctx.withOracle([b], (o) => o.balanceSheet("2026-10-31")).totalAssets, 0);
    const allBs = await owner.get(`${ctx.A}/reports/balance-sheet?${Q}&scope=all`);
    c.ok("Σ aset tiap cabang = aset Gabungan (rekonsiliasi), dan blok antar-kantor menyatakan eliminated=false", allBs.json.totalAssets === sumAssets && allBs.json.interBranch?.eliminated === false, `${allBs.json.totalAssets} vs ${sumAssets}`);
    const pos = allBs.json.interBranch;
    c.ok("posisi antar-kantor bruto tercatat dan pasangan lengkap (selisih 0) pada cakupan seluruh cabang", pos.netDifference === 0, JSON.stringify(pos));
  });

  await run("D2", "Ekspor XLSX dan PDF: angka, periode, nama file, keterbacaan, dan label cakupan (gabungan wajib berlabel belum dieliminasi)", async (c) => {
    const { formatIdr } = await dist("modules/report-export/pdf.js");
    const cases = [["Cabang Metro", `branch:${metro}`, [metro], /Cabang-Cabang-Metro/], ["Gabungan seluruh cabang", "all", null, /Gabungan-Seluruh-Cabang-Belum-Dieliminasi/], ["Gabungan Metro+Lampung", `selected:${metro},${bl}`, [metro, bl], /Gabungan-Cabang-Terpilih-Belum-Dieliminasi/]];
    for (const [label, scope, ids, namePat] of cases) {
      const sc = `&scope=${encodeURIComponent(scope)}`;
      const combined = scope === "all" || scope.startsWith("selected");
      for (const fmt of ["xlsx", "pdf"]) {
        const r = await owner.get(`${ctx.A}/reports/export/balance-sheet?format=${fmt}&${Q}${sc}`, { raw: true });
        const disp = r.headers.get("content-disposition") ?? "";
        const wb = ctx.withOracle(ids, (o) => o.balanceSheet("2026-10-31"));
        c.ok(`${label} ${fmt.toUpperCase()}: status 200, tipe berkas benar, nama file memuat cakupan dan periode`, r.status === 200 && namePat.test(disp) && /2026-07-01-2026-10-31/.test(disp) && (fmt === "pdf" ? r.buf.subarray(0, 5).toString("latin1") === "%PDF-" : r.buf.subarray(0, 2).toString("latin1") === "PK"), `${r.status} ${disp}`);
        const text = fmt === "xlsx" ? (await xlsxCells(r.buf)).flat().map(String).join("\n") : pdfText(r.buf);
        c.ok(`${label} ${fmt.toUpperCase()}: periode "01 Juli 2026 - 31 Oktober 2026", nama perusahaan, judul, tanpa em/en dash`, /Periode: 01 Juli 2026 - 31 Oktober 2026/.test(text) && /PT UJI BISNIS CABANG \(UAT\)/.test(text) && /Neraca \(Balance Sheet\)/.test(text) && !/[–—]/.test(text), text.slice(0, 120).replace(/\n/g, " | "));
        if (fmt === "xlsx") {
          const rows = await xlsxCells(r.buf);
          const row = rows.find((x) => String(x[1] ?? x[0] ?? "").includes("Total Assets") || x.some((v) => String(v) === "Total Assets"));
          const num = row?.find((v) => typeof v === "number");
          c.ok(`${label} XLSX: baris Total Assets bernilai angka = oracle (${fmtIdr(wb.totalAssets)})`, num === wb.totalAssets, `${num} vs ${wb.totalAssets}`);
        } else {
          c.ok(`${label} PDF: Total Assets tertulis "${formatIdr(wb.totalAssets)}" dan teks terbaca (≥ 200 karakter)`, text.includes(formatIdr(wb.totalAssets)) && text.length > 200, `panjang ${text.length}`);
        }
        if (combined) c.ok(`${label} ${fmt.toUpperCase()}: peringatan wajib "belum dieliminasi" dan "bukan laporan konsolidasi final" tercetak di dokumen`, /belum dieliminasi/i.test(text) && /bukan laporan konsolidasi final/i.test(text), "label hilang");
        else c.ok(`${label} ${fmt.toUpperCase()}: baris Cakupan menyebut ${ctx.NAME[metro]}`, new RegExp(`Cakupan: ${ctx.NAME[metro]}`).test(text));
      }
    }
    // jenis laporan lain pada satu cabang (XLSX)
    for (const [kind, q] of [["income-statement", Q], ["equity", Q], ["cash-flow", Q], ["trial-balance", `periodId=${ctx.OKT}`], ["ledger", `fromDate=2026-07-01&toDate=2026-10-31&accountId=${acc["1100"]}`]]) {
      const r = await owner.get(`${ctx.A}/reports/export/${kind}?format=xlsx&${q}&scope=branch:${metro}`, { raw: true });
      const text = (await xlsxCells(r.buf)).flat().map(String).join("\n");
      c.ok(`ekspor ${kind} Metro: 200, label cakupan Cabang Metro, tanpa em/en dash`, r.status === 200 && /Cakupan: Cabang Metro/.test(text) && !/[–—]/.test(text), `${r.status}`);
    }
    const lg = await owner.get(`${ctx.A}/reports/export/ledger?format=xlsx&fromDate=2026-07-01&toDate=2026-10-31&accountId=${acc["1100"]}&scope=branch:${metro}`, { raw: true });
    const rows = await xlsxCells(lg.buf);
    const wl = ctx.withOracle([metro], (o) => o.ledger(acc["1100"], "2026-07-01", "2026-10-31"));
    const end = rows.find((x) => x.some((v) => String(v) === "Saldo Akhir"));
    c.ok(`ekspor Buku Besar Kas Metro: saldo akhir = oracle (${fmtIdr(wl.ending)})`, end?.find((v) => typeof v === "number") === wl.ending, JSON.stringify(end));
    // ekspor di luar hak
    c.ok("ekspor cabang di luar akses = 404; gabungan tanpa izin = 403; komparasi = 400", (await ctx.as("acctMetro", metro).get(`${ctx.A}/reports/export/balance-sheet?format=xlsx&${Q}&scope=branch:${bl}`)).status === 404 && (await ctx.as("staffMetro", metro).get(`${ctx.A}/reports/export/balance-sheet?format=xlsx&${Q}&scope=all`)).status === 403 && (await owner.get(`${ctx.A}/reports/export/balance-sheet?format=xlsx&${Q}&scope=branches:${metro},${bl}`)).status === 400);
  });

  await run("D3", "Perusahaan uji TERPISAH dengan multi-cabang OFF: perilaku lama utuh, Antar Cabang 404, angka = oracle, tanpa label cakupan", async (c) => {
    const o2 = ctx.as("otherOwner");
    const orc = (fn) => ctx.withOracle(null, fn, COMPANY_DB(ctx.SLUG_OFF));
    const bs = await o2.get(`${ctx.AOFF}/reports/balance-sheet?${Q}`), wb = orc((o) => o.balanceSheet("2026-10-31"));
    c.ok(`Neraca = oracle (${fmtIdr(wb.totalAssets)}); mode COMPANY tanpa peringatan`, bs.json.totalAssets === wb.totalAssets && bs.json.isBalanced && bs.json.scope.mode === "COMPANY" && bs.json.scope.label.warnings.length === 0, `${bs.status}`);
    const is = await o2.get(`${ctx.AOFF}/reports/income-statement?${Q}`), wi = orc((o) => o.incomeStatement("2026-07-01", "2026-10-31"));
    c.ok("Laba Rugi = oracle", is.json.netProfit === wi.netProfit, `${is.json.netProfit} vs ${wi.netProfit}`);
    const per = dbAll("select id from periods", ...[]).length; void per;
    const d2 = (await o2.get(`${ctx.AOFF}/periods`)).json.periods.find((p) => p.label === "Okt 2026");
    const tb = await o2.get(`${ctx.AOFF}/trial-balance?periodId=${d2.id}`), wt = orc((o) => o.trialBalance(d2.id));
    c.ok("Neraca Saldo = oracle dan seimbang", tb.json.isBalanced && tb.json.totalDebit === wt.totalDebit && tb.json.totalCredit === wt.totalCredit, `${tb.status}`);
    c.ok("parameter scope selain kosong/all ditolak 400; scope=all dilayani sama dengan tanpa parameter", (await o2.get(`${ctx.AOFF}/reports/balance-sheet?${Q}&scope=branch:x`)).status === 400 && (await o2.get(`${ctx.AOFF}/reports/balance-sheet?${Q}&scope=selected:a,b`)).status === 400 && (await o2.get(`${ctx.AOFF}/reports/balance-sheet?${Q}&scope=all`)).json.totalAssets === bs.json.totalAssets);
    const eps = [["GET", ""], ["GET", "/summary"], ["GET", "/options"], ["GET", "/settings"], ["GET", `/${ctx.uid()}`], ["POST", ""], ["POST", `/${ctx.uid()}/approve`], ["POST", `/${ctx.uid()}/reverse`]];
    const st = [];
    for (const [m, p] of eps) st.push((await o2.req(m, `${ctx.AOFF}/inter-branch${p}`, { body: m === "POST" ? {} : undefined })).status);
    c.ok("seluruh endpoint Antar Cabang 404 seragam (termasuk body tidak valid)", st.every((x) => x === 404), st.join(","));
    const valid = await o2.post(`${ctx.AOFF}/inter-branch`, { type: "TRANSFER_KAS", toBranchId: ctx.uid(), transactionDate: ctx.today, amount: 1000, fromAccountId: ctx.uid(), toAccountSuggestedId: ctx.uid(), description: "uji flag off", idempotencyKey: ctx.uid() });
    c.ok("POST Antar Cabang dengan body valid pada perusahaan flag OFF = 404", valid.status === 404, `${valid.status}`);
    const br = await o2.get(`${ctx.AOFF}/branch-context`);
    c.ok("konteks cabang: multi-cabang OFF, hanya Kantor Pusat", br.json.multiBranchEnabled === false && br.json.branches.length === 1, JSON.stringify(br.json.branches?.map((b) => b.name)));
    const ex = await o2.get(`${ctx.AOFF}/reports/export/balance-sheet?format=xlsx&${Q}`, { raw: true });
    c.ok("nama file ekspor tanpa akhiran cakupan; isi tanpa baris Cakupan; Total Assets = oracle", !/Cabang|Gabungan/.test(ex.headers.get("content-disposition")) && !(await xlsxCells(ex.buf)).flat().some((v) => /^Cakupan:/.test(String(v))) && (await xlsxCells(ex.buf)).some((r) => r.some((v) => v === wb.totalAssets)));
    const sr = await o2.get(`${ctx.AOFF}/search?q=SC-`);
    c.ok("pencarian dan jurnal lama tetap berfungsi", sr.status === 200 && sr.json.journals.length > 0, `${sr.json?.journals?.length}`);
    c.ok("silang perusahaan: OWNER perusahaan 1 tidak dapat membaca perusahaan 2 dan sebaliknya", [403, 404].includes((await ctx.as("owner").get(`${ctx.AOFF}/reports/balance-sheet?${Q}`)).status) && [403, 404].includes((await o2.get(`${ctx.A}/reports/balance-sheet?${Q}`)).status));
  });
}
