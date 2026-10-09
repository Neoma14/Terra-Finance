import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { CompanyAccessUser, GrantAccessInput } from "./access-types.js";
import type { CompanyWorkspaceRole } from "./types.js";

/** Company Access Management UI (TASK-022) -- 100% reuse API
 * `modules/company-access/routes.ts` (TASK-DB-ARCH-011 Part A), TIDAK ADA
 * endpoint/permission baru. Authorization SEPENUHNYA tetap di backend
 * (`requireCompanyAccess` -> `requirePermission("users.manage")`) -- hook
 * di sini cuma transport, bukan keputusan izin. */

function invalidateAccessQueries(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["workspace", "access", companySlug] });
}

export function useCompanyAccessList(companySlug: string, enabled = true) {
  return useQuery({
    queryKey: ["workspace", "access", companySlug],
    queryFn: () => companyApi.get<{ users: CompanyAccessUser[] }>(`/${companySlug}/access`),
    enabled: Boolean(companySlug) && enabled,
  });
}

export function useGrantAccess(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GrantAccessInput) => companyApi.post<{ success: true; accessId: string; userId: string; role: string }>(`/${companySlug}/access`, input),
    onSuccess: () => invalidateAccessQueries(qc, companySlug),
  });
}

export function useUpdateAccessRole(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: CompanyWorkspaceRole }) =>
      companyApi.patch<{ success: true }>(`/${companySlug}/access/${userId}`, { role }),
    onSuccess: () => invalidateAccessQueries(qc, companySlug),
  });
}

export function useUpdateAccessStatus(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: "ACTIVE" | "SUSPENDED" }) =>
      companyApi.patch<{ success: true }>(`/${companySlug}/access/${userId}/status`, { status }),
    onSuccess: () => invalidateAccessQueries(qc, companySlug),
  });
}

export function useRevokeAccess(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => companyApi.delete<{ success: true }>(`/${companySlug}/access/${userId}`),
    onSuccess: () => invalidateAccessQueries(qc, companySlug),
  });
}
