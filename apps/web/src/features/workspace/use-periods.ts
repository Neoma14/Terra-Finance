import { useMutation, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";

export interface CreatePeriodInput {
  label: string;
  startDate: string;
  endDate: string;
  periodType: "month" | "quarter" | "year";
  fiscalYear: number;
}

export interface GenerateMonthlyPeriodsResult {
  success: true;
  created: number;
  skipped: number;
  skippedReasons: string[];
}

function invalidatePeriods(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["workspace", "periods", companySlug] });
}

export function useCreatePeriod(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePeriodInput) => companyApi.post<{ success: true; id: string }>(`/${companySlug}/periods`, input),
    onSuccess: () => invalidatePeriods(qc, companySlug),
  });
}

export function useGenerateMonthlyPeriods(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fromDate: string; toDate: string }) =>
      companyApi.post<GenerateMonthlyPeriodsResult>(`/${companySlug}/periods/generate-monthly`, input),
    onSuccess: () => invalidatePeriods(qc, companySlug),
  });
}
