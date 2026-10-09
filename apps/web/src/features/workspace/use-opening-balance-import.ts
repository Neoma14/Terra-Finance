import { useMutation, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { OpeningBalanceImportCommitResult, OpeningBalanceImportValidationResult } from "./opening-balance-types.js";

/** "TERRA Import Standard" -- pola identik `use-journal-import.ts`/
 * `use-account-import.ts`. */

export function useDownloadOpeningBalanceTemplate(companySlug: string) {
  return useMutation({
    mutationFn: () => companyApi.download(`/${companySlug}/opening-balance-import/template`, "Template Opening Balance.xlsx"),
  });
}

export function usePreviewOpeningBalanceImport(companySlug: string) {
  return useMutation({
    mutationFn: (file: File) => companyApi.upload<OpeningBalanceImportValidationResult>(`/${companySlug}/opening-balance-import/preview`, file),
  });
}

export function useCommitOpeningBalanceImport(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => companyApi.upload<OpeningBalanceImportCommitResult>(`/${companySlug}/opening-balance-import/commit`, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", "opening-balance", companySlug] }),
  });
}
