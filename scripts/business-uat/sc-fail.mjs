// E: skenario gagal dan pemulihan: input tidak valid, hak tidak cukup, periode terkunci, akun terkunci, kegagalan posting terkontrol
// (tanpa jurnal parsial), dan pemulihan backup ke database uji terpisah.
import { run, Database, COMPANY_DB, dbAll, dbOne } from "./lib.mjs";
import { backupRestoreProof, realCheck } from "./sc-env.mjs";
import { verifyCompleted } from "./sc-ib.mjs";

export async function failScenarios(ctx) {
  const { hq, metro, bl } = ctx.B;
  const acc = ctx.acc;

  await run("E1", "Input tidak valid dan hak tidak cukup ditolak tanpa efek; periode dikunci dan akun terkunci menahan posting tanpa jurnal", async (c) => {
    const n0 = ctx.counts(), b0 = ctx.snap();
    const m = ctx.as("acctMetro", metro);
    const bad = [
      ["nominal 0", { to: bl, amount: 0 }], ["nominal negatif", { to: bl, amount: -5 }], ["nominal 3 desimal", { to: bl, amount: 10.123 }], ["tanpa keterangan", { to: bl, amount: 1000, desc: "" }],
      ["cabang asal = tujuan", { to: metro, amount: 1000 }], ["cabang tujuan tidak ada", { to: "00000000-0000-4000-8000-000000000000", amount: 1000 }], ["tanggal masa depan", { to: bl, amount: 1000, date: "2027-01-01" }],
      ["tanggal tidak valid", { to: bl, amount: 1000, date: "2026-02-30" }], ["periode belum ada", { to: bl, amount: 1000, date: "2030-01-15" }], ["TRANSFER_KAS ke akun non-kas", { to: bl, amount: 1000, toAcc: acc["6100"] }],
      ["PEMBEBANAN kas ke kas", { to: bl, amount: 1000, type: "PEMBEBANAN" }], ["akun asal tidak ada", { to: bl, amount: 1000, fromAcc: "tidak-ada" }], ["jenis tidak dikenal", { to: bl, amount: 1000, type: "PERSEDIAAN" }],
    ];
    for (const [label, o] of bad) { const r = await ctx.propose(m, o); c.ok(`ditolak: ${label}`, r.status >= 400 && r.status < 500, `${r.status} ${r.text.slice(0, 80)}`); }
    const ibAcc = ctx.ibAsset(bl);
    const r1 = await ctx.propose(m, { to: bl, amount: 1000, fromAcc: ibAcc.id, type: "PEMBEBANAN", toAcc: acc["6100"] });
    c.ok("ditolak: akun antar-cabang dipakai sebagai akun sendiri", r1.status >= 400 && r1.status < 500, `${r1.status}`);
    // hak
    c.ok("STAF tidak dapat menyetujui/menolak; VIEWER tidak dapat melihat atau mengajukan; pengguna luar ditolak; tanpa sesi 401", (await ctx.act(ctx.as("staffMetro", metro), "x", "approve")).status >= 400 && (await ctx.propose(ctx.as("viewer", hq), { to: metro, amount: 1000 })).status === 403 && (await ctx.as("viewer", hq).get(ctx.IB)).status === 403 && [403, 404].includes((await ctx.propose(ctx.as("outsider"), { to: metro, amount: 1000 })).status) && (await new (await import("./lib.mjs")).Client(ctx.srv.base, null).get(ctx.IB)).status === 401);
    c.ok("mengajukan dari cabang tanpa akses (header cabang Lampung oleh Akuntan Metro) ditolak 403", (await ctx.propose(ctx.as("acctMetro", bl), { to: metro, amount: 1000 })).status === 403);
    c.ok("semua penolakan tanpa efek: tidak ada transaksi/jurnal/audit tambahan dan saldo tidak berubah", ctx.counts().tx === n0.tx && ctx.counts().journals === n0.journals && Object.keys(ctx.delta(b0, ctx.snap())).length === 0, JSON.stringify([n0, ctx.counts()]));
    // periode dikunci setelah pengajuan; akun terkunci
    const ow = ctx.as("owner", hq), sep = ctx.periodId("2026-09");
    const t = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 16_000, date: "2026-09-20", desc: "Pengajuan tanggal September; periode dikunci sebelum persetujuan" }));
    const lk = await ow.post(`${ctx.A}/periods/${sep}/lock`, {});
    c.ok("(persiapan) OWNER mengunci periode September setelah pengajuan", lk.status === 200, `${lk.status} ${lk.text.slice(0, 100)}`);
    const nb = ctx.counts(), sb = ctx.snap();
    const ap = await ctx.act(ctx.as("acctBL", bl), t.id, "approve");
    c.ok("persetujuan setelah periode dikunci ditolak (4xx), 0 jurnal, status tetap WAITING, saldo tidak berubah", ap.status >= 400 && ap.status < 500 && ctx.txJournals(t.id).length === 0 && ctx.txRow(t.id).status === "WAITING_APPROVAL" && ctx.counts().journals === nb.journals && Object.keys(ctx.delta(sb, ctx.snap())).length === 0, `${ap.status} ${ap.text.slice(0, 110)}`);
    c.ok("penerima masih dapat menolak pengajuan yang tidak dapat diposting", (await ctx.act(ctx.as("acctBL", bl), t.id, "reject", { reason: "Periode September sudah dikunci" })).status === 200);
    const t2 = ctx.txOf(await ctx.propose(ctx.as("acctMetro", metro), { to: bl, amount: 33_000, toAcc: acc["6100"], type: "PEMBEBANAN", desc: "Akun tujuan akan dikunci" }));
    await ow.post(`${ctx.A}/accounts/${acc["6100"]}/lock`, {});
    const ap2 = await ctx.act(ctx.as("acctBL", bl), t2.id, "approve");
    c.ok("akun tujuan terkunci: persetujuan ditolak menyebut akun, 0 jurnal", ap2.status >= 400 && ap2.status < 500 && /terkunci|kunci/i.test(ap2.text) && ctx.txJournals(t2.id).length === 0, `${ap2.status} ${ap2.text.slice(0, 100)}`);
    await ow.post(`${ctx.A}/accounts/${acc["6100"]}/unlock`, {});
    await ctx.act(ctx.as("acctMetro", metro), t2.id, "cancel", { reason: "Pembersihan data uji akun terkunci" });
  });

  await run("E2", "Kegagalan posting terkontrol di 6 titik + pembalikan: tidak ada jurnal parsial, saldo/audit tak berubah, pulih lalu ulang berhasil", async (c) => {
    const maker = ctx.as("acctMetro", metro), appr = ctx.as("acctBL", bl);
    const points = [
      ["jurnal sisi FROM dibuat", "BEFORE INSERT ON journal_entries WHEN NEW.inter_branch_side='FROM'"],
      ["jurnal sisi TO dibuat (sisi FROM sudah tertulis)", "BEFORE INSERT ON journal_entries WHEN NEW.inter_branch_side='TO'"],
      ["baris jurnal sisi TO", "BEFORE INSERT ON journal_entry_lines WHEN (SELECT inter_branch_side FROM journal_entries WHERE id=NEW.journal_entry_id)='TO'"],
      ["posting jurnal sisi TO", "BEFORE UPDATE ON journal_entries WHEN NEW.inter_branch_side='TO' AND NEW.status='POSTED' AND OLD.status<>'POSTED'"],
      ["status transaksi menjadi COMPLETED", "BEFORE UPDATE ON inter_branch_transactions WHEN NEW.status='COMPLETED'"],
      ["audit COMPLETED (penulisan terakhir)", "BEFORE INSERT ON company_audit_log WHEN NEW.action='INTER_BRANCH_COMPLETED'"],
    ];
    const base = dbAll("select name from sqlite_master where type='trigger' order by name").map((r) => r.name).join(",");
    let n = 0;
    for (const [label, when] of points) {
      n++;
      const X = 91_000 + n * 1_111;
      const t = ctx.txOf(await ctx.propose(maker, { to: bl, amount: X, desc: `Injeksi kegagalan: ${label}` }));
      const before = ctx.snap(), cn = ctx.counts();
      const w = new Database(COMPANY_DB()); w.exec(`create trigger uat_biz_fail_${n} ${when} begin select raise(abort, 'UAT injeksi kegagalan'); end;`); w.close();
      const bad = await ctx.act(appr, t.id, "approve");
      const after = ctx.snap(), ca = ctx.counts();
      c.ok(`${label}: persetujuan gagal (bukan 2xx) tanpa membocorkan SQL/stack`, bad.status >= 400 && !/SQLITE|select |insert into|at \w+\./i.test(bad.text), `${bad.status} ${bad.text.slice(0, 80)}`);
      c.ok(`${label}: tidak ada jurnal setengah jadi; jurnal, audit, dan saldo semua sel tak berubah`, ca.journals === cn.journals && ca.audit === cn.audit && Object.keys(ctx.delta(before, after)).length === 0, `${cn.journals}->${ca.journals} audit ${cn.audit}->${ca.audit}`);
      c.ok(`${label}: transaksi tetap WAITING_APPROVAL dan persetujuan tetap WAITING`, ctx.txRow(t.id).status === "WAITING_APPROVAL" && dbOne("select status s from inter_branch_approvals where transaction_id=? and kind='POST'", t.id).s === "WAITING");
      const d = new Database(COMPANY_DB()); d.exec(`drop trigger uat_biz_fail_${n}`); d.close();
      const ok = await ctx.act(appr, t.id, "approve");
      const exp = verifyCompleted(ctx, c, `E2-${n}`, t, X, "1100", metro, "1100", bl, before, ctx.snap());
      c.ok(`${label}: setelah pulih, ulang berhasil dengan tepat 2 jurnal`, ok.status === 200 && ctx.txJournals(t.id).length === 2, `${ok.status}`);
      ctx.done.push({ id: t.id, X, exp, reversed: false });
    }
    // pembalikan: jurnal TO pembalik gagal
    const X = 333_000, t = ctx.txOf(await ctx.propose(maker, { to: bl, amount: X, desc: "Injeksi pembalikan" }));
    await ctx.act(appr, t.id, "approve");
    const e = ctx.expectedPosting(X, acc["1100"], metro, acc["1100"], bl);
    ctx.done.push({ id: t.id, X, exp: e, reversed: true });
    await ctx.act(maker, t.id, "reverse", { reason: "Uji injeksi kegagalan pembalikan" });
    const rid = dbOne("select id from inter_branch_approvals where transaction_id=? and kind='REVERSE' and status='WAITING'", t.id).id;
    const before = ctx.snap(), cn = ctx.counts();
    const w = new Database(COMPANY_DB()); w.exec("create trigger uat_biz_fail_r1 before insert on journal_entries when new.inter_branch_side='TO' and new.inter_branch_leg='REVERSAL' begin select raise(abort,'UAT injeksi'); end;"); w.close();
    const bad = await appr.post(`${ctx.IB}/${t.id}/reverse/${rid}/approve`, {});
    c.ok("pembalikan gagal di jurnal TO: tidak ada jurnal pembalik, saldo tak berubah, tetap REVERSAL_WAITING", bad.status >= 400 && ctx.counts().journals === cn.journals && Object.keys(ctx.delta(before, ctx.snap())).length === 0 && ctx.txRow(t.id).reversal_state === "REVERSAL_WAITING", `${bad.status}`);
    const d = new Database(COMPANY_DB()); d.exec("drop trigger uat_biz_fail_r1"); d.close();
    const ok = await appr.post(`${ctx.IB}/${t.id}/reverse/${rid}/approve`, {});
    c.ok("setelah pulih, pembalikan berhasil: 4 jurnal, dampak transaksi kembali nol", ok.status === 200 && ctx.txJournals(t.id).length === 4 && Object.keys(ctx.delta(before, ctx.snap())).length === 4, `${ok.status}`);
    c.ok("daftar trigger = baseline (tidak ada sisa injeksi)", dbAll("select name from sqlite_master where type='trigger' order by name").map((r) => r.name).join(",") === base);
  });

  await run("E3", "Backup resmi dan pemulihan ke database terpisah SESUDAH UAT: integritas dan angka penting identik; %APPDATA% utuh", async (c) => {
    await backupRestoreProof(ctx, "akhir", c);
    const r = realCheck();
    c.ok("%APPDATA%\\TERRA FINANCE tidak berubah selama seluruh UAT", r.before === r.after, `${r.before} -> ${r.after}`);
    c.ok("ATURAN BERHENTI: setiap respons gabungan/komparasi (semua skenario) memuat peringatan belum dieliminasi + bukan konsolidasi final", ctx.labelAudit.missing.length === 0 && ctx.labelAudit.combined > 0, `diperiksa ${ctx.labelAudit.combined}; hilang: ${ctx.labelAudit.missing.slice(0, 5).join(",")}`);
  });
}
