import crypto from "node:crypto";
import type { Knex } from "knex";
import type { CompanyRole, Permission } from "../system/rbac.js";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { isSqliteBusy, runExclusive } from "./company-write-queue.js";
import { assertAccountUsable, type AccountRow } from "./account-service.js";
import { assertAccountsAllowedForJournal } from "./account-branch-policy.js";
import { getBranch, isMultiBranchEnabled, type BranchRow } from "./branch-service.js";
import { resolvePeriodForDate } from "./journal-import-service.js";
import { assertEntryDatePolicy, getMaxBackdateDays } from "./journal-policy.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "./journal-service.js";
import { isValidIsoDate } from "../../lib/calendar-date.js";
import { toCents } from "../../lib/money.js";
import {
  INTER_BRANCH_AUDIT_ACTIONS,
  INTER_BRANCH_AUDIT_ENTITY,
  INTER_BRANCH_EXPIRY_DAYS_MAX,
  INTER_BRANCH_EXPIRY_DAYS_MIN,
  allocateTransactionNo,
  calculateExpiresAt,
  isInterBranchType,
  journalReferenceFor,
  type InterBranchReversalState,
  type InterBranchStatus,
  type InterBranchType,
} from "./inter-branch-domain.js";
import { resolveInterBranchAccounts } from "./inter-branch-accounts.js";
import { verifyInterBranchIntegrity } from "./inter-branch-integrity.js";
import { expireOverdueInterBranch } from "./inter-branch-lifecycle.js";

/**
 * Alur transaksi antar-cabang (Spek §6-§15): ajukan -> (cabang tujuan) setujui = terima = posting dua sisi ATOMIK |
 * tolak | (pengaju) batalkan | kedaluwarsa; lalu reversal berpasangan. Tidak ada jurnal sebelum disetujui.
 *
 * Otorisasi diputuskan DI SINI (bukan di UI/route saja): `principal.canAct(permission, branchId)` = permission efektif
 * (role + GRANT - DENY) DAN akses cabang saat ini; delegasi tidak pernah menambah hak. Peran OWNER dibaca dari System DB
 * oleh pemanggil (tidak pernah dari klien). Semua aksi tulis berjalan di antrean tulis per-perusahaan dan satu
 * `db.transaction`; kesalahan TIDAK ditangkap di dalam prosedur sehingga kegagalan mana pun membatalkan seluruhnya.
 */

// ------------------------------------------------------------------------------------------------ error

export class InterBranchNotFoundError extends Error {
  readonly code = "INTER_BRANCH_NOT_FOUND" as const;
  constructor() {
    super("Transaksi antar-cabang tidak ditemukan.");
  }
}
export class InterBranchDisabledError extends Error {
  readonly code = "INTER_BRANCH_DISABLED" as const;
  constructor() {
    super("Fitur antar-cabang tidak aktif untuk perusahaan ini.");
  }
}
export class InterBranchForbiddenError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(message = "Anda tidak memiliki izin untuk melakukan aksi ini pada transaksi antar-cabang ini.") {
    super(message);
  }
}
export class SelfApprovalNotAllowedError extends Error {
  readonly code = "SELF_APPROVAL_NOT_ALLOWED" as const;
  constructor() {
    super("Pengaju tidak dapat memutuskan transaksinya sendiri. Minta pengguna lain yang berwenang di cabang tujuan.");
  }
}
export class InterBranchStateChangedError extends Error {
  readonly code = "INTER_BRANCH_STATE_CHANGED" as const;
  constructor(message = "Status transaksi sudah berubah. Muat ulang untuk melihat keadaan terbaru.") {
    super(message);
  }
}
export class InterBranchExpiredError extends Error {
  readonly code = "INTER_BRANCH_EXPIRED" as const;
  constructor() {
    super("Pengajuan ini sudah kedaluwarsa dan tidak dapat diputuskan. Minta pengaju mengajukan ulang.");
  }
}
export class InterBranchBusyError extends Error {
  readonly code = "INTER_BRANCH_BUSY" as const;
  constructor() {
    super("Database sedang sibuk. Tidak ada perubahan yang tersimpan; periksa status transaksi lalu coba lagi.");
  }
}
export class InterBranchIdempotencyConflictError extends Error {
  readonly code = "INTER_BRANCH_IDEMPOTENCY_CONFLICT" as const;
  constructor() {
    super("Kunci pengajuan ini sudah dipakai untuk transaksi yang berbeda.");
  }
}
/** Pelanggaran aturan domain/akuntansi (400/422 di route). `code` stabil untuk klien. */
export class InterBranchValidationError extends Error {
  constructor(
    public readonly code:
      | "INTER_BRANCH_INVALID_INPUT"
      | "INTER_BRANCH_BRANCH_NOT_ACTIVE"
      | "INTER_BRANCH_REASON_REQUIRED"
      | "INTER_BRANCH_ACCOUNT_INVALID"
      | "INTER_BRANCH_PERIOD_NOT_FOUND"
      | "INTER_BRANCH_POSTING_INVALID",
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------------------------------------ tipe

export interface InterBranchPrincipal {
  /** Id pengguna (System DB). */
  userId: string;
  /** Peran dari System DB (`request.companyAccess.role`) -- sumber tunggal business rule OWNER. */
  role: CompanyRole;
  actor: ActorContext;
  /** permission efektif DAN akses cabang saat ini (`canActOnBranch`). */
  canAct(permission: Permission, branchId: string): boolean;
  /** Nama tampilan pengguna (System DB). */
  userNames(ids: string[]): Promise<Map<string, string>>;
}

export interface ProposeInput {
  type: string;
  fromBranchId: string;
  toBranchId: string;
  transactionDate: string;
  amount: number;
  fromAccountId: string;
  toAccountSuggestedId: string;
  description: string;
  referenceText?: string | null;
  fromCounterpartyId?: string | null;
  toCounterpartyId?: string | null;
  idempotencyKey: string;
}

interface TxRow {
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
  from_counterparty_id: string | null;
  to_counterparty_id: string | null;
  status: InterBranchStatus;
  reversal_state: InterBranchReversalState;
  proposed_by: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  transaction_id: string;
  kind: "POST" | "REVERSE";
  status: "WAITING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  requested_by: string;
  requested_by_branch_id: string;
  requested_at: string;
  request_reason: string | null;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  self_approved: number;
  confirmed_account_id: string | null;
}

const MIN_REASON = 10;

// ------------------------------------------------------------------------------------------------ pembantu

function money(value: unknown): number {
  return Number(Number(value).toFixed(2));
}

async function guarded<T>(db: Knex, task: () => Promise<T>): Promise<T> {
  try {
    return await runExclusive(db, task);
  } catch (err) {
    if (isSqliteBusy(err)) throw new InterBranchBusyError();
    throw err;
  }
}

async function assertEnabled(db: Knex): Promise<void> {
  if (!(await isMultiBranchEnabled(db))) throw new InterBranchDisabledError();
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function requireReason(reason: string | null | undefined, label: string): string {
  const value = trimmed(reason);
  if (value.length < MIN_REASON) {
    throw new InterBranchValidationError("INTER_BRANCH_REASON_REQUIRED", `${label} wajib diisi (minimal ${MIN_REASON} karakter).`);
  }
  return value;
}

/** Satu-satunya tempat aturan pengaju != penyetuju (Spek §8.1). Peran OWNER berasal dari System DB. */
function assertCanDecide(principal: InterBranchPrincipal, requestedBy: string): void {
  if (principal.role === "OWNER") return;
  if (principal.userId === requestedBy) throw new SelfApprovalNotAllowedError();
}

async function loadTransaction(db: Knex, id: string): Promise<TxRow | undefined> {
  return db("inter_branch_transactions").where({ id }).first();
}

function canRead(principal: InterBranchPrincipal, tx: Pick<TxRow, "from_branch_id" | "to_branch_id">): boolean {
  return principal.canAct("interbranch.read", tx.from_branch_id) || principal.canAct("interbranch.read", tx.to_branch_id);
}

/** Tidak ada atau tidak terlihat => 404 identik (tidak membocorkan keberadaan). */
async function requireVisible(db: Knex, principal: InterBranchPrincipal, id: string): Promise<TxRow> {
  const tx = await loadTransaction(db, id);
  if (!tx || !canRead(principal, tx)) throw new InterBranchNotFoundError();
  return tx;
}

function statusError(tx: Pick<TxRow, "status">): Error {
  return tx.status === "EXPIRED" ? new InterBranchExpiredError() : new InterBranchStateChangedError();
}

async function requireActiveBranch(db: Knex, branchId: string, label: string): Promise<BranchRow> {
  const branch = await getBranch(db, branchId);
  if (!branch) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", `Cabang ${label} tidak ditemukan.`);
  if (branch.status !== "ACTIVE") {
    throw new InterBranchValidationError("INTER_BRANCH_BRANCH_NOT_ACTIVE", `Cabang ${label} "${branch.name}" tidak aktif sehingga tidak dapat bertransaksi.`);
  }
  return branch;
}

async function getExpiryDays(db: Knex): Promise<number> {
  const row = await db("company_profile").first("inter_branch_expiry_days as days");
  return Number(row?.days ?? 14);
}

async function audit(
  trx: Knex,
  principal: InterBranchPrincipal,
  action: string,
  tx: Pick<TxRow, "id" | "transaction_no" | "from_branch_id" | "to_branch_id" | "amount">,
  branchId: string,
  after: Record<string, unknown> = {},
  reason: string | null = null,
  before?: Record<string, unknown>,
): Promise<void> {
  await appendCompanyAudit(trx, {
    actor: principal.actor,
    action,
    entityType: INTER_BRANCH_AUDIT_ENTITY,
    entityId: tx.id,
    branchId,
    before,
    after: { transactionNo: tx.transaction_no, fromBranchId: tx.from_branch_id, toBranchId: tx.to_branch_id, amount: money(tx.amount), ...after },
    reason,
  });
}

/** Aturan akun sisi sendiri per jenis (Spek §5): TRANSFER_KAS = dua akun kas; PEMBEBANAN = bukan kas-ke-kas. */
function assertTypeAccountRules(type: InterBranchType, fromAccount: AccountRow, toAccount: AccountRow): void {
  if (type === "TRANSFER_KAS" && !(fromAccount.isCash && toAccount.isCash)) {
    throw new InterBranchValidationError("INTER_BRANCH_ACCOUNT_INVALID", "Transfer kas mewajibkan akun asal dan akun tujuan keduanya akun kas.");
  }
  if (type === "PEMBEBANAN" && fromAccount.isCash && toAccount.isCash) {
    throw new InterBranchValidationError("INTER_BRANCH_ACCOUNT_INVALID", "Kedua akun adalah akun kas: gunakan jenis Transfer Kas.");
  }
}

async function loadOwnSideAccount(db: Knex, accountId: string, label: string): Promise<AccountRow> {
  const account = await assertAccountUsable(db, accountId);
  if (account.branchPolicy === "INTER_BRANCH") {
    throw new InterBranchValidationError("INTER_BRANCH_ACCOUNT_INVALID", `Akun ${label} tidak boleh akun antar-cabang: akun antar-cabang dipilih otomatis oleh sistem.`);
  }
  return account;
}

// ------------------------------------------------------------------------------------------------ ajukan

export interface ProposeResult {
  id: string;
  transactionNo: string;
  /** true bila kunci idempotensi yang sama mengembalikan pengajuan yang sudah ada. */
  replayed: boolean;
}

export async function proposeInterBranch(db: Knex, principal: InterBranchPrincipal, input: ProposeInput, now: Date = new Date()): Promise<ProposeResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    const key = trimmed(input.idempotencyKey);
    if (key.length < 8 || key.length > 100) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Kunci pengajuan tidak valid.");
    if (!isInterBranchType(input.type)) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Jenis transaksi tidak dikenal. Pilih Transfer Kas atau Pembebanan.");
    const type = input.type;
    const amountCents = Number.isFinite(input.amount) ? toCents(input.amount) : 0n;
    if (amountCents <= 0n || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 1e-6) {
      throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Nominal harus lebih dari nol dengan maksimal dua desimal.");
    }
    if (!isValidIsoDate(input.transactionDate)) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Tanggal transaksi tidak valid (YYYY-MM-DD).");
    const description = trimmed(input.description);
    if (description.length < 3 || description.length > 500) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Keterangan wajib diisi (3-500 karakter).");
    const referenceText = trimmed(input.referenceText) || null;
    if (referenceText && referenceText.length > 100) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Nomor bukti maksimal 100 karakter.");
    if (input.fromBranchId === input.toBranchId) throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Cabang asal dan cabang tujuan harus berbeda.");
    if (!principal.canAct("interbranch.create", input.fromBranchId)) throw new InterBranchForbiddenError("Anda tidak berwenang mengajukan transaksi antar-cabang dari cabang ini.");

    const replayOrConflict = (existing: Record<string, any>): ProposeResult => {
      const same =
        existing.to_branch_id === input.toBranchId && existing.from_branch_id === input.fromBranchId && existing.type === type &&
        existing.transaction_date === input.transactionDate && toCents(money(existing.amount)) === amountCents;
      if (!same) throw new InterBranchIdempotencyConflictError();
      return { id: existing.id, transactionNo: existing.transaction_no, replayed: true };
    };
    const existing = await db("inter_branch_transactions").where({ proposed_by: principal.userId, idempotency_key: key }).first();
    if (existing) return replayOrConflict(existing);

    try {
      return await insertProposal();
    } catch (err) {
      // Pengajuan serempak dengan kunci yang sama dari proses lain: keduanya lolos pra-cek di atas, satu menang commit, dan
      // indeks UNIQUE (proposed_by, idempotency_key) menolak yang kalah. Itu BUKAN galat bagi pemanggil: ia menerima transaksi
      // pemenang sebagai replay idempoten (atau konflik bila isinya berbeda). Transaksi yang kalah sudah di-rollback penuh.
      if (isIdempotencyUniqueViolation(err)) {
        const winner = await db("inter_branch_transactions").where({ proposed_by: principal.userId, idempotency_key: key }).first();
        if (winner) return replayOrConflict(winner);
      }
      throw err;
    }

    function insertProposal(): Promise<ProposeResult> {
    return db.transaction(async (trx) => {
      const fromBranch = await requireActiveBranch(trx, input.fromBranchId, "asal");
      const toBranch = await requireActiveBranch(trx, input.toBranchId, "tujuan");
      await assertEntryDatePolicy(trx, input.transactionDate);
      const period = await resolvePeriodForDate(trx, input.transactionDate);
      if (!period) throw new InterBranchValidationError("INTER_BRANCH_PERIOD_NOT_FOUND", "Belum ada periode akuntansi yang memuat tanggal transaksi ini.");
      if (period.status !== "OPEN") throw new InterBranchValidationError("INTER_BRANCH_PERIOD_NOT_FOUND", `Periode "${period.label}" berstatus ${period.status} dan tidak menerima transaksi baru.`);

      const fromAccount = await loadOwnSideAccount(trx, input.fromAccountId, "asal");
      const toAccount = await loadOwnSideAccount(trx, input.toAccountSuggestedId, "tujuan");
      assertTypeAccountRules(type, fromAccount, toAccount);
      await assertAccountsAllowedForJournal(trx, [fromAccount.id], fromBranch, "inter_branch");
      await assertAccountsAllowedForJournal(trx, [toAccount.id], toBranch, "inter_branch");
      await resolveInterBranchAccounts(trx, { fromBranchId: fromBranch.id, toBranchId: toBranch.id });
      for (const counterpartyId of [input.fromCounterpartyId, input.toCounterpartyId]) {
        if (counterpartyId && !(await trx("counterparties").where({ id: counterpartyId }).first("id"))) {
          throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", "Pihak (counterparty) tidak ditemukan.");
        }
      }

      const id = crypto.randomUUID();
      const transactionNo = await allocateTransactionNo(trx, input.transactionDate);
      const proposedAt = now.toISOString();
      const expiresAt = calculateExpiresAt({
        proposedAt: now,
        expiryDays: await getExpiryDays(trx),
        transactionDate: input.transactionDate,
        maxBackdateDays: await getMaxBackdateDays(trx),
      });
      await trx("inter_branch_transactions").insert({
        id,
        transaction_no: transactionNo,
        type,
        transaction_date: input.transactionDate,
        from_branch_id: fromBranch.id,
        to_branch_id: toBranch.id,
        amount: money(input.amount),
        description,
        reference_text: referenceText,
        from_account_id: fromAccount.id,
        to_account_suggested_id: toAccount.id,
        from_counterparty_id: input.fromCounterpartyId ?? null,
        to_counterparty_id: input.toCounterpartyId ?? null,
        status: "WAITING_APPROVAL",
        proposed_by: principal.userId,
        idempotency_key: key,
        created_at: proposedAt,
        updated_at: proposedAt,
      });
      await trx("inter_branch_approvals").insert({
        id: crypto.randomUUID(),
        transaction_id: id,
        kind: "POST",
        status: "WAITING",
        requested_by: principal.userId,
        requested_by_branch_id: fromBranch.id,
        requested_at: proposedAt,
        expires_at: expiresAt,
      });
      const tx = { id, transaction_no: transactionNo, from_branch_id: fromBranch.id, to_branch_id: toBranch.id, amount: input.amount };
      const summary = { type, transactionDate: input.transactionDate, expiresAt };
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.CREATED, tx, fromBranch.id, summary);
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.SUBMITTED, tx, fromBranch.id, { ...summary, status: "WAITING_APPROVAL" });
      return { id, transactionNo, replayed: false };
    });
    }
  });
}

/** Pelanggaran indeks UNIQUE (proposed_by, idempotency_key) pada `inter_branch_transactions` (balapan idempotensi lintas-proses). */
export function isIdempotencyUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return Boolean(e && e.code === "SQLITE_CONSTRAINT_UNIQUE" && /inter_branch_transactions\.idempotency_key/.test(String(e.message)));
}

// ------------------------------------------------------------------------------------------------ setujui = terima = posting atomik

export interface DecisionResult {
  id: string;
  transactionNo: string;
  status: InterBranchStatus;
  reversalState: InterBranchReversalState;
}

export async function approveInterBranch(
  db: Knex,
  principal: InterBranchPrincipal,
  id: string,
  input: { confirmedAccountId?: string | null } = {},
  now: Date = new Date(),
): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      if (!principal.canAct("interbranch.approve", tx.to_branch_id)) throw new InterBranchForbiddenError("Anda tidak berwenang menyetujui transaksi untuk cabang tujuan ini.");
      assertCanDecide(principal, tx.proposed_by);
      if (tx.status !== "WAITING_APPROVAL") throw statusError(tx);

      // 1. validasi keadaan saat ini (dibaca ulang di dalam transaksi posting)
      const fromBranch = await requireActiveBranch(trx, tx.from_branch_id, "asal");
      const toBranch = await requireActiveBranch(trx, tx.to_branch_id, "tujuan");
      const period = await resolvePeriodForDate(trx, tx.transaction_date);
      if (!period) throw new InterBranchValidationError("INTER_BRANCH_PERIOD_NOT_FOUND", "Belum ada periode akuntansi yang memuat tanggal transaksi ini.");
      const suggestedId = tx.to_account_suggested_id;
      const fromAccount = await loadOwnSideAccount(trx, tx.from_account_id, "asal");
      const toAccount = await loadOwnSideAccount(trx, trimmed(input.confirmedAccountId) || suggestedId, "tujuan");
      assertTypeAccountRules(tx.type, fromAccount, toAccount);

      // 2. klaim bersyarat status (0 baris = sudah diputuskan pihak lain) -- mengunci tulis sebelum jurnal dibuat
      const decidedAt = now.toISOString();
      const selfApproved = principal.userId === tx.proposed_by;
      const claimed = await trx("inter_branch_transactions").where({ id, status: "WAITING_APPROVAL" }).update({ status: "COMPLETED", updated_at: decidedAt });
      if (claimed === 0) throw new InterBranchStateChangedError();
      const approvalClaimed = await trx("inter_branch_approvals")
        .where({ transaction_id: id, kind: "POST", status: "WAITING" })
        .update({ status: "APPROVED", decided_by: principal.userId, decided_at: decidedAt, self_approved: selfApproved ? 1 : 0, confirmed_account_id: toAccount.id });
      if (approvalClaimed === 0) throw new InterBranchStateChangedError();

      // 3. akun antar-cabang dipilih sistem
      const ib = await resolveInterBranchAccounts(trx, { fromBranchId: fromBranch.id, toBranchId: toBranch.id });

      // 4. dua jurnal -- fungsi jurnal yang ada dipanggil dengan `trx` (savepoint); kesalahan tidak ditangkap
      const amount = money(tx.amount);
      const memo = `${tx.transaction_no} ${tx.description}`.slice(0, 255);
      const post = async (side: "FROM" | "TO", branchId: string, lines: Array<{ accountId: string; debit: number; credit: number; counterpartyId?: string | null }>) => {
        const { id: journalId } = await createDraftJournalEntry(
          trx,
          {
            entryDate: tx.transaction_date,
            periodId: period.id,
            referenceNo: journalReferenceFor(tx.transaction_no, "ORIGINAL", side),
            description: memo,
            createdBy: tx.proposed_by,
            branchId,
            interBranch: { transactionId: id, side },
            lines: lines.map((l) => ({ ...l, memo })),
          },
          principal.actor,
        );
        await postJournalEntry(trx, { journalEntryId: journalId, postedBy: principal.userId }, principal.actor);
        return journalId;
      };
      const fromJournal = await post("FROM", fromBranch.id, [
        { accountId: ib.fromDebit.id, debit: amount, credit: 0 },
        { accountId: fromAccount.id, debit: 0, credit: amount, counterpartyId: tx.from_counterparty_id },
      ]);
      const toJournal = await post("TO", toBranch.id, [
        { accountId: toAccount.id, debit: amount, credit: 0, counterpartyId: tx.to_counterparty_id },
        { accountId: ib.toCredit.id, debit: 0, credit: amount },
      ]);

      // 5. pasca-kondisi: tepat dua jurnal ORIGINAL, seimbang, nominal & arah benar, persetujuan konsisten
      const violations = await verifyInterBranchIntegrity(trx, { transactionId: id });
      if (violations.length > 0) {
        throw new InterBranchValidationError("INTER_BRANCH_POSTING_INVALID", `Posting dibatalkan karena pemeriksaan integritas gagal: ${violations[0].message}`);
      }

      // 6. audit (satu transaksi yang sama)
      const decision = { status: "COMPLETED", actorRole: principal.role, makerEqualsApprover: selfApproved, self_approved: selfApproved };
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.APPROVED, tx, toBranch.id, decision);
      if (toAccount.id !== suggestedId) {
        await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.ACCOUNT_CONFIRMED, tx, toBranch.id, { accountId: toAccount.id }, null, { accountId: suggestedId });
      }
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.POSTED, tx, toBranch.id, { fromJournalId: fromJournal, toJournalId: toJournal, accountingEvent: "POSTED" });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.COMPLETED, tx, toBranch.id, { status: "COMPLETED" });
      return { id, transactionNo: tx.transaction_no, status: "COMPLETED" as const, reversalState: tx.reversal_state };
    });
  });
}

// ------------------------------------------------------------------------------------------------ tolak / batalkan

export async function rejectInterBranch(db: Knex, principal: InterBranchPrincipal, id: string, input: { reason: string }, now: Date = new Date()): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      if (!principal.canAct("interbranch.approve", tx.to_branch_id)) throw new InterBranchForbiddenError("Anda tidak berwenang menolak transaksi untuk cabang tujuan ini.");
      assertCanDecide(principal, tx.proposed_by);
      const reason = requireReason(input.reason, "Alasan penolakan");
      if (tx.status !== "WAITING_APPROVAL") throw statusError(tx);
      const at = now.toISOString();
      if ((await trx("inter_branch_transactions").where({ id, status: "WAITING_APPROVAL" }).update({ status: "REJECTED", updated_at: at })) === 0) throw new InterBranchStateChangedError();
      await trx("inter_branch_approvals")
        .where({ transaction_id: id, kind: "POST", status: "WAITING" })
        .update({ status: "REJECTED", decided_by: principal.userId, decided_at: at, decision_reason: reason });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.REJECTED, tx, tx.to_branch_id, { from: "WAITING_APPROVAL", to: "REJECTED", actorRole: principal.role }, reason);
      return { id, transactionNo: tx.transaction_no, status: "REJECTED" as const, reversalState: tx.reversal_state };
    });
  });
}

export async function cancelInterBranch(db: Knex, principal: InterBranchPrincipal, id: string, input: { reason?: string | null } = {}, now: Date = new Date()): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      // pengaju sendiri, atau OWNER (tindakan administratif atas pengajuan di cabang asal); wajib berwenang di cabang asal
      if (!principal.canAct("interbranch.create", tx.from_branch_id) || (principal.userId !== tx.proposed_by && principal.role !== "OWNER")) {
        throw new InterBranchForbiddenError("Hanya pengaju (atau OWNER) yang dapat membatalkan pengajuan ini.");
      }
      if (tx.status !== "WAITING_APPROVAL") throw statusError(tx);
      const at = now.toISOString();
      if ((await trx("inter_branch_transactions").where({ id, status: "WAITING_APPROVAL" }).update({ status: "CANCELLED", updated_at: at })) === 0) throw new InterBranchStateChangedError();
      await trx("inter_branch_approvals").where({ transaction_id: id, kind: "POST", status: "WAITING" }).update({ status: "CANCELLED" });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.CANCELLED, tx, tx.from_branch_id, { from: "WAITING_APPROVAL", to: "CANCELLED", actorRole: principal.role }, trimmed(input.reason) || null);
      return { id, transactionNo: tx.transaction_no, status: "CANCELLED" as const, reversalState: tx.reversal_state };
    });
  });
}

// ------------------------------------------------------------------------------------------------ reversal

/** Sisi lawan dari sisi pemohon reversal. */
function oppositeBranch(tx: TxRow, requestedByBranchId: string): string {
  return requestedByBranchId === tx.from_branch_id ? tx.to_branch_id : tx.from_branch_id;
}

export async function requestInterBranchReversal(db: Knex, principal: InterBranchPrincipal, id: string, input: { reason: string }, now: Date = new Date()): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      const side = principal.canAct("interbranch.reverse", tx.from_branch_id) ? tx.from_branch_id : principal.canAct("interbranch.reverse", tx.to_branch_id) ? tx.to_branch_id : null;
      if (!side) throw new InterBranchForbiddenError("Anda tidak berwenang meminta pembalikan transaksi ini.");
      const reason = requireReason(input.reason, "Alasan pembalikan");
      if (tx.status !== "COMPLETED" || tx.reversal_state !== "NOT_REVERSED") throw new InterBranchStateChangedError("Transaksi ini tidak dapat dimintakan pembalikan pada statusnya saat ini.");
      await requireActiveBranch(trx, tx.from_branch_id, "asal");
      await requireActiveBranch(trx, tx.to_branch_id, "tujuan");
      const period = await resolvePeriodForDate(trx, tx.transaction_date);
      if (!period || period.status !== "OPEN") {
        throw new InterBranchValidationError("INTER_BRANCH_PERIOD_NOT_FOUND", "Periode transaksi asal sudah ditutup atau dikunci. Buat transaksi koreksi berarah sebaliknya pada periode yang terbuka.");
      }
      const at = now.toISOString();
      if ((await trx("inter_branch_transactions").where({ id, status: "COMPLETED", reversal_state: "NOT_REVERSED" }).update({ reversal_state: "REVERSAL_WAITING", updated_at: at })) === 0) throw new InterBranchStateChangedError();
      await trx("inter_branch_approvals").insert({
        id: crypto.randomUUID(),
        transaction_id: id,
        kind: "REVERSE",
        status: "WAITING",
        requested_by: principal.userId,
        requested_by_branch_id: side,
        requested_at: at,
        request_reason: reason,
        expires_at: calculateExpiresAt({ proposedAt: now, expiryDays: await getExpiryDays(trx), transactionDate: tx.transaction_date, maxBackdateDays: null }),
      });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_REQUESTED, tx, side, { from: "NOT_REVERSED", to: "REVERSAL_WAITING" }, reason);
      return { id, transactionNo: tx.transaction_no, status: tx.status, reversalState: "REVERSAL_WAITING" as const };
    });
  });
}

async function waitingReversal(trx: Knex, tx: TxRow, approvalId?: string | null): Promise<ApprovalRow> {
  const q = trx("inter_branch_approvals").where({ transaction_id: tx.id, kind: "REVERSE", status: "WAITING" });
  if (approvalId) q.where({ id: approvalId });
  const approval: ApprovalRow | undefined = await q.first();
  if (!approval || tx.reversal_state !== "REVERSAL_WAITING") throw new InterBranchStateChangedError("Tidak ada permintaan pembalikan yang menunggu untuk transaksi ini.");
  return approval;
}

export async function approveInterBranchReversal(db: Knex, principal: InterBranchPrincipal, id: string, input: { approvalId?: string | null } = {}, now: Date = new Date()): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      const approval = await waitingReversal(trx, tx, input.approvalId);
      if (!principal.canAct("interbranch.approve", oppositeBranch(tx, approval.requested_by_branch_id))) {
        throw new InterBranchForbiddenError("Pembalikan harus disetujui oleh pihak berwenang di cabang lawan pemohon.");
      }
      assertCanDecide(principal, approval.requested_by);
      await requireActiveBranch(trx, tx.from_branch_id, "asal");
      await requireActiveBranch(trx, tx.to_branch_id, "tujuan");

      const at = now.toISOString();
      if ((await trx("inter_branch_transactions").where({ id, reversal_state: "REVERSAL_WAITING" }).update({ reversal_state: "REVERSED", updated_at: at })) === 0) throw new InterBranchStateChangedError();
      const selfApproved = principal.userId === approval.requested_by;
      if ((await trx("inter_branch_approvals").where({ id: approval.id, status: "WAITING" }).update({ status: "APPROVED", decided_by: principal.userId, decided_at: at, self_approved: selfApproved ? 1 : 0 })) === 0) {
        throw new InterBranchStateChangedError();
      }

      const originals: Array<{ id: string; side: "FROM" | "TO" }> = await trx("journal_entries")
        .where({ inter_branch_transaction_id: id, inter_branch_leg: "ORIGINAL" })
        .select("id", "inter_branch_side as side");
      if (originals.length !== 2) throw new InterBranchValidationError("INTER_BRANCH_POSTING_INVALID", "Jurnal asal transaksi tidak lengkap; pembalikan dibatalkan.");
      const reversalIds: Record<string, string> = {};
      for (const side of ["FROM", "TO"] as const) {
        const original = originals.find((o) => o.side === side)!;
        const { id: reversalId } = await reverseJournalEntry(
          trx,
          { journalEntryId: original.id, reversalReferenceNo: journalReferenceFor(tx.transaction_no, "REVERSAL", side), reason: approval.request_reason ?? "Pembalikan transaksi antar-cabang", reversedBy: principal.userId, interBranchTransactionId: id },
          principal.actor,
        );
        reversalIds[side] = reversalId;
      }
      const violations = await verifyInterBranchIntegrity(trx, { transactionId: id });
      if (violations.length > 0) throw new InterBranchValidationError("INTER_BRANCH_POSTING_INVALID", `Pembalikan dibatalkan karena pemeriksaan integritas gagal: ${violations[0].message}`);

      const branchId = oppositeBranch(tx, approval.requested_by_branch_id);
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_APPROVED, tx, branchId, { actorRole: principal.role, makerEqualsApprover: selfApproved, self_approved: selfApproved });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_POSTED, tx, branchId, { fromReversalJournalId: reversalIds.FROM, toReversalJournalId: reversalIds.TO, reversalState: "REVERSED" });
      return { id, transactionNo: tx.transaction_no, status: tx.status, reversalState: "REVERSED" as const };
    });
  });
}

export async function rejectInterBranchReversal(db: Knex, principal: InterBranchPrincipal, id: string, input: { reason: string; approvalId?: string | null }, now: Date = new Date()): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      const approval = await waitingReversal(trx, tx, input.approvalId);
      if (!principal.canAct("interbranch.approve", oppositeBranch(tx, approval.requested_by_branch_id))) throw new InterBranchForbiddenError("Pembalikan harus diputuskan oleh pihak berwenang di cabang lawan pemohon.");
      assertCanDecide(principal, approval.requested_by);
      const reason = requireReason(input.reason, "Alasan penolakan");
      const at = now.toISOString();
      if ((await trx("inter_branch_transactions").where({ id, reversal_state: "REVERSAL_WAITING" }).update({ reversal_state: "NOT_REVERSED", updated_at: at })) === 0) throw new InterBranchStateChangedError();
      await trx("inter_branch_approvals").where({ id: approval.id, status: "WAITING" }).update({ status: "REJECTED", decided_by: principal.userId, decided_at: at, decision_reason: reason });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_REJECTED, tx, oppositeBranch(tx, approval.requested_by_branch_id), { from: "REVERSAL_WAITING", to: "NOT_REVERSED", actorRole: principal.role }, reason);
      return { id, transactionNo: tx.transaction_no, status: tx.status, reversalState: "NOT_REVERSED" as const };
    });
  });
}

export async function cancelInterBranchReversal(db: Knex, principal: InterBranchPrincipal, id: string, input: { approvalId?: string | null; reason?: string | null } = {}, now: Date = new Date()): Promise<DecisionResult> {
  return guarded(db, async () => {
    await assertEnabled(db);
    await db.transaction((trx) => expireOverdueInterBranch(trx, now));
    return db.transaction(async (trx) => {
      const tx = await requireVisible(trx, principal, id);
      const approval = await waitingReversal(trx, tx, input.approvalId);
      if (!principal.canAct("interbranch.reverse", approval.requested_by_branch_id) || (principal.userId !== approval.requested_by && principal.role !== "OWNER")) {
        throw new InterBranchForbiddenError("Hanya pemohon (atau OWNER) yang dapat membatalkan permintaan pembalikan ini.");
      }
      const at = now.toISOString();
      if ((await trx("inter_branch_transactions").where({ id, reversal_state: "REVERSAL_WAITING" }).update({ reversal_state: "NOT_REVERSED", updated_at: at })) === 0) throw new InterBranchStateChangedError();
      await trx("inter_branch_approvals").where({ id: approval.id, status: "WAITING" }).update({ status: "CANCELLED" });
      await audit(trx, principal, INTER_BRANCH_AUDIT_ACTIONS.REVERSAL_CANCELLED, tx, approval.requested_by_branch_id, { from: "REVERSAL_WAITING", to: "NOT_REVERSED", actorRole: principal.role }, trimmed(input.reason) || null);
      return { id, transactionNo: tx.transaction_no, status: tx.status, reversalState: "NOT_REVERSED" as const };
    });
  });
}

// ------------------------------------------------------------------------------------------------ pengaturan

export async function getInterBranchSettings(db: Knex): Promise<{ expiryDays: number; minDays: number; maxDays: number }> {
  return { expiryDays: await getExpiryDays(db), minDays: INTER_BRANCH_EXPIRY_DAYS_MIN, maxDays: INTER_BRANCH_EXPIRY_DAYS_MAX };
}

/** Hanya OWNER (business rule yang sama dengan pengaturan perusahaan lain). Berlaku untuk pengajuan berikutnya. */
export async function setInterBranchExpiryDays(db: Knex, principal: InterBranchPrincipal, days: number): Promise<void> {
  if (principal.role !== "OWNER") throw new InterBranchForbiddenError("Hanya OWNER yang dapat mengubah masa berlaku pengajuan.");
  if (!Number.isInteger(days) || days < INTER_BRANCH_EXPIRY_DAYS_MIN || days > INTER_BRANCH_EXPIRY_DAYS_MAX) {
    throw new InterBranchValidationError("INTER_BRANCH_INVALID_INPUT", `Masa berlaku harus ${INTER_BRANCH_EXPIRY_DAYS_MIN}-${INTER_BRANCH_EXPIRY_DAYS_MAX} hari.`);
  }
  await guarded(db, () =>
    db.transaction(async (trx) => {
      const before = await getExpiryDays(trx);
      await trx("company_profile").update({ inter_branch_expiry_days: days, updated_at: new Date().toISOString() });
      await appendCompanyAudit(trx, {
        actor: principal.actor,
        action: INTER_BRANCH_AUDIT_ACTIONS.SETTINGS_CHANGED,
        entityType: "company_profile",
        entityId: "inter_branch_expiry_days",
        before: { expiryDays: before },
        after: { expiryDays: days },
      });
    }),
  );
}
