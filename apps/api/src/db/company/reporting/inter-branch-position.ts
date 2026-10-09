import type { Knex } from "knex";
import { applyBranchScope, type AuthorizedScope } from "../report-scope.js";
import { fromCents, toCents } from "../../../lib/money.js";

/**
 * Posisi akun antar-kantor (INTER_BRANCH) dalam sebuah cakupan, SEBAGAI INFORMASI -- bukan eliminasi (Phase 7).
 * Laporan gabungan menampilkan akun antar-cabang apa adanya (bruto); blok ini membuat besarnya terlihat dan menyatakan
 * secara eksplisit bahwa belum dieliminasi. Tidak menulis jurnal apa pun dan tidak mengubah angka laporan.
 *  - receivableGross: saldo bersih akun antar-kantor bersifat aset (normal debit)
 *  - payableGross:    saldo bersih akun antar-kantor bersifat liabilitas (normal kredit)
 *  - netDifference:   receivableGross - payableGross; 0 bila setiap pasangan lengkap berada dalam cakupan (invarian Σ pasangan = 0)
 */
export interface InterBranchPosition {
  eliminated: false;
  asOf: string;
  receivableGross: number;
  payableGross: number;
  netDifference: number;
}

export async function getInterBranchPosition(db: Knex, scope: AuthorizedScope, asOfDate: string): Promise<InterBranchPosition> {
  const base = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .join("accounts as a", "a.id", "jel.account_id")
    .where("a.branch_policy", "INTER_BRANCH")
    .whereIn("je.status", ["POSTED", "REVERSED"])
    .andWhere("je.entry_date", "<=", asOfDate);
  const rows: Array<{ normalBalance: string; debitTotal: number; creditTotal: number }> = await applyBranchScope(base, scope)
    .groupBy("a.normal_balance")
    .select("a.normal_balance as normalBalance", db.raw("COALESCE(SUM(jel.debit), 0) as debitTotal"), db.raw("COALESCE(SUM(jel.credit), 0) as creditTotal"));

  let receivable = 0n;
  let payable = 0n;
  for (const r of rows) {
    const net = toCents(Number(r.debitTotal)) - toCents(Number(r.creditTotal));
    if (r.normalBalance === "debit") receivable += net;
    else payable += -net;
  }
  return { eliminated: false, asOf: asOfDate, receivableGross: fromCents(receivable), payableGross: fromCents(payable), netDifference: fromCents(receivable - payable) };
}
