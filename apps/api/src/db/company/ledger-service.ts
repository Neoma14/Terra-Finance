import { isValidIsoDate } from "../../lib/calendar-date.js";
import type { Knex } from "knex";
import { getAccount, AccountNotFoundError } from "./account-service.js";
import { loadPeriodOrThrow } from "./fiscal-period.js";
import { InvalidDateRangeError } from "./reporting/reporting-types.js";
import { applyBranchScope, type AuthorizedScope } from "./report-scope.js";

/**
 * General Ledger (TASK-DB-ARCH-011 Part B §31-32). HANYA journal yang
 * PERNAH efektif diposting (`status IN ('POSTED','REVERSED')`) yang masuk
 * ledger -- DRAFT/VOID dikecualikan secara struktural (§31: "hanya posted
 * yang masuk ledger"). PENTING: status REVERSED BUKAN "dikecualikan" --
 * entry yang sudah di-reversal TETAP tercatat historis di ledger (ia
 * BENAR-BENAR terjadi & posted saat itu, Accounting_Rules.md §9 "posted
 * tidak boleh diedit/dihapus" berlaku juga scr efek ke ledger), reversal-
 * nya sendiri (entry BARU, status POSTED) MENAMBAH baris baru yang
 * meng-offset efeknya -- bukan menggantikannya secara retroaktif. Kalau
 * REVERSED dikecualikan, efek original akan "menghilang" sementara efek
 * reversal tetap mengurangi saldo -- mengurangi DUA KALI, salah secara
 * akuntansi (ditemukan & diperbaiki lewat test, lihat ledger-service.test.ts).
 *
 * Opening balance per periode dihitung LIVE dari seluruh baris POSTED
 * sebelum `period.start_date` (bukan dari `trial_balance_snapshots`, yang
 * TIDAK PERNAH diisi oleh journal-service.ts Company DB -- berbeda dari
 * `modules/journal/posting.ts` shared-DB lama yang punya recompute
 * terpisah). Account "flow" (revenue/expense/COGS/other income/other
 * expense) SELALU mulai dari nol tiap periode (tidak carry-forward),
 * sama persis logika `isFlow` di posting.ts lama.
 */

const FLOW_ACCOUNT_TYPE_CODES = new Set(["REVENUE", "EXPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"]);
// TAX sengaja diperlakukan sbg balance-type (carry-forward) -- Accounting_Rules.md
// tidak menentukan ini eksplisit (lihat Architecture_Contract.md/audit
// TASK-DB-ARCH-003 C0002), keputusan diambil di sini & didokumentasikan,
// bukan diam-diam.

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
  /** Rentang tanggal (inklusif) yang dipakai query. */
  fromDate: string;
  toDate: string;
  /** Hanya terisi bila ledger diminta lewat periode (kompatibilitas drill-down). */
  periodId?: string;
  openingBalance: number;
  lines: LedgerLineRow[];
  endingBalance: number;
}

async function isFlowAccount(db: Knex, accountTypeId: string): Promise<boolean> {
  const accountType = await db("account_types").where({ id: accountTypeId }).first();
  return Boolean(accountType && FLOW_ACCOUNT_TYPE_CODES.has(accountType.code));
}

function signedMovement(normalBalance: "debit" | "credit", debit: number, credit: number): number {
  return normalBalance === "debit" ? debit - credit : credit - debit;
}

/** Saldo akun dari SELURUH baris POSTED sebelum `beforeDate` (exclusive) --
 * dipakai sbg opening balance satu periode. Account flow selalu 0
 * (§31/§32, tidak carry-forward). */
export async function getAccountBalanceBeforeDate(db: Knex, accountId: string, beforeDate: string, scope?: AuthorizedScope): Promise<number> {
  const account = await getAccount(db, accountId);
  if (!account) throw new AccountNotFoundError(`Akun dengan id "${accountId}" tidak ditemukan.`);

  if (await isFlowAccount(db, account.accountTypeId)) return 0;

  const balanceQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .where("jel.account_id", accountId)
    .whereIn("je.status", ["POSTED", "REVERSED"])
    .andWhere("je.entry_date", "<", beforeDate);
  const row = await applyBranchScope(balanceQuery, scope) // Phase 5: tanpa cakupan penyaring, SQL identik dengan sebelumnya
    .select(db.raw("COALESCE(SUM(jel.debit), 0) as debitTotal"), db.raw("COALESCE(SUM(jel.credit), 0) as creditTotal"))
    .first();

  return signedMovement(account.normalBalance, Number((row as any)?.debitTotal ?? 0), Number((row as any)?.creditTotal ?? 0));
}

export { isValidIsoDate };

/**
 * Ledger akun untuk rentang tanggal [fromDate, toDate] -- KEDUA ujung
 * inklusif (transaksi tepat pada fromDate dan toDate ikut).
 *
 * Saldo awal = saldo SEBELUM fromDate (semua jurnal POSTED/REVERSED
 * bertanggal < fromDate). Akun flow (pendapatan/beban) tetap bersaldo awal 0
 * pada fromDate -- konvensi sistem yang sama dengan ledger per periode dan
 * Trial Balance: ledger akun laba-rugi menunjukkan aktivitas dalam rentang.
 *
 * Filter memakai `entry_date`, BUKAN `period_id`: jurnal yang tanggalnya
 * ada di rentang selalu ikut, apa pun periodenya.
 */
export async function getAccountLedgerByRange(db: Knex, accountId: string, fromDate: string, toDate: string, scope?: AuthorizedScope): Promise<AccountLedgerResult> {
  if (!fromDate || !toDate) throw new InvalidDateRangeError("Tanggal Dari dan Tanggal Sampai wajib diisi.");
  if (!isValidIsoDate(fromDate)) throw new InvalidDateRangeError(`Tanggal Dari "${fromDate}" bukan tanggal yang valid (format YYYY-MM-DD).`);
  if (!isValidIsoDate(toDate)) throw new InvalidDateRangeError(`Tanggal Sampai "${toDate}" bukan tanggal yang valid (format YYYY-MM-DD).`);
  if (fromDate > toDate) throw new InvalidDateRangeError(`Tanggal Dari (${fromDate}) tidak boleh setelah Tanggal Sampai (${toDate}).`);

  const account = await getAccount(db, accountId);
  if (!account) throw new AccountNotFoundError(`Akun dengan id "${accountId}" tidak ditemukan.`);

  const isFlow = await isFlowAccount(db, account.accountTypeId);
  const openingBalance = isFlow ? 0 : await getAccountBalanceBeforeDate(db, accountId, fromDate, scope);

  const linesQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .where("jel.account_id", accountId)
    .andWhere("je.entry_date", ">=", fromDate)
    .andWhere("je.entry_date", "<=", toDate)
    .whereIn("je.status", ["POSTED", "REVERSED"]); // §31 -- lihat komentar header file ttg REVERSED tetap tercatat
  const lines = await applyBranchScope(linesQuery, scope)
    // Urutan deterministik: tanggal, lalu urutan pembuatan jurnal, lalu
    // nomor referensi/id (pemutus seri), lalu urutan baris di dalam jurnal.
    // Tanpa ini baris dari dua jurnal bertanggal sama bisa tercampur karena
    // hanya `line_order` yang membedakan.
    .orderBy([{ column: "je.entry_date" }, { column: "je.created_at" }, { column: "je.reference_no" }, { column: "je.id" }, { column: "jel.line_order" }])
    .select(
      "je.id as journalEntryId",
      "je.entry_date as entryDate",
      "je.reference_no as referenceNo",
      "jel.memo",
      "jel.debit",
      "jel.credit",
    );

  let runningBalance = openingBalance;
  const ledgerLines: LedgerLineRow[] = lines.map((l: any) => {
    runningBalance += signedMovement(account.normalBalance, Number(l.debit), Number(l.credit));
    return {
      journalEntryId: l.journalEntryId,
      entryDate: String(l.entryDate).slice(0, 10),
      referenceNo: l.referenceNo,
      memo: l.memo,
      debit: Number(l.debit),
      credit: Number(l.credit),
      runningBalance,
    };
  });

  return { accountId, fromDate, toDate, openingBalance, lines: ledgerLines, endingBalance: runningBalance };
}

/** Ledger per periode fiskal (dipakai drill-down Trial Balance) -- hanya
 * menerjemahkan periode ke rentang tanggalnya, lalu memakai query yang sama. */
export async function getAccountLedger(db: Knex, accountId: string, periodId: string, scope?: AuthorizedScope): Promise<AccountLedgerResult> {
  const period = await loadPeriodOrThrow(db, periodId);
  const { start_date, end_date } = period as unknown as { start_date: string; end_date: string };
  const result = await getAccountLedgerByRange(db, accountId, String(start_date).slice(0, 10), String(end_date).slice(0, 10), scope);
  return { ...result, periodId };
}
