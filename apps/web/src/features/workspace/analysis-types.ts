export interface RatioValue {
  value: number | null;
  label: string;
  unavailableReason?: string;
}

/** Persis bentuk response `GET /api/company-db/:slug/analysis`
 * (`db/company/ratio-analysis-service.ts`). */
export interface RatioAnalysis {
  period: { fromDate: string; toDate: string };
  profitability: {
    grossProfitMargin: RatioValue;
    operatingMargin: RatioValue;
    netProfitMargin: RatioValue;
    returnOnAssets: RatioValue;
    returnOnEquity: RatioValue;
  };
  solvency: {
    debtToEquity: RatioValue;
    debtToAssets: RatioValue;
  };
  liquidity: {
    currentRatio: RatioValue;
  };
}
