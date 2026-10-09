// A: pengaturan dan akses cabang. Setiap pengguna diuji menurut hak yang BENAR-BENAR diberikan (peran + cakupan cabang),
// dibandingkan dengan oracle SQL independen untuk angkanya.
import { run } from "./lib.mjs";

export function accessSpec(ctx) {
  const { hq, metro, bl } = ctx.B;
  const all3 = [hq, metro, bl];
  return {
    owner: { branches: all3, cons: true, all: true, ibRead: true, ibCreate: true, ibApprove: true },
    adminAll: { branches: all3, cons: true, all: true, ibRead: true, ibCreate: true, ibApprove: true },
    adminLim: { branches: [metro, bl], cons: true, all: false, ibRead: true, ibCreate: true, ibApprove: true },
    acctHQ: { branches: [hq], cons: true, all: false, ibRead: true, ibCreate: true, ibApprove: true },
    acctMetro: { branches: [metro], cons: true, all: false, ibRead: true, ibCreate: true, ibApprove: true },
    acctBL: { branches: [bl], cons: true, all: false, ibRead: true, ibCreate: true, ibApprove: true },
    acctBoth: { branches: [metro, bl], cons: true, all: false, ibRead: true, ibCreate: true, ibApprove: true },
    staffMetro: { branches: [metro], cons: false, all: false, ibRead: true, ibCreate: true, ibApprove: false },
    staffBL: { branches: [bl], cons: false, all: false, ibRead: true, ibCreate: true, ibApprove: false },
    viewer: { branches: all3, cons: false, all: false, ibRead: false, ibCreate: false, ibApprove: false },
    delegate: { branches: [metro], cons: true, all: false, ibRead: true, ibCreate: true, ibApprove: true },
    outsider: { branches: [], cons: false, all: false, ibRead: false, ibCreate: false, ibApprove: false, none: true },
  };
}

export async function accessScenarios(ctx) {
  const { hq, metro, bl } = ctx.B;
  const all3 = [hq, metro, bl];
  const SPEC = accessSpec(ctx);
  const Q = "fromDate=2026-01-01&toDate=2026-12-31";
  const ghost = "00000000-0000-4000-8000-000000000000";

  await run("A1", "Konteks cabang dan kapabilitas tiap pengguna sesuai hak yang diberikan (peran + cakupan)", async (c) => {
    for (const [key, s] of Object.entries(SPEC)) {
      const cl = ctx.as(key, s.branches[0] ?? null);
      const r = await cl.get(`${ctx.A}/branch-context`);
      if (s.none) { c.ok(`${key}: tanpa akses perusahaan ditolak`, [403, 404].includes(r.status), `${r.status}`); continue; }
      c.ok(`${key}: konteks cabang terbuka`, r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
      if (r.status !== 200) continue;
      c.ok(`${key}: daftar cabang = persis cabang yang dimiliki aksesnya`, JSON.stringify(r.json.branches.map((b) => b.id).sort()) === JSON.stringify([...s.branches].sort()), r.json.branches.map((b) => b.name).join(","));
      c.ok(`${key}: multi-cabang ON, kapabilitas laporan gabungan sesuai izin (${s.cons})`, r.json.multiBranchEnabled === true && Boolean(r.json.capabilities.viewConsolidatedReports) === s.cons, JSON.stringify(r.json.capabilities));
    }
  });

  await run("A2", "Laporan per cabang menurut hak: satu cabang, default cabang aktif, gabungan terpilih, seluruh cabang, komparasi; angka = oracle SQL independen", async (c) => {
    for (const [key, s] of Object.entries(SPEC)) {
      if (s.none) continue;
      const cl = ctx.as(key, s.branches[0]);
      for (const b of all3) {
        const r = await cl.get(`${ctx.A}/reports/balance-sheet?${Q}&scope=branch:${b}`);
        const allowed = s.branches.includes(b);
        c.ok(`${key}: Neraca ${ctx.NAME[b]} ${allowed ? "diizinkan" : "404"}`, allowed ? r.status === 200 : r.status === 404, `${r.status}`);
        if (allowed && r.status === 200) {
          const want = ctx.withOracle([b], (o) => o.balanceSheet("2026-12-31"));
          c.ok(`${key}: Neraca ${ctx.NAME[b]}: aset/kewajiban/ekuitas = oracle (${want.totalAssets})`, r.json.totalAssets === want.totalAssets && r.json.totalLiabilities === want.totalLiabilities && r.json.totalEquity === want.totalEquity && r.json.isBalanced, `${r.json.totalAssets} vs ${want.totalAssets}`);
          const is = await cl.get(`${ctx.A}/reports/income-statement?${Q}&scope=branch:${b}`);
          const wi = ctx.withOracle([b], (o) => o.incomeStatement("2026-01-01", "2026-12-31"));
          c.ok(`${key}: Laba Rugi ${ctx.NAME[b]}: laba bersih = oracle (${wi.netProfit})`, is.status === 200 && is.json.netProfit === wi.netProfit, `${is.json?.netProfit}`);
        }
      }
      // default tanpa parameter = cabang kerja aktif (header)
      const d = await cl.get(`${ctx.A}/reports/balance-sheet?${Q}`);
      const wantD = ctx.withOracle([s.branches[0]], (o) => o.balanceSheet("2026-12-31"));
      c.ok(`${key}: tanpa parameter = cabang kerja aktif (${ctx.NAME[s.branches[0]]})`, d.status === 200 && d.json.scope.mode === "SINGLE" && d.json.totalAssets === wantD.totalAssets, `${d.status}`);
      // seluruh cabang
      const all = await cl.get(`${ctx.A}/reports/balance-sheet?${Q}&scope=all`);
      ctx.checkCombinedLabel(`${key} all`, all.json);
      const wantAll = ctx.withOracle(null, (o) => o.balanceSheet("2026-12-31"));
      c.ok(`${key}: gabungan seluruh cabang ${s.all ? "diizinkan dan = oracle perusahaan" : "ditolak 403"}`, s.all ? all.status === 200 && all.json.totalAssets === wantAll.totalAssets && all.json.scope.eliminationStatus === "NOT_ELIMINATED" : all.status === 403, `${all.status}`);
      // gabungan terpilih Metro + Lampung
      const sel = await cl.get(`${ctx.A}/reports/income-statement?${Q}&scope=${encodeURIComponent(`selected:${metro},${bl}`)}`);
      ctx.checkCombinedLabel(`${key} selected`, sel.json);
      const both = s.branches.includes(metro) && s.branches.includes(bl);
      const expectedStatus = !s.cons ? 403 : both ? 200 : 404;
      c.ok(`${key}: gabungan terpilih Metro+Lampung -> ${expectedStatus}`, sel.status === expectedStatus, `${sel.status}`);
      if (sel.status === 200) {
        const wi = ctx.withOracle([metro, bl], (o) => o.incomeStatement("2026-01-01", "2026-12-31"));
        c.ok(`${key}: laba gabungan terpilih = oracle (${wi.netProfit}); label belum dieliminasi`, sel.json.netProfit === wi.netProfit && sel.json.scope.label.warnings.join(" ").match(/belum dieliminasi/i), `${sel.json.netProfit}`);
      }
      // komparasi
      const cmp = await cl.get(`${ctx.A}/reports/balance-sheet?${Q}&scope=${encodeURIComponent(`branches:${metro},${bl}`)}`);
      ctx.checkCombinedLabel(`${key} comparison`, cmp.json);
      c.ok(`${key}: komparasi Metro+Lampung -> ${expectedStatus}${expectedStatus === 200 ? " (terekonsiliasi)" : ""}`, cmp.status === expectedStatus && (cmp.status !== 200 || cmp.json.comparison.reconciliation.ok === true), `${cmp.status}`);
    }
  });

  await run("A3", "Buku Besar, Neraca Saldo, Dashboard, Hutang/Piutang dan pencarian hanya memuat data cabang yang diizinkan (angka = oracle)", async (c) => {
    for (const [key, s] of Object.entries(SPEC)) {
      if (s.none) continue;
      const b = s.branches[0];
      const cl = ctx.as(key, b);
      const wTB = ctx.withOracle([b], (o) => o.trialBalance(ctx.OKT));
      const tb = await cl.get(`${ctx.A}/trial-balance?periodId=${ctx.OKT}&scope=branch:${b}`);
      const got = Object.fromEntries(tb.json.rows.filter((r) => !r.isBridge).map((r) => [r.code, r.debit - r.credit]));
      const want = Object.fromEntries(wTB.rows.map((r) => [r.code, r.debit - r.credit]));
      c.ok(`${key}: Neraca Saldo Okt 2026 ${ctx.NAME[b]} = oracle per akun, seimbang`, tb.status === 200 && tb.json.isBalanced && JSON.stringify(got) === JSON.stringify(want), `${tb.status}`);
      const lg = await cl.get(`${ctx.A}/ledger/${ctx.acc["1100"]}?fromDate=2026-07-01&toDate=2026-12-31&scope=branch:${b}`);
      const wl = ctx.withOracle([b], (o) => o.ledger(ctx.acc["1100"], "2026-07-01", "2026-12-31"));
      c.ok(`${key}: Buku Besar Kas ${ctx.NAME[b]}: saldo awal/akhir/baris = oracle`, lg.status === 200 && lg.json.openingBalance === wl.opening && lg.json.endingBalance === wl.ending && lg.json.lines.length === wl.lines, `${lg.json?.endingBalance} vs ${wl.ending}`);
      const ds = await cl.get(`${ctx.A}/dashboard?fromDate=2026-09-01&toDate=2026-09-30&scope=branch:${b}`);
      const wi = ctx.withOracle([b], (o) => o.incomeStatement("2026-09-01", "2026-09-30"));
      c.ok(`${key}: Dashboard September ${ctx.NAME[b]}: laba bersih = oracle (${wi.netProfit})`, ds.status === 200 && (ds.json.kpis.netProfit.value ?? ds.json.kpis.netProfit.current) === wi.netProfit && ds.json.scope.branches[0].id === b, `${ds.status}`);
      for (const type of ["vendor", "customer"]) {
        const r = await cl.get(`${ctx.A}/counterparties/balances?type=${type}&scope=branch:${b}`);
        const m = ctx.withOracle([b], (o) => o.counterparties(type));
        const bad = (r.json?.balances ?? []).filter((x) => (m.get(x.counterpartyId) ?? 0) !== x.balance);
        c.ok(`${key}: saldo ${type === "vendor" ? "hutang" : "piutang"} ${ctx.NAME[b]} = oracle`, r.status === 200 && bad.length === 0, `${r.status} salah=${bad.length}`);
      }
      // pencarian: tidak pernah memuat jurnal cabang lain
      const mine = new Set(s.branches.map((x) => ctx.CODE[x]));
      for (const other of all3.filter((x) => !s.branches.includes(x))) {
        const prefix = { PUSAT: "PST-", MTR: "MTR-", BDL: "BDL-" }[ctx.CODE[other]];
        const sr = await cl.get(`${ctx.A}/search?q=${prefix}`);
        c.ok(`${key}: pencarian "${prefix}" (cabang tanpa akses) tidak memuat jurnal`, sr.status === 200 && sr.json.journals.length === 0, `${sr.status} ${sr.json?.journals?.length}`);
      }
      const ownPrefix = { PUSAT: "PST-", MTR: "MTR-", BDL: "BDL-" }[ctx.CODE[b]];
      const sr2 = await cl.get(`${ctx.A}/search?q=${ownPrefix}`);
      c.ok(`${key}: pencarian "${ownPrefix}" (cabang sendiri) menemukan jurnal`, sr2.status === 200 && sr2.json.journals.length > 0 && sr2.json.journals.every((j) => j.referenceNo.startsWith(ownPrefix)), `${sr2.status} ${sr2.json?.journals?.length}`);
      const l = await cl.get(ctx.IB);
      c.ok(`${key}: daftar Antar Cabang ${s.ibRead ? "terbuka" : "ditolak"}`, s.ibRead ? l.status === 200 : l.status >= 400, `${l.status}`);
    }
  });
}
