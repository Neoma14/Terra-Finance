import type { Account, AccountsImportCommitInput, AccountsImportPreviewResult, StatementLineOption } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export function useAccounts(companySlug: string) {
  return useQuery({
    queryKey: ["accounts", companySlug],
    queryFn: () => api.get<{ accounts: Account[] }>(`/c/${companySlug}/accounts`),
    enabled: Boolean(companySlug),
  });
}

/** Daftar baris laporan (Neraca/Laba-Rugi) utk dropdown mapping akun di
 * halaman Tambah Akun. */
export function useStatementLineOptions(companySlug: string) {
  return useQuery({
    queryKey: ["statement-lines", companySlug],
    queryFn: () => api.get<{ lines: StatementLineOption[] }>(`/c/${companySlug}/statement-lines`),
    enabled: Boolean(companySlug),
  });
}

export interface CreateAccountInput {
  code: string;
  name: string;
  accountType: "asset" | "liability" | "equity" | "revenue" | "expense";
  accountSubtype: string;
  normalBalance: "debit" | "credit";
  cashFlowActivity?: "operating" | "investing" | "financing";
  isCash?: boolean;
  subledgerType?: "payable" | "receivable" | null;
  statementLineId?: string;
  openingBalance?: { amount: number; periodId: string };
}

export function useCreateAccount(companySlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) => api.post<{ id: string }>(`/c/${companySlug}/accounts`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts", companySlug] }),
  });
}

export interface UpdateAccountInput {
  name?: string;
  accountType?: "asset" | "liability" | "equity" | "revenue" | "expense";
  accountSubtype?: string;
  normalBalance?: "debit" | "credit";
  cashFlowActivity?: "operating" | "investing" | "financing" | null;
  isCash?: boolean;
  subledgerType?: "payable" | "receivable" | null;
  statementLineId?: string;
  isActive?: boolean;
}

export function useUpdateAccount(companySlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAccountInput }) =>
      api.patch<{ success: true }>(`/c/${companySlug}/accounts/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts", companySlug] }),
  });
}

export function useDeleteAccount(companySlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ success: true }>(`/c/${companySlug}/accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts", companySlug] }),
  });
}

export function useDownloadAccountsExcelRange(companySlug: string) {
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.download(`/c/${companySlug}/accounts/export/range?from=${from}&to=${to}`, "Chart of Accounts.xlsx"),
  });
}

// --- Import Chart of Accounts + Saldo Awal dari Excel -- fitur BARU
// (tidak ada di versi online). ---
export function useDownloadAccountsImportTemplate(companySlug: string) {
  return useMutation({
    mutationFn: () => api.download(`/c/${companySlug}/accounts/import/template`, "Template Import Akun.xlsx"),
  });
}

export function usePreviewAccountsImport(companySlug: string) {
  return useMutation({
    mutationFn: (file: File) => api.upload<AccountsImportPreviewResult>(`/c/${companySlug}/accounts/import/preview`, file),
  });
}

export function useCommitAccountsImport(companySlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AccountsImportCommitInput) =>
      api.post<{ createdCount: number; skippedCount: number; skippedCodes: string[] }>(`/c/${companySlug}/accounts/import/commit`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts", companySlug] });
      queryClient.invalidateQueries({ queryKey: ["periods", companySlug] });
      queryClient.invalidateQueries({ queryKey: ["ledger", companySlug] });
      queryClient.invalidateQueries({ queryKey: ["statements", companySlug] });
      queryClient.invalidateQueries({ queryKey: ["ratios", companySlug] });
    },
  });
}
