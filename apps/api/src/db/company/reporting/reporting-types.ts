/**
 * Shared types -- Financial Reporting Engine (TASK-DB-ARCH-012). Dipakai
 * SEMUA 4 laporan supaya response contract konsisten (§14 instruksi).
 */

export interface FinancialReportPeriod {
  fromDate: string;
  toDate: string;
}

export interface FinancialReportLineAmount {
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: number; // SELALU presentasi (positif utk arah normal akun), lihat reporting-utils.ts
}

export interface FinancialReportSection {
  label: string;
  lines: FinancialReportLineAmount[];
  total: number;
}

export class InvalidDateRangeError extends Error {
  readonly code = "INVALID_DATE_RANGE" as const;
}

export class BalanceSheetNotBalancedError extends Error {
  readonly code = "BALANCE_SHEET_NOT_BALANCED" as const;
  constructor(
    message: string,
    public readonly totalAssets: number,
    public readonly totalLiabilities: number,
    public readonly totalEquity: number,
    public readonly difference: number,
  ) {
    super(message);
  }
}

export interface BalanceSheetReport {
  period: FinancialReportPeriod;
  assets: FinancialReportSection;
  liabilities: FinancialReportSection;
  equity: FinancialReportSection;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanceDifference: number;
  isBalanced: boolean;
}

export interface IncomeStatementReport {
  period: FinancialReportPeriod;
  revenue: FinancialReportSection;
  cogs: FinancialReportSection;
  grossProfit: number;
  operatingExpenses: FinancialReportSection;
  operatingProfit: number;
  otherIncome: FinancialReportSection;
  otherExpense: FinancialReportSection;
  netProfit: number;
}

export interface EquityStatementReport {
  period: FinancialReportPeriod;
  openingEquity: number;
  additionalCapitalOrDrawings: number; // §9 limitation: tidak bisa dipisah capital vs drawings, lihat komentar equity-statement-service.ts
  netProfit: number;
  closingEquity: number;
}

export interface CashFlowCategorySection {
  label: string;
  amount: number;
}

export interface CashFlowReport {
  period: FinancialReportPeriod;
  operating: CashFlowCategorySection;
  investing: CashFlowCategorySection;
  financing: CashFlowCategorySection;
  netChangeInCash: number;
  beginningCash: number;
  endingCash: number;
  /** §11/§12: entry yang menyentuh akun kas TAPI tidak punya satu pun
   * counterpart non-kas dgn `cash_flow_activity` jelas (mis. transfer
   * kas<->kas, atau counterpart tanpa `cash_flow_activity` diisi) --
   * TIDAK diklasifikasikan ke O/I/F, dilaporkan terpisah sbg limitation,
   * bukan ditebak. */
  unclassifiedAmount: number;
}
