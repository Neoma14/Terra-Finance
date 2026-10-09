import type { CashFlowDetailResult, CashFlowResult, EquityStatementResult, FinancialTrendPoint, Period, StatementResult } from "@konsultan/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function usePeriods(companySlug: string) {
  return useQuery({
    queryKey: ["periods", companySlug],
    queryFn: () => api.get<{ periods: Period[] }>(`/c/${companySlug}/periods`),
    enabled: Boolean(companySlug),
  });
}

export function useBalanceSheetRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["statements", companySlug, "balance-sheet", from, to],
    queryFn: () => api.get<{ result: StatementResult }>(`/c/${companySlug}/statements/balance-sheet?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useIncomeStatementRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["statements", companySlug, "income-statement", from, to],
    queryFn: () => api.get<{ result: StatementResult }>(`/c/${companySlug}/statements/income-statement?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useCashFlowRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["statements", companySlug, "cash-flow", from, to],
    queryFn: () => api.get<{ result: CashFlowResult }>(`/c/${companySlug}/statements/cash-flow?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useEquityStatementRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["statements", companySlug, "equity", from, to],
    queryFn: () => api.get<{ result: EquityStatementResult }>(`/c/${companySlug}/statements/equity?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useDownloadStatementsExcelRange(companySlug: string) {
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.download(`/c/${companySlug}/statements/export/range?from=${from}&to=${to}`, "Laporan Keuangan.xlsx"),
  });
}

/** Tren finansial antar periode (dipakai chart "Tren Kinerja" & sparkline
 * KPI di Dashboard) -- sama persis logikanya dgn versi online. */
export function useFinancialTrendRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["statements", companySlug, "trend-range", from, to],
    queryFn: () => api.get<{ points: FinancialTrendPoint[] }>(`/c/${companySlug}/statements/trend/range?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

/** Rincian arus kas per-akun (bukan cuma 3 angka lump-sum) -- dipakai
 * tabel "Laporan Arus Kas" di tab Laporan Dashboard. */
export function useCashFlowDetailRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["statements", companySlug, "cash-flow-detail-range", from, to],
    queryFn: () => api.get<{ result: CashFlowDetailResult }>(`/c/${companySlug}/statements/cash-flow/detail/range?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}
