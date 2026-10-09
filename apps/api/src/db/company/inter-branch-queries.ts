import type { Knex } from "knex";
import { isMultiBranchEnabled } from "./branch-service.js";
import { InterBranchDisabledError, InterBranchForbiddenError, InterBranchNotFoundError, type InterBranchPrincipal } from "./inter-branch-service.js";
import { resolveInterBranchAccounts } from "./inter-branch-accounts.js";
import { INTER_BRANCH_AUDIT_ENTITY, type InterBranchReversalState, type InterBranchStatus, type InterBranchType } from "./inter-branch-domain.js";

/**
 * Pembacaan Inter-Branch (daftar, detail, ringkasan). READ-ONLY. Visibilitas: hanya transaksi yang cabang asal ATAU
 * tujuannya dapat dibaca pengguna (`interbranch.read` DAN akses cabang saat ini); selain itu tidak muncul di daftar dan
 * detailnya 404 identik dengan "tidak ada". Kedaluwarsa dihitung virtual (tanpa menulis) saat dibaca.
 */

export interface BranchRef {
  id: string;
  code: string;
  name: string;
}
export interface PersonRef {
  id: string;
  name: string;
}
export interface InterBranchCapabilities {
  canApprove: boolean;
  canReject: boolean;
  /** Punya wewenang tetapi dicegah karena pengaju sendiri (non-OWNER). Hanya untuk UX; server tetap menolak. */
  selfApprovalBlocked: boolean;
  canCancel: boolean;
  canRequestReversal: boolean;
  canApproveReversal: boolean;
  canRejectReversal: boolean;
  canCancelReversal: boolean;
}
export interface ReversalView {
  approvalId: string;
  requestedBy: PersonRef;
  requestedAt: string;
  reason: string | null;
  expiresAt: string;
  requestedByBranchId: string;
}
export interface InterBranchListItem {
  id: string;
  transactionNo: string;
  type: InterBranchType;
  transactionDate: string;
  amount: number;
  description: string;
  referenceText: string | null;
  fromBranch: BranchRef;
  toBranch: BranchRef;
  /** Status bisnis efektif (WAITING_APPROVAL yang lewat batas ditampilkan EXPIRED). */
  status: InterBranchStatus;
  /** Accounting event diturunkan dari jurnal (tidak disimpan). */
  accountingEvent: "POSTED" | "NOT_POSTED";
  reversalState: InterBranchReversalState;
  direction: "in" | "out" | "both";
  proposedBy: PersonRef;
  proposedAt: string;
  expiresAt: string | null;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionReason: string | null;
  selfApproved: boolean;
  reversal: ReversalView | null;
  capabilities: InterBranchCapabilities;
}
export interface JournalLineView {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}
export interface InterBranchJournalView {
  referenceNo: string;
  leg: "ORIGINAL" | "REVERSAL";
  side: "FROM" | "TO";
  status: string;
  branchId: string;
  /** Isi jurnal hanya untuk sisi yang cabangnya dapat dibaca pengguna; sisi lawan hanya nomor referensi. */
  journalId: string | null;
  lines: JournalLineView[] | null;
}
export interface AccountView {
  id: string;
  code: string;
  name: string;
}
export interface InterBranchHistoryItem {
  action: string;
  actorLabel: string;
  createdAt: string;
  reason: string | null;
  branchId: string | null;
}
export interface InterBranchDetail extends InterBranchListItem {
  /** Akun sisi pemberi -- hanya bila cabang asal dapat dibaca. */
  fromAccount: AccountView | null;
  /** Akun usulan sisi penerima -- hanya bila cabang tujuan dapat dibaca. */
  toAccountSuggested: AccountView | null;
  toAccountConfirmed: AccountView | null;
  journals: InterBranchJournalView[];
  history: InterBranchHistoryItem[];
}

export interface ListInterBranchQuery {
  box?: "in" | "out" | "all";
  status?: InterBranchStatus;
  type?: InterBranchType;
  fromBranchId?: string;
  toBranchId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

interface Row {
  id: string;
  transaction_no: string;
  type: InterBranchType;
  transaction_date: string;
  from_branch_id: string;
  to_branch_id: string;
  amount: number | string;
  description: string;
  reference_text: string | null;
  from_account_id: string;
  to_account_suggested_id: string;
  status: InterBranchStatus;
  reversal_state: InterBranchReversalState;
  proposed_by: string;
  created_at: string;
  pa_status: string;
  pa_expires_at: string;
  pa_decided_by: string | null;
  pa_decided_at: string | null;
  pa_decision_reason: string | null;
  pa_self_approved: number;
  pa_confirmed_account_id: string | null;
}

interface ReverseWaiting {
  id: string;
  transaction_id: string;
  requested_by: string;
  requested_by_branch_id: string;
  requested_at: string;
  request_reason: string | null;
  expires_at: string;
}

const SELECT = [
  "t.id", "t.transaction_no", "t.type", "t.transaction_date", "t.from_branch_id", "t.to_branch_id", "t.amount", "t.description", "t.reference_text",
  "t.from_account_id", "t.to_account_suggested_id", "t.status", "t.reversal_state", "t.proposed_by", "t.created_at",
  "pa.status as pa_status", "pa.expires_at as pa_expires_at", "pa.decided_by as pa_decided_by", "pa.decided_at as pa_decided_at",
  "pa.decision_reason as pa_decision_reason", "pa.self_approved as pa_self_approved", "pa.confirmed_account_id as pa_confirmed_account_id",
];

function baseQuery(db: Knex): Knex.QueryBuilder {
  return db("inter_branch_transactions as t").join("inter_branch_approvals as pa", function () {
    this.on("pa.transaction_id", "t.id").andOn(db.raw("pa.kind = 'POST'"));
  });
}

function effectiveStatus(row: Pick<Row, "status" | "pa_expires_at">, now: Date): InterBranchStatus {
  return row.status === "WAITING_APPROVAL" && row.pa_expires_at < now.toISOString() ? "EXPIRED" : row.status;
}

async function readableBranchIds(db: Knex, principal: InterBranchPrincipal): Promise<string[]> {
  const branches: Array<{ id: string }> = await db("branches").whereNull("deleted_at").select("id");
  return branches.filter((b) => principal.canAct("interbranch.read", b.id)).map((b) => b.id);
}

async function assertEnabled(db: Knex): Promise<void> {
  if (!(await isMultiBranchEnabled(db))) throw new InterBranchDisabledError();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function capabilitiesFor(principal: InterBranchPrincipal, row: Row, status: InterBranchStatus, reversal: ReverseWaiting | undefined): InterBranchCapabilities {
  const isOwner = principal.role === "OWNER";
  const maker = principal.userId === row.proposed_by;
  const waiting = status === "WAITING_APPROVAL";
  const mayDecide = waiting && principal.canAct("interbranch.approve", row.to_branch_id);
  const reversalDecider = reversal !== undefined && principal.canAct("interbranch.approve", reversal.requested_by_branch_id === row.from_branch_id ? row.to_branch_id : row.from_branch_id);
  const reversalMaker = reversal !== undefined && principal.userId === reversal.requested_by;
  return {
    canApprove: mayDecide && (isOwner || !maker),
    canReject: mayDecide && (isOwner || !maker),
    selfApprovalBlocked: mayDecide && !isOwner && maker,
    canCancel: waiting && principal.canAct("interbranch.create", row.from_branch_id) && (maker || isOwner),
    canRequestReversal:
      status === "COMPLETED" && row.reversal_state === "NOT_REVERSED" && (principal.canAct("interbranch.reverse", row.from_branch_id) || principal.canAct("interbranch.reverse", row.to_branch_id)),
    canApproveReversal: reversalDecider && (isOwner || !reversalMaker),
    canRejectReversal: reversalDecider && (isOwner || !reversalMaker),
    canCancelReversal: reversal !== undefined && principal.canAct("interbranch.reverse", reversal.requested_by_branch_id) && (reversalMaker || isOwner),
  };
}

async function toItems(db: Knex, principal: InterBranchPrincipal, rows: Row[], readable: Set<string>, now: Date): Promise<InterBranchListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const branchRows: Array<BranchRef> = await db("branches").select("id", "code", "name");
  const branches = new Map(branchRows.map((b) => [b.id, b]));
  const waitingReversals: ReverseWaiting[] = await db("inter_branch_approvals").whereIn("transaction_id", ids).where({ kind: "REVERSE", status: "WAITING" }).select("id", "transaction_id", "requested_by", "requested_by_branch_id", "requested_at", "request_reason", "expires_at");
  const reversalByTx = new Map(waitingReversals.filter((r) => r.expires_at >= now.toISOString()).map((r) => [r.transaction_id, r]));
  const posted: Array<{ tx: string; c: number }> = await db("journal_entries")
    .whereIn("inter_branch_transaction_id", ids)
    .where("inter_branch_leg", "ORIGINAL")
    .whereIn("status", ["POSTED", "REVERSED"])
    .groupBy("inter_branch_transaction_id")
    .select("inter_branch_transaction_id as tx", db.raw("count(*) as c"));
  const postedSet = new Set(posted.filter((p) => Number(p.c) === 2).map((p) => p.tx));
  const people = new Set<string>();
  for (const r of rows) {
    people.add(r.proposed_by);
    if (r.pa_decided_by) people.add(r.pa_decided_by);
  }
  for (const r of reversalByTx.values()) people.add(r.requested_by);
  const names = await principal.userNames([...people]);
  const person = (id: string): PersonRef => ({ id, name: names.get(id) ?? "Pengguna" });

  return rows.map((row) => {
    const status = effectiveStatus(row, now);
    const reversal = reversalByTx.get(row.id);
    const fromReadable = readable.has(row.from_branch_id);
    const toReadable = readable.has(row.to_branch_id);
    return {
      id: row.id,
      transactionNo: row.transaction_no,
      type: row.type,
      transactionDate: String(row.transaction_date).slice(0, 10),
      amount: Number(Number(row.amount).toFixed(2)),
      description: row.description,
      referenceText: row.reference_text,
      fromBranch: branches.get(row.from_branch_id)!,
      toBranch: branches.get(row.to_branch_id)!,
      status,
      accountingEvent: postedSet.has(row.id) ? "POSTED" : "NOT_POSTED",
      reversalState: row.reversal_state === "REVERSAL_WAITING" && !reversal ? "NOT_REVERSED" : row.reversal_state,
      direction: fromReadable && toReadable ? "both" : toReadable ? "in" : "out",
      proposedBy: person(row.proposed_by),
      proposedAt: row.created_at,
      expiresAt: status === "WAITING_APPROVAL" || status === "EXPIRED" ? row.pa_expires_at : null,
      decidedBy: row.pa_decided_by ? person(row.pa_decided_by) : null,
      decidedAt: row.pa_decided_at,
      decisionReason: row.pa_decision_reason,
      selfApproved: Boolean(row.pa_self_approved),
      reversal: reversal
        ? { approvalId: reversal.id, requestedBy: person(reversal.requested_by), requestedAt: reversal.requested_at, reason: reversal.request_reason, expiresAt: reversal.expires_at, requestedByBranchId: reversal.requested_by_branch_id }
        : null,
      capabilities: capabilitiesFor(principal, row, status, reversal),
    };
  });
}

export async function listInterBranch(db: Knex, principal: InterBranchPrincipal, query: ListInterBranchQuery = {}, now: Date = new Date()): Promise<{ items: InterBranchListItem[]; total: number; page: number; pageSize: number }> {
  await assertEnabled(db);
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 25)));
  const readable = await readableBranchIds(db, principal);
  if (readable.length === 0) return { items: [], total: 0, page, pageSize };
  const nowIso = now.toISOString();

  const filtered = () => {
    const q = baseQuery(db);
    const box = query.box ?? "all";
    if (box === "in") q.whereIn("t.to_branch_id", readable);
    else if (box === "out") q.whereIn("t.from_branch_id", readable);
    else q.where((w) => w.whereIn("t.from_branch_id", readable).orWhereIn("t.to_branch_id", readable));
    if (query.type) q.where("t.type", query.type);
    if (query.fromBranchId) q.where("t.from_branch_id", query.fromBranchId);
    if (query.toBranchId) q.where("t.to_branch_id", query.toBranchId);
    if (query.fromDate) q.where("t.transaction_date", ">=", query.fromDate);
    if (query.toDate) q.where("t.transaction_date", "<=", query.toDate);
    if (query.status === "EXPIRED") q.where((w) => w.where("t.status", "EXPIRED").orWhere((x) => x.where("t.status", "WAITING_APPROVAL").where("pa.expires_at", "<", nowIso)));
    else if (query.status === "WAITING_APPROVAL") q.where("t.status", "WAITING_APPROVAL").where("pa.expires_at", ">=", nowIso);
    else if (query.status) q.where("t.status", query.status);
    const search = (query.search ?? "").trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      q.where((w) => w.whereRaw("t.transaction_no like ? escape '\\'", [like]).orWhereRaw("t.description like ? escape '\\'", [like]).orWhereRaw("t.reference_text like ? escape '\\'", [like]));
    }
    return q;
  };

  const total = Number((await filtered().count({ c: "*" }).first())?.c ?? 0);
  const rows: Row[] = await filtered().select(SELECT).orderBy("t.created_at", "desc").orderBy("t.id").limit(pageSize).offset((page - 1) * pageSize);
  return { items: await toItems(db, principal, rows, new Set(readable), now), total, page, pageSize };
}

export async function getInterBranchSummary(db: Knex, principal: InterBranchPrincipal, now: Date = new Date()): Promise<{ incomingWaiting: number; outgoingWaiting: number }> {
  await assertEnabled(db);
  const readable = new Set(await readableBranchIds(db, principal));
  const nowIso = now.toISOString();
  const waiting: Array<{ from_branch_id: string; to_branch_id: string }> = await baseQuery(db).where("t.status", "WAITING_APPROVAL").where("pa.expires_at", ">=", nowIso).select("t.from_branch_id", "t.to_branch_id");
  const reversals: Array<{ from_branch_id: string; to_branch_id: string; requested_by_branch_id: string }> = await db("inter_branch_approvals as a")
    .join("inter_branch_transactions as t", "t.id", "a.transaction_id")
    .where({ "a.kind": "REVERSE", "a.status": "WAITING" })
    .where("a.expires_at", ">=", nowIso)
    .select("t.from_branch_id", "t.to_branch_id", "a.requested_by_branch_id");
  const incomingWaiting =
    waiting.filter((w) => readable.has(w.to_branch_id)).length +
    reversals.filter((r) => readable.has(r.requested_by_branch_id === r.from_branch_id ? r.to_branch_id : r.from_branch_id)).length;
  const outgoingWaiting = waiting.filter((w) => readable.has(w.from_branch_id)).length + reversals.filter((r) => readable.has(r.requested_by_branch_id)).length;
  return { incomingWaiting, outgoingWaiting };
}

export interface InterBranchDestination extends BranchRef {
  /** Pasangan akun antarkantor lengkap dan dapat dipakai; bila false `reason` berisi arahan. */
  ready: boolean;
  reason: string | null;
}

/**
 * Pilihan untuk formulir pengajuan: cabang tujuan = semua cabang ACTIVE selain cabang asal (akses ke tujuan TIDAK
 * disyaratkan untuk mengajukan), beserta kesiapan akun antarkantor pasangan itu. Hanya nama/kode cabang yang dibuka.
 */
export async function getInterBranchOptions(db: Knex, principal: InterBranchPrincipal, fromBranchId: string): Promise<{ fromBranch: BranchRef; destinations: InterBranchDestination[] }> {
  await assertEnabled(db);
  if (!principal.canAct("interbranch.create", fromBranchId)) throw new InterBranchForbiddenError("Anda tidak berwenang mengajukan transaksi antar-cabang dari cabang ini.");
  const fromBranch: BranchRef | undefined = await db("branches").whereNull("deleted_at").where({ id: fromBranchId }).first("id", "code", "name");
  if (!fromBranch) throw new InterBranchNotFoundError();
  const candidates: BranchRef[] = await db("branches").whereNull("deleted_at").where({ status: "ACTIVE" }).whereNot({ id: fromBranchId }).orderBy("sort_order").orderBy("code").select("id", "code", "name");
  const destinations: InterBranchDestination[] = [];
  for (const branch of candidates) {
    try {
      await resolveInterBranchAccounts(db, { fromBranchId, toBranchId: branch.id });
      destinations.push({ ...branch, ready: true, reason: null });
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || !String((err as { code: string }).code).startsWith("INTER_BRANCH_ACCOUNT_")) throw err;
      destinations.push({ ...branch, ready: false, reason: err.message });
    }
  }
  return { fromBranch, destinations };
}

async function accountView(db: Knex, id: string | null): Promise<AccountView | null> {
  if (!id) return null;
  const row = await db("accounts").where({ id }).first("id", "code", "name");
  return row ?? null;
}

export async function getInterBranchDetail(db: Knex, principal: InterBranchPrincipal, id: string, now: Date = new Date()): Promise<InterBranchDetail> {
  await assertEnabled(db);
  const row: Row | undefined = await baseQuery(db).where("t.id", id).select(SELECT).first();
  const visible = row && (principal.canAct("interbranch.read", row.from_branch_id) || principal.canAct("interbranch.read", row.to_branch_id));
  if (!row || !visible) throw new InterBranchNotFoundError();
  const readable = new Set(await readableBranchIds(db, principal));
  const [item] = await toItems(db, principal, [row], readable, now);

  const journalRows: Array<{ id: string; reference_no: string; inter_branch_leg: "ORIGINAL" | "REVERSAL"; inter_branch_side: "FROM" | "TO"; status: string; branch_id: string }> = await db("journal_entries")
    .where({ inter_branch_transaction_id: id })
    .orderBy([{ column: "inter_branch_leg" }, { column: "inter_branch_side" }])
    .select("id", "reference_no", "inter_branch_leg", "inter_branch_side", "status", "branch_id");
  const journals: InterBranchJournalView[] = [];
  for (const j of journalRows) {
    const open = readable.has(j.branch_id);
    const lines: JournalLineView[] | null = open
      ? (
          await db("journal_entry_lines as l")
            .join("accounts as a", "a.id", "l.account_id")
            .where("l.journal_entry_id", j.id)
            .orderBy("l.line_order")
            .select("a.code as accountCode", "a.name as accountName", "l.debit", "l.credit")
        ).map((l: any) => ({ accountCode: l.accountCode, accountName: l.accountName, debit: Number(l.debit), credit: Number(l.credit) }))
      : null;
    journals.push({ referenceNo: j.reference_no, leg: j.inter_branch_leg, side: j.inter_branch_side, status: j.status, branchId: j.branch_id, journalId: open ? j.id : null, lines });
  }

  const history: InterBranchHistoryItem[] = (
    await db("company_audit_log").where({ entity_type: INTER_BRANCH_AUDIT_ENTITY, entity_id: id }).orderBy("created_at").orderBy("rowid").select("action", "actor_label", "created_at", "reason", "branch_id")
  ).map((h: any) => ({ action: h.action, actorLabel: h.actor_label, createdAt: h.created_at, reason: h.reason, branchId: h.branch_id }));

  const fromReadable = readable.has(row.from_branch_id);
  const toReadable = readable.has(row.to_branch_id);
  return {
    ...item,
    fromAccount: fromReadable ? await accountView(db, row.from_account_id) : null,
    toAccountSuggested: toReadable ? await accountView(db, row.to_account_suggested_id) : null,
    toAccountConfirmed: toReadable ? await accountView(db, row.pa_confirmed_account_id) : null,
    journals,
    history,
  };
}
