// Konteks bersama skenario UAT bisnis: server uji, persona, akun, cabang, oracle independen, dan pembantu verifikasi akuntansi.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, DATA, SLUG, SLUG_OFF, COMPANY_DB, PORT, Client, startServer, loadPersonas, dbAll, dbOne, ro, cents, uid, sleep, netByAccountBranch } from "./lib.mjs";

export async function makeCtx() {
  const P = loadPersonas();
  const srv = await startServer(PORT, 0, "uat");
  const { Oracle } = await import(pathToFileURL(`${ROOT}/docs/uat/harness/phase5/oracle.mjs`).href);
  const A = `/api/company-db/${SLUG}`;
  const AOFF = `/api/company-db/${SLUG_OFF}`;
  const IB = `${A}/inter-branch`;
  const B = { hq: P.hq, metro: P.metro, bl: P.bl };
  const CODE = { [P.hq]: "PUSAT", [P.metro]: "MTR", [P.bl]: "BDL" };
  const NAME = { [P.hq]: "Kantor Pusat", [P.metro]: "Cabang Metro", [P.bl]: "Cabang Bandar Lampung" };
  const acc = P.accounts; // kode -> id (perusahaan 1)
  const accRows = () => dbAll("select id, code, name, is_cash isCash, branch_policy bp, counterpart_branch_id cb from accounts");
  const ibAsset = (toBranch) => accRows().find((a) => a.bp === "INTER_BRANCH" && a.code === `IBA-${CODE[toBranch]}`);
  const ibLiab = (fromBranch) => accRows().find((a) => a.bp === "INTER_BRANCH" && a.code === `IBP-${CODE[fromBranch]}`);
  const as = (key, branch = null, base = srv.base) => { const c = new Client(base, P.personas[key].token, key); c.branch = branch; return c; };
  const login = async (key, base = srv.base) => { const c = new Client(base, null, key); const r = await c.post("/api/auth/login", { email: P.personas[key].email, password: P.personas[key].password }); if (r.status !== 200) throw new Error(`login ${key}: ${r.status}`); return c; };
  const today = new Date().toISOString().slice(0, 10);
  const periodId = (ym) => dbOne("select id from periods where start_date = ?", `${ym}-01`).id;
  const OKT = periodId("2026-10");
  const oracle = (branchIds = null, file = COMPANY_DB(SLUG)) => { const d = ro(file); return { o: new Oracle(d, branchIds), close: () => d.close() }; };
  const withOracle = (branchIds, fn, file) => { const { o, close } = oracle(branchIds, file); try { return fn(o); } finally { close(); } };

  const propose = (c, o = {}) => c.post(IB, {
    type: o.type ?? "TRANSFER_KAS", toBranchId: o.to, transactionDate: o.date ?? today, amount: o.amount, fromAccountId: o.fromAcc ?? acc["1100"], toAccountSuggestedId: o.toAcc ?? acc["1100"],
    description: o.desc ?? "Transaksi uji bisnis", idempotencyKey: o.key ?? uid(), ...(o.extra ?? {}),
  });
  const act = (c, id, action, body = {}) => c.post(`${IB}/${id}/${action}`, body);
  const txOf = (r) => r.json?.transaction;
  const txRow = (id) => dbOne("select * from inter_branch_transactions where id = ?", id);
  const txJournals = (id) => dbAll(`select j.id, j.reference_no ref, j.status, j.branch_id, j.entry_date, j.period_id, j.inter_branch_leg leg, j.inter_branch_side side, j.origin, j.is_reversed rev, j.reversal_of_journal_id revOf from journal_entries j where j.inter_branch_transaction_id = ? order by j.created_at, j.reference_no`, id);
  const jLines = (jid) => dbAll("select a.code, l.debit, l.credit from journal_entry_lines l join accounts a on a.id = l.account_id where l.journal_entry_id = ? order by l.line_order", jid);
  const auditActions = (id) => dbAll("select action, actor_label actor, reason, after_json afterJson from company_audit_log where entity_id = ? order by created_at, rowid", id);
  const snap = () => netByAccountBranch();
  const delta = (a, b) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d !== 0) o[k] = d; } return o; };
  const sameMap = (a, b) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).filter((k) => b[k] !== 0).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]); };
  /** Delta saldo yang HARUS terjadi dari satu transaksi selesai (dari spesifikasi akuntansi, bukan dari kode): sisi FROM D antarkantor aset(lawan=TO)/K akun asal; sisi TO D akun tujuan/K antarkantor passiva(lawan=FROM). */
  const expectedPosting = (X, fromAccId, fromBr, toAccId, toBr) => ({
    [`${fromAccId}|${fromBr}`]: -cents(X), [`${ibAsset(toBr).id}|${fromBr}`]: cents(X), [`${toAccId}|${toBr}`]: cents(X), [`${ibLiab(fromBr).id}|${toBr}`]: -cents(X),
  });
  const counts = () => ({
    journals: dbOne("select count(*) n from journal_entries").n, effective: dbOne("select count(*) n from journal_entries where status in ('POSTED','REVERSED')").n,
    audit: dbOne("select count(*) n from company_audit_log").n, tx: dbOne("select count(*) n from inter_branch_transactions").n,
  });
  /** ATURAN BERHENTI: setiap respons gabungan/komparasi WAJIB menyatakan belum dieliminasi dan bukan konsolidasi final; dihitung global. */
  const labelAudit = { combined: 0, missing: [] };
  const checkCombinedLabel = (where, json) => {
    const sc = json?.scope;
    if (!sc || !["COMBINED_SELECTED", "COMBINED_ALL", "COMPARISON"].includes(sc.mode)) return true;
    labelAudit.combined++;
    const text = `${sc.label?.title} ${sc.label?.warnings?.join(" ")}`;
    const ok = sc.eliminationStatus === "NOT_ELIMINATED" && /belum dieliminasi/i.test(text) && /bukan laporan konsolidasi/i.test(text);
    if (!ok) labelAudit.missing.push(where);
    return ok;
  };
  return { P, srv, A, AOFF, IB, B, CODE, NAME, acc, accRows, ibAsset, ibLiab, as, login, today, periodId, OKT, oracle, withOracle, propose, act, txOf, txRow, txJournals, jLines, auditActions, snap, delta, sameMap, expectedPosting, counts, labelAudit, checkCombinedLabel, dbAll, dbOne, uid, sleep, COMPANY_DB, DATA, SLUG, SLUG_OFF };
}
