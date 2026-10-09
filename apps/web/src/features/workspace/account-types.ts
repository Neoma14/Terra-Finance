/**
 * Tipe COA + COA Import utk workspace company-scoped baru
 * (TASK-DB-ARCH-015). Mencerminkan persis response `modules/company-
 * accounts/routes.ts` & `modules/company-accounts-import/routes.ts` --
 * SENGAJA tipe baru, TIDAK reuse `@konsultan/shared` (model legacy
 * shared-DB, lihat catatan `workspace/types.ts` & `journal-types.ts`).
 */

export interface AccountTypeOption {
  id: string;
  code: string;
  name: string;
  normalBalance: "debit" | "credit";
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  accountTypeId: string;
  accountSubtype: string | null;
  normalBalance: "debit" | "credit";
  parentAccountId: string | null;
  isActive: boolean;
  isSystemAccount: boolean;
  cashFlowActivity: string | null;
  isCash: boolean;
  subledgerType: string | null;
  isLocked?: boolean;
}

export interface AccountListFilters {
  search?: string;
  accountTypeId?: string;
  isActive?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CreateAccountInput {
  code: string;
  name: string;
  accountTypeCode: string;
  normalBalance: "debit" | "credit";
  accountSubtype?: string | null;
  parentAccountId?: string | null;
  cashFlowActivity?: string | null;
  isCash?: boolean;
  subledgerType?: string | null;
}

export interface UpdateAccountInput {
  name?: string;
  normalBalance?: "debit" | "credit";
  isActive?: boolean;
  accountSubtype?: string | null;
  parentAccountId?: string | null;
  cashFlowActivity?: string | null;
  isCash?: boolean;
  subledgerType?: string | null;
}

// ---- COA Import ("TERRA Import Standard") ----

export type AccountImportStatus = "NEW" | "EXISTING" | "WARNING" | "ERROR";

export interface ValidatedAccountImportRow {
  rowNumber: number;
  code: string;
  name: string;
  accountTypeCode: string | null;
  parentCode: string | null;
  normalBalance: "debit" | "credit" | null;
  isActive: boolean;
  isCash: boolean;
  cashFlowActivity: string | null;
  subledgerType: string | null;
  status: AccountImportStatus;
  issues: string[];
}

export interface AccountImportValidationResult {
  fileName: string;
  rows: ValidatedAccountImportRow[];
  totalRows: number;
  newCount: number;
  existingCount: number;
  warningCount: number;
  errorCount: number;
  fileErrors: string[];
  canCommit: boolean;
}

export interface AccountImportCommitResult {
  success: true;
  createdCount: number;
  skippedCount: number;
  createdCodes: string[];
}

export interface AccountImportHistoryItem {
  id: string;
  actorLabel: string;
  createdAt: string;
  fileName: string;
  createdCount: number;
  skippedCount: number;
  createdCodes: string[];
}
