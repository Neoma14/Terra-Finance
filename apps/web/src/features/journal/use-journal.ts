import type { JournalCommitEntryInput, JournalEntryDetail, JournalHistoryLine, JournalLineInput, JournalPreviewResult } from "@konsultan/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

function invalidateAfterPosting(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["accounts", companySlug] });
  qc.invalidateQueries({ queryKey: ["periods", companySlug] });
  qc.invalidateQueries({ queryKey: ["journal", companySlug] });
  qc.invalidateQueries({ queryKey: ["ledger", companySlug] });
  qc.invalidateQueries({ queryKey: ["statements", companySlug] });
  qc.invalidateQueries({ queryKey: ["ratios", companySlug] });
  qc.invalidateQueries({ queryKey: ["tax", companySlug] });
}

export function usePreviewJournal(companySlug: string) {
  return useMutation({
    mutationFn: (file: File) => api.upload<JournalPreviewResult>(`/c/${companySlug}/journal/preview`, file),
  });
}

export function useDownloadJournalTemplate(companySlug: string) {
  return useMutation({
    mutationFn: () => api.download(`/c/${companySlug}/journal/template`, "Template Jurnal.xlsx"),
  });
}

export function useCommitJournal(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entries: JournalCommitEntryInput[] }) =>
      api.post<{ createdCount: number; referenceNumbers: string[]; skippedCount: number; skippedReferenceNumbers: string[] }>(
        `/c/${companySlug}/journal/commit`,
        input,
      ),
    onSuccess: () => invalidateAfterPosting(qc, companySlug),
  });
}

export function useManualJournalEntry(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entryDate: string; referenceNo?: string; description?: string; lines: JournalLineInput[] }) =>
      api.post<{ id: string; referenceNo: string }>(`/c/${companySlug}/journal/manual`, input),
    onSuccess: () => invalidateAfterPosting(qc, companySlug),
  });
}

export function useReverseJournalEntry(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { reversalDate: string; referenceNo: string }) =>
      api.post<{ id: string; referenceNo: string }>(`/c/${companySlug}/journal/reversal`, input),
    onSuccess: () => invalidateAfterPosting(qc, companySlug),
  });
}

export function useJournalHistory(companySlug: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["journal", companySlug, "history", from, to],
    queryFn: () => api.get<{ lines: JournalHistoryLine[] }>(`/c/${companySlug}/journal?from=${from}&to=${to}`),
    enabled: Boolean(companySlug && from && to),
  });
}

export function useDownloadJournalHistory(companySlug: string) {
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.download(`/c/${companySlug}/journal/export?from=${from}&to=${to}`, "Riwayat Jurnal.xlsx"),
  });
}

export function useJournalEntryDetail(companySlug: string, id?: string) {
  return useQuery({
    queryKey: ["journal", companySlug, "detail", id],
    queryFn: () => api.get<{ entry: JournalEntryDetail }>(`/c/${companySlug}/journal/${id}`),
    enabled: Boolean(companySlug && id),
  });
}
