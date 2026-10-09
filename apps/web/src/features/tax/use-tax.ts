import type { TaxEstimateResult, TaxReference, TaxReferenceUpdateInput } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useTaxReference(companySlug: string) {
  return useQuery({
    queryKey: ["tax", companySlug, "reference"],
    queryFn: () => api.get<{ reference: TaxReference }>(`/c/${companySlug}/tax/reference`),
    enabled: Boolean(companySlug),
  });
}

export function useUpdateTaxReference(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaxReferenceUpdateInput) => api.put<{ reference: TaxReference }>(`/c/${companySlug}/tax/reference`, input),
    onSuccess: (data) => qc.setQueryData(["tax", companySlug, "reference"], data),
  });
}

export function useTaxEstimate(companySlug: string, periodId?: string) {
  return useQuery({
    queryKey: ["tax", companySlug, "estimate", periodId],
    queryFn: () => api.get<{ estimate: TaxEstimateResult }>(`/c/${companySlug}/tax/estimate?periodId=${periodId}`),
    enabled: Boolean(companySlug && periodId),
  });
}

export function useTaxEstimateRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["tax", companySlug, "estimate", "range", from, to],
    queryFn: () => api.get<{ estimate: TaxEstimateResult }>(`/c/${companySlug}/tax/estimate/range?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useDownloadTaxEstimateExcel(companySlug: string) {
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.download(`/c/${companySlug}/tax/estimate/export/range?from=${from}&to=${to}`, "Estimasi Pajak.xlsx"),
  });
}
