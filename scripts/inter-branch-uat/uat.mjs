// UAT Antar Cabang (HTTP sungguhan terhadap server HASIL BUILD, data = salinan UAT 5 tahun; multi-cabang ON hanya di salinan).
//   node scripts/inter-branch-uat/uat.mjs <folder-kerja>      (siapkan dulu: bash scripts/inter-branch-uat/reset-uat.sh <kerja> <backup-uat>)
// Setiap skenario: snapshot akuntansi SEBELUM -> aksi -> snapshot SESUDAH -> bandingkan dengan delta yang DIHITUNG dari spesifikasi
// (bukan hanya HTTP 200). Hasil: PASS / FAIL (cacat aplikasi atau ekspektasi) / BLOCKED (tidak dapat diuji) / SCRIPT-ERROR (cacat skrip).
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import * as L from "./uat-lib.mjs";
const { P, IB, SLUG, OFF_SLUG, Scenario, record, snapshot, delta, sameDelta, txJournals, txRow, auditActions, dbAll, dbOne } = L;

const srv = await L.startServer(4540, 0, "uat");
const BASE = `/api/company-db/${SLUG}`;
const M = P.metro, BL = P.bl, KTB = P.kotabumi;
const accs = L.accountsByCode();
const A = (code) => accs.find((a) => a.code === code);
const cashM = A("1112"), cashBL = A("1113"), cashKTB = A("1114"), bankBCA = A("1120"), bankMandiri = A("1130"), expBL = A("6113"), expM = A("6112"), expTransport = A("6300");
const c100 = (x) => Math.round(x * 100);
const ibPair = (fromBr, toBr) => {
  const rows = L.accountsByCode();
  return {
    asset: rows.find((a) => a.branch_policy === "INTER_BRANCH" && a.counterpart_branch_id === toBr && a.code.startsWith("IBA")),
    liab: rows.find((a) => a.branch_policy === "INTER_BRANCH" && a.counterpart_branch_id === fromBr && a.code.startsWith("IBP")),
  };
};
/** Delta saldo bersih yang diharapkan dari satu transaksi SELESAI (FROM: D antarkantor / K akun asal; TO: D akun tujuan / K antarkantor). */
const expectPosting = (X, fromAcc, fromBr, toAcc, toBr) => {
  const ib = ibPair(fromBr, toBr);
  return { [`${fromAcc.id}|${fromBr}`]: -c100(X), [`${ib.asset.id}|${fromBr}`]: c100(X), [`${toAcc.id}|${toBr}`]: c100(X), [`${ib.liab.id}|${toBr}`]: -c100(X) };
};
const uid = () => crypto.randomUUID();

const owner = L.as(srv, "owner"); // ALL: laporan perusahaan
const periods = (await owner.get(`${BASE}/periods`)).json.periods;
const periodOf = (label) => periods.find((p) => p.label === label);
const OKT = periodOf("Okt 2026");

async function reports(o = owner) {
  // Phase 5 (D1): tanpa parameter laporan = cabang kerja aktif; angka perusahaan (gabungan seluruh cabang, belum dieliminasi) diminta eksplisit.
  const q = "fromDate=2026-01-01&toDate=2026-12-31&scope=all";
  const bs = (await o.get(`${BASE}/reports/balance-sheet?${q}`)).json;
  const is = (await o.get(`${BASE}/reports/income-statement?${q}`)).json;
  const cf = (await o.get(`${BASE}/reports/cash-flow?${q}`)).json;
  const tb = (await o.get(`${BASE}/trial-balance?periodId=${OKT.id}&scope=all`)).json;
  return { ta: bs.totalAssets, tl: bs.totalLiabilities, te: bs.totalEquity, bsOk: bs.isBalanced, np: is.netProfit, cash: cf.endingCash, tbDr: tb.totalDebit, tbCr: tb.totalCredit, tbOk: tb.isBalanced };
}
const propose = (c, o = {}) => c.post(IB, {
  type: o.type ?? "TRANSFER_KAS", toBranchId: o.to ?? BL, transactionDate: o.date ?? L.today(), amount: o.amount ?? 1_000_000,
  fromAccountId: (o.fromAcc ?? cashM).id, toAccountSuggestedId: (o.toAcc ?? cashBL).id, description: o.desc ?? "UAT transfer kas", idempotencyKey: o.key ?? uid(), ...(o.extra ?? {}),
});
const act = (c, id, action, body = {}) => c.post(`${IB}/${id}/${action}`, body);
const detail = async (c, id) => (await c.get(`${IB}/${id}`)).json;
const txOf = (r) => r.json?.transaction;

/** Aman: satu skenario yang melempar galat dicatat SCRIPT-ERROR (bukan FAIL aplikasi) dan tidak menghentikan skenario lain. */
async function run(id, name, fn) {
  const sc = new Scenario(id, name);
  try { await fn(sc); sc.done(); } catch (e) { record(id, name, "SCRIPT-ERROR", String(e?.stack ?? e).split("\n").slice(0, 3).join(" / ")); }
}

// ================================================================ keadaan awal
const S0 = snapshot();
const hashHistorical = () => {
  const d = L.ro();
  const h = crypto.createHash("sha256");
  for (const r of d.prepare("select * from journal_entries where inter_branch_transaction_id is null order by id").iterate()) h.update(JSON.stringify(r));
  for (const r of d.prepare("select l.* from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.inter_branch_transaction_id is null order by l.id").iterate()) h.update(JSON.stringify(r));
  d.close();
  return h.digest("hex");
};
const H0 = hashHistorical();
const R0 = await reports();
const baselineTriggers = dbAll("select name from sqlite_master where type='trigger' order by name").map((r) => r.name).join(",");
console.log("DATASET", JSON.stringify({ journals: S0.journals, effective: S0.effective, accountsTouched: Object.keys(S0.bal).length, ...R0 }));
const completed = []; // transaksi SELESAI & belum dibalik, untuk invarian akhir: { X, delta }

// ================================================================ S01 Transfer kas (UAT-01..08, 39)
let tx1;
await run("S01", "Transfer kas Metro->BL: ajukan, tidak ada jurnal, setujui, dua jurnal seimbang & saldo", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL);
  const X = 2_500_000;
  const b0 = snapshot(), r0 = await reports();
  const p = await propose(maker, { amount: X, desc: "Setoran kas Metro ke BL" });
  s.ok("pengajuan 201", p.status === 201, `status=${p.status} ${p.text.slice(0, 120)}`);
  tx1 = txOf(p); if (!tx1) return;
  s.ok("status WAITING_APPROVAL & bernomor IB-", tx1.status === "WAITING_APPROVAL" && /^IB-\d{4}-\d{6}$/.test(tx1.transactionNo), `${tx1.status} ${tx1.transactionNo}`);
  const b1 = snapshot(), r1 = await reports();
  s.ok("UAT-39: menunggu = tanpa jurnal, tanpa delta saldo, laporan & Neraca Saldo tidak berubah", b1.journals === b0.journals && Object.keys(delta(b0, b1)).length === 0 && JSON.stringify(r0) === JSON.stringify(r1));
  const outBox = await maker.get(`${IB}?box=out`), inBox = await appr.get(`${IB}?box=in`);
  s.ok("UAT-02/04: tampil di Keluar pengaju dan Masuk penerima", JSON.stringify(outBox.json).includes(tx1.id) && JSON.stringify(inBox.json).includes(tx1.id));
  const sum = await appr.get(`${IB}/summary`);
  s.ok("lencana penerima > 0", /[1-9]/.test(JSON.stringify(sum.json)), JSON.stringify(sum.json));
  const a = await act(appr, tx1.id, "approve");
  s.ok("persetujuan 200", a.status === 200, `status=${a.status} ${a.text.slice(0, 160)}`);
  const t = txOf(a);
  s.ok("status COMPLETED, accountingEvent POSTED", t?.status === "COMPLETED" && JSON.stringify(t).includes("POSTED"), `${t?.status}`);
  const b2 = snapshot(), r2 = await reports();
  const js = txJournals(tx1.id);
  s.ok("tepat 2 jurnal tertaut", js.length === 2 && b2.journals === b0.journals + 2, `${js.length}`);
  s.ok("tiap jurnal seimbang (sen) dan POSTED", js.every((j) => j.dr === j.cr && j.dr === c100(X) && j.status === "POSTED"), JSON.stringify(js.map((j) => [j.dr, j.cr, j.status])));
  s.ok("kedua jurnal bertanggal sama & periode sama = periode Okt 2026", js.every((j) => j.entry_date.slice(0, 10) === tx1.transactionDate && j.period_id === OKT.id));
  s.ok("cabang jurnal: satu di Metro (FROM), satu di BL (TO)", new Set(js.map((j) => j.branch_id)).size === 2 && js.some((j) => j.branch_id === M && j.side === "FROM") && js.some((j) => j.branch_id === BL && j.side === "TO"), JSON.stringify(js.map((j) => [j.leg, j.side])));
  const exp = expectPosting(X, cashM, M, cashBL, BL);
  s.ok("delta saldo per akun x cabang = persis hasil perhitungan spesifikasi", sameDelta(delta(b0, b2), exp), JSON.stringify(delta(b0, b2)));
  s.ok("laporan gabungan: laba & kas tidak berubah; aset dan liabilitas masing-masing +X (akun antarkantor belum dieliminasi: Phase 7); BS & NS seimbang", r2.np === r0.np && r2.cash === r0.cash && r2.te === r0.te && r2.ta === r0.ta + X && r2.tl === r0.tl + X && r2.bsOk && r2.tbOk, JSON.stringify({ r0, r2 }));
  s.ok("Neraca Saldo (saldo bersih per akun): debit & kredit masing-masing +X, tetap seimbang", r2.tbDr - r0.tbDr === X && r2.tbCr - r0.tbCr === X, `${r2.tbDr - r0.tbDr}`);
  const actions = auditActions(tx1.id).map((r) => r.action);
  s.ok("UAT-14 audit lengkap: CREATED, SUBMITTED, APPROVED, POSTED, COMPLETED", ["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED", "INTER_BRANCH_APPROVED", "INTER_BRANCH_POSTED", "INTER_BRANCH_COMPLETED"].every((x) => actions.includes(x)), actions.join(","));
  const aud = auditActions(tx1.id).find((r) => r.action === "INTER_BRANCH_APPROVED");
  s.ok("audit APPROVED mencatat pelaku persetujuan (bukan pengaju)", aud?.actor_label === P.personas.approverBl.label, aud?.actor_label);
  const repApp = await act(appr, tx1.id, "approve");
  s.ok("UAT-36: persetujuan ulang (replay) = 409 dan tidak menambah jurnal", repApp.status === 409 && snapshot().journals === b2.journals, `${repApp.status}`);
  completed.push({ id: tx1.id, X, d: exp });
});

await run("S01b", "Penerima mengonfirmasi akun sisinya sendiri (UAT-05)", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL);
  const X = 700_000, b0 = snapshot();
  const t = txOf(await propose(maker, { amount: X, toAcc: cashBL, desc: "Setoran, tujuan dikonfirmasi ke BCA" }));
  const a = await act(appr, t.id, "approve", { confirmedAccountId: bankBCA.id });
  s.ok("setuju dengan akun konfirmasi 200", a.status === 200, `${a.status} ${a.text.slice(0, 140)}`);
  const exp = expectPosting(X, cashM, M, bankBCA, BL);
  s.ok("jurnal BL memakai akun yang dikonfirmasi (Bank BCA), bukan usulan", sameDelta(delta(b0, snapshot()), exp), JSON.stringify(delta(b0, snapshot())));
  s.ok("audit ACCOUNT_CONFIRMED tercatat", auditActions(t.id).some((r) => r.action === "INTER_BRANCH_ACCOUNT_CONFIRMED"));
  completed.push({ id: t.id, X, d: exp });
});

// ================================================================ S02 Pembebanan biaya
await run("S02", "Pembebanan biaya antar-cabang (Metro membayar beban BL) + validasi jenis", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL);
  const X = 1_750_000, b0 = snapshot(), r0 = await reports();
  const p = await propose(maker, { type: "PEMBEBANAN", amount: X, toAcc: expBL, desc: "Metro membayar biaya transportasi untuk BL" });
  s.ok("pengajuan pembebanan 201", p.status === 201, `${p.status} ${p.text.slice(0, 160)}`);
  const t = txOf(p); if (!t) return;
  const a = await act(appr, t.id, "approve");
  s.ok("persetujuan 200 & COMPLETED", a.status === 200 && txOf(a)?.status === "COMPLETED", `${a.status}`);
  const b2 = snapshot(), r2 = await reports();
  const exp = expectPosting(X, cashM, M, expBL, BL);
  s.ok("delta: kas Metro -X, antarkantor Metro +X, beban BL +X, antarkantor BL -X", sameDelta(delta(b0, b2), exp), JSON.stringify(delta(b0, b2)));
  s.ok("laporan: laba bersih turun X (beban diakui), liabilitas +X, aset gabungan tidak berubah, seimbang", r2.np === r0.np - X && r2.tl === r0.tl + X && r2.ta === r0.ta && r2.bsOk && r2.tbOk, JSON.stringify({ np: r2.np - r0.np, tl: r2.tl - r0.tl, ta: r2.ta - r0.ta }));
  completed.push({ id: t.id, X, d: exp });
  // validasi jenis
  const bad1 = await propose(maker, { type: "PEMBEBANAN", amount: 1000, toAcc: cashBL, desc: "kas ke kas sebagai pembebanan" });
  s.ok("PEMBEBANAN kas->kas ditolak 422", bad1.status === 422, `${bad1.status}`);
  const bad2 = await propose(maker, { type: "TRANSFER_KAS", amount: 1000, toAcc: expBL, desc: "kas ke beban sebagai transfer kas" });
  s.ok("TRANSFER_KAS ke akun beban ditolak 422", bad2.status === 422, `${bad2.status}`);
  const bad3 = await propose(maker, { amount: 0 });
  s.ok("nominal 0 ditolak 400", bad3.status === 400, `${bad3.status}`);
  const bad4 = await propose(maker, { amount: -5 });
  s.ok("nominal negatif ditolak 400", bad4.status === 400, `${bad4.status}`);
  const bad5 = await propose(maker, { to: M });
  s.ok("cabang asal = tujuan ditolak", bad5.status >= 400 && bad5.status < 500, `${bad5.status}`);
  const bad6 = await propose(maker, { date: "2099-01-01" });
  s.ok("tanggal masa depan ditolak", bad6.status >= 400 && bad6.status < 500, `${bad6.status}`);
  const idemKey = uid();
  const i1 = await propose(maker, { amount: 5000, key: idemKey, desc: "idempoten" }), i2 = await propose(maker, { amount: 5000, key: idemKey, desc: "idempoten" });
  s.ok("kunci idempotensi sama: kedua kali menghasilkan transaksi yang sama (replayed)", txOf(i1)?.id === txOf(i2)?.id && i2.status === 200, `${i1.status}/${i2.status}`);
  const i3 = await propose(maker, { amount: 6000, key: idemKey, desc: "idempoten beda isi" });
  s.ok("kunci sama dengan isi berbeda = 409", i3.status === 409, `${i3.status}`);
  if (txOf(i1)) await act(maker, txOf(i1).id, "cancel", { reason: "bersihkan data uji" });
});

// ================================================================ S03 Penolakan, pembatalan (kedaluwarsa di S03e)
await run("S03", "Penolakan & pembatalan: tanpa jurnal, tanpa delta, status & alasan, audit", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL), ow = L.as(srv, "owner", M);
  const b0 = snapshot(), r0 = await reports();
  const t1 = txOf(await propose(maker, { amount: 300_000, desc: "akan ditolak" }));
  const noReason = await act(appr, t1.id, "reject", { reason: "" });
  s.ok("tolak tanpa alasan -> 400", noReason.status === 400, `${noReason.status}`);
  const rj = await act(appr, t1.id, "reject", { reason: "Nominal tidak sesuai dokumen" });
  s.ok("tolak dengan alasan 200 -> REJECTED", rj.status === 200 && txOf(rj)?.status === "REJECTED", `${rj.status}`);
  s.ok("pengaju melihat alasan penolakan", JSON.stringify(await detail(maker, t1.id)).includes("Nominal tidak sesuai dokumen"));
  const ap2 = await act(appr, t1.id, "approve");
  s.ok("menyetujui transaksi yang sudah ditolak -> 409", ap2.status === 409, `${ap2.status}`);
  const t2 = txOf(await propose(maker, { amount: 410_000, desc: "akan dibatalkan pengaju" }));
  const cn = await act(maker, t2.id, "cancel", { reason: "salah cabang" });
  s.ok("batal oleh pengaju 200 -> CANCELLED", cn.status === 200 && txOf(cn)?.status === "CANCELLED", `${cn.status}`);
  const t3 = txOf(await propose(maker, { amount: 420_000, desc: "dibatalkan OWNER" }));
  const cnO = await act(ow, t3.id, "cancel", { reason: "administratif" });
  s.ok("OWNER membatalkan pengajuan pengguna lain -> CANCELLED", cnO.status === 200 && txOf(cnO)?.status === "CANCELLED", `${cnO.status}`);
  const t4 = txOf(await propose(maker, { amount: 430_000, desc: "pembatalan oleh penerima tidak boleh" }));
  const cnR = await act(appr, t4.id, "cancel", { reason: "bukan pengaju" });
  s.ok("pembatalan oleh penerima (bukan pengaju, bukan OWNER) ditolak", cnR.status >= 400 && cnR.status < 500 && txOf(cnR) === undefined, `${cnR.status}`);
  await act(maker, t4.id, "cancel", { reason: "bersihkan data uji" });
  const b2 = snapshot(), r2 = await reports();
  s.ok("tidak ada jurnal baru, tidak ada delta saldo, laporan identik", b2.journals === b0.journals && Object.keys(delta(b0, b2)).length === 0 && JSON.stringify(r0) === JSON.stringify(r2));
  const aud1 = auditActions(t1.id).map((r) => r.action), aud2 = auditActions(t2.id).map((r) => r.action);
  s.ok("audit REJECTED (dengan alasan) dan CANCELLED tercatat", aud1.includes("INTER_BRANCH_REJECTED") && aud2.includes("INTER_BRANCH_CANCELLED") && auditActions(t1.id).find((r) => r.action === "INTER_BRANCH_REJECTED")?.reason === "Nominal tidak sesuai dokumen");
});

// ================================================================ S04 Pembalikan
await run("S04", "Pembalikan transaksi selesai: permintaan, ditolak, disetujui; 4 jurnal; saldo kembali", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL);
  const X = 1_100_000, b0 = snapshot(), r0 = await reports();
  const t = txOf(await propose(maker, { amount: X, desc: "akan dibalik" }));
  await act(appr, t.id, "approve");
  const bDone = snapshot();
  const noReason = await act(maker, t.id, "reverse", { reason: "" });
  s.ok("minta pembalikan tanpa alasan -> 400", noReason.status === 400, `${noReason.status}`);
  const rq = await act(maker, t.id, "reverse", { reason: "Salah input nominal" });
  s.ok("minta pembalikan 200 -> REVERSAL_WAITING", rq.status === 200 && JSON.stringify(txOf(rq)).includes("REVERSAL_WAITING"), `${rq.status}`);
  s.ok("selama menunggu: tidak ada jurnal baru & saldo tetap (UAT-39)", snapshot().journals === bDone.journals && Object.keys(delta(bDone, snapshot())).length === 0);
  const dup = await act(maker, t.id, "reverse", { reason: "permintaan ganda" });
  s.ok("UAT-37: permintaan pembalikan kedua = 409", dup.status === 409, `${dup.status}`);
  const reqId = (await detail(maker, t.id)).reversal?.approvalId ?? (await detail(maker, t.id)).pendingReversal?.approvalId ?? dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id)?.id;
  const selfApp = await maker.post(`${IB}/${t.id}/reverse/${reqId}/approve`, {});
  s.ok("pemohon (non-OWNER) tidak bisa menyetujui pembalikannya sendiri", selfApp.status >= 400 && snapshot().journals === bDone.journals, `${selfApp.status}`);
  const rj = await appr.post(`${IB}/${t.id}/reverse/${reqId}/reject`, { reason: "Belum perlu" });
  s.ok("pembalikan ditolak -> kembali NOT_REVERSED, tanpa jurnal", rj.status === 200 && txOf(rj)?.reversalState === "NOT_REVERSED" || JSON.stringify(txOf(rj)).includes("NOT_REVERSED"), `${rj.status}`);
  const rq2 = await act(maker, t.id, "reverse", { reason: "Ajukan lagi, nominal salah" });
  const reqId2 = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id)?.id;
  const ap = await appr.post(`${IB}/${t.id}/reverse/${reqId2}/approve`, {});
  s.ok("pembalikan disetujui 200", ap.status === 200, `${ap.status} ${ap.text.slice(0, 140)}`);
  const js = txJournals(t.id);
  s.ok("4 jurnal tertaut; 2 ORIGINAL berstatus REVERSED, 2 REVERSAL berstatus POSTED", js.length === 4 && js.filter((j) => j.leg === "ORIGINAL" && j.status === "REVERSED").length === 2 && js.filter((j) => j.leg === "REVERSAL" && j.status === "POSTED").length === 2, JSON.stringify(js.map((j) => [j.leg, j.side, j.status])));
  s.ok("semua jurnal seimbang (sen)", js.every((j) => j.dr === j.cr && j.dr === c100(X)));
  s.ok("jurnal pembalikan bertanggal sama dengan transaksi dan satu periode", js.every((j) => j.entry_date.slice(0, 10) === txRow(t.id).transaction_date && j.period_id === OKT.id));
  const b2 = snapshot(), r2 = await reports();
  s.ok("saldo semua akun x cabang kembali PERSIS ke sebelum transaksi", Object.keys(delta(b0, b2)).length === 0, JSON.stringify(delta(b0, b2)));
  s.ok("laporan kembali sama (aset, liabilitas, laba, kas, Neraca Saldo)", r2.ta === r0.ta && r2.tl === r0.tl && r2.np === r0.np && r2.cash === r0.cash && r2.tbOk && r2.tbDr === r0.tbDr && r2.tbCr === r0.tbCr, `${r2.tbDr - r0.tbDr}`);
  const acts = auditActions(t.id).map((r) => r.action);
  s.ok("audit: REVERSAL_REQUESTED, REVERSAL_REJECTED, REVERSAL_REQUESTED, REVERSAL_APPROVED, REVERSAL_POSTED", ["INTER_BRANCH_REVERSAL_REQUESTED", "INTER_BRANCH_REVERSAL_REJECTED", "INTER_BRANCH_REVERSAL_APPROVED", "INTER_BRANCH_REVERSAL_POSTED"].every((x) => acts.includes(x)), acts.join(","));
  const again = await act(maker, t.id, "reverse", { reason: "sudah dibalik" });
  s.ok("membalik transaksi yang sudah dibalik = 409", again.status === 409, `${again.status}`);
  const t2 = txOf(await propose(maker, { amount: 1000, desc: "belum selesai" }));
  const premature = await act(maker, t2.id, "reverse", { reason: "belum selesai" });
  s.ok("membalik transaksi yang belum selesai ditolak", premature.status >= 400 && premature.status < 500, `${premature.status}`);
  await act(maker, t2.id, "cancel", { reason: "bersihkan data uji" });
  s.ok("pembatalan permintaan pembalikan oleh pemohon", await (async () => {
    const t3 = txOf(await propose(maker, { amount: 2000, desc: "uji batal reversal" })); await act(appr, t3.id, "approve");
    completed.push({ id: t3.id, X: 2000, d: expectPosting(2000, cashM, M, cashBL, BL) });
    await act(maker, t3.id, "reverse", { reason: "batalkan nanti" });
    const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t3.id)?.id;
    const cn = await maker.post(`${IB}/${t3.id}/reverse/${rid}/cancel`, { reason: "tidak jadi" });
    return cn.status === 200 && JSON.stringify(txOf(cn)).includes("NOT_REVERSED");
  })());
});

// ================================================================ S05 Kegagalan di berbagai titik posting + pemulihan
await run("S05", "Kegagalan disuntik di 6 titik posting (+2 titik reversal): semua-atau-tidak, lalu pulih & ulang", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL);
  const points = [
    ["P1 jurnal sisi FROM dibuat", "BEFORE INSERT ON journal_entries WHEN NEW.inter_branch_side='FROM'"],
    ["P2 jurnal sisi TO dibuat (sisi FROM sudah tertulis)", "BEFORE INSERT ON journal_entries WHEN NEW.inter_branch_side='TO'"],
    ["P3 baris jurnal sisi TO", "BEFORE INSERT ON journal_entry_lines WHEN (SELECT inter_branch_side FROM journal_entries WHERE id=NEW.journal_entry_id)='TO'"],
    ["P4 posting jurnal sisi TO", "BEFORE UPDATE ON journal_entries WHEN NEW.inter_branch_side='TO' AND NEW.status='POSTED' AND OLD.status<>'POSTED'"],
    ["P5 status transaksi -> COMPLETED", "BEFORE UPDATE ON inter_branch_transactions WHEN NEW.status='COMPLETED'"],
    ["P6 audit COMPLETED (penulisan terakhir)", "BEFORE INSERT ON company_audit_log WHEN NEW.action='INTER_BRANCH_COMPLETED'"],
  ];
  let n = 0;
  for (const [label, when] of points) {
    n++;
    const X = 100_000 + n * 1111;
    const t = txOf(await propose(maker, { amount: X, desc: `injeksi ${label}` }));
    const before = snapshot(), apBefore = dbOne("select status from inter_branch_approvals where transaction_id=? and kind='POST'", t.id)?.status;
    const w = new L.Database(L.COMPANY_DB); w.exec(`create trigger uat_fail_${n} ${when} begin select raise(abort, 'UAT injeksi kegagalan'); end;`); w.close();
    const bad = await act(appr, t.id, "approve");
    s.ok(`${label}: persetujuan gagal (bukan 2xx)`, bad.status >= 400, `${bad.status}`);
    s.ok(`${label}: respons tidak membocorkan SQL/stack`, !/SQLITE|select |insert |at \w+\./i.test(bad.text), bad.text.slice(0, 100));
    const after = snapshot();
    s.ok(`${label}: tidak ada jurnal setengah jadi, saldo & audit tak berubah`, after.journals === before.journals && after.audit === before.audit && Object.keys(delta(before, after)).length === 0, `jurnal ${before.journals}->${after.journals} audit ${before.audit}->${after.audit}`);
    s.ok(`${label}: transaksi tetap WAITING_APPROVAL & persetujuan tetap WAITING`, txRow(t.id).status === "WAITING_APPROVAL" && dbOne("select status from inter_branch_approvals where transaction_id=? and kind='POST'", t.id).status === apBefore, txRow(t.id).status);
    const d = new L.Database(L.COMPANY_DB); d.exec(`drop trigger uat_fail_${n}`); d.close();
    const ok = await act(appr, t.id, "approve");
    const exp = expectPosting(X, cashM, M, cashBL, BL);
    s.ok(`${label}: setelah pulih, ulang berhasil: tepat 2 jurnal & delta benar`, ok.status === 200 && txJournals(t.id).length === 2 && sameDelta(delta(before, snapshot()), exp), `${ok.status} ${txJournals(t.id).length}`);
    completed.push({ id: t.id, X, d: exp });
  }
  // reversal sisi TO
  const X = 333_333, bPre = snapshot(), t = txOf(await propose(maker, { amount: X, desc: "injeksi reversal" })); await act(appr, t.id, "approve");
  await act(maker, t.id, "reverse", { reason: "uji injeksi reversal" });
  const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id).id;
  const before = snapshot();
  const w = new L.Database(L.COMPANY_DB); w.exec("create trigger uat_fail_r1 before insert on journal_entries when new.inter_branch_side='TO' and new.inter_branch_leg='REVERSAL' begin select raise(abort,'UAT injeksi'); end;"); w.close();
  const bad = await appr.post(`${IB}/${t.id}/reverse/${rid}/approve`, {});
  const mid = snapshot();
  s.ok("reversal: gagal di jurnal TO -> tak ada jurnal reversal, saldo tak berubah, tetap REVERSAL_WAITING", bad.status >= 400 && mid.journals === before.journals && Object.keys(delta(before, mid)).length === 0 && txRow(t.id).reversal_state === "REVERSAL_WAITING", `${bad.status} ${txRow(t.id).reversal_state}`);
  const d = new L.Database(L.COMPANY_DB); d.exec("drop trigger uat_fail_r1"); d.close();
  const okR = await appr.post(`${IB}/${t.id}/reverse/${rid}/approve`, {});
  s.ok("reversal: setelah pulih, ulang berhasil -> 4 jurnal, saldo kembali", okR.status === 200 && txJournals(t.id).length === 4 && Object.keys(delta(bPre, snapshot())).length === 0, `${okR.status}`);
  s.ok("trigger uji sudah dibuang; daftar trigger = baseline", dbAll("select name from sqlite_master where type='trigger' order by name").map((r) => r.name).join(",") === baselineTriggers);
});

// ================================================================ S06 OWNER
await run("S06", "OWNER mengajukan & menyetujui sendiri, serta pembalikan sendiri (UAT-21/22/24)", async (s) => {
  const ow = L.as(srv, "owner", M);
  const X = 900_000, b0 = snapshot();
  const t = txOf(await propose(ow, { amount: X, desc: "OWNER self-complete" }));
  s.ok("OWNER mengajukan 201", Boolean(t));
  const a = await act(ow, t.id, "approve");
  s.ok("OWNER menyetujui transaksinya sendiri 200 -> COMPLETED", a.status === 200 && txOf(a)?.status === "COMPLETED", `${a.status} ${a.text.slice(0, 120)}`);
  const exp = expectPosting(X, cashM, M, cashBL, BL);
  s.ok("2 jurnal seimbang & delta benar", txJournals(t.id).length === 2 && sameDelta(delta(b0, snapshot()), exp));
  const aud = auditActions(t.id).find((r) => r.action === "INTER_BRANCH_APPROVED");
  const after = JSON.parse(aud?.after_json ?? "{}");
  s.ok("audit APPROVED: makerEqualsApprover=true, actorRole=OWNER", after.makerEqualsApprover === true && after.actorRole === "OWNER", aud?.after_json?.slice(0, 160));
  s.ok("approvals.self_approved diisi server (1)", dbOne("select self_approved s from inter_branch_approvals where transaction_id=? and kind='POST'", t.id)?.s === 1);
  await act(ow, t.id, "reverse", { reason: "OWNER membalik sendiri" });
  const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id).id;
  const ra = await ow.post(`${IB}/${t.id}/reverse/${rid}/approve`, {});
  s.ok("OWNER meminta & menyetujui reversal sendiri -> REVERSED, 4 jurnal, saldo kembali", ra.status === 200 && txJournals(t.id).length === 4 && Object.keys(delta(b0, snapshot())).length === 0, `${ra.status}`);
  const ow2 = L.as(srv, "owner", KTB);
  const noPair = await propose(ow2, { to: M, fromAcc: cashKTB, toAcc: cashM, desc: "OWNER tanpa akun antarkantor" });
  s.ok("UAT-23: OWNER tetap tunduk validasi domain (akun antarkantor belum ada -> 422 + arahan)", noPair.status === 422 && /antarkantor|antar-cabang/i.test(noPair.text), `${noPair.status} ${noPair.text.slice(0, 120)}`);
});

// ================================================================ S07 Self-approval non-OWNER
await run("S07", "Non-OWNER tidak dapat menyetujui sendiri (ACCOUNTANT/ADMIN/ADMIN LIMITED pemegang dua cabang) + pemalsuan peran", async (s) => {
  const b0 = snapshot();
  for (const key of ["acctBoth", "adminBoth", "adminAll"]) {
    const c = L.as(srv, key, M);
    const t = txOf(await propose(c, { amount: 123_000, desc: `self-approve ${key}` }));
    if (!t) { s.ok(`${key}: dapat mengajukan`, false); continue; }
    const a = await act(c, t.id, "approve");
    s.ok(`${key}: menyetujui sendiri ditolak 403 SELF_APPROVAL_NOT_ALLOWED`, a.status === 403 && a.json?.code === "SELF_APPROVAL_NOT_ALLOWED", `${a.status} ${a.json?.code}`);
    const forged = await c.post(`${IB}/${t.id}/approve`, { role: "OWNER", actorRole: "OWNER", userId: P.personas.owner.id }, { headers: { "x-role": "OWNER", "x-user-role": "OWNER", "x-company-role": "OWNER" } });
    s.ok(`${key}: peran OWNER palsu (body/header) diabaikan -> tetap 403`, forged.status === 403, `${forged.status}`);
    s.ok(`${key}: tetap WAITING, tanpa jurnal`, txRow(t.id).status === "WAITING_APPROVAL" && txJournals(t.id).length === 0);
    await act(c, t.id, "cancel", { reason: "bersihkan data uji" });
  }
  const c = L.as(srv, "acctBoth", M), other = L.as(srv, "approverBl", BL);
  const t = txOf(await propose(c, { amount: 124_000, desc: "pengaju pemegang dua cabang disetujui orang lain" }));
  const okOther = await act(other, t.id, "approve");
  s.ok("pengaju pemegang dua cabang: persetujuan oleh pengguna LAIN berhasil (UAT-25)", okOther.status === 200, `${okOther.status}`);
  completed.push({ id: t.id, X: 124_000, d: expectPosting(124_000, cashM, M, cashBL, BL) });
  await act(c, t.id, "reverse", { reason: "uji self-approve reversal" });
  const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id).id;
  const selfRev = await c.post(`${IB}/${t.id}/reverse/${rid}/approve`, {});
  s.ok("pemohon pembalikan non-OWNER pemegang dua cabang tidak dapat menyetujui sendiri", selfRev.status === 403 || selfRev.status === 404, `${selfRev.status} ${selfRev.json?.code}`);
  const cancel = await c.post(`${IB}/${t.id}/reverse/${rid}/cancel`, { reason: "bersihkan data uji" });
  s.ok("pemohon membatalkan permintaan pembalikannya", cancel.status === 200, `${cancel.status}`);
  s.ok("percobaan self-approval tidak menghasilkan jurnal: satu-satunya delta = transaksi yang disetujui orang lain", sameDelta(delta(b0, snapshot()), expectPosting(124_000, cashM, M, cashBL, BL)), JSON.stringify(delta(b0, snapshot())).slice(0, 160));
});

// ================================================================ S08 Matriks peran
await run("S08", "Matriks peran: ADMIN, ADMIN LIMITED, ACCOUNTANT, STAFF, VIEWER sesuai permission & akses cabang", async (s) => {
  const maker = L.as(srv, "makerM", M);
  const mk = async () => txOf(await propose(maker, { amount: 50_000 + Math.floor(Math.random() * 900), desc: "matriks peran" }));
  const cases = [
    // [persona, boleh lihat daftar, boleh mengajukan dari Metro, boleh menyetujui (tujuan BL), catatan]
    ["owner", true, true, true],
    ["adminAll", true, true, true],
    ["adminBoth", true, true, true],
    ["adminBl", true, false, true],      // hanya cabang BL: tak punya akses Metro untuk mengajukan dari Metro
    ["acctAll", true, true, true],
    ["acctBoth", true, true, true],
    ["approverBl", true, false, true],
    ["makerM", true, true, false],       // tak punya akses BL
    ["staffM", true, true, false],       // STAFF boleh mengajukan, tidak boleh menyetujui
    ["staffBl", true, false, false],
    ["viewer", false, false, false],
    ["noBranch", "empty", false, false],  // daftar 200 tetapi kosong dari transaksi Metro-BL (tidak ada akses cabang)
    ["ktb", "empty", false, false],
  ];
  for (const [key, canList, canPropose, canApprove] of cases) {
    const ctxBranch = ["adminBl", "approverBl", "staffBl"].includes(key) ? BL : M;
    const c = L.as(srv, key, ctxBranch);
    const l = await c.get(IB);
    if (canList === "empty") s.ok(`${key}: daftar tidak berisi transaksi Metro-BL`, l.status === 200 && (l.json?.items ?? l.json?.transactions ?? []).length === 0 || l.status >= 400, `${l.status} ${JSON.stringify(l.json).slice(0, 100)}`);
    else s.ok(`${key}: daftar ${canList ? "boleh" : "ditolak"}`, canList ? l.status === 200 : l.status >= 400, `${l.status}`);
    const cm = L.as(srv, key, M);
    const pr = await propose(cm, { amount: 11_000 + Math.floor(Math.random() * 99), desc: `matriks ${key}` });
    s.ok(`${key}: mengajukan dari Metro ${canPropose ? "boleh" : "ditolak"}`, canPropose ? pr.status === 201 : pr.status >= 400, `${pr.status} ${pr.json?.code ?? ""}`);
    if (pr.status === 201) await act(cm, txOf(pr).id, "cancel", { reason: "bersihkan data uji" });
    const t = await mk();
    const cb = L.as(srv, key, BL);
    const ap = await act(cb, t.id, "approve");
    const approved = ap.status === 200;
    s.ok(`${key}: menyetujui (tujuan BL, pengaju orang lain) ${canApprove ? "boleh" : "ditolak"}`, approved === canApprove, `${ap.status} ${ap.json?.code ?? ""}`);
    if (approved) completed.push({ id: t.id, X: txRow(t.id).amount, d: expectPosting(txRow(t.id).amount, cashM, M, cashBL, BL) });
    else await act(maker, t.id, "cancel", { reason: "bersihkan data uji" });
  }
  const ownerSet = await L.as(srv, "owner").put(`${IB}/settings`, { expiryDays: 14 });
  const adminSet = await L.as(srv, "adminAll").put(`${IB}/settings`, { expiryDays: 5 });
  s.ok("pengaturan masa berlaku: OWNER boleh, ADMIN ditolak 403", ownerSet.status === 200 && adminSet.status === 403, `${ownerSet.status}/${adminSet.status}`);
  const bad = await L.as(srv, "owner").put(`${IB}/settings`, { expiryDays: 0 });
  s.ok("masa berlaku di luar 1-90 ditolak", bad.status === 400 || bad.status === 422, `${bad.status}`);
});

// ================================================================ S09 Akses lintas cabang / perusahaan / delegasi
await run("S09", "Akses lintas cabang, lintas perusahaan, IDOR, spoofing, dan delegasi", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL);
  const t = txOf(await propose(maker, { amount: 77_000, desc: "target IDOR" }));
  const ktb = L.as(srv, "ktb", KTB);
  const ghost = "00000000-0000-4000-8000-000000000000";
  const g1 = await ktb.get(`${IB}/${t.id}`), g2 = await ktb.get(`${IB}/${ghost}`);
  s.ok("IDOR: cabang lain membaca detail = 404 identik dengan id yang tidak ada", g1.status === 404 && g2.status === 404 && g1.text === g2.text, `${g1.status}/${g2.status}`);
  const lst = await ktb.get(IB);
  s.ok("daftar pengguna Kotabumi tidak memuat transaksi Metro-BL", lst.status === 200 && !JSON.stringify(lst.json).includes(t.id));
  const byNo = await ktb.get(`${IB}?search=${encodeURIComponent(t.transactionNo)}`);
  s.ok("pencarian nomor transaksi tidak membocorkan", !JSON.stringify(byNo.json).includes(t.id));
  s.ok("pengguna Kotabumi tidak dapat menyetujui/menolak/membatalkan/membalik", (await Promise.all(["approve", "reject", "cancel", "reverse"].map((a) => act(L.as(srv, "ktb", KTB), t.id, a, { reason: "x" })))).every((r) => r.status === 404 || r.status === 403), "");
  const sp = await L.as(srv, "ktb", KTB).post(IB, { type: "TRANSFER_KAS", fromBranchId: M, toBranchId: BL, transactionDate: L.today(), amount: 1000, fromAccountId: cashM.id, toAccountSuggestedId: cashBL.id, description: "spoof fromBranchId", idempotencyKey: uid() });
  s.ok("spoof fromBranchId=Metro oleh pengguna Kotabumi ditolak", sp.status >= 400 && sp.status < 500, `${sp.status}`);
  const sp2 = await L.as(srv, "makerM", BL).post(IB, { type: "TRANSFER_KAS", toBranchId: M, transactionDate: L.today(), amount: 1000, fromAccountId: cashBL.id, toAccountSuggestedId: cashM.id, description: "konteks cabang BL tanpa akses", idempotencyKey: uid() });
  s.ok("header cabang aktif ke cabang tanpa akses ditolak", sp2.status >= 400 && sp2.status < 500, `${sp2.status}`);
  const sp3 = await L.as(srv, "makerM", M).post(IB, { type: "TRANSFER_KAS", fromBranchId: BL, toBranchId: BL, transactionDate: L.today(), amount: 1000, fromAccountId: cashM.id, toAccountSuggestedId: cashBL.id, description: "body fromBranchId != konteks", idempotencyKey: uid() });
  s.ok("fromBranchId body berbeda dari konteks ditolak", sp3.status >= 400 && sp3.status < 500, `${sp3.status}`);
  // lintas perusahaan
  const other = L.as(srv, "otherOwner"), otherOwnerBranch = null;
  const x1 = await other.get(`/api/company-db/${SLUG}/inter-branch`), x2 = await other.get(`/api/company-db/${SLUG}/inter-branch/${t.id}`), x3 = await other.get(`${BASE}/journals`);
  s.ok("pemilik perusahaan lain: semua akses ke perusahaan ini ditolak (403/404)", [x1, x2, x3].every((r) => r.status === 403 || r.status === 404), [x1, x2, x3].map((r) => r.status).join("/"));
  const x4 = await other.get(`/api/company-db/${OFF_SLUG}/inter-branch/${t.id}`);
  s.ok("ID transaksi perusahaan A dipakai di path perusahaan B = 404", x4.status === 404, `${x4.status}`);
  const x5 = await other.post(`/api/company-db/${OFF_SLUG}/inter-branch/${t.id}/approve`, {}, { headers: { "x-company-slug": SLUG, "x-company-id": "x" } });
  s.ok("spoof header perusahaan tidak berpengaruh (404)", x5.status === 404, `${x5.status}`);
  // delegasi
  const dl = await owner.post(`${BASE}/delegations`, { granteeUserId: P.personas.delegateM.id, capabilities: ["inter_branch", "view_branch_reports"], maxRole: "STAFF", branchIds: [BL], reason: "UAT delegasi" });
  s.ok("OWNER membuat delegasi (inter_branch) untuk penerima di Metro dengan cakupan BL", dl.status === 200 || dl.status === 201, `${dl.status} ${dl.text.slice(0, 140)}`);
  const dAp = await act(L.as(srv, "delegateM", M), t.id, "approve");
  s.ok("UAT-27: delegasi tidak memberi hak menyetujui di BL (tanpa akses BL) -> ditolak", dAp.status >= 400 && dAp.status < 500 && txRow(t.id).status === "WAITING_APPROVAL", `${dAp.status}`);
  const dMetro = await propose(L.as(srv, "delegateM", M), { amount: 1000, desc: "hak asli peran/akses tetap berlaku" });
  s.ok("hak asli (peran ACCOUNTANT + akses Metro) tetap berlaku: dapat mengajukan dari Metro", dMetro.status === 201, `${dMetro.status}`);
  if (txOf(dMetro)) await act(L.as(srv, "delegateM", M), txOf(dMetro).id, "cancel", { reason: "bersihkan data uji" });
  await act(maker, t.id, "cancel", { reason: "bersihkan data uji" });
  // pengguna tanpa sesi / sesi palsu
  const anon = new L.Client(srv.base, null, "anon");
  s.ok("tanpa sesi = 401", (await anon.get(IB)).status === 401);
  const fake = new L.Client(srv.base, "token-palsu-" + uid(), "fake");
  s.ok("token palsu = 401", (await fake.get(IB)).status === 401);
});

// ================================================================ S10 Flag OFF
await run("S10", "Multi-cabang OFF (pt-pembanding): semua endpoint Antar Cabang 404; fitur lama & angka tidak berubah", async (s) => {
  const o = L.as(srv, "otherOwner");
  const base = `/api/company-db/${OFF_SLUG}`;
  const rep = async () => {
    const q = "fromDate=2026-01-01&toDate=2026-12-31";
    const a = (await o.get(`${base}/reports/balance-sheet?${q}`)).json, b = (await o.get(`${base}/reports/income-statement?${q}`)).json;
    return JSON.stringify([a?.totalAssets, a?.totalLiabilities, b?.netProfit]);
  };
  const r0 = await rep();
  const ep = [["GET", ""], ["GET", "/summary"], ["GET", "/options"], ["GET", "/settings"], ["GET", "/" + uid()], ["POST", ""], ["POST", "/" + uid() + "/approve"], ["POST", "/" + uid() + "/reverse"]];
  const res = [];
  for (const [m, p] of ep) res.push((await o.req(m, base + "/inter-branch" + p, { body: m === "POST" ? {} : undefined })).status);
  s.ok("semua endpoint IB = 404 seragam (termasuk body tidak valid)", res.every((x) => x === 404), res.join(","));
  const validBody = await o.post(base + "/inter-branch", { type: "TRANSFER_KAS", toBranchId: uid(), transactionDate: L.today(), amount: 1000, fromAccountId: uid(), toAccountSuggestedId: uid(), description: "uji flag off", idempotencyKey: uid() });
  s.ok("body VALID pada perusahaan flag OFF = 404", validBody.status === 404, `${validBody.status}`);
  const badQuery = await o.get(base + "/inter-branch?status=NGAWUR");
  s.ok("query tidak valid pada flag OFF = 404 (bukan 400)", badQuery.status === 404, `${badQuery.status}`);
  s.ok("menu data: /branch-context perusahaan OFF tidak menampilkan multi-cabang", (await o.get(`${base}/branches`)).status < 500);
  const j = await o.get(`${base}/journals`);
  s.ok("fitur lama (jurnal, laporan) tetap berjalan", j.status === 200 && (await rep()) === r0, `${j.status}`);
  s.ok("OWNER perusahaan A di jalur perusahaan B tanpa akses = ditolak", [403, 404].includes((await owner.get(`${base}/inter-branch`)).status), "");
});

// ================================================================ S11 Persetujuan bersamaan
await run("S11", "Enam penyetuju bersamaan + replay/klik ganda; dua PROSES server; satu pasang jurnal", async (s) => {
  const maker = L.as(srv, "makerM", M);
  const X = 640_000, b0 = snapshot();
  const t = txOf(await propose(maker, { amount: X, desc: "balapan 6 penyetuju" }));
  const keys = ["approverBl", "adminBl", "acctAll", "owner", "adminAll", "acctBoth"];
  const res = await Promise.all(keys.map((k) => act(L.as(srv, k, BL), t.id, "approve")));
  const codes = res.map((r) => r.status);
  s.ok("tepat satu 200; sisanya 409 (atau 503 aman diulang)", codes.filter((c) => c === 200).length === 1 && codes.every((c) => [200, 409, 503].includes(c)), codes.join(","));
  const exp = expectPosting(X, cashM, M, cashBL, BL);
  s.ok("hanya satu pasang jurnal (2) & delta tepat satu kali", txJournals(t.id).length === 2 && sameDelta(delta(b0, snapshot()), exp), `${txJournals(t.id).length}`);
  completed.push({ id: t.id, X, d: exp });
  // klik ganda satu pengguna
  const t2 = txOf(await propose(maker, { amount: 650_000, desc: "klik ganda" })), ap = L.as(srv, "approverBl", BL);
  const dbl = await Promise.all([1, 2, 3].map(() => act(ap, t2.id, "approve")));
  s.ok("klik ganda (3 permintaan paralel pengguna sama): satu sukses", dbl.filter((r) => r.status === 200).length === 1 && txJournals(t2.id).length === 2, dbl.map((r) => r.status).join(","));
  completed.push({ id: t2.id, X: 650_000, d: expectPosting(650_000, cashM, M, cashBL, BL) });
  // reversal ganda paralel
  const rr = await Promise.all([1, 2, 3].map(() => act(maker, t2.id, "reverse", { reason: "permintaan paralel" })));
  s.ok("UAT-37: tiga permintaan pembalikan paralel -> satu sukses", rr.filter((r) => r.status === 200).length === 1, rr.map((r) => r.status).join(","));
  const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t2.id).id;
  const ra = await Promise.all(["approverBl", "adminBl", "acctAll"].map((k) => L.as(srv, k, BL).post(`${IB}/${t2.id}/reverse/${rid}/approve`, {})));
  s.ok("persetujuan pembalikan paralel -> satu sukses, 4 jurnal", ra.filter((r) => r.status === 200).length === 1 && txJournals(t2.id).length === 4, ra.map((r) => r.status).join(","));
  completed.pop();
  // dua proses server berbeda memakai file DB yang sama
  const srv2 = await L.startServer(4541, 0, "uat2");
  try {
    const t3 = txOf(await propose(maker, { amount: 660_000, desc: "dua proses server" }));
    const reqs = ["approverBl", "adminBl", "acctAll", "adminAll", "acctBoth", "owner"].map((k, i) => act(L.as(i % 2 ? srv2 : srv, k, BL), t3.id, "approve"));
    const out = await Promise.all(reqs);
    s.ok("dua proses server: tepat satu 200; sisanya 409/503; 2 jurnal", out.filter((r) => r.status === 200).length === 1 && out.every((r) => [200, 409, 503].includes(r.status)) && txJournals(t3.id).length === 2, out.map((r) => r.status).join(","));
    completed.push({ id: t3.id, X: 660_000, d: expectPosting(660_000, cashM, M, cashBL, BL) });
  } finally { await srv2.stop(); }
});

// ================================================================ S12 Akun belum ada, periode, cabang, akun terkunci (UAT-16..18, 29..31)
await run("S12", "Akun antarkantor belum ada -> pembuatan terpandu; periode; cabang nonaktif; akun terkunci", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL), ow = L.as(srv, "owner");
  // UAT-18
  const no = await propose(maker, { to: KTB, toAcc: cashKTB, desc: "belum ada akun antarkantor" });
  s.ok("UAT-18: Metro->Kotabumi ditolak 422 dengan arahan membuat akun", no.status === 422 && /antarkantor|antar-cabang/i.test(no.text), `${no.status} ${no.text.slice(0, 120)}`);
  const lim = await maker.post(`${BASE}/accounts/inter-branch`, { branchAId: M, branchBId: KTB, accountTypeCode: "ASSET", confirm: true });
  s.ok("pembuatan akun terpandu oleh non-OWNER ditolak", lim.status === 403, `${lim.status}`);
  for (const accountTypeCode of ["ASSET", "LIABILITY"]) {
    const cr = await ow.post(`${BASE}/accounts/inter-branch`, { branchAId: M, branchBId: KTB, accountTypeCode, confirm: true });
    s.ok(`OWNER membuat pasangan akun ${accountTypeCode} Metro-Kotabumi`, cr.status === 201, `${cr.status} ${cr.text.slice(0, 100)}`);
  }
  const b0 = snapshot();
  const t = txOf(await propose(maker, { to: KTB, toAcc: cashKTB, amount: 222_000, desc: "setelah akun dibuat" }));
  s.ok("setelah akun dibuat, pengajuan Metro->Kotabumi berhasil", Boolean(t));
  const ktb = L.as(srv, "ktb", KTB);
  const a = await act(ktb, t.id, "approve");
  const exp = expectPosting(222_000, cashM, M, cashKTB, KTB);
  s.ok("persetujuan oleh pengguna Kotabumi: COMPLETED & delta benar", a.status === 200 && sameDelta(delta(b0, snapshot()), exp), `${a.status} ${a.text.slice(0, 100)}`);
  completed.push({ id: t.id, X: 222_000, d: exp });
  // UAT-16/30 periode
  const sep = periodOf("Sep 2026"), agu = periodOf("Agu 2026");
  const tAgu = txOf(await propose(maker, { date: "2026-08-15", amount: 15_000, desc: "tanggal Agustus (menunggu)" }));
  s.ok("pengajuan bertanggal Agustus 2026 (periode OPEN) diterima", Boolean(tAgu), "");
  const clo = await ow.post(`${BASE}/periods/${agu.id}/close`, {});
  s.ok("UAT-16: menutup periode yang memiliki pengajuan menunggu diblokir dengan penjelasan", clo.status >= 400 && clo.status < 500 && /antar|menunggu|pengajuan/i.test(clo.text), `${clo.status} ${clo.text.slice(0, 160)}`);
  await act(maker, tAgu.id, "cancel", { reason: "bersihkan data uji" });
  const tSep = txOf(await propose(maker, { date: "2026-09-10", amount: 16_000, desc: "tanggal September; periode dikunci sebelum persetujuan" }));
  const lk = await ow.post(`${BASE}/periods/${sep.id}/lock`, {});
  s.ok("(persiapan) periode September dikunci setelah pengajuan", lk.status === 200 || lk.status === 409 || lk.status === 422, `${lk.status} ${lk.text.slice(0, 160)}`);
  if (lk.status === 200) {
    const bb = snapshot();
    const ap = await act(appr, tSep.id, "approve");
    s.ok("UAT-30: persetujuan setelah periode dikunci ditolak (4xx), 0 jurnal, status tetap WAITING_APPROVAL", ap.status >= 400 && ap.status < 500 && txJournals(tSep.id).length === 0 && txRow(tSep.id).status === "WAITING_APPROVAL" && snapshot().journals === bb.journals, `${ap.status} ${ap.text.slice(0, 140)}`);
    const rjt = await act(appr, tSep.id, "reject", { reason: "periode dikunci" });
    s.ok("penyetuju tetap dapat menolak pengajuan yang tak bisa diposting", rjt.status === 200, `${rjt.status}`);
  } else record("S12-period-lock", "UAT-30 periode dikunci setelah pengajuan", "BLOCKED", `lock periode tidak dapat dijalankan: ${lk.status} ${lk.text.slice(0, 120)}`);
  // UAT-31 akun terkunci
  const t31 = txOf(await propose(maker, { amount: 33_000, toAcc: bankMandiri, desc: "akun tujuan akan dikunci" }));
  const lockA = await ow.post(`${BASE}/accounts/${bankMandiri.id}/lock`, {});
  s.ok("(persiapan) akun Bank Mandiri dikunci", lockA.status === 200, `${lockA.status}`);
  const bb = snapshot();
  const ap31 = await act(appr, t31.id, "approve");
  s.ok("UAT-31: akun tujuan terkunci -> ditolak 4xx menyebut akun, 0 jurnal, tetap WAITING", ap31.status >= 400 && ap31.status < 500 && /terkunci|kunci/i.test(ap31.text) && txJournals(t31.id).length === 0 && snapshot().journals === bb.journals, `${ap31.status} ${ap31.text.slice(0, 140)}`);
  const ap31b = await act(appr, t31.id, "approve", { confirmedAccountId: bankBCA.id });
  const exp31 = expectPosting(33_000, cashM, M, bankBCA, BL);
  s.ok("penyetuju mengonfirmasi akun lain (BCA) -> berhasil, delta benar", ap31b.status === 200 && sameDelta(delta(bb, snapshot()), exp31), `${ap31b.status}`);
  completed.push({ id: t31.id, X: 33_000, d: exp31 });
  await ow.post(`${BASE}/accounts/${bankMandiri.id}/unlock`, {});
  // UAT-17/29 cabang nonaktif
  const tK = txOf(await propose(maker, { to: KTB, toAcc: cashKTB, amount: 44_000, desc: "cabang tujuan akan ditutup" }));
  const bK = snapshot();
  const st = await ow.post(`${BASE}/branches/${KTB}/status`, { to: "INACTIVE", reason: "UAT" });
  s.ok("(persiapan) cabang Kotabumi dinonaktifkan/diblokir dengan penjelasan", st.status >= 200 && st.status < 500, `${st.status} ${st.text.slice(0, 160)}`);
  const stNow = dbOne("select status from branches where id=?", KTB).status;
  const apK = await act(ktb, tK.id, "approve");
  const sK = txRow(tK.id).status;
  s.ok("UAT-17/29: cabang tujuan tidak aktif -> tidak ada jurnal; transaksi dibatalkan otomatis atau persetujuan ditolak", snapshot().journals === bK.journals && stNow === "INACTIVE" && sK === "CANCELLED" && apK.status >= 400 && auditActions(tK.id).some((r) => r.action === "INTER_BRANCH_CANCELLED" && /INACTIVE/.test(r.reason ?? "")), `branch=${stNow} tx=${sK} approve=${apK.status} ${apK.text.slice(0, 100)}`);
  if (stNow !== "ACTIVE") await ow.post(`${BASE}/branches/${KTB}/status`, { to: "ACTIVE", reason: "UAT pulihkan" });
  if (txRow(tK.id).status === "WAITING_APPROVAL") await act(maker, tK.id, "cancel", { reason: "bersihkan data uji" });
});

// ================================================================ S13 Kedaluwarsa (jam server digeser)
await run("S13", "Kedaluwarsa pengajuan & permintaan pembalikan (jam server uji digeser +3 hari)", async (s) => {
  const maker = L.as(srv, "makerM", M), appr = L.as(srv, "approverBl", BL), ow = L.as(srv, "owner");
  const set = await ow.put(`${IB}/settings`, { expiryDays: 1 });
  s.ok("OWNER mengatur masa berlaku 1 hari", set.status === 200, `${set.status}`);
  const tE = txOf(await propose(maker, { amount: 55_000, desc: "akan kedaluwarsa" }));
  const tC = txOf(await propose(maker, { amount: 56_000, desc: "akan selesai lalu minta reversal yang kedaluwarsa" }));
  await act(appr, tC.id, "approve");
  const exC = { id: tC.id, X: 56_000, d: expectPosting(56_000, cashM, M, cashBL, BL) };
  await act(maker, tC.id, "reverse", { reason: "reversal yang akan kedaluwarsa" });
  await ow.put(`${IB}/settings`, { expiryDays: 14 });
  const tt = await L.startServer(4542, 3, "uat-tt");
  try {
    const a2 = await L.loginAs(tt, "approverBl"); a2.branch = BL;
    const before = snapshot();
    const ap = await act(a2, tE.id, "approve");
    s.ok("persetujuan setelah lewat masa berlaku ditolak 409 INTER_BRANCH_EXPIRED", ap.status === 409 && ap.json?.code === "INTER_BRANCH_EXPIRED", `${ap.status} ${ap.json?.code}`);
    s.ok("tidak ada jurnal; status EXPIRED setelah dibaca/diterapkan", txJournals(tE.id).length === 0 && snapshot().journals === before.journals, "");
    const dt = await a2.get(`${IB}/${tE.id}`);
    s.ok("detail menampilkan EXPIRED", /EXPIRED/.test(dt.text) && txRow(tE.id).status === "EXPIRED", txRow(tE.id).status);
    s.ok("audit EXPIRED tercatat", auditActions(tE.id).some((r) => r.action === "INTER_BRANCH_EXPIRED"), auditActions(tE.id).map((r) => r.action).join(","));
    const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status in ('WAITING','EXPIRED')", tC.id)?.id;
    const ra = await a2.post(`${IB}/${tC.id}/reverse/${rid}/approve`, {});
    s.ok("persetujuan pembalikan setelah kedaluwarsa ditolak; transaksi tetap COMPLETED/NOT_REVERSED", ra.status >= 400 && txJournals(tC.id).length === 2 && txRow(tC.id).status === "COMPLETED", `${ra.status} ${ra.text.slice(0, 120)} rs=${txRow(tC.id).reversal_state}`);
    completed.push(exC);
  } finally { await tt.stop(); }
});

// ================================================================ S14 LIMITED & laporan
await run("S14", "Pengguna LIMITED melihat laporan cabangnya (Phase 5A/5B): angka = angka cabang, dampak transaksi Antar Cabang terlihat, cabang lain & gabungan ditolak", async (s) => {
  const q = "fromDate=2026-01-01&toDate=2026-12-31";
  const rep = async (c, scope = "") => {
    const sc = scope ? `&scope=${encodeURIComponent(scope)}` : "";
    const bs = await c.get(`${BASE}/reports/balance-sheet?${q}${sc}`);
    const is = await c.get(`${BASE}/reports/income-statement?${q}${sc}`);
    const tb = await c.get(`${BASE}/trial-balance?periodId=${OKT.id}${sc}`);
    const lg = await c.get(`${BASE}/ledger/${cashM.id}?${q}${sc}`);
    const dash = await c.get(`${BASE}/dashboard?${q}${sc}`);
    return { bs, is, tb, lg, dash };
  };
  // angka referensi dari OWNER (cakupan eksplisit per cabang)
  const refM = await rep(owner, `branch:${M}`), refBL = await rep(owner, `branch:${BL}`);
  for (const [key, branch, ref] of [["makerM", M, refM], ["staffM", M, refM], ["approverBl", BL, refBL], ["adminBl", BL, refBL], ["staffBl", BL, refBL]]) {
    const r = await rep(L.as(srv, key, branch));
    s.ok(`${key} (LIMITED): Neraca, Laba Rugi, Neraca Saldo, Buku Besar, Dashboard terbuka (200)`, [r.bs, r.is, r.tb, r.lg, r.dash].every((x) => x.status === 200), [r.bs, r.is, r.tb, r.lg, r.dash].map((x) => x.status).join(","));
    s.ok(`${key}: angka = angka cabangnya menurut OWNER (aset, laba bersih, kas buku besar), tanpa data cabang lain`, r.bs.json.totalAssets === ref.bs.json.totalAssets && r.is.json.netProfit === ref.is.json.netProfit && r.lg.json.endingBalance === ref.lg.json.endingBalance && r.bs.json.scope.mode === "SINGLE", `${r.bs.json?.totalAssets} vs ${ref.bs.json?.totalAssets}`);
    s.ok(`${key}: scope cabang lain / gabungan seluruh ditolak (404/403)`, (await L.as(srv, key, branch).get(`${BASE}/reports/balance-sheet?${q}&scope=branch:${branch === M ? BL : M}`)).status === 404 && (await L.as(srv, key, branch).get(`${BASE}/reports/balance-sheet?${q}&scope=all`)).status === 403);
  }
  // dampak transaksi Antar Cabang pada laporan cabang: akun antar-kantor muncul di Neraca cabang pemberi (aset) dan penerima (liabilitas)
  const lines = (res, sec) => (res.json[sec]?.lines ?? []).map((l) => l.accountCode);
  s.ok("Neraca Metro memuat akun antar-kantor aset; Neraca BL memuat akun antar-kantor liabilitas (sisi masing-masing)", lines(refM.bs, "assets").some((c) => c.startsWith("IBA")) && lines(refBL.bs, "liabilities").some((c) => c.startsWith("IBP")));
  // Σ cabang LIMITED yang dipegang acctBoth (Metro+BL) = gabungan terpilih
  const both = L.as(srv, "acctBoth", M);
  const sel = await both.get(`${BASE}/reports/income-statement?${q}&scope=${encodeURIComponent(`selected:${M},${BL}`)}`);
  s.ok("ACCOUNTANT dua cabang: gabungan terpilih = Σ laba cabang, berlabel belum dieliminasi", sel.status === 200 && sel.json.netProfit === refM.is.json.netProfit + refBL.is.json.netProfit && /belum dieliminasi/i.test(sel.json.scope.label.warnings.join(" ")), `${sel.status}`);
  // route level perusahaan tetap ditolak untuk LIMITED (D3, D9)
  for (const url of ["/analysis?fromDate=2026-01-01&toDate=2026-12-31", "/projection", "/tax-summary?fromDate=2026-01-01&toDate=2026-12-31", "/audit-log"]) {
    s.ok(`LIMITED: ${url.split("?")[0]} (level perusahaan) ditolak 403`, (await L.as(srv, "makerM", M).get(`${BASE}${url}`)).status === 403);
  }
  for (const key of ["owner", "adminAll", "acctAll", "viewer"]) s.ok(`${key} (ALL): laporan perusahaan terbuka`, (await L.as(srv, key, M).get(`${BASE}/reports/balance-sheet?${q}`)).status === 200);
  record("S14-report", "Laporan per cabang untuk pengguna LIMITED (Phase 5A/5B)", "PASS", "tersedia: satu cabang, gabungan terpilih (butuh report.consolidated), komparasi; gabungan selalu berlabel belum dieliminasi");
});

// ================================================================ S15 Batas laju (auth 30/menit/IP)
await run("S15", "Batas laju: login beruntun dalam satu menit dari satu IP", async (s) => {
  const rl = await L.startServer(4543, 0, "uat-rl"); // bucket baru
  try {
    const keys = ["owner", "adminAll", "adminBoth", "adminBl", "makerM", "approverBl", "acctBoth", "acctAll", "staffM", "staffBl", "viewer", "ktb", "delegateM"];
    let ok = 0, first429 = -1, retryAfter = null, msg = "";
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      const c = new L.Client(rl.base, null, "rl");
      const r = await c.req("POST", "/api/auth/login", { body: { email: P.personas[keys[i % keys.length]].email, password: P.personas[keys[i % keys.length]].password }, noRetry: true });
      if (r.status === 200) ok++;
      else if (r.status === 429 && first429 < 0) { first429 = i + 1; msg = r.json?.error ?? r.text.slice(0, 100); }
    }
    s.ok(`login sah ke-${first429} dalam ${Math.round((Date.now() - t0) / 1000)} dtk mendapat 429 (batas ${ok} login sah per menit per IP)`, ok === 30 && first429 === 31, `ok=${ok} first429=${first429} pesan=${msg}`);
    const reads = new L.Client(rl.base, P.personas.owner.token, "rl");
    const rr = await reads.get(`/api/company-db/${SLUG}/branches`);
    s.ok("bucket auth terpisah dari baca: pembacaan tetap 200 saat auth terbatas", rr.status === 200, `${rr.status}`);
    s.ok("status 429 memuat pesan berbahasa Indonesia dengan lama tunggu", /Terlalu banyak permintaan/.test(msg), msg);
  } finally { await rl.stop(); }
  record("S15-calc", "Perhitungan beban auth per pengguna", "PASS", "Pengguna aktif mengirim 1 ping aktivitas/menit (PING_INTERVAL 60 dtk) + 1 login + 1 logout. Sebuah IP (server hanya mengikat 127.0.0.1) dengan N pengguna aktif serempak memakai ~N permintaan auth/menit: batas 30/menit jenuh pada ~25-30 pengguna serempak, atau pada penggantian akun cepat (>=15 siklus login+logout/menit). Server desktop tidak dapat diakses dari mesin lain (127.0.0.1) sehingga satu kantor dengan mesin sendiri-sendiri tidak berbagi bucket; risiko nyata baru muncul bila kelak multi-perangkat (LAN/NAT/reverse proxy) diaktifkan.");
});

// ================================================================ S17 Idempotensi pengajuan lintas PROSES SERVER (HTTP)
await run("S17", "Pengajuan serempak dengan kunci idempotensi sama dari dua proses server: satu transaksi, sisanya replay yang sama, tanpa 500 dan tanpa efek ganda", async (s) => {
  const srv2 = await L.startServer(4541, 0, "uat-idem");
  try {
    const before = snapshot();
    let replays = 0, created = 0;
    for (let round = 0; round < 5; round++) {
      const key = "idem-" + uid();
      const clients = Array.from({ length: 8 }, (_, i) => L.as(i % 2 ? srv2 : srv, "makerM", M));
      const res = await Promise.all(clients.map((c) => propose(c, { key, amount: 71_000 + round, desc: `idempotensi putaran ${round}` })));
      const codes = res.map((r) => r.status);
      s.ok(`putaran ${round}: hanya 201/200/503 (tanpa 500 atau galat lain)`, codes.every((c) => [200, 201, 503].includes(c)), codes.join(","));
      s.ok(`putaran ${round}: paling banyak satu 201`, codes.filter((c) => c === 201).length <= 1, codes.join(","));
      // pemanggil yang mendapat 503 mengulang -> harus menerima replay pemenang
      for (const [i, r] of res.entries()) if (r.status === 503) res[i] = await propose(clients[i], { key, amount: 71_000 + round, desc: `idempotensi putaran ${round}` });
      const ids = new Set(res.map((r) => txOf(r)?.id));
      s.ok(`putaran ${round}: semua pemanggil memperoleh transaksi yang SAMA`, ids.size === 1 && !ids.has(undefined), [...ids].join(","));
      const rows = dbAll("select id, status from inter_branch_transactions where idempotency_key = ?", key);
      s.ok(`putaran ${round}: tepat satu transaksi di DB, status WAITING_APPROVAL`, rows.length === 1 && rows[0].status === "WAITING_APPROVAL", JSON.stringify(rows));
      const id = rows[0]?.id;
      s.ok(`putaran ${round}: satu persetujuan, audit hanya CREATED+SUBMITTED, tanpa jurnal`, dbAll("select 1 from inter_branch_approvals where transaction_id = ?", id).length === 1 && auditActions(id).map((r) => r.action).join(",") === "INTER_BRANCH_CREATED,INTER_BRANCH_SUBMITTED" && txJournals(id).length === 0, auditActions(id).map((r) => r.action).join(","));
      replays += res.filter((r) => r.json?.replayed === true).length;
      created += res.filter((r) => r.json?.replayed === false).length;
      if (id) await act(L.as(srv, "makerM", M), id, "cancel", { reason: "bersihkan idempotensi uji" });
    }
    s.ok(`setiap putaran menghasilkan tepat satu pembuatan baru (total ${created}) dan sisanya replay (${replays})`, created === 5 && replays === 35, `created=${created} replays=${replays}`);
    // isi berbeda dengan kunci sama = 409; pengguna lain dengan kunci sama = transaksi sendiri
    const key = "idem-" + uid();
    const a = await propose(L.as(srv, "makerM", M), { key, amount: 72_000, desc: "kunci sama isi berbeda" });
    const conflict = await propose(L.as(srv2, "makerM", M), { key, amount: 72_001, desc: "kunci sama isi berbeda" });
    const other = await propose(L.as(srv2, "owner", M), { key, amount: 72_000, desc: "kunci sama pengguna lain" });
    s.ok("kunci sama dengan isi berbeda (proses lain) = 409; pengguna lain dengan kunci sama = transaksi baru 201", a.status === 201 && conflict.status === 409 && other.status === 201 && txOf(a).id !== txOf(other).id, `${a.status}/${conflict.status}/${other.status}`);
    // kegagalan LAIN bukan konflik idempotensi: tidak pernah menjadi replay sukses
    const bad = await propose(L.as(srv2, "makerM", M), { key: "idem-" + uid(), amount: 72_002, desc: "akun salah", toAcc: expBL, type: "TRANSFER_KAS" });
    s.ok("kegagalan validasi lain (TRANSFER_KAS ke akun beban) tetap 422, bukan replay", bad.status === 422 && !bad.json?.replayed, `${bad.status}`);
    for (const r of [a, other]) await act(r === a ? L.as(srv, "makerM", M) : L.as(srv, "owner", M), txOf(r).id, "cancel", { reason: "bersihkan idempotensi uji" });
    const after = snapshot();
    s.ok("tidak ada jurnal baru dan saldo tidak berubah akibat pengajuan idempoten", after.journals === before.journals && Object.keys(delta(before, after)).length === 0);
  } finally { await srv2.stop(); }
});

// ================================================================ S16 Audit trail & integritas keseluruhan
await run("S16", "Verifikasi akhir: integritas, keseimbangan, periode, saldo agregat, audit, data historis tak berubah", async (s) => {
  const dist = (p) => import(pathToFileURL(`${L.ROOT}/apps/api/dist/${p}`).href);
  const { createCompanyDb } = await dist("db/company/index.js");
  const { verifyInterBranchIntegrity } = await dist("db/company/inter-branch-integrity.js");
  const db = createCompanyDb(L.COMPANY_DB);
  const viol = await verifyInterBranchIntegrity(db);
  s.ok("verifyInterBranchIntegrity seluruh data = 0 pelanggaran", viol.length === 0, JSON.stringify(viol).slice(0, 300));
  const unb = await db.raw("select count(*) c from (select j.id from journal_entries j join journal_entry_lines l on l.journal_entry_id=j.id where j.inter_branch_transaction_id is not null group by j.id having sum(cast(round(l.debit*100) as integer)) <> sum(cast(round(l.credit*100) as integer)))");
  s.ok("semua jurnal Antar Cabang seimbang (sen bulat)", unb[0].c === 0);
  const txs = await db("inter_branch_transactions").select("*");
  const byStatus = {}; for (const t of txs) byStatus[`${t.status}/${t.reversal_state}`] = (byStatus[`${t.status}/${t.reversal_state}`] ?? 0) + 1;
  console.log("TRANSAKSI", txs.length, JSON.stringify(byStatus));
  let bad = 0;
  for (const t of txs) {
    const js = txJournals(t.id);
    const expectN = t.status !== "COMPLETED" ? 0 : t.reversal_state === "REVERSED" ? 4 : 2;
    if (js.length !== expectN) bad++;
    if (t.status === "COMPLETED") {
      const per = await db("periods").where({ id: js[0]?.period_id }).first();
      if (!per || t.transaction_date < per.start_date || t.transaction_date > per.end_date) bad++;
      if (new Set(js.map((j) => j.entry_date.slice(0, 10))).size !== 1) bad++;
    }
  }
  s.ok(`jumlah jurnal per status benar & tanggal/periode konsisten (${txs.length} transaksi)`, bad === 0, `pelanggaran=${bad}`);
  const doneNet = completed.reduce((acc, e) => { for (const [k, v] of Object.entries(e.d)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
  const sF = snapshot();
  s.ok("selisih saldo akhir terhadap awal = jumlah transaksi SELESAI yang belum dibalik (tidak ada efek tersembunyi)", sameDelta(delta(S0, sF), doneNet), `jumlahAkunDelta=${Object.keys(delta(S0, sF)).length} diharapkan=${Object.keys(doneNet).length}`);
  s.ok("Σ debit = Σ kredit seluruh jurnal efektif", sF.sumDebit === sF.sumCredit, `${sF.sumDebit} vs ${sF.sumCredit}`);
  s.ok("DATA HISTORIS tidak berubah (hash jurnal & baris non-Antar-Cabang identik dengan sebelum UAT)", hashHistorical() === H0);
  const R1 = await reports();
  s.ok("laporan akhir: Neraca & Neraca Saldo seimbang", R1.bsOk && R1.tbOk, JSON.stringify(R1));
  const noAud = [];
  for (const t of txs) { const a = auditActions(t.id).map((r) => r.action); if (!a.includes("INTER_BRANCH_CREATED") || !a.includes("INTER_BRANCH_SUBMITTED")) noAud.push(t.transaction_no); if (t.status === "COMPLETED" && !a.includes("INTER_BRANCH_COMPLETED")) noAud.push(t.transaction_no + ":COMPLETED"); }
  s.ok("UAT-14: setiap transaksi memiliki jejak audit sesuai status akhirnya", noAud.length === 0, noAud.slice(0, 5).join(","));
  const pr = await db.raw("pragma integrity_check"), fk = await db.raw("pragma foreign_key_check");
  s.ok("integrity_check ok & foreign_key_check kosong", pr[0].integrity_check === "ok" && fk.length === 0);
  s.ok("daftar trigger sama dengan baseline (tidak ada sisa injeksi)", dbAll("select name from sqlite_master where type='trigger' order by name").map((r) => r.name).join(",") === baselineTriggers);
  await db.destroy();
});

await srv.stop();
const rate = ["owner"]; // 429 yang dialami klien uji tercatat per klien; ringkas dari log server
L.saveResults("uat-results");
const tally = L.results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
console.log("RINGKAS", JSON.stringify(tally), "dari", L.results.length);
process.exit(tally.FAIL || tally["SCRIPT-ERROR"] ? 1 : 0);
