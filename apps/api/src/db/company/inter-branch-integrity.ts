import type { Knex } from "knex";
import { isValidStateCombination, type InterBranchReversalState, type InterBranchStatus } from "./inter-branch-domain.js";

/**
 * `verifyInterBranchIntegrity` -- diagnostik READ-ONLY invarian akuntansi Inter-Branch (Spek §19, I-1…I-11).
 * Mengembalikan daftar pelanggaran; daftar kosong = sehat. Dijalankan di tes, setelah migrasi, dan dapat
 * dipakai sebagai diagnostik admin. Peran pelaku (OWNER/non-OWNER) tinggal di System DB sehingga I-11
 * hanya diperiksa konsistensinya terhadap kolom informasional `self_approved`.
 */

export interface IntegrityViolation {
  code: string;
  message: string;
  transactionId?: string;
  journalId?: string;
  accountId?: string;
}

interface TxRow {
  id: string;
  transaction_no: string;
  transaction_date: string;
  from_branch_id: string;
  to_branch_id: string;
  amount: number | string;
  status: InterBranchStatus;
  reversal_state: InterBranchReversalState;
}
interface JournalRow {
  id: string;
  reference_no: string;
  status: string;
  entry_date: string;
  branch_id: string;
  origin: string;
  tx: string | null;
  leg: "ORIGINAL" | "REVERSAL" | null;
  side: "FROM" | "TO" | null;
  debit_c: number | null;
  credit_c: number | null;
}
interface IbLineRow {
  journal_id: string;
  counterpart: string;
  debit_c: number | null;
  credit_c: number | null;
}
interface ApprovalRow {
  id: string;
  transaction_id: string;
  kind: "POST" | "REVERSE";
  status: "WAITING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  requested_by: string;
  decided_by: string | null;
  self_approved: number;
}

const cents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const CENTS_SQL = (col: string) => `COALESCE(SUM(CAST(ROUND(${col} * 100) AS INTEGER)), 0)`;

export async function verifyInterBranchIntegrity(db: Knex, scope: { transactionId?: string } = {}): Promise<IntegrityViolation[]> {
  const only = scope.transactionId;
  const violations: IntegrityViolation[] = [];
  const add = (v: IntegrityViolation) => violations.push(v);

  const transactions: TxRow[] = await db("inter_branch_transactions").modify((q) => { if (only) q.where({ id: only }); }).select("id", "transaction_no", "transaction_date", "from_branch_id", "to_branch_id", "amount", "status", "reversal_state");
  const journals: JournalRow[] = await db("journal_entries as je")
    .where((q) => (only ? q.where("je.inter_branch_transaction_id", only) : q.whereNotNull("je.inter_branch_transaction_id").orWhere("je.origin", "inter_branch")))
    .select(
      "je.id as id", "je.reference_no as reference_no", "je.status as status", "je.entry_date as entry_date", "je.branch_id as branch_id", "je.origin as origin",
      "je.inter_branch_transaction_id as tx", "je.inter_branch_leg as leg", "je.inter_branch_side as side",
      db.raw(`(SELECT ${CENTS_SQL("debit")} FROM journal_entry_lines WHERE journal_entry_id = je.id) as debit_c`),
      db.raw(`(SELECT ${CENTS_SQL("credit")} FROM journal_entry_lines WHERE journal_entry_id = je.id) as credit_c`),
    );
  const ibLines: IbLineRow[] = await db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .join("accounts as a", "a.id", "jel.account_id")
    .modify((q) => { if (only) q.where("je.inter_branch_transaction_id", only); else q.whereNotNull("je.inter_branch_transaction_id"); })
    .where("a.branch_policy", "INTER_BRANCH")
    .groupBy("jel.journal_entry_id", "a.counterpart_branch_id")
    .select("jel.journal_entry_id as journal_id", "a.counterpart_branch_id as counterpart", db.raw(`${CENTS_SQL("jel.debit")} as debit_c`), db.raw(`${CENTS_SQL("jel.credit")} as credit_c`));
  const approvals: ApprovalRow[] = await db("inter_branch_approvals").modify((q) => { if (only) q.where({ transaction_id: only }); }).select("id", "transaction_id", "kind", "status", "requested_by", "decided_by", "self_approved");

  const txById = new Map(transactions.map((t) => [t.id, t]));
  const journalsByTx = new Map<string, JournalRow[]>();
  const linesByJournal = new Map<string, IbLineRow[]>();
  for (const l of ibLines) linesByJournal.set(l.journal_id, [...(linesByJournal.get(l.journal_id) ?? []), l]);

  // I-6: jurnal tanpa induk / asal tidak konsisten / I-1 keseimbangan
  for (const j of journals) {
    if (j.debit_c !== j.credit_c) add({ code: "JOURNAL_NOT_BALANCED", message: `Jurnal ${j.reference_no} tidak seimbang.`, journalId: j.id });
    if (!j.tx) {
      add({ code: "ORIGIN_WITHOUT_LINK", message: `Jurnal ${j.reference_no} ber-origin inter_branch tanpa tautan transaksi.`, journalId: j.id });
      continue;
    }
    if (j.origin !== "inter_branch") add({ code: "LINK_WITHOUT_ORIGIN", message: `Jurnal ${j.reference_no} bertaut transaksi antar-cabang tetapi origin = ${j.origin}.`, journalId: j.id });
    if (!txById.has(j.tx)) {
      add({ code: "ORPHAN_JOURNAL", message: `Jurnal ${j.reference_no} menunjuk transaksi antar-cabang yang tidak ada.`, journalId: j.id });
      continue;
    }
    journalsByTx.set(j.tx, [...(journalsByTx.get(j.tx) ?? []), j]);
  }

  const approvalsByTx = new Map<string, ApprovalRow[]>();
  for (const a of approvals) approvalsByTx.set(a.transaction_id, [...(approvalsByTx.get(a.transaction_id) ?? []), a]);

  for (const t of transactions) {
    const at = { transactionId: t.id };
    const label = t.transaction_no;
    const mine = journalsByTx.get(t.id) ?? [];
    const slot = (leg: "ORIGINAL" | "REVERSAL", side: "FROM" | "TO") => mine.filter((j) => j.leg === leg && j.side === side);

    // I-9: kombinasi status
    if (!isValidStateCombination(t.status, t.reversal_state)) {
      add({ ...at, code: "STATE_COMBINATION_INVALID", message: `${label}: reversal_state ${t.reversal_state} tidak sah untuk status ${t.status}.` });
    }

    // I-2 / I-3: jumlah jurnal sesuai keadaan
    const expectOriginal = t.status === "COMPLETED";
    const expectReversal = t.status === "COMPLETED" && t.reversal_state === "REVERSED";
    if (!expectOriginal && mine.length > 0) {
      add({ ...at, code: "JOURNAL_ON_UNCOMPLETED", message: `${label}: transaksi ${t.status} seharusnya tidak punya jurnal (ada ${mine.length}).` });
    } else if (expectOriginal) {
      for (const [leg, expected] of [["ORIGINAL", true], ["REVERSAL", expectReversal]] as const) {
        for (const side of ["FROM", "TO"] as const) {
          const found = slot(leg, side);
          if (found.length !== (expected ? 1 : 0)) {
            add({ ...at, code: expected ? "LEG_MISSING" : "LEG_UNEXPECTED", message: `${label}: jurnal ${leg}/${side} ${expected ? "harus tepat satu" : "tidak boleh ada"} (ditemukan ${found.length}).` });
          }
        }
      }
    }

    // I-4 / I-5 / tanggal / status jurnal
    const amountC = cents(t.amount);
    for (const j of mine) {
      if (!j.leg || !j.side) continue;
      const expectedBranch = j.side === "FROM" ? t.from_branch_id : t.to_branch_id;
      if (j.branch_id !== expectedBranch) add({ ...at, journalId: j.id, code: "BRANCH_MISMATCH", message: `${label}: cabang jurnal ${j.reference_no} tidak sesuai sisi ${j.side}.` });
      if (String(j.entry_date).slice(0, 10) !== t.transaction_date) add({ ...at, journalId: j.id, code: "DATE_MISMATCH", message: `${label}: tanggal jurnal ${j.reference_no} berbeda dari tanggal transaksi.` });
      const expectedStatus = j.leg === "REVERSAL" ? "POSTED" : expectReversal ? "REVERSED" : "POSTED";
      if (j.status !== expectedStatus) add({ ...at, journalId: j.id, code: "JOURNAL_STATUS", message: `${label}: jurnal ${j.reference_no} berstatus ${j.status}, seharusnya ${expectedStatus}.` });

      // sisi FROM mendebit akun lawan = TO; sisi TO mengkredit akun lawan = FROM; reversal menukar arah
      const counterpart = j.side === "FROM" ? t.to_branch_id : t.from_branch_id;
      const wantDebit = (j.side === "FROM") === (j.leg === "ORIGINAL");
      const lines = (linesByJournal.get(j.id) ?? []).filter((l) => l.counterpart === counterpart);
      const debit = lines.reduce((s, l) => s + (l.debit_c ?? 0), 0);
      const credit = lines.reduce((s, l) => s + (l.credit_c ?? 0), 0);
      if ((wantDebit ? debit : credit) !== amountC || (wantDebit ? credit : debit) !== 0) {
        add({ ...at, journalId: j.id, code: "AMOUNT_MISMATCH", message: `${label}: baris antar-cabang jurnal ${j.reference_no} tidak sama dengan nominal transaksi pada arah yang benar.` });
      }
    }

    // I-9 / I-11: persetujuan
    const mineApprovals = approvalsByTx.get(t.id) ?? [];
    const post = mineApprovals.filter((a) => a.kind === "POST");
    const reverse = mineApprovals.filter((a) => a.kind === "REVERSE");
    const wantPost = t.status === "WAITING_APPROVAL" ? "WAITING" : t.status === "COMPLETED" ? "APPROVED" : t.status;
    if (post.length !== 1 || post[0].status !== wantPost) {
      add({ ...at, code: "POST_APPROVAL_MISMATCH", message: `${label}: transaksi ${t.status} harus punya tepat satu persetujuan POST berstatus ${wantPost}.` });
    }
    const reverseWaiting = reverse.filter((a) => a.status === "WAITING").length;
    if ((t.reversal_state === "REVERSAL_WAITING") !== (reverseWaiting === 1) || reverseWaiting > 1) {
      add({ ...at, code: "REVERSE_APPROVAL_MISMATCH", message: `${label}: reversal_state ${t.reversal_state} tidak sesuai dengan persetujuan REVERSE yang menunggu (${reverseWaiting}).` });
    }
    if (t.reversal_state === "REVERSED" && !reverse.some((a) => a.status === "APPROVED")) {
      add({ ...at, code: "REVERSE_APPROVAL_MISSING", message: `${label}: REVERSED tanpa persetujuan REVERSE yang disetujui.` });
    }
    for (const a of mineApprovals) {
      if (a.status === "APPROVED" && Boolean(a.self_approved) !== (a.decided_by === a.requested_by)) {
        add({ ...at, code: "SELF_APPROVED_INCONSISTENT", message: `${label}: penanda self_approved tidak konsisten dengan pelaku keputusan.` });
      }
    }
  }

  if (only) return violations;

  // F-7: aturan akun antar-cabang
  const badAccounts = await db("accounts")
    .where("branch_policy", "INTER_BRANCH")
    .where((q) => q.where("is_cash", true).orWhereNotNull("cash_flow_activity").orWhereNull("counterpart_branch_id"))
    .select("id", "code");
  for (const a of badAccounts) add({ code: "ACCOUNT_RULE", message: `Akun antar-cabang ${a.code} melanggar aturan (kas/klasifikasi arus kas/cabang lawan).`, accountId: a.id });

  return violations;
}
