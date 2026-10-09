export interface KpiSnapshot {
  id: string;
  companyId: string;
  periodLabel: string;
  periodEndDate: string;
  currentRatio: number | null;
  quickRatio: number | null;
  debtRatio: number | null;
  debtToEquity: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  roa: number | null;
  roe: number | null;
  assetTurnover: number | null;
  inventoryTurnover: number | null;
  receivableTurnover: number | null;
  revenue: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  operatingCashFlow: number | null;
  computedAt: string;
}

export interface BenchmarkRow {
  companyId: string;
  companyName: string;
  snapshot: KpiSnapshot;
}
