import type { AccountBalanceSummary, LedgerResult } from "@konsultan/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useLedger(companySlug: string, periodId?: string, accountId?: string) {
  return useQuery({
    queryKey: ["ledger", companySlug, periodId, accountId],
    queryFn: () => api.get<{ result: LedgerResult }>(`/c/${companySlug}/ledger?periodId=${periodId}&accountId=${accountId}`),
    enabled: Boolean(companySlug && periodId && accountId),
  });
}

export function useLedgerBalances(companySlug: string, periodId?: string) {
  return useQuery({
    queryKey: ["ledger", companySlug, "balances", periodId],
    queryFn: () => api.get<{ balances: AccountBalanceSummary[] }>(`/c/${companySlug}/ledger/balances?periodId=${periodId}`),
    enabled: Boolean(companySlug && periodId),
  });
}

export function useLedgerRange(companySlug: string, accountId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["ledger", companySlug, "range", accountId, from, to],
    queryFn: () => api.get<{ result: LedgerResult }>(`/c/${companySlug}/ledger/range?accountId=${accountId}&from=${from}&to=${to}`),
    enabled: Boolean(companySlug && accountId && from && to),
  });
}

export function useLedgerBalancesRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["ledger", companySlug, "balances", "range", from, to],
    queryFn: () => api.get<{ balances: AccountBalanceSummary[] }>(`/c/${companySlug}/ledger/balances/range?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useDownloadLedgerExcelRange(companySlug: string) {
  return useMutation({
    mutationFn: ({ accountId, from, to }: { accountId: string; from: string; to: string }) =>
      api.download(`/c/${companySlug}/ledger/export/range?accountId=${accountId}&from=${from}&to=${to}`, "Buku Besar.xlsx"),
  });
}
