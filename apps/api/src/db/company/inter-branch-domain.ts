import type { Knex } from "knex";
import { subtractDays } from "./journal-policy.js";

/**
 * Model domain transaksi antar-cabang (IB-1). Tanpa HTTP dan tanpa efek samping, kecuali
 * `allocateTransactionNo` yang hanya membaca. Aturan di sini mencerminkan penjaga database
 * (C0019); database tetap lapisan terakhir.
 */

export const INTER_BRANCH_TYPES = ["TRANSFER_KAS", "PEMBEBANAN"] as const;
export type InterBranchType = (typeof INTER_BRANCH_TYPES)[number];

/** Jalur Business Transaction (Spek §7.1). `COMPLETED` bukan `POSTED`: accounting event diturunkan dari jurnal. */
export const INTER_BRANCH_STATUSES = ["WAITING_APPROVAL", "COMPLETED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export type InterBranchStatus = (typeof INTER_BRANCH_STATUSES)[number];

/** Jalur Reversal (Spek §7.3). */
export const INTER_BRANCH_REVERSAL_STATES = ["NOT_REVERSED", "REVERSAL_WAITING", "REVERSED"] as const;
export type InterBranchReversalState = (typeof INTER_BRANCH_REVERSAL_STATES)[number];

export type InterBranchLeg = "ORIGINAL" | "REVERSAL";
export type InterBranchSide = "FROM" | "TO";

export const INTER_BRANCH_REFERENCE_PREFIX = "IB-";

/** Entitas dan event audit (Spek §15). Audit ditulis di `company_audit_log` dengan `branch_id` cabang pelaku. */
export const INTER_BRANCH_AUDIT_ENTITY = "inter_branch_transaction";
export const INTER_BRANCH_AUDIT_ACTIONS = {
  CREATED: "INTER_BRANCH_CREATED",
  SUBMITTED: "INTER_BRANCH_SUBMITTED",
  APPROVED: "INTER_BRANCH_APPROVED",
  ACCOUNT_CONFIRMED: "INTER_BRANCH_ACCOUNT_CONFIRMED",
  POSTED: "INTER_BRANCH_POSTED",
  COMPLETED: "INTER_BRANCH_COMPLETED",
  REJECTED: "INTER_BRANCH_REJECTED",
  CANCELLED: "INTER_BRANCH_CANCELLED",
  EXPIRED: "INTER_BRANCH_EXPIRED",
  REVERSAL_REQUESTED: "INTER_BRANCH_REVERSAL_REQUESTED",
  REVERSAL_APPROVED: "INTER_BRANCH_REVERSAL_APPROVED",
  REVERSAL_POSTED: "INTER_BRANCH_REVERSAL_POSTED",
  REVERSAL_REJECTED: "INTER_BRANCH_REVERSAL_REJECTED",
  REVERSAL_CANCELLED: "INTER_BRANCH_REVERSAL_CANCELLED",
  REVERSAL_EXPIRED: "INTER_BRANCH_REVERSAL_EXPIRED",
  SETTINGS_CHANGED: "INTER_BRANCH_SETTINGS_CHANGED",
} as const;

const STATUS_TRANSITIONS: Record<InterBranchStatus, readonly InterBranchStatus[]> = {
  WAITING_APPROVAL: ["COMPLETED", "REJECTED", "CANCELLED", "EXPIRED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

const REVERSAL_TRANSITIONS: Record<InterBranchReversalState, readonly InterBranchReversalState[]> = {
  NOT_REVERSED: ["REVERSAL_WAITING"],
  REVERSAL_WAITING: ["REVERSED", "NOT_REVERSED"],
  REVERSED: [],
};

export function isValidStatusTransition(from: InterBranchStatus, to: InterBranchStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function isValidReversalTransition(from: InterBranchReversalState, to: InterBranchReversalState): boolean {
  return REVERSAL_TRANSITIONS[from].includes(to);
}

/** Reversal hanya sah pada transaksi COMPLETED (CHECK database yang sama). */
export function isValidStateCombination(status: InterBranchStatus, reversalState: InterBranchReversalState): boolean {
  return reversalState === "NOT_REVERSED" || status === "COMPLETED";
}

/** Transaksi masih menunggu keputusan -- dasar K-3 (flag tidak boleh dimatikan). */
export function isPendingInterBranch(status: InterBranchStatus, reversalState: InterBranchReversalState): boolean {
  return status === "WAITING_APPROVAL" || reversalState === "REVERSAL_WAITING";
}

export function isInterBranchType(value: unknown): value is InterBranchType {
  return typeof value === "string" && (INTER_BRANCH_TYPES as readonly string[]).includes(value);
}

// ------------------------------------------------------------------------------------------ referensi

/** Normalisasi untuk perbandingan: spasi pinggir dibuang dan huruf besar (UNIQUE `reference_no` peka huruf besar-kecil). */
export function normalizeReference(reference: string): string {
  return reference.trim().toUpperCase();
}

export function isReservedInterBranchReference(reference: string | null | undefined): boolean {
  return typeof reference === "string" && normalizeReference(reference).startsWith(INTER_BRANCH_REFERENCE_PREFIX);
}

export function formatTransactionNo(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new RangeError(`Tahun nomor transaksi tidak valid: ${year}`);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999_999) throw new RangeError(`Urutan nomor transaksi tidak valid: ${sequence}`);
  return `${INTER_BRANCH_REFERENCE_PREFIX}${year}-${String(sequence).padStart(6, "0")}`;
}

/** Referensi jurnal deterministik: `<no>-F`, `<no>-T`, `<no>-F-REV`, `<no>-T-REV`. */
export function journalReferenceFor(transactionNo: string, leg: InterBranchLeg, side: InterBranchSide): string {
  return `${transactionNo}-${side === "FROM" ? "F" : "T"}${leg === "REVERSAL" ? "-REV" : ""}`;
}

export function allJournalReferencesFor(transactionNo: string): string[] {
  return (["ORIGINAL", "REVERSAL"] as const).flatMap((leg) => (["FROM", "TO"] as const).map((side) => journalReferenceFor(transactionNo, leg, side)));
}

export class InterBranchNumberingError extends Error {
  readonly code = "INTER_BRANCH_NUMBERING_EXHAUSTED" as const;
}

/**
 * Nomor berikutnya `IB-<tahun transaction_date>-<urutan>`: MAX+1 per tahun, dilewati bila nomor atau salah satu
 * referensi jurnal turunannya sudah dipakai (mis. referensi lama berawalan `IB-` di mesin klien). Membaca saja;
 * pemanggil harus memanggilnya di dalam transaksi pembuat (UNIQUE `transaction_no` tetap pengaman terakhir).
 */
export async function allocateTransactionNo(db: Knex, transactionDate: string): Promise<string> {
  const year = Number(transactionDate.slice(0, 4));
  const prefix = `${INTER_BRANCH_REFERENCE_PREFIX}${year}-`;
  const row = await db("inter_branch_transactions")
    .where("transaction_no", "like", `${prefix}%`)
    .max({ m: "transaction_no" })
    .first();
  let sequence = row?.m ? Number(String(row.m).slice(prefix.length)) + 1 : 1;
  for (; sequence <= 999_999; sequence += 1) {
    const candidate = formatTransactionNo(year, sequence);
    const taken = await db("journal_entries").whereIn("reference_no", allJournalReferencesFor(candidate)).first("id");
    if (!taken) return candidate;
  }
  throw new InterBranchNumberingError(`Nomor transaksi antar-cabang tahun ${year} sudah habis.`);
}

// ------------------------------------------------------------------------------------------ kedaluwarsa

export const INTER_BRANCH_EXPIRY_DAYS_MIN = 1;
export const INTER_BRANCH_EXPIRY_DAYS_MAX = 90;

export interface ExpiryInput {
  /** Waktu pengajuan. */
  proposedAt: Date;
  expiryDays: number;
  /** Tanggal akuntansi `YYYY-MM-DD`. */
  transactionDate: string;
  /** Batas backdate perusahaan; `null` = tanpa batas. */
  maxBackdateDays: number | null;
}

/**
 * `expires_at` = min(proposedAt + expiryDays, akhir hari (transaction_date + maxBackdateDays)), jam lokal
 * komputer -- sama dengan "hari ini" pada kebijakan tanggal jurnal. Batas kedua mencegah pengajuan yang
 * mustahil disetujui karena kebijakan backdate. Hasil: ISO-8601 UTC.
 */
export function calculateExpiresAt(input: ExpiryInput): string {
  if (!Number.isInteger(input.expiryDays) || input.expiryDays < INTER_BRANCH_EXPIRY_DAYS_MIN || input.expiryDays > INTER_BRANCH_EXPIRY_DAYS_MAX) {
    throw new RangeError(`Masa berlaku harus ${INTER_BRANCH_EXPIRY_DAYS_MIN}-${INTER_BRANCH_EXPIRY_DAYS_MAX} hari.`);
  }
  const byDays = new Date(input.proposedAt.getTime());
  byDays.setDate(byDays.getDate() + input.expiryDays);
  if (input.maxBackdateDays === null) return byDays.toISOString();

  const lastValidDay = subtractDays(input.transactionDate, -input.maxBackdateDays);
  const [y, m, d] = lastValidDay.split("-").map(Number);
  const byBackdate = new Date(y, m - 1, d, 23, 59, 59, 999);
  return (byBackdate < byDays ? byBackdate : byDays).toISOString();
}

export function isInterBranchExpired(expiresAt: string, now: Date): boolean {
  return now.getTime() > new Date(expiresAt).getTime();
}
