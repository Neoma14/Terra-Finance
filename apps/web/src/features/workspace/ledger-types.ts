/**
 * Tipe Ledger -- cermin PERSIS response `db/company/ledger-service.ts`
 * via `modules/company-ledger/routes.ts` (TASK-DB-ARCH-011/012, backend
 * TIDAK diubah task ini). TASK-DB-ARCH-017: frontend HANYA consumer --
 * field di sini sengaja sama persis dgn `AccountLedgerResult`/
 * `LedgerLineRow` backend, bukan bentuk baru.
 */

export interface LedgerLineRow {
  journalEntryId: string;
  entryDate: string;
  referenceNo: string | null;
  memo: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface AccountLedgerResult {
  accountId: string;
  fromDate: string;
  toDate: string;
  periodId?: string;
  openingBalance: number;
  lines: LedgerLineRow[];
  endingBalance: number;
}
