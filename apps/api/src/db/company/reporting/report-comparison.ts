import { toCents } from "../../../lib/money.js";
import { combinedScopeOf, scopeForBranch, type AuthorizedScope, type ScopeBranch } from "../report-scope.js";
import type { BalanceSheetReport, EquityStatementReport, FinancialReportSection, IncomeStatementReport } from "./reporting-types.js";
import type { TrialBalanceResult } from "../trial-balance-service.js";

/**
 * Komparasi per cabang (Phase 5B): satu kolom per cabang + kolom Gabungan. Setiap kolom dihitung oleh SERVICE LAPORAN
 * YANG SAMA dengan satu cabang (cakupan satu cabang yang diturunkan dari cakupan yang sudah diotorisasi); kolom Gabungan
 * DIHITUNG oleh service yang sama dengan cakupan gabungan (bukan dijumlahkan dari angka tampilan), lalu DIVERIFIKASI:
 * untuk tiap baris dan total, Σ(kolom cabang) harus sama dengan Gabungan (dalam sen bulat). Selisih = galat integritas
 * (500), tidak pernah disembunyikan atau "dirapikan".
 *
 * Catatan kinerja: belum set-based (satu laporan per cabang). Dibatasi `REPORT_COMPARISON_MAX_BRANCHES`; Arus Kas dan
 * Dashboard belum mendukung komparasi (menunggu optimasi, keputusan D8).
 */

export class ReportReconciliationError extends Error {
  readonly code = "REPORT_RECONCILIATION_FAILED" as const;
  constructor(
    message: string,
    public readonly differences: Array<{ key: string; combined: string; sumOfColumns: string }>,
  ) {
    super(message);
  }
}

export interface ComparisonColumn<T> {
  branch: ScopeBranch;
  report: T;
}
export interface ComparisonResult<T> {
  columns: ComparisonColumn<T>[];
  combined: T;
  reconciliation: { ok: true; checkedKeys: number };
}

type Flat = Map<string, bigint>;

function sectionFlat(out: Flat, name: string, section: FinancialReportSection) {
  for (const line of section.lines) out.set(`${name}:${line.accountId}`, toCents(line.amount));
  out.set(`${name}:total`, toCents(section.total));
}

export const flatBalanceSheet = (r: BalanceSheetReport): Flat => {
  const out: Flat = new Map();
  sectionFlat(out, "assets", r.assets);
  sectionFlat(out, "liabilities", r.liabilities);
  sectionFlat(out, "equity", r.equity);
  out.set("totalAssets", toCents(r.totalAssets));
  out.set("totalLiabilities", toCents(r.totalLiabilities));
  out.set("totalEquity", toCents(r.totalEquity));
  return out;
};
export const flatIncomeStatement = (r: IncomeStatementReport): Flat => {
  const out: Flat = new Map();
  sectionFlat(out, "revenue", r.revenue);
  sectionFlat(out, "cogs", r.cogs);
  sectionFlat(out, "operatingExpenses", r.operatingExpenses);
  sectionFlat(out, "otherIncome", r.otherIncome);
  sectionFlat(out, "otherExpense", r.otherExpense);
  out.set("grossProfit", toCents(r.grossProfit));
  out.set("operatingProfit", toCents(r.operatingProfit));
  out.set("netProfit", toCents(r.netProfit));
  return out;
};
export const flatEquity = (r: EquityStatementReport): Flat =>
  new Map([
    ["openingEquity", toCents(r.openingEquity)],
    ["additionalCapitalOrDrawings", toCents(r.additionalCapitalOrDrawings)],
    ["netProfit", toCents(r.netProfit)],
    ["closingEquity", toCents(r.closingEquity)],
  ]);
/** Neraca Saldo: tiap akun berupa saldo bersih (debit - kredit) sehingga additif lintas cabang; total debit/kredit kolom tidak additif karena saling-netting per akun. */
export const flatTrialBalance = (r: TrialBalanceResult): Flat => {
  const out: Flat = new Map();
  for (const row of r.rows) out.set(`row:${row.accountId}`, toCents(row.debit) - toCents(row.credit));
  out.set("difference", toCents(r.difference));
  return out;
};

export async function buildComparison<T>(
  scope: AuthorizedScope,
  build: (scopeForReport: AuthorizedScope) => Promise<T>,
  flatten: (report: T) => Flat,
): Promise<ComparisonResult<T>> {
  const columns: ComparisonColumn<T>[] = [];
  for (const branch of scope.branches) columns.push({ branch: { ...branch }, report: await build(scopeForBranch(scope, branch.id)) });
  const combined = await build(combinedScopeOf(scope));

  const sum: Flat = new Map();
  for (const col of columns) for (const [k, v] of flatten(col.report)) sum.set(k, (sum.get(k) ?? 0n) + v);
  const combinedFlat = flatten(combined);
  const differences: ReportReconciliationError["differences"] = [];
  for (const k of new Set([...sum.keys(), ...combinedFlat.keys()])) {
    const a = combinedFlat.get(k) ?? 0n;
    const b = sum.get(k) ?? 0n;
    if (a !== b) differences.push({ key: k, combined: a.toString(), sumOfColumns: b.toString() });
  }
  if (differences.length > 0) {
    throw new ReportReconciliationError(`Rekonsiliasi komparasi gagal: ${differences.length} baris/total tidak sama dengan jumlah kolom cabang. Ini galat integritas, bukan kondisi laporan yang valid.`, differences);
  }
  return { columns, combined, reconciliation: { ok: true, checkedKeys: new Set([...sum.keys(), ...combinedFlat.keys()]).size } };
}
