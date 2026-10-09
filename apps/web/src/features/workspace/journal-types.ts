/**
 * Tipe Journal + Journal Import utk workspace company-scoped baru
 * (TASK-DB-ARCH-014). Mencerminkan persis response `modules/company-
 * journal/routes.ts` & `modules/company-journal-import/routes.ts` --
 * SENGAJA tipe baru, TIDAK reuse `@konsultan/shared` (`JournalEntrySummary`
 * dkk milik model legacy shared-DB, lihat catatan `workspace/types.ts`).
 */

export type JournalStatus = "DRAFT" | "POSTED" | "REVERSED" | "VOID";

export interface JournalListItem {
  id: string;
  entryDate: string;
  referenceNo: string | null;
  description: string | null;
  status: JournalStatus;
  isOpeningBalance: boolean;
  periodId: string;
}

export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string | null;
  counterpartyId?: string | null;
}

export interface JournalEntryRow {
  id: string;
  entry_date: string;
  period_id: string;
  reference_no: string | null;
  description: string | null;
  source: "manual" | "import";
  status: JournalStatus;
  is_opening_balance: boolean;
  created_by: string | null;
  posted_by: string | null;
  posted_at: string | null;
  reversal_of_journal_id: string | null;
  is_reversed: boolean;
  reversal_reason: string | null;
  created_at: string;
}

export interface JournalLineRow {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: number;
  credit: number;
  memo: string | null;
  counterparty_id: string | null;
  line_order: number;
}

export interface JournalDetail {
  journal: JournalEntryRow;
  lines: JournalLineRow[];
}

export interface CreateJournalInput {
  referenceNo: string;
  description?: string | null;
  periodId: string;
  entryDate: string;
  isOpeningBalance?: boolean;
  lines: JournalLineInput[];
}

export interface Period {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "LOCKED" | "CLOSED";
}

// ---- Journal Import ("TERRA Import Standard": upload -> parse ->
// validate -> preview -> confirm -> commit -> audit) ----

export type ImportItemStatus = "VALID" | "WARNING" | "ERROR";

export interface ImportValidatedLine {
  rowNumber: number;
  accountCode: string;
  accountId: string | null;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
  issues: string[];
}

export interface ImportValidatedTransaction {
  index: number;
  referenceNo: string | null;
  date: string;
  periodId: string | null;
  periodLabel: string | null;
  lines: ImportValidatedLine[];
  totalDebit: number;
  totalCredit: number;
  status: ImportItemStatus;
  alreadyExists: boolean;
  issues: string[];
}

export interface ImportValidationResult {
  fileName: string;
  transactions: ImportValidatedTransaction[];
  totalTransactions: number;
  totalLines: number;
  totalDebit: number;
  totalCredit: number;
  validCount: number;
  warningCount: number;
  errorCount: number;
  fileErrors: string[];
  canCommit: boolean;
}

export interface ImportCommitResult {
  success: true;
  committedCount: number;
  skippedCount: number;
  referenceNumbers: string[];
}

export interface ImportHistoryItem {
  id: string;
  actorLabel: string;
  createdAt: string;
  fileName: string;
  committedCount: number;
  skippedCount: number;
  totalDebit: number;
  totalCredit: number;
  referenceNumbers: string[];
}
