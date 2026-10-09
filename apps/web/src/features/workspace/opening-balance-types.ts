/**
 * Tipe Opening Balance + Import (TASK-DB-ARCH-016). Mencerminkan persis
 * response `modules/company-opening-balance/routes.ts` & `modules/
 * company-opening-balance-import/routes.ts` -- SENGAJA tipe baru, TIDAK
 * reuse `@konsultan/shared` (lihat catatan `journal-types.ts`/
 * `account-types.ts`).
 */

export type OpeningBalanceStatus = "DRAFT" | "POSTED" | "REVERSED";

export interface OpeningBalanceLineInput {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string | null;
}

export interface OpeningBalanceLineSummary {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface OpeningBalanceSummary {
  exists: boolean;
  id: string | null;
  status: OpeningBalanceStatus | null;
  entryDate: string | null;
  periodId: string | null;
  periodLabel: string | null;
  referenceNo: string | null;
  lines: OpeningBalanceLineSummary[];
  totalDebit: number;
  totalCredit: number;
  difference: number;
  isBalanced: boolean;
}

export interface UpsertOpeningBalanceInput {
  entryDate: string;
  periodId: string;
  lines: OpeningBalanceLineInput[];
}

// ---- Import ("TERRA Import Standard") ----

export type OpeningBalanceImportRowStatus = "VALID" | "WARNING" | "ERROR";

export interface ValidatedOpeningBalanceImportRow {
  rowNumber: number;
  code: string;
  name: string;
  accountId: string | null;
  debit: number;
  credit: number;
  memo: string;
  status: OpeningBalanceImportRowStatus;
  issues: string[];
}

export interface OpeningBalanceImportValidationResult {
  fileName: string;
  openingDate: string | null;
  periodId: string | null;
  periodLabel: string | null;
  rows: ValidatedOpeningBalanceImportRow[];
  totalRows: number;
  validCount: number;
  warningCount: number;
  errorCount: number;
  totalDebit: number;
  totalCredit: number;
  difference: number;
  isBalanced: boolean;
  fileErrors: string[];
  canCommit: boolean;
}

export interface OpeningBalanceImportCommitResult {
  success: true;
  id: string;
  lineCount: number;
}
