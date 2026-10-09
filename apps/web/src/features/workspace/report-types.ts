/**
 * Cermin PERSIS `db/company/reporting/reporting-types.ts` (backend
 * reporting engine, TASK-DB-ARCH-012, TIDAK diubah task ini). TIDAK ADA
 * breakdown current/non-current di `FinancialReportLineAmount` --
 * backend TIDAK menyediakannya (tidak ada field classification semacam
 * itu per baris), jadi frontend TIDAK membuat pemisahan itu scr sepihak
 * (TASK-DB-ARCH-017 §11/§22: "jangan membuat pemisahan palsu").
 */

export interface FinancialReportPeriod {
  fromDate: string;
  toDate: string;
}

export interface FinancialReportLineAmount {
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface FinancialReportSection {
  label: string;
  lines: FinancialReportLineAmount[];
  total: number;
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
  additionalCapitalOrDrawings: number;
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
  unclassifiedAmount: number;
}
