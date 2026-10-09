import type { Counterparty } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useCounterparties(companySlug: string, type?: "vendor" | "customer") {
  return useQuery({
    queryKey: ["counterparties", companySlug, type],
    queryFn: () => api.get<{ counterparties: Counterparty[] }>(`/c/${companySlug}/counterparties${type ? `?type=${type}` : ""}`),
    enabled: Boolean(companySlug),
  });
}

export function useCreateCounterparty(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: "vendor" | "customer"; code: string; name: string }) =>
      api.post<{ id: string }>(`/c/${companySlug}/counterparties`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["counterparties", companySlug] }),
  });
}
