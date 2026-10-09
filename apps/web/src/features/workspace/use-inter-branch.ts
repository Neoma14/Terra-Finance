import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBranches, useMyAuthorization } from "./use-authorization.js";
import { companyApi } from "../../lib/company-api-client.js";
import { getActiveBranch } from "../../lib/active-branch.js";
import type { CreateInterBranchInput, InterBranchDetail, InterBranchListFilters, InterBranchListItem, InterBranchOptions } from "./inter-branch-types.js";

/** Hook hanya transport: semua keputusan izin dan akuntansi ada di server (`/inter-branch`). Kunci query berawalan
 * ["workspace", ...] sehingga pergantian cabang aktif (yang menyegarkan seluruh data kerja) ikut menyegarkan modul ini. */

const key = (slug: string, ...rest: unknown[]) => ["workspace", "inter-branch", slug, ...rest];

function listQueryString(f: InterBranchListFilters): string {
  const p = new URLSearchParams();
  if (f.box) p.set("box", f.box);
  if (f.status) p.set("status", f.status);
  if (f.type) p.set("type", f.type);
  if (f.search) p.set("search", f.search);
  if (f.fromDate) p.set("fromDate", f.fromDate);
  if (f.toDate) p.set("toDate", f.toDate);
  p.set("page", String(f.page ?? 1));
  p.set("pageSize", String(f.pageSize ?? 20));
  return p.toString();
}

export function useInterBranchList(slug: string, filters: InterBranchListFilters, enabled = true) {
  return useQuery({
    queryKey: key(slug, "list", filters),
    queryFn: () => companyApi.get<{ items: InterBranchListItem[]; total: number; page: number; pageSize: number }>(`/${slug}/inter-branch?${listQueryString(filters)}`),
    enabled: Boolean(slug) && enabled,
    placeholderData: (previous) => previous,
  });
}

/** Lencana menu: jumlah masuk-menunggu. Polling 60 dtk / fokus jendela, sama dengan pemilih cabang aktif. */
export function useInterBranchSummary(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: key(slug, "summary"),
    queryFn: () => companyApi.get<{ incomingWaiting: number; outgoingWaiting: number }>(`/${slug}/inter-branch/summary`),
    enabled: Boolean(slug) && enabled,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
}

export function useInterBranchDetail(slug: string, id: string | null) {
  return useQuery({
    queryKey: key(slug, "detail", id),
    queryFn: () => companyApi.get<InterBranchDetail>(`/${slug}/inter-branch/${id}`),
    enabled: Boolean(slug && id),
  });
}

/** Pilihan formulir bergantung pada cabang kerja aktif (cabang asal) -> ikut dalam kunci. */
export function useInterBranchOptions(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: key(slug, "options", getActiveBranch(slug)),
    queryFn: () => companyApi.get<InterBranchOptions>(`/${slug}/inter-branch/options`),
    enabled: Boolean(slug) && enabled,
  });
}

export function useInterBranchSettings(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: key(slug, "settings"),
    queryFn: () => companyApi.get<{ expiryDays: number; minDays: number; maxDays: number }>(`/${slug}/inter-branch/settings`),
    enabled: Boolean(slug) && enabled,
  });
}

function useAction<TVars, TResult = unknown>(slug: string, run: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    // Jurnal ikut berubah saat disetujui/dibalik: segarkan daftar jurnal, buku besar, dan laporan juga.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(slug) });
      void qc.invalidateQueries({ queryKey: ["workspace", "journals", slug] });
    },
  });
}

export function useCreateInterBranch(slug: string) {
  return useAction(slug, (input: CreateInterBranchInput) => companyApi.post<{ success: true; replayed: boolean; transaction: InterBranchDetail }>(`/${slug}/inter-branch`, input));
}
export function useApproveInterBranch(slug: string) {
  return useAction(slug, ({ id, confirmedAccountId }: { id: string; confirmedAccountId?: string }) => companyApi.post(`/${slug}/inter-branch/${id}/approve`, { confirmedAccountId: confirmedAccountId ?? null }));
}
export function useRejectInterBranch(slug: string) {
  return useAction(slug, ({ id, reason }: { id: string; reason: string }) => companyApi.post(`/${slug}/inter-branch/${id}/reject`, { reason }));
}
export function useCancelInterBranch(slug: string) {
  return useAction(slug, ({ id, reason }: { id: string; reason?: string }) => companyApi.post(`/${slug}/inter-branch/${id}/cancel`, { reason: reason ?? "" }));
}
export function useRequestInterBranchReversal(slug: string) {
  return useAction(slug, ({ id, reason }: { id: string; reason: string }) => companyApi.post(`/${slug}/inter-branch/${id}/reverse`, { reason }));
}
export function useDecideInterBranchReversal(slug: string) {
  return useAction(slug, ({ id, approvalId, action, reason }: { id: string; approvalId: string; action: "approve" | "reject" | "cancel"; reason?: string }) =>
    companyApi.post(`/${slug}/inter-branch/${id}/reverse/${approvalId}/${action}`, action === "approve" ? {} : { reason: reason ?? "" }),
  );
}
export function useSetInterBranchExpiry(slug: string) {
  return useAction(slug, (expiryDays: number) => companyApi.put(`/${slug}/inter-branch/settings`, { expiryDays }));
}

/** Visibilitas menu + lencana jumlah masuk-menunggu. Hanya UX: server menegakkan flag, izin, dan akses cabang pada tiap request. */
export function useInterBranchNav(slug: string): { visible: boolean; badge: number } {
  const branches = useBranches(slug);
  const authorization = useMyAuthorization(slug);
  const visible =
    branches.data?.multiBranchEnabled === true && (branches.data.branches.length > 0) && (authorization.data?.permissions ?? []).includes("interbranch.read");
  const summary = useInterBranchSummary(slug, visible);
  return { visible, badge: visible ? (summary.data?.incomingWaiting ?? 0) : 0 };
}
