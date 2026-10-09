import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { OpeningBalanceSummary, UpsertOpeningBalanceInput } from "./opening-balance-types.js";

function invalidateOpeningBalance(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["workspace", "opening-balance", companySlug] });
}

export function useOpeningBalance(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "opening-balance", companySlug],
    queryFn: () => companyApi.get<OpeningBalanceSummary>(`/${companySlug}/opening-balance`),
    enabled: Boolean(companySlug),
  });
}

export function useCreateOpeningBalance(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertOpeningBalanceInput) => companyApi.post<{ success: true; id: string; status: string }>(`/${companySlug}/opening-balance`, input),
    onSuccess: () => invalidateOpeningBalance(qc, companySlug),
  });
}

export function useUpdateOpeningBalance(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertOpeningBalanceInput) => companyApi.put<{ success: true; id: string; status: string }>(`/${companySlug}/opening-balance`, input),
    onSuccess: () => invalidateOpeningBalance(qc, companySlug),
  });
}

export function useDeleteOpeningBalance(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => companyApi.delete<{ success: true }>(`/${companySlug}/opening-balance`),
    onSuccess: () => invalidateOpeningBalance(qc, companySlug),
  });
}

export function usePostOpeningBalance(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => companyApi.post<{ success: true; status: string }>(`/${companySlug}/opening-balance/post`),
    onSuccess: () => invalidateOpeningBalance(qc, companySlug),
  });
}

export function useReverseOpeningBalance(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { targetPeriodId: string; reason: string }) =>
      companyApi.post<{ success: true; reversalJournalId: string }>(`/${companySlug}/opening-balance/reverse`, input),
    onSuccess: () => invalidateOpeningBalance(qc, companySlug),
  });
}
