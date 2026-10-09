import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { TaxSettings, TaxSummary, UpdateTaxSettingsInput } from "./tax-types.js";

export function useTaxSettings(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "tax-settings", companySlug],
    queryFn: () => companyApi.get<{ settings: TaxSettings }>(`/${companySlug}/tax-settings`),
    enabled: Boolean(companySlug),
  });
}

export function useUpdateTaxSettings(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaxSettingsInput) => companyApi.patch<{ success: true; settings: TaxSettings }>(`/${companySlug}/tax-settings`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", "tax-settings", companySlug] }),
  });
}

export function useTaxSummary(companySlug: string, fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ["workspace", "tax-summary", companySlug, fromDate, toDate],
    queryFn: () => companyApi.get<TaxSummary>(`/${companySlug}/tax-summary?fromDate=${fromDate}&toDate=${toDate}`),
    enabled: Boolean(companySlug && fromDate && toDate),
  });
}
