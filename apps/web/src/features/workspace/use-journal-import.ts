import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { ImportCommitResult, ImportHistoryItem, ImportValidationResult } from "./journal-types.js";

/** "TERRA Import Standard" (TASK-DB-ARCH-014 §7): upload -> parse ->
 * validate -> preview -> confirm -> commit -> audit. Hook ini dibuat
 * generik dari sisi NAMA/pola (bukan hardcode ke jurnal di level nama
 * fungsi) sejauh praktis, supaya modul import berikutnya (COA/Opening
 * Balance/dst, §7 instruksi) bisa mengikuti pola file yang sama. */

export function useDownloadJournalImportTemplate(companySlug: string) {
  return useMutation({
    mutationFn: () => companyApi.download(`/${companySlug}/journal-import/template`, "Template Jurnal.xlsx"),
  });
}

export function usePreviewJournalImport(companySlug: string) {
  return useMutation({
    mutationFn: (file: File) => companyApi.upload<ImportValidationResult>(`/${companySlug}/journal-import/preview`, file),
  });
}

export function useCommitJournalImport(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => companyApi.upload<ImportCommitResult>(`/${companySlug}/journal-import/commit`, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspace", "journals", companySlug] });
      qc.invalidateQueries({ queryKey: ["workspace", "journal-import-history", companySlug] });
    },
  });
}

export function useJournalImportHistory(companySlug: string, page = 1) {
  return useQuery({
    queryKey: ["workspace", "journal-import-history", companySlug, page],
    queryFn: () => companyApi.get<{ history: ImportHistoryItem[]; total: number; page: number; pageSize: number }>(
      `/${companySlug}/journal-import/history?page=${page}`,
    ),
    enabled: Boolean(companySlug),
  });
}
