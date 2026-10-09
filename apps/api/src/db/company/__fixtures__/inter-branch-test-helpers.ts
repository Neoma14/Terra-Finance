import crypto from "node:crypto";
import type { Knex } from "knex";
import { canActOnBranch } from "../../system/authorization.js";
import type { CompanyRole, Permission } from "../../system/rbac.js";
import { createInterBranchAccountPair } from "../account-policy-service.js";
import type { InterBranchPrincipal } from "../inter-branch-service.js";
import { journalReferenceFor, type InterBranchLeg, type InterBranchSide } from "../inter-branch-domain.js";
import { addBranch, freshCompanyDb, seedBasics, testActor, type SeededAccounts } from "./branch-test-helpers.js";

/**
 * Fixture Inter-Branch (IB-1). Menyusun data lewat SQL langsung karena alur posting IB baru ada di IB-3;
 * urutan penulisan meniru alur yang disepakati (induk WAITING -> klaim COMPLETED -> jurnal DRAFT -> baris -> POSTED).
 */

export interface InterBranchWorld {
  db: Knex;
  seed: SeededAccounts;
  metro: string;
  bl: string;
  /** Akun antar-cabang: kunci "<tipe>-<kode cabang lawan>" (mis. ASSET-BL = Antarkantor Aktiva dengan lawan BL). */
  ib: Record<string, string>;
}

export async function interBranchWorld(): Promise<InterBranchWorld> {
  const db = await freshCompanyDb();
  const seed = await seedBasics(db);
  const metro = await addBranch(db, "METRO", "Cabang Metro");
  const bl = await addBranch(db, "BL", "Bandar Lampung");
  for (const accountTypeCode of ["ASSET", "LIABILITY"] as const) {
    await createInterBranchAccountPair(db, { branchAId: metro, branchBId: bl, accountTypeCode, confirm: true }, testActor);
  }
  const rows = await db("accounts as a")
    .join("account_types as t", "t.id", "a.account_type_id")
    .join("branches as b", "b.id", "a.counterpart_branch_id")
    .where("a.branch_policy", "INTER_BRANCH")
    .select("a.id as id", "t.code as type", "b.code as branch");
  return { db, seed, metro, bl, ib: Object.fromEntries(rows.map((r: any) => [`${r.type}-${r.branch}`, r.id])) };
}

let seq = 0;

export interface ProposeOptions {
  from: string;
  to: string;
  fromAccountId: string;
  toAccountId: string;
  amount?: number;
  date?: string;
  proposedBy?: string;
}

/** Pengajuan WAITING_APPROVAL + persetujuan POST yang menunggu (tanpa jurnal). */
export async function proposeTransaction(db: Knex, o: ProposeOptions): Promise<{ id: string; no: string }> {
  seq += 1;
  const id = crypto.randomUUID();
  const no = `IB-2026-${String(seq).padStart(6, "0")}`;
  const proposedBy = o.proposedBy ?? "maker-1";
  await db("inter_branch_transactions").insert({
    id,
    transaction_no: no,
    type: "TRANSFER_KAS",
    transaction_date: o.date ?? "2026-01-15",
    from_branch_id: o.from,
    to_branch_id: o.to,
    amount: o.amount ?? 1_000_000,
    description: "Uji",
    from_account_id: o.fromAccountId,
    to_account_suggested_id: o.toAccountId,
    status: "WAITING_APPROVAL",
    proposed_by: proposedBy,
    idempotency_key: crypto.randomUUID(),
  });
  await db("inter_branch_approvals").insert({
    id: crypto.randomUUID(),
    transaction_id: id,
    kind: "POST",
    status: "WAITING",
    requested_by: proposedBy,
    requested_by_branch_id: o.from,
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return { id, no };
}

/** Klaim: transaksi COMPLETED dan persetujuan POST APPROVED (langkah pertama posting atomik, Spek §12). */
export async function claimTransaction(db: Knex, id: string, decidedBy = "approver-1"): Promise<void> {
  const tx = await db("inter_branch_transactions").where({ id }).first();
  await db("inter_branch_transactions").where({ id }).update({ status: "COMPLETED" });
  await db("inter_branch_approvals")
    .where({ transaction_id: id, kind: "POST", status: "WAITING" })
    .update({ status: "APPROVED", decided_by: decidedBy, decided_at: new Date().toISOString(), self_approved: decidedBy === tx.proposed_by ? 1 : 0 });
}

export interface JournalOptions {
  txId: string;
  leg: InterBranchLeg;
  side: InterBranchSide;
  lines: Array<{ accountId: string; debit: number; credit: number }>;
  /** Jurnal REVERSAL dibuat langsung POSTED lebih dulu baru barisnya (urutan reverseJournalEntry); ORIGINAL: DRAFT -> baris -> POSTED. */
  periodId: string;
}

export async function insertInterBranchJournal(db: Knex, o: JournalOptions): Promise<string> {
  const tx = await db("inter_branch_transactions").where({ id: o.txId }).first();
  const id = crypto.randomUUID();
  const header = {
    id,
    entry_date: tx.transaction_date,
    period_id: o.periodId,
    reference_no: journalReferenceFor(tx.transaction_no, o.leg, o.side),
    branch_id: o.side === "FROM" ? tx.from_branch_id : tx.to_branch_id,
    origin: "inter_branch",
    inter_branch_transaction_id: o.txId,
    inter_branch_leg: o.leg,
    inter_branch_side: o.side,
  };
  const lines = o.lines.map((l, i) => ({ id: crypto.randomUUID(), journal_entry_id: id, account_id: l.accountId, debit: l.debit, credit: l.credit, line_order: i }));
  if (o.leg === "REVERSAL") {
    await db("journal_entries").insert({ ...header, status: "POSTED" });
    await db("journal_entry_lines").insert(lines);
  } else {
    await db("journal_entries").insert({ ...header, status: "DRAFT" });
    await db("journal_entry_lines").insert(lines);
    await db("journal_entries").where({ id }).update({ status: "POSTED" });
  }
  return id;
}

/** Transaksi COMPLETED lengkap: dua jurnal ORIGINAL sesuai model akuntansi Spek §5 (FROM: D antarkantor[TO] / K kas; TO: D hutang / K antarkantor[FROM]). */
export async function completedTransaction(w: InterBranchWorld, amount = 1_000_000): Promise<{ id: string; no: string; journals: { from: string; to: string } }> {
  const { db, seed, metro, bl, ib } = w;
  const tx = await proposeTransaction(db, { from: metro, to: bl, fromAccountId: seed.kasId, toAccountId: seed.hutangId, amount });
  await claimTransaction(db, tx.id);
  const from = await insertInterBranchJournal(db, {
    txId: tx.id, leg: "ORIGINAL", side: "FROM", periodId: seed.periodId,
    lines: [{ accountId: ib["ASSET-BL"], debit: amount, credit: 0 }, { accountId: seed.kasId, debit: 0, credit: amount }],
  });
  const to = await insertInterBranchJournal(db, {
    txId: tx.id, leg: "ORIGINAL", side: "TO", periodId: seed.periodId,
    lines: [{ accountId: seed.hutangId, debit: amount, credit: 0 }, { accountId: ib["LIABILITY-METRO"], debit: 0, credit: amount }],
  });
  return { ...tx, journals: { from, to } };
}

/** Reversal selesai: REVERSAL_WAITING -> REVERSED, dua jurnal REVERSAL, dua ORIGINAL menjadi REVERSED. */
export async function reverseTransaction(w: InterBranchWorld, tx: { id: string; journals: { from: string; to: string } }, amount = 1_000_000): Promise<void> {
  const { db, seed, metro, ib } = w;
  await db("inter_branch_transactions").where({ id: tx.id }).update({ reversal_state: "REVERSAL_WAITING" });
  await db("inter_branch_approvals").insert({
    id: crypto.randomUUID(), transaction_id: tx.id, kind: "REVERSE", status: "WAITING", requested_by: "maker-1", requested_by_branch_id: metro,
    requested_at: new Date().toISOString(), request_reason: "Salah input", expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await db("inter_branch_transactions").where({ id: tx.id }).update({ reversal_state: "REVERSED" });
  await db("inter_branch_approvals").where({ transaction_id: tx.id, kind: "REVERSE", status: "WAITING" }).update({ status: "APPROVED", decided_by: "approver-1", decided_at: new Date().toISOString() });
  await insertInterBranchJournal(db, {
    txId: tx.id, leg: "REVERSAL", side: "FROM", periodId: seed.periodId,
    lines: [{ accountId: ib["ASSET-BL"], debit: 0, credit: amount }, { accountId: seed.kasId, debit: amount, credit: 0 }],
  });
  await insertInterBranchJournal(db, {
    txId: tx.id, leg: "REVERSAL", side: "TO", periodId: seed.periodId,
    lines: [{ accountId: seed.hutangId, debit: 0, credit: amount }, { accountId: ib["LIABILITY-METRO"], debit: amount, credit: 0 }],
  });
  await db("journal_entries").whereIn("id", [tx.journals.from, tx.journals.to]).update({ status: "REVERSED", is_reversed: true });
}

/** Principal dengan logika otorisasi Phase 3 yang SUNGGUHAN (`canActOnBranch`): permission efektif DAN akses cabang. Delegasi tidak ikut (tidak menambah hak). */
export function makePrincipal(o: { userId: string; role: CompanyRole; branches?: "ALL" | string[]; grants?: Permission[]; denies?: Permission[] }): InterBranchPrincipal {
  const access = {
    role: o.role,
    grants: new Set<Permission>(o.grants ?? []),
    denies: new Set<Permission>(o.denies ?? []),
    delegation: null,
    branchScope: o.branches === "ALL" || o.branches === undefined ? ("ALL" as const) : ("LIMITED" as const),
    allowedBranchIds: o.branches === "ALL" || o.branches === undefined ? null : o.branches,
  };
  return {
    userId: o.userId,
    role: o.role,
    actor: { actorType: "user", actorId: o.userId, actorLabel: `Pengguna ${o.userId}` },
    canAct: (permission, branchId) => canActOnBranch(access, permission, branchId),
    userNames: async (ids) => new Map(ids.map((id) => [id, `Pengguna ${id}`])),
  };
}

export interface CashAccounts {
  kas: string;
  bank: string;
  beban: string;
  hutang: string;
}

/** Kas menjadi akun kas, ditambah akun Bank (kas) -- bahan Transfer Kas; beban/hutang untuk Pembebanan. */
export async function cashAccounts(w: InterBranchWorld): Promise<CashAccounts> {
  await w.db("accounts").where({ id: w.seed.kasId }).update({ is_cash: true });
  const asset = (await w.db("account_types").where({ code: "ASSET" }).first()).id;
  const bank = crypto.randomUUID();
  await w.db("accounts").insert({ id: bank, code: "1010", name: "Bank", account_type_id: asset, normal_balance: "debit", is_cash: true });
  return { kas: w.seed.kasId, bank, beban: w.seed.bebanId, hutang: w.seed.hutangId };
}
