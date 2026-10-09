import { scopeKeyParts, scopeParam, type ScopedExtras } from "./report-scope.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { Counterparty, CounterpartyBalance, CounterpartyType, CreateCounterpartyInput } from "./counterparty-types.js";

export function useCounterpartyList(companySlug: string, type: CounterpartyType) {
  return useQuery({
    queryKey: ["workspace", "counterparties", companySlug, "list", type],
    queryFn: () => companyApi.get<{ counterparties: Counterparty[] }>(`/${companySlug}/counterparties?type=${type}`),
    enabled: Boolean(companySlug),
  });
}

export function useCounterpartyBalances(companySlug: string, type: CounterpartyType, scope = "") {
  return useQuery({
    queryKey: ["workspace", "counterparties", companySlug, "balances", type, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<{ balances: CounterpartyBalance[] } & ScopedExtras>(`/${companySlug}/counterparties/balances?type=${type}${scopeParam(scope)}`),
    enabled: Boolean(companySlug),
  });
}

export function useCreateCounterparty(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCounterpartyInput) => companyApi.post<{ success: true; id: string }>(`/${companySlug}/counterparties`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", "counterparties", companySlug] }),
  });
}

export type { Counterparty };
