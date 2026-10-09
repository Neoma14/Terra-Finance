import type { RatioResult, RatioTrendPoint } from "@konsultan/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useRatiosRange(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["ratios", companySlug, "range", from, to],
    queryFn: () => api.get<{ result: RatioResult }>(`/c/${companySlug}/ratios/range?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useRatioTrend(companySlug: string) {
  return useQuery({
    queryKey: ["ratios", companySlug, "trend"],
    queryFn: () => api.get<{ points: RatioTrendPoint[] }>(`/c/${companySlug}/ratios/trend`),
    enabled: Boolean(companySlug),
  });
}

export function useDownloadRatiosExcelRange(companySlug: string) {
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.download(`/c/${companySlug}/ratios/export/range?from=${from}&to=${to}`, "Rasio Keuangan.xlsx"),
  });
}
