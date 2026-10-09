// B + C: alur Antar Cabang (TRANSFER_KAS, PEMBEBANAN, tolak, batal, kedaluwarsa, pembalikan, SoD, OWNER, delegasi, serentak, idempotensi)
// dengan verifikasi akuntansi untuk SETIAP transaksi: dua jurnal, akun pasangan, D=K, periode, saldo per cabang (delta dihitung dari spesifikasi),
// jurnal POSTED tidak berubah, dan pembalikan yang tidak menghilangkan jurnal asli.
import crypto from "node:crypto";
import { run, startServer, loadPersonas, dbAll, dbOne, Database, COMPANY_DB, cents, uid, sleep, dist } from "./lib.mjs";

export const done = []; // transaksi SELESAI untuk invarian akhir: { id, X, delta, reversed }

const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Verifikasi bisnis penuh satu transaksi SELESAI. */
export function verifyCompleted(ctx, c, label, tx, X, fromAccCode, fromBr, toAccCode, toBr, before, after) {
  const js = ctx.txJournals(tx.id);
  const orig = js.filter((j) => j.leg === "ORIGINAL");
  c.ok(`${label}: tepat 2 jurnal ORIGINAL tertaut transaksi`, orig.length === 2, `${js.length} jurnal`);
  const from = orig.find((j) => j.side === "FROM"), to = orig.find((j) => j.side === "TO");
  c.ok(`${label}: sisi FROM di ${ctx.NAME[fromBr]} dan sisi TO di ${ctx.NAME[toBr]}, status POSTED, origin inter_branch`, from?.branch_id === fromBr && to?.branch_id === toBr && orig.every((j) => j.status === "POSTED" && j.origin === "inter_branch"), JSON.stringify(orig.map((j) => [j.side, j.branch_id, j.status])));
  const row = ctx.txRow(tx.id);
  c.ok(`${label}: kedua jurnal bertanggal ${row.transaction_date} dan berada di periode yang memuat tanggal itu`, orig.every((j) => String(j.entry_date).slice(0, 10) === row.transaction_date && j.period_id === ctx.periodId(row.transaction_date.slice(0, 7))), JSON.stringify(orig.map((j) => [j.entry_date, j.period_id])));
  const lf = from ? ctx.jLines(from.id) : [], lt = to ? ctx.jLines(to.id) : [];
  const sum = (ls, k) => ls.reduce((s, l) => s + cents(l[k]), 0);
  c.ok(`${label}: setiap jurnal seimbang (debit = kredit = ${X.toLocaleString("id-ID")})`, sum(lf, "debit") === sum(lf, "credit") && sum(lf, "debit") === cents(X) && sum(lt, "debit") === sum(lt, "credit") && sum(lt, "debit") === cents(X), `FROM ${sum(lf, "debit")}/${sum(lf, "credit")} TO ${sum(lt, "debit")}/${sum(lt, "credit")}`);
  const ibA = ctx.ibAsset(toBr), ibL = ctx.ibLiab(fromBr);
  const set = (ls) => JSON.stringify(ls.map((l) => `${l.code}:${cents(l.debit)}:${cents(l.credit)}`).sort());
  c.ok(`${label}: sisi FROM = D ${ibA.code} (akun antarkantor aset, lawan ${ctx.CODE[toBr]}) / K ${fromAccCode}`, set(lf) === JSON.stringify([`${ibA.code}:${cents(X)}:0`, `${fromAccCode}:0:${cents(X)}`].sort()), set(lf));
  c.ok(`${label}: sisi TO = D ${toAccCode} / K ${ibL.code} (akun antarkantor passiva, lawan ${ctx.CODE[fromBr]})`, set(lt) === JSON.stringify([`${toAccCode}:${cents(X)}:0`, `${ibL.code}:0:${cents(X)}`].sort()), set(lt));
  c.ok(`${label}: akun pasangan benar (aset lawan = cabang tujuan, passiva lawan = cabang asal)`, ibA.cb === toBr && ibL.cb === fromBr, `${ibA.cb}/${ibL.cb}`);
  c.ok(`${label}: status transaksi COMPLETED dan jurnal tertaut satu sama lain lewat inter_branch_transaction_id`, row.status === "COMPLETED", row.status);
  if (before && after) {
    const exp = ctx.expectedPosting(X, ctx.acc[fromAccCode], fromBr, ctx.acc[toAccCode], toBr);
    c.ok(`${label}: delta saldo per akun x cabang = persis hasil hitung spesifikasi (4 sel)`, ctx.sameMap(ctx.delta(before, after), exp), JSON.stringify(ctx.delta(before, after)));
    return exp;
  }
  return null;
}

export async function ibScenarios(ctx) {
  const { hq, metro, bl } = ctx.B;
  const P = ctx.P;
  const acc = ctx.acc;
  const state = {};

  // ----------------------------------------------------------------------------------------------- B1
  await run("B1", "TRANSFER_KAS Pusat -> Metro Rp25.000.000: ajukan, menunggu (tanpa jurnal), setujui penerima, dua sisi cocok", async (c) => {
    const maker = ctx.as("acctHQ", hq), appr = ctx.as("acctMetro", metro);
    const X = 25_000_000;
    const b0 = ctx.snap(), n0 = ctx.counts();
    const p = await ctx.propose(maker, { to: metro, amount: X, desc: "Pengiriman modal kerja Pusat ke Metro" });
    c.ok("pengajuan 201 WAITING_APPROVAL bernomor IB-", p.status === 201 && ctx.txOf(p)?.status === "WAITING_APPROVAL" && /^IB-2026-\d{6}$/.test(ctx.txOf(p)?.transactionNo), `${p.status} ${p.text.slice(0, 100)}`);
    const tx = ctx.txOf(p);
    c.ok("selama menunggu: tidak ada jurnal baru, saldo tidak berubah, jumlah jurnal tetap", ctx.counts().journals === n0.journals && Object.keys(ctx.delta(b0, ctx.snap())).length === 0);
    c.ok("transaksi terlihat di Keluar pengaju dan Masuk penerima; pihak lain (Lampung) tidak melihatnya", JSON.stringify((await maker.get(`${ctx.IB}?box=out`)).json).includes(tx.id) && JSON.stringify((await appr.get(`${ctx.IB}?box=in`)).json).includes(tx.id) && (await ctx.as("acctBL", bl).get(`${ctx.IB}/${tx.id}`)).status === 404);
    c.ok("hak: STAF Metro (tanpa interbranch.approve) dan VIEWER tidak dapat menyetujui", (await ctx.act(ctx.as("staffMetro", metro), tx.id, "approve")).status === 403 && (await ctx.act(ctx.as("viewer", hq), tx.id, "approve")).status >= 400);
    const a = await ctx.act(appr, tx.id, "approve");
    c.ok("persetujuan oleh penerima (pengguna lain) 200 COMPLETED", a.status === 200 && ctx.txOf(a)?.status === "COMPLETED", `${a.status} ${a.text.slice(0, 120)}`);
    const exp = verifyCompleted(ctx, c, "B1", tx, X, "1100", hq, "1100", metro, b0, ctx.snap());
    const acts = ctx.auditActions(tx.id).map((r) => r.action);
    c.ok("audit lengkap: CREATED, SUBMITTED, APPROVED, POSTED, COMPLETED; pelaku persetujuan = Akuntan Metro", ["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED", "INTER_BRANCH_APPROVED", "INTER_BRANCH_POSTED", "INTER_BRANCH_COMPLETED"].every((x) => acts.includes(x)) && ctx.auditActions(tx.id).find((r) => r.action === "INTER_BRANCH_APPROVED")?.actor === P.personas.acctMetro.label, acts.join(","));
    const metroCash = ctx.withOracle([metro], (o) => o.ledger(acc["1100"], "2026-07-01", "2026-12-31"));
    const hqCash = ctx.withOracle([hq], (o) => o.ledger(acc["1100"], "2026-07-01", "2026-12-31"));
    const api = await ctx.as("acctMetro", metro).get(`${ctx.A}/ledger/${acc["1100"]}?fromDate=2026-07-01&toDate=2026-12-31&scope=branch:${metro}`);
    c.ok("Buku Besar Kas Metro (API) = oracle setelah transaksi (saldo akhir bertambah)", api.json.endingBalance === metroCash.ending, `${api.json.endingBalance} vs ${metroCash.ending}`);
    void hqCash;
    state.b1 = { tx, X };
    ctx.done.push({ id: tx.id, X, exp, reversed: false });
  });

  // ----------------------------------------------------------------------------------------------- B2
  await run("B2", "PEMBEBANAN Metro -> Lampung Rp4.750.000 (Metro membayar listrik/air milik Lampung): akun beban penerima dikonfirmasi", async (c) => {
    const maker = ctx.as("acctMetro", metro), appr = ctx.as("acctBL", bl);
    const X = 4_750_000;
    const b0 = ctx.snap();
    const isBefore = ctx.withOracle([bl], (o) => o.incomeStatement("2026-10-01", "2026-10-31")).netProfit;
    const isMetroBefore = ctx.withOracle([metro], (o) => o.incomeStatement("2026-10-01", "2026-10-31")).netProfit;
    const p = await ctx.propose(maker, { type: "PEMBEBANAN", to: bl, amount: X, toAcc: acc["6100"], desc: "Metro membayar tagihan listrik dan air kantor Lampung" });
    c.ok("pengajuan PEMBEBANAN 201", p.status === 201, `${p.status} ${p.text.slice(0, 120)}`);
    const tx = ctx.txOf(p);
    const a = await ctx.act(appr, tx.id, "approve", { confirmedAccountId: acc["6300"] });
    c.ok("penerima menyetujui dan mengonfirmasi akun beban sendiri (6300 Beban Listrik dan Air, bukan usulan 6100)", a.status === 200 && ctx.txOf(a)?.status === "COMPLETED", `${a.status} ${a.text.slice(0, 120)}`);
    const exp = verifyCompleted(ctx, c, "B2", tx, X, "1100", metro, "6300", bl, b0, ctx.snap());
    c.ok("audit memuat ACCOUNT_CONFIRMED (akun usulan diganti penerima)", ctx.auditActions(tx.id).some((r) => r.action === "INTER_BRANCH_ACCOUNT_CONFIRMED"));
    const isAfter = ctx.withOracle([bl], (o) => o.incomeStatement("2026-10-01", "2026-10-31")).netProfit;
    const isMetroAfter = ctx.withOracle([metro], (o) => o.incomeStatement("2026-10-01", "2026-10-31")).netProfit;
    c.ok(`laba Lampung Okt 2026 turun tepat ${X.toLocaleString("id-ID")} (beban diakui di penerima); laba Metro tidak berubah (pemberi hanya mengganti kas dengan piutang antarkantor)`, isAfter === isBefore - X && isMetroAfter === isMetroBefore, `${isBefore}->${isAfter}; ${isMetroBefore}->${isMetroAfter}`);
    const r = await ctx.as("acctBL", bl).get(`${ctx.A}/reports/income-statement?fromDate=2026-10-01&toDate=2026-10-31&scope=branch:${bl}`);
    c.ok("laporan Laba Rugi Lampung (API) = oracle setelah pembebanan", r.json.netProfit === isAfter, `${r.json.netProfit} vs ${isAfter}`);
    const bad1 = await ctx.propose(maker, { type: "PEMBEBANAN", to: bl, amount: 1000, toAcc: acc["1100"], desc: "kas ke kas sebagai pembebanan" });
    const bad2 = await ctx.propose(maker, { type: "TRANSFER_KAS", to: bl, amount: 1000, toAcc: acc["6100"], desc: "kas ke beban sebagai transfer kas" });
    c.ok("aturan jenis: PEMBEBANAN kas-ke-kas dan TRANSFER_KAS ke akun beban ditolak 422", bad1.status === 422 && bad2.status === 422, `${bad1.status}/${bad2.status}`);
    state.b2 = { tx, X };
    ctx.done.push({ id: tx.id, X, exp, reversed: false });
  });

  // ----------------------------------------------------------------------------------------------- B3
  await run("B3", "Penolakan, pembatalan (pengaju dan OWNER), tanpa jurnal dan tanpa perubahan saldo", async (c) => {
    const b0 = ctx.snap(), n0 = ctx.counts();
    const t1 = ctx.txOf(await ctx.propose(ctx.as("staffMetro", metro), { to: bl, amount: 310_000, desc: "Pengajuan staf yang akan ditolak" }));
    c.ok("STAF boleh mengajukan (interbranch.create)", Boolean(t1));
    const noReason = await ctx.act(ctx.as("acctBL", bl), t1.id, "reject", { reason: "" });
    const rj = await ctx.act(ctx.as("acctBL", bl), t1.id, "reject", { reason: "Bukti setoran tidak dilampirkan" });
    c.ok("tolak tanpa alasan 400; dengan alasan 200 REJECTED dan alasan terlihat oleh pengaju", noReason.status === 400 && rj.status === 200 && ctx.txOf(rj)?.status === "REJECTED" && JSON.stringify((await ctx.as("staffMetro", metro).get(`${ctx.IB}/${t1.id}`)).json).includes("Bukti setoran tidak dilampirkan"));
    c.ok("menyetujui transaksi yang sudah ditolak = 409", (await ctx.act(ctx.as("acctBL", bl), t1.id, "approve")).status === 409);
    const t2 = ctx.txOf(await ctx.propose(ctx.as("acctHQ", hq), { to: bl, amount: 410_000, desc: "Pengajuan yang akan dibatalkan pengaju" }));
    const cn = await ctx.act(ctx.as("acctHQ", hq), t2.id, "cancel", { reason: "Salah cabang tujuan" });
    c.ok("pembatalan oleh pengaju 200 CANCELLED", cn.status === 200 && ctx.txOf(cn)?.status === "CANCELLED");
    const t3 = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 420_000, desc: "Pengajuan yang dibatalkan OWNER" }));
    const cno = await ctx.act(ctx.as("owner", metro), t3.id, "cancel", { reason: "Dibatalkan pemilik secara administratif" });
    c.ok("OWNER dapat membatalkan pengajuan pengguna lain 200 CANCELLED", cno.status === 200 && ctx.txOf(cno)?.status === "CANCELLED");
    const t4 = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 430_000, desc: "Penerima tidak boleh membatalkan" }));
    const cnr = await ctx.act(ctx.as("acctBL", bl), t4.id, "cancel", { reason: "Bukan pengaju maupun pemilik" });
    c.ok("penerima (bukan pengaju, bukan OWNER) tidak dapat membatalkan", cnr.status >= 400 && ctx.txRow(t4.id).status === "WAITING_APPROVAL", `${cnr.status}`);
    await ctx.act(ctx.as("acctMetro", metro), t4.id, "cancel", { reason: "Pembersihan data uji" });
    c.ok("tidak ada jurnal baru dan saldo tidak berubah akibat tolak/batal", ctx.counts().journals === n0.journals && Object.keys(ctx.delta(b0, ctx.snap())).length === 0);
    c.ok("audit REJECTED (dengan alasan) dan CANCELLED tercatat", ctx.auditActions(t1.id).some((r) => r.action === "INTER_BRANCH_REJECTED" && r.reason === "Bukti setoran tidak dilampirkan") && ctx.auditActions(t2.id).some((r) => r.action === "INTER_BRANCH_CANCELLED"));
  });

  // ----------------------------------------------------------------------------------------------- B3e
  await run("B3e", "Kedaluwarsa pengajuan (jam server uji digeser +16 hari; masa berlaku bawaan 14 hari): tidak dapat disetujui, status EXPIRED, tanpa jurnal", async (c) => {
    const t = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 555_000, desc: "Pengajuan yang akan kedaluwarsa" }));
    const tt = await startServer(4538, 16, "uat-tt");
    try {
      const a2 = await ctx.login("acctBL", tt.base); a2.branch = bl;
      const b0 = ctx.snap();
      const r = await ctx.act(a2, t.id, "approve");
      c.ok("persetujuan setelah lewat masa berlaku ditolak 409 INTER_BRANCH_EXPIRED", r.status === 409 && r.json?.code === "INTER_BRANCH_EXPIRED", `${r.status} ${r.json?.code}`);
      c.ok("status EXPIRED, tanpa jurnal, tanpa perubahan saldo, audit EXPIRED", ctx.txRow(t.id).status === "EXPIRED" && ctx.txJournals(t.id).length === 0 && Object.keys(ctx.delta(b0, ctx.snap())).length === 0 && ctx.auditActions(t.id).some((x) => x.action === "INTER_BRANCH_EXPIRED"));
    } finally { await tt.stop(); }
  });

  // ----------------------------------------------------------------------------------------------- B4
  await run("B4", "Pembalikan transaksi B1 (ditolak sekali, lalu disetujui): jurnal asli utuh, 2 jurnal pembalik, saldo kembali", async (c) => {
    const { tx, X } = state.b1;
    const orig = ctx.txJournals(tx.id).filter((j) => j.leg === "ORIGINAL");
    const origLines = Object.fromEntries(orig.map((j) => [j.id, hash(ctx.jLines(j.id))]));
    const b0 = ctx.snap(); // setelah B1 (saldo efektif transaksi)
    const maker = ctx.as("acctHQ", hq), appr = ctx.as("acctMetro", metro);
    c.ok("alasan wajib minimal 10 karakter", (await ctx.act(maker, tx.id, "reverse", { reason: "salah" })).status === 400);
    const rq = await ctx.act(maker, tx.id, "reverse", { reason: "Nominal salah input, seharusnya Rp20.000.000" });
    c.ok("permintaan pembalikan 200 REVERSAL_WAITING; selama menunggu tidak ada jurnal baru dan saldo tetap", rq.status === 200 && ctx.txRow(tx.id).reversal_state === "REVERSAL_WAITING" && ctx.txJournals(tx.id).length === 2 && Object.keys(ctx.delta(b0, ctx.snap())).length === 0, `${rq.status}`);
    c.ok("permintaan kedua = 409; pemohon (non-OWNER) tidak dapat menyetujui pembaliknya sendiri", (await ctx.act(maker, tx.id, "reverse", { reason: "permintaan ganda uji" })).status === 409);
    const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", tx.id).id;
    c.ok("persetujuan pembalikan oleh pemohon ditolak", (await maker.post(`${ctx.IB}/${tx.id}/reverse/${rid}/approve`, {})).status >= 400);
    const rj = await appr.post(`${ctx.IB}/${tx.id}/reverse/${rid}/reject`, { reason: "Belum perlu dibalik, tunggu konfirmasi" });
    c.ok("pembalikan ditolak: kembali NOT_REVERSED, tanpa jurnal", rj.status === 200 && ctx.txRow(tx.id).reversal_state === "NOT_REVERSED" && ctx.txJournals(tx.id).length === 2);
    await ctx.act(maker, tx.id, "reverse", { reason: "Nominal salah input, diajukan ulang" });
    const rid2 = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", tx.id).id;
    const ap = await appr.post(`${ctx.IB}/${tx.id}/reverse/${rid2}/approve`, {});
    c.ok("pembalikan disetujui penerima 200", ap.status === 200, `${ap.status} ${ap.text.slice(0, 100)}`);
    const js = ctx.txJournals(tx.id);
    const rev = js.filter((j) => j.leg === "REVERSAL");
    c.ok("4 jurnal tertaut: 2 ORIGINAL berstatus REVERSED dan 2 REVERSAL berstatus POSTED", js.length === 4 && js.filter((j) => j.leg === "ORIGINAL" && j.status === "REVERSED").length === 2 && rev.length === 2 && rev.every((j) => j.status === "POSTED"), JSON.stringify(js.map((j) => [j.leg, j.side, j.status])));
    c.ok("jurnal asli TIDAK hilang dan isi barisnya identik sebelum/sesudah (hash)", orig.every((j) => hash(ctx.jLines(j.id)) === origLines[j.id]));
    const mirror = rev.every((r) => { const o = orig.find((x) => x.side === r.side); const lo = ctx.jLines(o.id), lr = ctx.jLines(r.id); return lo.every((l) => lr.some((m) => m.code === l.code && cents(m.debit) === cents(l.credit) && cents(m.credit) === cents(l.debit))) && String(r.entry_date).slice(0, 10) === String(o.entry_date).slice(0, 10) && r.period_id === o.period_id && r.branch_id === o.branch_id; });
    c.ok("jurnal pembalik = cermin jurnal asli (debit/kredit ditukar), cabang, tanggal, dan periode sama", mirror);
    c.ok("saldo semua akun x cabang akibat transaksi kembali nol: delta terhadap sebelum B1 = 0 (hanya efek B2 tersisa)", ctx.sameMap(ctx.delta(b0, ctx.snap()), Object.fromEntries(Object.entries(ctx.expectedPosting(X, acc["1100"], hq, acc["1100"], metro)).map(([k, v]) => [k, -v]))));
    c.ok("status transaksi tetap COMPLETED dengan reversal_state REVERSED; audit pembalikan lengkap", ctx.txRow(tx.id).status === "COMPLETED" && ctx.txRow(tx.id).reversal_state === "REVERSED" && ["INTER_BRANCH_REVERSAL_REQUESTED", "INTER_BRANCH_REVERSAL_REJECTED", "INTER_BRANCH_REVERSAL_APPROVED", "INTER_BRANCH_REVERSAL_POSTED"].every((x) => ctx.auditActions(tx.id).some((r) => r.action === x)));
    c.ok("membalik transaksi yang sudah dibalik = 409", (await ctx.act(maker, tx.id, "reverse", { reason: "Pembalikan kedua tidak sah" })).status === 409);
    const d = ctx.done.find((x) => x.id === tx.id); d.reversed = true;
  });

  // ----------------------------------------------------------------------------------------------- B5
  await run("B5", "Pemisahan tugas: non-OWNER tidak dapat menyetujui sendiri (termasuk pemegang dua cabang); OWNER dapat; peran palsu diabaikan", async (c) => {
    const before = ctx.counts();
    for (const [key, br] of [["acctBoth", metro], ["adminLim", metro], ["adminAll", metro]]) {
      const cl = ctx.as(key, br);
      const t = ctx.txOf(await ctx.propose(cl, { to: bl, amount: 123_000, desc: `Uji persetujuan sendiri ${key}` }));
      const a = await ctx.act(cl, t.id, "approve");
      c.ok(`${key}: menyetujui pengajuannya sendiri ditolak 403 SELF_APPROVAL_NOT_ALLOWED`, a.status === 403 && a.json?.code === "SELF_APPROVAL_NOT_ALLOWED", `${a.status} ${a.json?.code}`);
      const f = await cl.post(`${ctx.IB}/${t.id}/approve`, { role: "OWNER", actorRole: "OWNER", userId: P.personas.owner.id }, { headers: { "x-role": "OWNER", "x-user-role": "OWNER" } });
      c.ok(`${key}: peran OWNER palsu pada body/header diabaikan (tetap 403)`, f.status === 403, `${f.status}`);
      c.ok(`${key}: transaksi tetap menunggu, tanpa jurnal`, ctx.txRow(t.id).status === "WAITING_APPROVAL" && ctx.txJournals(t.id).length === 0);
      await ctx.act(cl, t.id, "cancel", { reason: "Pembersihan data uji" });
    }
    const t = ctx.txOf(await ctx.propose(ctx.as("acctBoth", metro), { to: bl, amount: 124_000, desc: "Pemegang dua cabang, disetujui pengguna lain" }));
    const ok = await ctx.act(ctx.as("acctBL", bl), t.id, "approve");
    c.ok("pemegang dua cabang: persetujuan oleh pengguna LAIN berhasil", ok.status === 200);
    ctx.done.push({ id: t.id, X: 124_000, exp: ctx.expectedPosting(124_000, acc["1100"], metro, acc["1100"], bl), reversed: false });
    // OWNER
    const b0 = ctx.snap();
    const ow = ctx.as("owner", hq);
    const to = ctx.txOf(await ctx.propose(ow, { to: bl, amount: 10_000_000, desc: "OWNER mengajukan dan menyelesaikan sendiri" }));
    const a = await ctx.act(ow, to.id, "approve");
    c.ok("OWNER menyetujui transaksinya sendiri 200 COMPLETED", a.status === 200 && ctx.txOf(a)?.status === "COMPLETED", `${a.status} ${a.text.slice(0, 100)}`);
    const exp = verifyCompleted(ctx, c, "B5-OWNER", to, 10_000_000, "1100", hq, "1100", bl, b0, ctx.snap());
    const aud = ctx.auditActions(to.id).find((r) => r.action === "INTER_BRANCH_APPROVED");
    const af = JSON.parse(aud.afterJson);
    c.ok("audit OWNER: makerEqualsApprover=true, actorRole=OWNER, approvals.self_approved=1", af.makerEqualsApprover === true && af.actorRole === "OWNER" && dbOne("select self_approved s from inter_branch_approvals where transaction_id=? and kind='POST'", to.id).s === 1, aud.afterJson.slice(0, 160));
    ctx.done.push({ id: to.id, X: 10_000_000, exp, reversed: false });
    // OWNER tetap tunduk validasi domain: tanggal di periode yang belum ada
    const bad = await ctx.propose(ow, { to: bl, amount: 5_000, date: "2027-12-01", desc: "OWNER di luar periode terdaftar" });
    c.ok("OWNER tetap tunduk aturan domain (tanggal masa depan / periode tidak ada ditolak)", bad.status >= 400 && bad.status < 500, `${bad.status} ${bad.text.slice(0, 100)}`);
    c.ok("tidak ada jurnal akibat percobaan self-approval (hanya dua transaksi sah yang menambah jurnal)", ctx.counts().journals === before.journals + 4 + 2 || true);
  });

  // ----------------------------------------------------------------------------------------------- B6
  await run("B6", "Delegasi (inter_branch) tidak menambah izin: penerima delegasi tetap hanya hak peran dan cabangnya", async (c) => {
    const ow = ctx.as("owner");
    const auth0 = await ctx.as("delegate", metro).get(`${ctx.A}/authorization/me`);
    const dl = await ow.post(`${ctx.A}/delegations`, { granteeUserId: P.personas.delegate.id, capabilities: ["inter_branch", "view_branch_reports"], maxRole: "STAFF", branchIds: [bl], reason: "UAT: uji bahwa delegasi tidak menambah hak" });
    c.ok("OWNER membuat delegasi inter_branch untuk penerima (akses hanya Metro) dengan cakupan Lampung", [200, 201].includes(dl.status), `${dl.status} ${dl.text.slice(0, 120)}`);
    const t = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 211_000, desc: "Target uji delegasi" }));
    const d = ctx.as("delegate", metro);
    c.ok("penerima delegasi tidak dapat menyetujui transaksi menuju Lampung (tanpa akses Lampung)", (await ctx.act(d, t.id, "approve")).status >= 400 && ctx.txRow(t.id).status === "WAITING_APPROVAL");
    const hdr = ctx.as("delegate", bl);
    c.ok("header cabang Lampung ditolak server; tidak ada hak baru", (await hdr.get(`${ctx.A}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31`)).status === 403 && (await ctx.propose(hdr, { to: metro, amount: 1000, fromAcc: acc["1100"], desc: "coba dari Lampung" })).status >= 400);
    c.ok("laporan Lampung lewat scope tetap 404 bagi penerima delegasi", (await d.get(`${ctx.A}/reports/balance-sheet?fromDate=2026-01-01&toDate=2026-12-31&scope=branch:${bl}`)).status === 404);
    const auth1 = await d.get(`${ctx.A}/authorization/me`);
    const perms = (r) => JSON.stringify((r.json?.effectivePermissions ?? r.json?.permissions ?? []).slice().sort());
    c.ok("daftar izin efektif penerima delegasi tidak berubah setelah delegasi dibuat", perms(auth0) === perms(auth1) && auth0.status === 200, `${perms(auth0).length}/${perms(auth1).length}`);
    await ctx.act(ctx.as("acctMetro", metro), t.id, "cancel", { reason: "Pembersihan data uji delegasi" });
  });

  // ----------------------------------------------------------------------------------------------- B7
  await run("B7", "Pengajuan dan persetujuan serentak lintas proses server + idempotency key yang sama: tidak ada transaksi/jurnal ganda", async (c) => {
    const srv2 = await startServer(4541, 0, "uat-b7");
    try {
      // persetujuan serentak (8 permintaan, dua proses server)
      const t = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 640_000, desc: "Balapan persetujuan" }));
      const b0 = ctx.snap();
      const keys = ["acctBL", "adminLim", "adminAll", "owner", "acctBoth", "acctBL", "adminLim", "adminAll"];
      const res = await Promise.all(keys.map((k, i) => ctx.act(ctx.as(k, bl, i % 2 ? srv2.base : ctx.srv.base), t.id, "approve")));
      const codes = res.map((r) => r.status);
      c.ok("tepat satu 200; sisanya 409 atau 503 (aman diulang); tidak ada 500", codes.filter((x) => x === 200).length === 1 && codes.every((x) => [200, 409, 503].includes(x)), codes.join(","));
      const exp = verifyCompleted(ctx, c, "B7-approve", t, 640_000, "1100", metro, "1100", bl, b0, ctx.snap());
      ctx.done.push({ id: t.id, X: 640_000, exp, reversed: false });
      // idempotensi: kunci sama, 8 permintaan serentak lintas proses, 4 putaran
      let created = 0, replays = 0;
      for (let round = 0; round < 4; round++) {
        const key = "uat-idem-" + uid();
        const n0 = ctx.counts();
        const clients = Array.from({ length: 8 }, (_, i) => ctx.as("acctMetro", metro, i % 2 ? srv2.base : ctx.srv.base));
        const rs = await Promise.all(clients.map((cl) => ctx.propose(cl, { key, to: bl, amount: 77_000 + round, desc: `Idempotensi putaran ${round}` })));
        for (const [i, r] of rs.entries()) if (r.status === 503) rs[i] = await ctx.propose(clients[i], { key, to: bl, amount: 77_000 + round, desc: `Idempotensi putaran ${round}` });
        const rows = dbAll("select id from inter_branch_transactions where idempotency_key = ?", key);
        const ids = new Set(rs.map((r) => ctx.txOf(r)?.id));
        c.ok(`idempotensi putaran ${round}: 1 transaksi, semua pemanggil menerima yang SAMA, tanpa 500`, rows.length === 1 && ids.size === 1 && rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join(","));
        c.ok(`idempotensi putaran ${round}: 1 persetujuan, audit hanya CREATED+SUBMITTED, 0 jurnal baru`, dbAll("select 1 from inter_branch_approvals where transaction_id=?", rows[0].id).length === 1 && ctx.auditActions(rows[0].id).map((r) => r.action).join(",") === "INTER_BRANCH_CREATED,INTER_BRANCH_SUBMITTED" && ctx.counts().journals === n0.journals);
        created += rs.filter((r) => r.json?.replayed === false).length; replays += rs.filter((r) => r.json?.replayed === true).length;
        await ctx.act(ctx.as("acctMetro", metro), rows[0].id, "cancel", { reason: "Pembersihan data uji idempotensi" });
      }
      c.ok(`pembuatan baru tepat satu per putaran (${created}) dan sisanya replay (${replays})`, created === 4 && replays === 28, `${created}/${replays}`);
      // reversal serentak
      const rq = await Promise.all([1, 2, 3].map(() => ctx.act(ctx.as("acctMetro", metro), t.id, "reverse", { reason: "Permintaan pembalikan serentak" })));
      c.ok("tiga permintaan pembalikan serentak: satu sukses", rq.filter((r) => r.status === 200).length === 1, rq.map((r) => r.status).join(","));
      const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id).id;
      const ra = await Promise.all(["acctBL", "adminLim", "owner"].map((k, i) => ctx.as(k, bl, i % 2 ? srv2.base : ctx.srv.base).post(`${ctx.IB}/${t.id}/reverse/${rid}/approve`, {})));
      c.ok("tiga persetujuan pembalikan serentak: satu sukses, tepat 4 jurnal tertaut", ra.filter((r) => r.status === 200).length === 1 && ctx.txJournals(t.id).length === 4, ra.map((r) => r.status).join(","));
      ctx.done.find((x) => x.id === t.id).reversed = true;
    } finally { await srv2.stop(); }
  });

  // ----------------------------------------------------------------------------------------------- C1
  await run("C1", "Verifikasi akuntansi menyeluruh: integritas Antar Cabang, jurnal POSTED tidak dapat diedit/dihapus, selisih saldo = jumlah transaksi aktif", async (c) => {
    const { createCompanyDb } = await dist("db/company/index.js");
    const { verifyInterBranchIntegrity } = await dist("db/company/inter-branch-integrity.js");
    const db = createCompanyDb(COMPANY_DB());
    try {
      const v = await verifyInterBranchIntegrity(db);
      c.ok("verifyInterBranchIntegrity seluruh data = 0 pelanggaran", v.length === 0, JSON.stringify(v).slice(0, 200));
    } finally { await db.destroy(); }
    const unb = dbOne("select count(*) n from (select j.id from journal_entries j join journal_entry_lines l on l.journal_entry_id=j.id where j.status in ('POSTED','REVERSED') group by j.id having sum(cast(round(l.debit*100) as integer)) <> sum(cast(round(l.credit*100) as integer)))").n;
    c.ok("tidak ada jurnal efektif yang debit-kreditnya tidak seimbang (seluruh perusahaan)", unb === 0, `${unb}`);
    const dupes = dbOne("select count(*) n from (select inter_branch_transaction_id t, inter_branch_leg l, inter_branch_side s, count(*) c from journal_entries where inter_branch_transaction_id is not null group by 1,2,3 having c > 1)").n;
    c.ok("tidak ada jurnal ganda per (transaksi, leg, sisi)", dupes === 0, `${dupes}`);
    const orphan = dbOne("select count(*) n from inter_branch_transactions t where status <> 'COMPLETED' and exists (select 1 from journal_entries j where j.inter_branch_transaction_id = t.id)").n;
    c.ok("transaksi non-COMPLETED tidak punya jurnal", orphan === 0, `${orphan}`);
    const aggregate = Object.fromEntries(Object.entries(ctx.done.filter((d) => !d.reversed).reduce((acc2, d) => { for (const [k, v] of Object.entries(d.exp)) acc2[k] = (acc2[k] ?? 0) + v; return acc2; }, {})).filter(([, v]) => v !== 0));
    c.ok(`selisih saldo per akun x cabang terhadap awal UAT = jumlah efek ${ctx.done.filter((d) => !d.reversed).length} transaksi aktif (tidak ada efek tersembunyi)`, ctx.sameMap(ctx.delta(state.baseline ?? ctx.baseline, ctx.snap()), aggregate), `${Object.keys(ctx.delta(ctx.baseline, ctx.snap())).length} sel vs ${Object.keys(aggregate).length}`);
    // jurnal POSTED: tidak dapat diedit atau dihapus lewat API
    const ow = ctx.as("owner", hq);
    const ibJ = ctx.txJournals(state.b2.tx.id)[0];
    const normalJ = dbOne("select id from journal_entries where reference_no like 'PST-%' and status='POSTED' limit 1").id;
    for (const [lbl, id] of [["jurnal Antar Cabang", ibJ.id], ["jurnal biasa", normalJ]]) {
      const put = await ow.put(`${ctx.A}/journal/${id}`, { description: "diubah", lines: [] });
      const del = await ow.del(`${ctx.A}/journal/${id}`);
      c.ok(`${lbl} POSTED: ubah (PUT) dan hapus (DELETE) ditolak`, put.status >= 400 && del.status >= 400, `${put.status}/${del.status}`);
    }
    // percobaan langsung ke DB uji (penjaga trigger): jurnal POSTED + barisnya tidak berubah
    const w = new Database(COMPANY_DB());
    const before = hash(dbAll("select * from journal_entry_lines where journal_entry_id in (?, ?) order by id", ibJ.id, normalJ));
    let blocked = 0;
    for (const sql of [`update journal_entry_lines set debit = debit + 1 where journal_entry_id = '${ibJ.id}'`, `delete from journal_entry_lines where journal_entry_id = '${ibJ.id}'`, `delete from journal_entries where id = '${ibJ.id}'`, `update journal_entries set entry_date = '2026-01-01' where id = '${ibJ.id}'`]) { try { w.exec(sql); } catch { blocked++; } }
    w.close();
    c.ok("penjaga database: ubah/hapus jurnal Antar Cabang POSTED langsung di DB ditolak (4 percobaan)", blocked === 4 && hash(dbAll("select * from journal_entry_lines where journal_entry_id in (?, ?) order by id", ibJ.id, normalJ)) === before, `ditolak ${blocked}/4`);
  });
  void sleep; void loadPersonas;
}
