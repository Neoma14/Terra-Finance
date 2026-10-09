import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { CreateJournalInput, JournalDetail, JournalListItem, Period } from "./journal-types.js";

/** Field AccountRow minimal yang dipakai UI Journal (dropdown akun) --
 * subset `db/company/account-service.ts` AccountRow, hanya field yang
 * benar2 dipakai di sini. */
export interface JournalAccountOption {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /** TASK-023 §6 -- backend `/accounts` SUDAH mengirim field ini (account-
   * service.ts COLUMNS), cuma belum dipakai di sini. Dipakai journal-form-
   * panel.tsx utk menampilkan dropdown counterparty HANYA utk baris akun
   * payable/receivable, supaya pelunasan hutang/piutang bisa tercatat
   * dgn counterparty_id yang benar lewat jurnal biasa (bukan form baru). */
  subledgerType: "payable" | "receivable" | null;
  /** Akun terkunci tidak boleh dipakai jurnal baru (ditegakkan juga di server). */
  isLocked?: boolean;
  /** Dikirim backend (account-service COLUMNS). Dipakai formulir Antar Cabang untuk menyaring akun kas dan mengecualikan akun antar-cabang. */
  isCash?: boolean;
  branchPolicy?: "ALL_BRANCH" | "CENTRAL_ONLY" | "SYSTEM_ONLY" | "INTER_BRANCH";
}

export interface JournalListFilters {
  periodId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

function invalidateJournalQueries(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["workspace", "journals", companySlug] });
}

function buildQueryString(filters: JournalListFilters): string {
  const params = new URLSearchParams();
  if (filters.periodId) params.set("periodId", filters.periodId);
  if (filters.fromDate) params.set("fromDate", filters.fromDate);
  if (filters.toDate) params.set("toDate", filters.toDate);
  if (filters.search) params.set("search", filters.search);
  if (filters.status) params.set("status", filters.status);
  params.set("page", String(filters.page ?? 1));
  params.set("pageSize", String(filters.pageSize ?? 20));
  return params.toString();
}

export function useJournalList(companySlug: string, filters: JournalListFilters) {
  return useQuery({
    queryKey: ["workspace", "journals", companySlug, filters],
    queryFn: () =>
      companyApi.get<{ journals: JournalListItem[]; total: number; page: number; pageSize: number }>(
        `/${companySlug}/journals?${buildQueryString(filters)}`,
      ),
    enabled: Boolean(companySlug),
  });
}

export function useJournalDetail(companySlug: string, journalId: string | undefined) {
  return useQuery({
    queryKey: ["workspace", "journals", companySlug, "detail", journalId],
    queryFn: () => companyApi.get<JournalDetail>(`/${companySlug}/journals/${journalId}`),
    enabled: Boolean(companySlug && journalId),
  });
}

export function useAccountOptions(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "accounts", companySlug],
    queryFn: async () => {
      // Endpoint `/accounts` paginated (default 50/halaman, maks 200). Ambil
      // SEMUA halaman supaya nama akun di detail jurnal & dropdown form
      // lengkap utk COA berapa pun besarnya.
      const pageSize = 200;
      const accounts: JournalAccountOption[] = [];
      for (let page = 1; ; page++) {
        const res = await companyApi.get<{ accounts: JournalAccountOption[]; total: number }>(
          `/${companySlug}/accounts?page=${page}&pageSize=${pageSize}`,
        );
        accounts.push(...res.accounts);
        if (res.accounts.length < pageSize || accounts.length >= res.total) break;
      }
      return { accounts };
    },
    enabled: Boolean(companySlug),
  });
}

export function usePeriodOptions(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "periods", companySlug],
    queryFn: () => companyApi.get<{ periods: Period[] }>(`/${companySlug}/periods`),
    enabled: Boolean(companySlug),
  });
}

export function useCreateJournal(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJournalInput) => companyApi.post<{ success: true; journalId: string; status: string }>(`/${companySlug}/journal`, input),
    onSuccess: () => invalidateJournalQueries(qc, companySlug),
  });
}

export function useUpdateDraftJournal(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CreateJournalInput }) =>
      companyApi.put<{ success: true; journalId: string; status: string }>(`/${companySlug}/journal/${id}`, input),
    onSuccess: () => invalidateJournalQueries(qc, companySlug),
  });
}

export function useDeleteDraftJournal(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => companyApi.delete<{ success: true }>(`/${companySlug}/journal/${id}`),
    onSuccess: () => invalidateJournalQueries(qc, companySlug),
  });
}

export function usePostJournal(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => companyApi.post<{ success: true; status: string }>(`/${companySlug}/journal/${id}/post`),
    onSuccess: () => invalidateJournalQueries(qc, companySlug),
  });
}

/** Proses Reversal Jurnal: referensi + tanggal transaksi + alasan. Server
 * memastikan tanggal sama dengan jurnal asli. */
export function useReverseByReference(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { referenceNo: string; entryDate: string; reason: string }) =>
      companyApi.post<{ success: true; reversalJournalId: string; reversalReferenceNo: string; reversalDate: string }>(`/${companySlug}/journal/reversal`, input),
    onSuccess: () => {
      invalidateJournalQueries(qc, companySlug);
      qc.invalidateQueries({ queryKey: ["workspace", "ledger", companySlug] });
    },
  });
}

export interface JournalSettings {
  maxBackdateDays: number | null;
  today: string;
  earliestAllowedDate: string | null;
}

export function useJournalSettings(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "journal-settings", companySlug],
    queryFn: () => companyApi.get<JournalSettings>(`/${companySlug}/journal-settings`),
    enabled: Boolean(companySlug),
  });
}

export function useUpdateJournalSettings(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (maxBackdateDays: number | null) => companyApi.put<JournalSettings>(`/${companySlug}/journal-settings`, { maxBackdateDays }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", "journal-settings", companySlug] }),
  });
}
