import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type {
  AuthorizationUser,
  BranchesResponse,
  CreateDelegationInput,
  DelegationView,
  MyAuthorization,
  OverridablePermission,
} from "./authorization-types.js";

/** Phase 3 (otorisasi & delegasi multi-cabang). Hook hanya transport: setiap keputusan izin,
 * cakupan cabang, dan batas wewenang ditegakkan server -- UI hanya menyembunyikan aksi yang pasti ditolak. */

function invalidate(qc: ReturnType<typeof useQueryClient>, companySlug: string) {
  qc.invalidateQueries({ queryKey: ["workspace", "authorization", companySlug] });
  qc.invalidateQueries({ queryKey: ["workspace", "access", companySlug] });
}

export function useBranches(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "authorization", companySlug, "branches"],
    queryFn: () => companyApi.get<BranchesResponse>(`/${companySlug}/branches`),
    enabled: Boolean(companySlug),
  });
}

export function useMyAuthorization(companySlug: string) {
  return useQuery({
    queryKey: ["workspace", "authorization", companySlug, "me"],
    queryFn: () => companyApi.get<MyAuthorization>(`/${companySlug}/authorization/me`),
    enabled: Boolean(companySlug),
  });
}

export function useAuthorizationUsers(companySlug: string, enabled: boolean) {
  return useQuery({
    queryKey: ["workspace", "authorization", companySlug, "users"],
    queryFn: () => companyApi.get<{ users: AuthorizationUser[] }>(`/${companySlug}/authorization/users`),
    enabled: Boolean(companySlug) && enabled,
  });
}

export function useDelegations(companySlug: string, enabled: boolean) {
  return useQuery({
    queryKey: ["workspace", "authorization", companySlug, "delegations"],
    queryFn: () => companyApi.get<{ delegations: DelegationView[] }>(`/${companySlug}/delegations`),
    enabled: Boolean(companySlug) && enabled,
  });
}

export function useGrantBranchAccess(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, branchId }: { userId: string; branchId: string }) => companyApi.post<{ success: true }>(`/${companySlug}/access/${userId}/branches`, { branchId }),
    onSuccess: () => invalidate(qc, companySlug),
  });
}

export function useRevokeBranchAccess(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, branchId }: { userId: string; branchId: string }) => companyApi.delete<{ success: true }>(`/${companySlug}/access/${userId}/branches/${branchId}`),
    onSuccess: () => invalidate(qc, companySlug),
  });
}

export function useSetPermissionOverride(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, permission, effect, reason }: { userId: string; permission: OverridablePermission; effect: "GRANT" | "DENY"; reason?: string }) =>
      companyApi.put<{ success: true }>(`/${companySlug}/access/${userId}/permission-overrides/${permission}`, { effect, reason: reason ?? null }),
    onSuccess: () => invalidate(qc, companySlug),
  });
}

export function useRevokePermissionOverride(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, permission }: { userId: string; permission: OverridablePermission }) =>
      companyApi.delete<{ success: true }>(`/${companySlug}/access/${userId}/permission-overrides/${permission}`),
    onSuccess: () => invalidate(qc, companySlug),
  });
}

export function useCreateDelegation(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDelegationInput) => companyApi.post<{ success: true; id: string }>(`/${companySlug}/delegations`, input),
    onSuccess: () => invalidate(qc, companySlug),
  });
}

export function useRevokeDelegation(companySlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => companyApi.delete<{ success: true }>(`/${companySlug}/delegations/${id}`),
    onSuccess: () => invalidate(qc, companySlug),
  });
}
