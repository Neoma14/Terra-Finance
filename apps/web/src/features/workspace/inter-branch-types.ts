/**
 * Bentuk respons `modules/company-inter-branch/routes.ts`. Hanya tipe tampilan: seluruh keputusan izin, cakupan cabang,
 * pemisahan tugas (pengaju != penyetuju, kecuali OWNER), dan validasi akuntansi ditegakkan server. `capabilities` hanyalah
 * petunjuk untuk menampilkan tombol; server tetap menolak aksi yang tidak sah.
 */

export type InterBranchType = "TRANSFER_KAS" | "PEMBEBANAN";
export type InterBranchStatus = "WAITING_APPROVAL" | "COMPLETED" | "REJECTED" | "CANCELLED" | "EXPIRED";
export type InterBranchReversalState = "NOT_REVERSED" | "REVERSAL_WAITING" | "REVERSED";

export const INTER_BRANCH_TYPE_LABEL: Record<InterBranchType, string> = {
  TRANSFER_KAS: "Transfer Kas",
  PEMBEBANAN: "Pembebanan",
};

export const INTER_BRANCH_STATUS_LABEL: Record<InterBranchStatus, string> = {
  WAITING_APPROVAL: "Menunggu persetujuan",
  COMPLETED: "Selesai",
  REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan",
  EXPIRED: "Kedaluwarsa",
};

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
  selfApprovalBlocked: boolean;
  canCancel: boolean;
  canRequestReversal: boolean;
  canApproveReversal: boolean;
  canRejectReversal: boolean;
  canCancelReversal: boolean;
}

export interface ReversalRequestView {
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
  status: InterBranchStatus;
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
  reversal: ReversalRequestView | null;
  capabilities: InterBranchCapabilities;
}

export interface AccountView {
  id: string;
  code: string;
  name: string;
}
export interface InterBranchJournalView {
  referenceNo: string;
  leg: "ORIGINAL" | "REVERSAL";
  side: "FROM" | "TO";
  status: string;
  branchId: string;
  journalId: string | null;
  lines: Array<{ accountCode: string; accountName: string; debit: number; credit: number }> | null;
}
export interface InterBranchHistoryItem {
  action: string;
  actorLabel: string;
  createdAt: string;
  reason: string | null;
  branchId: string | null;
}
export interface InterBranchDetail extends InterBranchListItem {
  fromAccount: AccountView | null;
  toAccountSuggested: AccountView | null;
  toAccountConfirmed: AccountView | null;
  journals: InterBranchJournalView[];
  history: InterBranchHistoryItem[];
}

export interface InterBranchListFilters {
  box?: "in" | "out" | "all";
  status?: InterBranchStatus | "";
  type?: InterBranchType | "";
  search?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

export interface InterBranchDestination extends BranchRef {
  ready: boolean;
  reason: string | null;
}
export interface InterBranchOptions {
  fromBranch: BranchRef;
  destinations: InterBranchDestination[];
}

export interface CreateInterBranchInput {
  type: InterBranchType;
  toBranchId: string;
  transactionDate: string;
  amount: number;
  fromAccountId: string;
  toAccountSuggestedId: string;
  description: string;
  referenceText?: string | null;
  idempotencyKey: string;
}

/** Nama peristiwa audit -> label tampilan. */
export const INTER_BRANCH_EVENT_LABEL: Record<string, string> = {
  INTER_BRANCH_CREATED: "Transaksi dibuat",
  INTER_BRANCH_SUBMITTED: "Diajukan ke cabang tujuan",
  INTER_BRANCH_APPROVED: "Disetujui",
  INTER_BRANCH_ACCOUNT_CONFIRMED: "Akun penerima dikonfirmasi",
  INTER_BRANCH_POSTED: "Jurnal kedua cabang diposting",
  INTER_BRANCH_COMPLETED: "Transaksi selesai",
  INTER_BRANCH_REJECTED: "Ditolak",
  INTER_BRANCH_CANCELLED: "Dibatalkan",
  INTER_BRANCH_EXPIRED: "Kedaluwarsa",
  INTER_BRANCH_REVERSAL_REQUESTED: "Pembalikan diminta",
  INTER_BRANCH_REVERSAL_APPROVED: "Pembalikan disetujui",
  INTER_BRANCH_REVERSAL_POSTED: "Jurnal pembalikan diposting",
  INTER_BRANCH_REVERSAL_REJECTED: "Pembalikan ditolak",
  INTER_BRANCH_REVERSAL_CANCELLED: "Permintaan pembalikan dibatalkan",
  INTER_BRANCH_REVERSAL_EXPIRED: "Permintaan pembalikan kedaluwarsa",
};
