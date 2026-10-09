/** Cermin PERSIS response `db/company/trial-balance-service.ts` (backend
 * TIDAK diubah, TASK-DB-ARCH-017 §2). */

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
  /** Baris sintetis "Laba (Rugi) Belum Ditutup" -- bukan akun, tidak punya ledger. */
  isBridge?: boolean;
}

export interface TrialBalanceResult {
  periodId: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
  difference: number;
}
