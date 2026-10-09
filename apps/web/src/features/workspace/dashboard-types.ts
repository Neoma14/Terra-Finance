/** Kontrak response GET /api/company-db/:slug/dashboard -- SAMA PERSIS dgn
 * `DashboardSummary` backend (db/company/dashboard-service.ts), tidak ada
 * transformasi/kalkulasi ulang di frontend (§28/§33 instruksi: backend
 * adalah source of truth). */

export interface DashboardKpi {
  value: number | null;
  previousValue: number | null;
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
    profitMargin: DashboardKpi;
  };
  trend: DashboardTrendPoint[];
  expenseComposition: Array<{ accountCode: string; accountName: string; amount: number }>;
  financialPosition: { totalAssets: number; totalLiabilities: number; totalEquity: number };
  recentActivity: DashboardRecentActivity[];
  alerts: DashboardAlert[];
}
