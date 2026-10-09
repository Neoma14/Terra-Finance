// Verifikasi akuntansi pasca-uji UI/Electron terhadap company.db hasil uji (salinan UAT; READ-ONLY).
// Pemakaian: node verify-accounting.mjs <folder-kerja> [slug]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORK = path.resolve(process.argv[2]);
const SLUG = process.argv[3] ?? "pt-terra-nusantara";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const imp = (p) => import(pathToFileURL(`${ROOT}/apps/api/dist/${p}`).href);
const { createCompanyDb } = await imp("db/company/index.js");
const { verifyInterBranchIntegrity } = await imp("db/company/inter-branch-integrity.js");
const { getTrialBalance } = await imp("db/company/trial-balance-service.js");

const db = createCompanyDb(`${WORK}/data/companies/${SLUG}/company.db`);
const out = [];
const ok = (name, pass, detail = "") => {
  out.push([pass ? "PASS" : "FAIL", name, detail]);
};

ok("verifyInterBranchIntegrity = tidak ada pelanggaran", (await verifyInterBranchIntegrity(db)).length === 0, JSON.stringify(await verifyInterBranchIntegrity(db)));

const txs = await db("inter_branch_transactions").orderBy("created_at");
const byStatus = Object.fromEntries((await db("inter_branch_transactions").groupBy("status", "reversal_state").select("status", "reversal_state", db.raw("count(*) c"))).map((r) => [`${r.status}/${r.reversal_state}`, r.c]));
console.log("transaksi Antar Cabang:", txs.length, JSON.stringify(byStatus));

// 1. Seluruh jurnal POSTED/REVERSED seimbang (sen bulat, per jurnal) -- khusus jurnal Antar Cabang dan keseluruhan
const unbalanced = async (extra) =>
  db.raw(
    `select count(*) c from (select j.id from journal_entries j join journal_entry_lines l on l.journal_entry_id=j.id where j.status in ('POSTED','REVERSED') ${extra} group by j.id having sum(cast(round(l.debit*100) as integer)) <> sum(cast(round(l.credit*100) as integer)))`,
  );
ok("jurnal Antar Cabang POSTED/REVERSED seimbang", (await unbalanced("and j.inter_branch_transaction_id is not null"))[0].c === 0);
ok("seluruh jurnal POSTED/REVERSED seimbang (jurnal DRAFT tidak ikut)", (await unbalanced(""))[0].c === 0);

// 2. Per transaksi: dua sisi konsisten, tanggal & periode valid, saldo bersih sesuai status
for (const t of txs) {
  const rows = await db("journal_entries as j")
    .join("journal_entry_lines as l", "l.journal_entry_id", "j.id")
    .join("accounts as a", "a.id", "l.account_id")
    .where("j.inter_branch_transaction_id", t.id)
    .select("j.inter_branch_leg as leg", "j.inter_branch_side as side", "j.branch_id", "j.entry_date", "j.status", "j.period_id", "a.branch_policy", "a.is_cash", "l.debit", "l.credit");
  const cents = (v) => Math.round(Number(v) * 100);
  const sumNet = (f) => rows.filter(f).reduce((s, r) => s + cents(r.debit) - cents(r.credit), 0);
  const amount = cents(t.amount);
  const reversed = t.reversal_state === "REVERSED";
  const completed = t.status === "COMPLETED";
  const fromCash = sumNet((r) => r.side === "FROM" && r.branch_policy !== "INTER_BRANCH");
  const toOwn = sumNet((r) => r.side === "TO" && r.branch_policy !== "INTER_BRANCH");
  const ibNet = sumNet((r) => r.branch_policy === "INTER_BRANCH");
  const ibFrom = sumNet((r) => r.branch_policy === "INTER_BRANCH" && r.side === "FROM");
  if (!completed) {
    ok(`${t.transaction_no} (${t.status}): tidak punya jurnal`, rows.length === 0);
    continue;
  }
  ok(`${t.transaction_no}: ${reversed ? "dibalik" : "selesai"} -- saldo akun sisi pemberi ${reversed ? "kembali 0" : `= -${amount / 100}`}, penerima ${reversed ? "kembali 0" : `= +${amount / 100}`}`, reversed ? fromCash === 0 && toOwn === 0 : fromCash === -amount && toOwn === amount, `from=${fromCash} to=${toOwn}`);
  ok(`${t.transaction_no}: akun antarkantor kedua sisi saling meniadakan (Σ = 0)${reversed ? "; sisi FROM kembali 0" : ""}`, ibNet === 0 && (reversed ? ibFrom === 0 : ibFrom === amount), `net=${ibNet} fromIB=${ibFrom}`);
  ok(`${t.transaction_no}: semua jurnal bertanggal ${t.transaction_date} dan di periode OPEN yang sama`, rows.every((r) => String(r.entry_date).slice(0, 10) === t.transaction_date && r.period_id === rows[0].period_id));
  ok(`${t.transaction_no}: jumlah jurnal ${reversed ? 4 : 2}`, new Set(rows.map((r) => `${r.leg}/${r.side}`)).size === (reversed ? 4 : 2));
}

// 3. Neraca saldo periode yang tersentuh tetap seimbang
const periods = await db("journal_entries").whereNotNull("inter_branch_transaction_id").distinct("period_id");
for (const p of periods) {
  const tb = await getTrialBalance(db, p.period_id);
  const label = (await db("periods").where({ id: p.period_id }).first()).label;
  ok(`Trial Balance periode ${label} seimbang`, tb.isBalanced === true, JSON.stringify({ diff: tb.difference }));
}

// 4. Kas per cabang yang berubah hanya sebesar transaksi bersih
const net = await db("journal_entries as j")
  .join("journal_entry_lines as l", "l.journal_entry_id", "j.id")
  .join("branches as b", "b.id", "j.branch_id")
  .whereNotNull("j.inter_branch_transaction_id")
  .join("accounts as a", "a.id", "l.account_id")
  .where("a.is_cash", 1)
  .groupBy("b.name")
  .select("b.name", db.raw("round(sum(l.debit) - sum(l.credit), 2) as net_cash"));
console.log("mutasi kas bersih akibat Antar Cabang per cabang:", JSON.stringify(net));

for (const [s, n, d] of out) console.log(s, n, d);
console.log(out.filter((r) => r[0] === "FAIL").length, "FAIL dari", out.length);
await db.destroy();
process.exit(out.some((r) => r[0] === "FAIL") ? 1 : 0);
