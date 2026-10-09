import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { AccountListFilters, AccountRow, AccountTypeOption, CreateAccountInput, UpdateAccountInput } from "./account-types.js";

function invalidateAccountQueries(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["workspace", "accounts", companySlug] });
}

function buildQueryString(filters: AccountListFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.accountTypeId) params.set("accountTypeId", filters.accountTypeId);
  if (filters.isActive !== undefined) params.set("isActive", String(filters.isActive));
  params.set("page", String(filters.page ?? 1));
  params.set("pageSize", String(filters.pageSize ?? 50));
  return params.toString();
}

export function useAccountTypes(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "account-types", companySlug],
    queryFn: () => companyApi.get<{ accountTypes: AccountTypeOption[] }>(`/${companySlug}/account-types`),
    enabled: Boolean(companySlug),
  });
}

export function useAccountList(companySlug: string, filters: AccountListFilters) {
  return useQuery({
    queryKey: ["workspace", "accounts", companySlug, filters],
    queryFn: () => companyApi.get<{ accounts: AccountRow[]; total: number; page: number; pageSize: number }>(`/${companySlug}/accounts?${buildQueryString(filters)}`),
    enabled: Boolean(companySlug),
  });
}

export function useAccountDetail(companySlug: string, accountId: string | undefined) {
  return useQuery({
    queryKey: ["workspace", "accounts", companySlug, "detail", accountId],
    queryFn: () => companyApi.get<{ account: AccountRow }>(`/${companySlug}/accounts/${accountId}`),
    enabled: Boolean(companySlug && accountId),
  });
}

export function useCreateAccount(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) => companyApi.post<{ success: true; accountId: string }>(`/${companySlug}/accounts`, input),
    onSuccess: () => invalidateAccountQueries(qc, companySlug),
  });
}

export function useUpdateAccount(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAccountInput }) => companyApi.patch<{ success: true }>(`/${companySlug}/accounts/${id}`, input),
    onSuccess: () => invalidateAccountQueries(qc, companySlug),
  });
}

/** Lock / Unlock akun (hanya OWNER/ADMIN -- ditegakkan di server). */
export function useSetAccountLocked(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, locked }: { id: string; locked: boolean }) =>
      companyApi.post<{ success: true; isLocked: boolean }>(`/${companySlug}/accounts/${id}/${locked ? "lock" : "unlock"}`),
    onSuccess: () => invalidateAccountQueries(qc, companySlug),
  });
}
