import type { Knex } from "knex";
import { listAccounts } from "./account-service.js";
import { loadPeriodOrThrow } from "./fiscal-period.js";
import { getAccountBalanceBeforeDate } from "./ledger-service.js";
import { classifyAccounts, getCumulativeUnclosedProfitLoss, UNCLOSED_PROFIT_LOSS_CODE } from "./reporting/reporting-utils.js";
import { applyBranchScope, type AuthorizedScope } from "./report-scope.js";

/**
 * Trial Balance (TASK-DB-ARCH-011 Part B §33). Sumber: journal yang pernah
 * efektif diposting (`status IN ('POSTED','REVERSED')` -- lihat alasan
 * lengkap REVERSED tetap dihitung di komentar header `ledger-service.ts`)
 * + opening balance yang valid (`ledger-service.ts`, live-computed, bukan
 * `trial_balance_snapshots` yang tidak diisi Company DB service layer
 * manapun). Presentasi baris
 * memakai konvensi trial balance baku: saldo akhir akun ditempatkan di
 * kolom Debit/Kredit sesuai ARAH saldo-nya (bukan sesuai `normal_balance`
 * tipe akun secara buta) -- akun kontra (mis. akumulasi depresiasi,
 * normal_balance debit tapi saldo akhirnya negatif/credit-arah) tetap
 * muncul di kolom yang benar.
 *
 * `isBalanced` dihitung TANPA toleransi apa pun (Accounting_Rules.md §19:
 * "jangan menyembunyikan selisih") -- kalau Total Debit != Total Credit,
 * ditampilkan APA ADANYA, bukan dibulatkan/disembunyikan.
 */

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
  /** true utk baris sintetis "Laba (Rugi) Belum Ditutup" -- bukan akun di
   * COA, tidak punya ledger. */
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

function signedMovement(normalBalance: "debit" | "credit", debit: number, credit: number): number {
  return normalBalance === "debit" ? debit - credit : credit - debit;
}

export async function getTrialBalance(db: Knex, periodId: string, scope?: AuthorizedScope): Promise<TrialBalanceResult> {
  const period = await loadPeriodOrThrow(db, periodId);
  const periodStartDate = (period as unknown as { start_date: string }).start_date;

  const accounts = await listAccounts(db);

  const movementQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .where("je.period_id", periodId)
    .whereIn("je.status", ["POSTED", "REVERSED"]);
  const movements = await applyBranchScope(movementQuery, scope)
    .groupBy("jel.account_id")
    .select("jel.account_id as accountId", db.raw("COALESCE(SUM(jel.debit), 0) as debitTotal"), db.raw("COALESCE(SUM(jel.credit), 0) as creditTotal"));
  const movementByAccount = new Map(movements.map((m: any) => [m.accountId, { debit: Number(m.debitTotal), credit: Number(m.creditTotal) }]));

  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const account of accounts) {
    const accountType = await db("account_types").where({ id: account.accountTypeId }).first();
    const isFlow = Boolean(accountType && ["REVENUE", "EXPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"].includes(accountType.code));
    const opening = isFlow ? 0 : await getAccountBalanceBeforeDate(db, account.id, periodStartDate, scope);
    const movement = movementByAccount.get(account.id) ?? { debit: 0, credit: 0 };
    const endingSigned = opening + signedMovement(account.normalBalance, movement.debit, movement.credit);

    // endingSigned > 0 = arah "normal" akun (debit utk akun debit-normal,
    // dst); endingSigned < 0 = arah kontra -- taruh di kolom berlawanan.
    let debitColumn = 0;
    let creditColumn = 0;
    if (account.normalBalance === "debit") {
      if (endingSigned >= 0) debitColumn = endingSigned;
      else creditColumn = -endingSigned;
    } else {
      if (endingSigned >= 0) creditColumn = endingSigned;
      else debitColumn = -endingSigned;
    }

    if (debitColumn === 0 && creditColumn === 0 && !movementByAccount.has(account.id)) {
      continue; // akun tanpa saldo & tanpa aktivitas periode ini -- tidak perlu ditampilkan
    }

    rows.push({ accountId: account.id, code: account.code, name: account.name, debit: debitColumn, credit: creditColumn });
    totalDebit += debitColumn;
    totalCredit += creditColumn;
  }

  // BUG-005 (Final UAT): saldo akun neraca dibawa dari SEBELUM awal periode,
  // tetapi akun laba rugi mulai dari nol tiap periode dan TERRA tidak membuat
  // jurnal penutup. Laba (rugi) kumulatif periode-periode sebelumnya jadi
  // tidak punya tempat, sehingga Trial Balance periode ke-2 dst selalu
  // selisih sebesar angka itu. Neraca menyelesaikannya dgn satu baris
  // sintetis di Ekuitas; baris yang SAMA (fungsi yang sama, batas "sebelum
  // awal periode") ditampilkan di sini. Laba di kolom Kredit, rugi di Debit.
  // Tidak ada jurnal yang ditulis dan saldo akun asli tidak berubah.
  const unclosedProfitLoss = await getCumulativeUnclosedProfitLoss(db, await classifyAccounts(db), periodStartDate, false, scope);
  if (unclosedProfitLoss !== 0) {
    const bridgeDebit = unclosedProfitLoss < 0 ? -unclosedProfitLoss : 0;
    const bridgeCredit = unclosedProfitLoss > 0 ? unclosedProfitLoss : 0;
    rows.push({
      accountId: UNCLOSED_PROFIT_LOSS_CODE,
      code: UNCLOSED_PROFIT_LOSS_CODE,
      name: "Laba (Rugi) Belum Ditutup (kumulatif s/d sebelum periode ini)",
      debit: bridgeDebit,
      credit: bridgeCredit,
      isBridge: true,
    });
    totalDebit += bridgeDebit;
    totalCredit += bridgeCredit;
  }

  const difference = totalDebit - totalCredit;
  return { periodId, rows, totalDebit, totalCredit, isBalanced: difference === 0, difference };
}
