import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { BalanceSheetReport, CashFlowReport, EquityStatementReport, IncomeStatementReport } from "./report-types.js";
import { scopeKeyParts, scopeParam, type ScopedResponse } from "./report-scope.js";

/** `GET /reports/*?fromDate=&toDate=&scope=` -- date-range based, sesuai
 * contract backend (TASK-DB-ARCH-012). Semua hook di bawah nol logic, murni
 * fetch -- backend adalah satu-satunya source of truth (TASK-DB-ARCH-017 §3).
 * Phase 5: `scope` = usulan cakupan cabang ("" = bawaan server); server memvalidasi
 * dan menjawab dengan `scope` yang dipakai. Kunci cache memuat cakupan + cabang kerja aktif. */

function qs(fromDate: string, toDate: string, scope: string): string {
  return `?fromDate=${fromDate}&toDate=${toDate}${scopeParam(scope)}`;
}

export function useBalanceSheetReport(companySlug: string, fromDate: string, toDate: string, scope = "") {
  return useQuery({
    queryKey: ["workspace", "reports", "balance-sheet", companySlug, fromDate, toDate, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<ScopedResponse<BalanceSheetReport>>(`/${companySlug}/reports/balance-sheet${qs(fromDate, toDate, scope)}`),
    enabled: Boolean(companySlug && fromDate && toDate),
  });
}

export function useIncomeStatementReport(companySlug: string, fromDate: string, toDate: string, scope = "") {
  return useQuery({
    queryKey: ["workspace", "reports", "income-statement", companySlug, fromDate, toDate, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<ScopedResponse<IncomeStatementReport>>(`/${companySlug}/reports/income-statement${qs(fromDate, toDate, scope)}`),
    enabled: Boolean(companySlug && fromDate && toDate),
  });
}

export function useEquityStatementReport(companySlug: string, fromDate: string, toDate: string, scope = "") {
  return useQuery({
    queryKey: ["workspace", "reports", "equity", companySlug, fromDate, toDate, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<ScopedResponse<EquityStatementReport>>(`/${companySlug}/reports/equity${qs(fromDate, toDate, scope)}`),
    enabled: Boolean(companySlug && fromDate && toDate),
  });
}

export function useCashFlowReport(companySlug: string, fromDate: string, toDate: string, scope = "", enabled = true) {
  return useQuery({
    queryKey: ["workspace", "reports", "cash-flow", companySlug, fromDate, toDate, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<CashFlowReport & import("./report-scope.js").ScopedExtras>(`/${companySlug}/reports/cash-flow${qs(fromDate, toDate, scope)}`),
    enabled: enabled && Boolean(companySlug && fromDate && toDate),
  });
}
