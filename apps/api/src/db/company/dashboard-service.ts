import type { Knex } from "knex";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { getIncomeStatement } from "./reporting/income-statement-service.js";
import { getCashFlowStatement } from "./reporting/cash-flow-service.js";
import { validateDateRange } from "./reporting/reporting-utils.js";
import { getOpeningBalance } from "./opening-balance-service.js";
import { applyBranchScope, type AuthorizedScope } from "./report-scope.js";

/**
 * TASK-020 -- KPI Dashboard, SATU-SATUNYA tempat aggregasi dibuat utk
 * halaman ini. REUSE MURNI `getBalanceSheet`/`getIncomeStatement`/
 * `getCashFlowStatement` (reporting engine TASK-DB-ARCH-012, TIDAK
 * diubah, TIDAK diduplikasi) -- dashboard TIDAK PERNAH menghitung ulang
 * accounting dgn query sendiri, hanya menyusun ulang angka yg SUDAH
 * dihitung & SUDAH diuji-rekonsiliasi oleh laporan existing (§28/§33
 * instruksi: "Dashboard Revenue = Income Statement Revenue", dst --
 * dijamin SECARA KONSTRUKSI di sini, bukan cuma kebetulan sama, krn
 * literal memanggil fungsi yang sama).
 *
 * Kalau Balance Sheet TIDAK balance (integrity bug nyata, lihat komentar
 * `BalanceSheetNotBalancedError` di balance-sheet-service.ts), exception
 * itu SENGAJA dibiarkan menjalar ke route handler (BUKAN ditangkap jadi
 * "alert" sambil tetap menampilkan angka) -- §33 instruksi: "DO NOT HIDE
 * IT", sama persis perilaku `/reports/balance-sheet` yang sudah ada.
 */

export interface DashboardKpi {
  /** null = "belum tersedia" (BUKAN 0) -- §22 instruksi. */
  value: number | null;
  previousValue: number | null;
  /** null kalau previousValue tidak tersedia ATAU previousValue = 0
   * (pembagi nol) -- §24 instruksi: jangan hasilkan Infinity%/NaN%. */
  changePercent: number | null;
}

export interface DashboardTrendPoint {
  label: string;
  fromDate: string;
  toDate: string;
  revenue: number;
  expense: number;
  netProfit: number;
  profitMargin: number | null;
  endingCash: number;
}

export interface DashboardAlert {
  type: "draft_journals" | "opening_balance_missing" | "opening_balance_draft";
  severity: "info" | "warning";
  message: string;
}

export interface DashboardRecentActivity {
  id: string;
  action: string;
  actorLabel: string;
  createdAt: string;
  entityType: string;
  entityId: string;
}

/** Laba tahun berjalan (Year-To-Date): dari awal tahun fiskal s/d `toDate`.
 * Dihitung dengan getIncomeStatement yang SAMA dengan laporan Laba Rugi --
 * bukan angka dashboard yang berdiri sendiri. */
export interface DashboardYtd {
  fromDate: string;
  toDate: string;
  revenue: number;
  expense: number;
  netProfit: number;
}

export interface DashboardSummary {
  period: { fromDate: string; toDate: string };
  ytd: DashboardYtd;
  previousPeriod: { fromDate: string; toDate: string } | null;
  kpis: {
    revenue: DashboardKpi;
    expense: DashboardKpi;
    netProfit: DashboardKpi;
    cashAndBank: DashboardKpi;
    totalAssets: DashboardKpi;
    totalLiabilities: DashboardKpi;
    totalEquity: DashboardKpi;
    /** rasio 0..1 (bukan 0..100) -- frontend yg format jadi "%", konsisten
     * dgn `formatRatio(..., "percent")` yg sudah dipakai modul Ratios. */
    profitMargin: DashboardKpi;
  };
  trend: DashboardTrendPoint[];
  expenseComposition: Array<{ accountCode: string; accountName: string; amount: number }>;
  financialPosition: { totalAssets: number; totalLiabilities: number; totalEquity: number };
  recentActivity: DashboardRecentActivity[];
  alerts: DashboardAlert[];
}

function expenseTotal(income: Awaited<ReturnType<typeof getIncomeStatement>>): number {
  return income.cogs.total + income.operatingExpenses.total + income.otherExpense.total;
}

/** Awal tahun fiskal yang memuat `toDate` (tanggal 1 pada bulan awal tahun
 * fiskal perusahaan; default Januari). */
export function fiscalYearStartFor(toDate: string, fiscalYearStartMonth: number): string {
  const year = Number(toDate.slice(0, 4));
  const month = Number(toDate.slice(5, 7));
  const startYear = month >= fiscalYearStartMonth ? year : year - 1;
  return `${startYear}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`;
}

function kpi(value: number | null, previousValue: number | null): DashboardKpi {
  const changePercent = value !== null && previousValue !== null && previousValue !== 0 ? ((value - previousValue) / Math.abs(previousValue)) * 100 : null;
  return { value, previousValue, changePercent };
}

/** Periode sebelumnya = rentang dgn PANJANG SAMA, tepat sebelum `fromDate`
 * (mis. 1-31 Jan -> periode sebelumnya 1-31 Des). Definisi umum & simetris,
 * bukan "bulan lalu" scr literal -- berlaku benar utk rentang custom
 * (minggu, kuartal, dst) juga, bukan cuma preset bulanan. */
function previousPeriodOf(fromDate: string, toDate: string): { fromDate: string; toDate: string } {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  const lengthMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 24 * 60 * 60 * 1000);
  const prevFrom = new Date(prevTo.getTime() - lengthMs);
  return { fromDate: prevFrom.toISOString().slice(0, 10), toDate: prevTo.toISOString().slice(0, 10) };
}

function monthBucketsEndingAt(toDate: string, count: number): Array<{ label: string; fromDate: string; toDate: string }> {
  const buckets: Array<{ label: string; fromDate: string; toDate: string }> = [];
  const end = new Date(`${toDate}T00:00:00Z`);
  for (let i = count - 1; i >= 0; i--) {
    const bucketMonthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const bucketMonthEnd = new Date(Date.UTC(bucketMonthStart.getUTCFullYear(), bucketMonthStart.getUTCMonth() + 1, 0));
    const effectiveEnd = bucketMonthEnd.getTime() > end.getTime() ? end : bucketMonthEnd;
    buckets.push({
      label: bucketMonthStart.toLocaleDateString("id-ID", { month: "short", year: "numeric", timeZone: "UTC" }),
      fromDate: bucketMonthStart.toISOString().slice(0, 10),
      toDate: effectiveEnd.toISOString().slice(0, 10),
    });
  }
  return buckets;
}

const TREND_MONTHS = 6;
const RECENT_ACTIVITY_LIMIT = 10;
const RECENT_ACTIVITY_ACTIONS = [
  "journal.create",
  "journal.post",
  "journal.reverse",
  "journal.import",
  "journal.delete_draft",
  "opening_balance.create",
];

export async function getDashboardSummary(db: Knex, fromDate: string, toDate: string, scope?: AuthorizedScope): Promise<DashboardSummary> {
  validateDateRange(fromDate, toDate);

  const [balanceSheet, income, cashFlow] = await Promise.all([
    getBalanceSheet(db, fromDate, toDate, scope),
    getIncomeStatement(db, fromDate, toDate, scope),
    getCashFlowStatement(db, fromDate, toDate, scope),
  ]);

  const expense = expenseTotal(income);
  const profile = await db("company_profile").select("fiscal_year_start_month as m").first();
  const ytdFrom = fiscalYearStartFor(toDate, Number(profile?.m ?? 1) || 1);
  const ytdIncome = await getIncomeStatement(db, ytdFrom, toDate, scope);
  const ytd: DashboardYtd = { fromDate: ytdFrom, toDate, revenue: ytdIncome.revenue.total, expense: expenseTotal(ytdIncome), netProfit: ytdIncome.netProfit };
  const profitMargin = income.revenue.total > 0 ? income.netProfit / income.revenue.total : null;

  const previousPeriod = previousPeriodOf(fromDate, toDate);
  let prevIncome: Awaited<ReturnType<typeof getIncomeStatement>> | null = null;
  let prevBalanceSheet: Awaited<ReturnType<typeof getBalanceSheet>> | null = null;
  let prevCashFlow: Awaited<ReturnType<typeof getCashFlowStatement>> | null = null;
  try {
    [prevIncome, prevBalanceSheet, prevCashFlow] = await Promise.all([
      getIncomeStatement(db, previousPeriod.fromDate, previousPeriod.toDate, scope),
      getBalanceSheet(db, previousPeriod.fromDate, previousPeriod.toDate, scope),
      getCashFlowStatement(db, previousPeriod.fromDate, previousPeriod.toDate, scope),
    ]);
  } catch {
    // Periode sebelumnya mungkin tidak py data/periode terdaftar sama
    // sekali (mis. perusahaan baru) -- KPI comparison cukup jadi
    // "tidak tersedia" (null), BUKAN bikin seluruh dashboard gagal (§24).
  }
  const prevExpense = prevIncome ? expenseTotal(prevIncome) : null;
  const prevProfitMargin = prevIncome && prevIncome.revenue.total > 0 ? prevIncome.netProfit / prevIncome.revenue.total : null;

  const trendBuckets = monthBucketsEndingAt(toDate, TREND_MONTHS);
  const trend: DashboardTrendPoint[] = [];
  for (const bucket of trendBuckets) {
    try {
      const [bIncome, bCashFlow] = await Promise.all([getIncomeStatement(db, bucket.fromDate, bucket.toDate, scope), getCashFlowStatement(db, bucket.fromDate, bucket.toDate, scope)]);
      trend.push({
        label: bucket.label,
        fromDate: bucket.fromDate,
        toDate: bucket.toDate,
        revenue: bIncome.revenue.total,
        expense: expenseTotal(bIncome),
        netProfit: bIncome.netProfit,
        profitMargin: bIncome.revenue.total > 0 ? bIncome.netProfit / bIncome.revenue.total : null,
        endingCash: bCashFlow.endingCash,
      });
    } catch {
      // Bucket bulan di mana belum ada periode terdaftar sama sekali --
      // dilewati drpd bikin seluruh trend gagal (perusahaan baru biasanya
      // belum py histori 6 bulan penuh).
    }
  }

  const expenseComposition = [...income.cogs.lines, ...income.operatingExpenses.lines, ...income.otherExpense.lines]
    .map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, amount: l.amount }))
    .sort((a, b) => b.amount - a.amount);

  const alerts: DashboardAlert[] = [];
  const draftCount = await applyBranchScope(db("journal_entries").where({ status: "DRAFT" }), scope, "journal_entries.branch_id").count<{ count: string }>({ count: "*" }).first();
  const draftN = Number(draftCount?.count ?? 0);
  if (draftN > 0) {
    alerts.push({ type: "draft_journals", severity: "info", message: `Ada ${draftN} jurnal berstatus DRAFT yang belum diposting.` });
  }
  const openingBalance = await getOpeningBalance(db, scope?.mode === "SINGLE" ? scope.branchIds[0] : undefined);
  if (!openingBalance.exists) {
    alerts.push({ type: "opening_balance_missing", severity: "warning", message: "Saldo awal perusahaan ini belum diisi." });
  } else if (openingBalance.status === "DRAFT") {
    alerts.push({ type: "opening_balance_draft", severity: "warning", message: "Saldo awal sudah dibuat tapi belum diposting." });
  }

  // Aktivitas terbaru mengikuti cakupan (kolom `branch_id` audit); entri tanpa cabang (level perusahaan) hanya untuk cakupan seluruh perusahaan.
  const recentActivityRows = await applyBranchScope(db("company_audit_log").whereIn("action", RECENT_ACTIVITY_ACTIONS), scope, "company_audit_log.branch_id")
    .orderBy("created_at", "desc")
    .limit(RECENT_ACTIVITY_LIMIT)
    .select("id", "action", "actor_label as actorLabel", "created_at as createdAt", "entity_type as entityType", "entity_id as entityId");

  return {
    period: { fromDate, toDate },
    ytd,
    previousPeriod: prevIncome ? previousPeriod : null,
    kpis: {
      revenue: kpi(income.revenue.total, prevIncome?.revenue.total ?? null),
      expense: kpi(expense, prevExpense),
      netProfit: kpi(income.netProfit, prevIncome?.netProfit ?? null),
      cashAndBank: kpi(cashFlow.endingCash, prevCashFlow?.endingCash ?? null),
      totalAssets: kpi(balanceSheet.totalAssets, prevBalanceSheet?.totalAssets ?? null),
      totalLiabilities: kpi(balanceSheet.totalLiabilities, prevBalanceSheet?.totalLiabilities ?? null),
      totalEquity: kpi(balanceSheet.totalEquity, prevBalanceSheet?.totalEquity ?? null),
      profitMargin: kpi(profitMargin, prevProfitMargin),
    },
    trend,
    expenseComposition,
    financialPosition: { totalAssets: balanceSheet.totalAssets, totalLiabilities: balanceSheet.totalLiabilities, totalEquity: balanceSheet.totalEquity },
    recentActivity: recentActivityRows as DashboardRecentActivity[],
    alerts,
  };
}
