import type { Knex } from "knex";
import { findPeriodsInRange } from "../periods/date-range.js";

const FLOW_TYPES = new Set(["revenue", "expense"]);

export interface RangeAccountBalance {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  beginningBalance: number;
  debitTotal: number;
  creditTotal: number;
  endingBalance: number;
}

/** Saldo SEMUA akun untuk rentang tanggal bebas -- sama persis logikanya
 * dgn versi online (lihat komentar di sana), scoped `company_id`. */
export async function getLedgerBalancesForRange(masterDb: Knex, companyId: string, from: string, to: string): Promise<RangeAccountBalance[]> {
  const periods = await findPeriodsInRange(masterDb, companyId, from, to);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");

  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];
  const periodIds = periods.map((p) => p.id);

  const accounts = await masterDb("accounts").where({ company_id: companyId }).orderBy("code").select("id", "code", "name", "account_type");
  const snapshots = await masterDb("trial_balance_snapshots")
    .whereIn("period_id", periodIds)
    .select("period_id", "account_id", "beginning_balance", "debit_total", "credit_total", "ending_balance");

  const byAccount = new Map<string, typeof snapshots>();
  for (const s of snapshots as any[]) {
    const list = byAccount.get(s.account_id) ?? [];
    list.push(s);
    byAccount.set(s.account_id, list);
  }

  return (accounts as any[]).map((a) => {
    const rows = byAccount.get(a.id) ?? [];
    const isFlow = FLOW_TYPES.has(a.account_type);
    const firstSnapshot = rows.find((r: any) => r.period_id === firstPeriod.id);
    const lastSnapshot = rows.find((r: any) => r.period_id === lastPeriod.id);
    const debitTotal = rows.reduce((sum: number, r: any) => sum + Number(r.debit_total), 0);
    const creditTotal = rows.reduce((sum: number, r: any) => sum + Number(r.credit_total), 0);
    const beginningBalance = isFlow ? 0 : Number(firstSnapshot?.beginning_balance ?? 0);
    const endingBalance = isFlow
      ? rows.reduce((sum: number, r: any) => sum + Number(r.ending_balance), 0)
      : Number(lastSnapshot?.ending_balance ?? beginningBalance);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      accountType: a.account_type,
      beginningBalance,
      debitTotal,
      creditTotal,
      endingBalance,
    };
  });
}
