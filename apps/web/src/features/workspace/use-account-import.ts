import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { AccountImportCommitResult, AccountImportHistoryItem, AccountImportValidationResult } from "./account-types.js";

/** "TERRA Import Standard" -- pola identik `use-journal-import.ts`
 * (TASK-DB-ARCH-014), diterapkan ke COA (TASK-DB-ARCH-015). */

export function useDownloadAccountImportTemplate(companySlug: string) {
  return useMutation({
    mutationFn: () => companyApi.download(`/${companySlug}/accounts-import/template`, "Template Import Akun.xlsx"),
  });
}

export function usePreviewAccountImport(companySlug: string) {
  return useMutation({
    mutationFn: (file: File) => companyApi.upload<AccountImportValidationResult>(`/${companySlug}/accounts-import/preview`, file),
  });
}

export function useCommitAccountImport(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => companyApi.upload<AccountImportCommitResult>(`/${companySlug}/accounts-import/commit`, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspace", "accounts", companySlug] });
      qc.invalidateQueries({ queryKey: ["workspace", "account-import-history", companySlug] });
    },
  });
}

export function useAccountImportHistory(companySlug: string, page = 1) {
  return useQuery({
    queryKey: ["workspace", "account-import-history", companySlug, page],
    queryFn: () => companyApi.get<{ history: AccountImportHistoryItem[]; total: number; page: number; pageSize: number }>(`/${companySlug}/accounts-import/history?page=${page}`),
    enabled: Boolean(companySlug),
  });
}
