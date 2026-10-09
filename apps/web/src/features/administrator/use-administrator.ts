import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export interface LicenseStatus {
  activated: boolean;
  clientName: string | null;
  status: "active" | "expired" | "locked" | null;
  expiresAt: string | null;
  fingerprintMatches: boolean | null;
}

export function useAdministratorMe() {
  return useQuery({
    queryKey: ["administrator", "me"],
    queryFn: () => api.get<{ license: LicenseStatus }>("/administrator/me"),
    retry: false,
  });
}

export function useAdministratorLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { licenseKey: string; token: string }) => api.post<{ ok: true }>("/administrator/login", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["administrator"] }),
  });
}

export function useAdministratorLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/administrator/logout"),
    onSuccess: () => qc.setQueryData(["administrator", "me"], null),
  });
}

export interface AuditLogRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
  repairMode: boolean;
  createdAt: string;
}

export function useAuditLog(filters: { actorType?: string } = {}) {
  return useQuery({
    queryKey: ["administrator", "audit-log", filters],
    queryFn: () => {
      const params = new URLSearchParams(filters as Record<string, string>).toString();
      return api.get<{ rows: AuditLogRow[] }>(`/administrator/audit-log${params ? `?${params}` : ""}`);
    },
  });
}

export interface ErrorLogRow {
  id: string;
  level: string;
  module: string;
  message: string;
  stackTrace: string | null;
  appVersion: string;
  createdAt: string;
}

export function useErrorLog() {
  return useQuery({
    queryKey: ["administrator", "error-log"],
    queryFn: () => api.get<{ rows: ErrorLogRow[] }>("/administrator/error-log"),
  });
}

export interface DeviceRow {
  id: string;
  deviceName: string;
  fingerprint: string;
  approved: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function useDevices() {
  return useQuery({
    queryKey: ["administrator", "devices"],
    queryFn: () => api.get<{ rows: DeviceRow[] }>("/administrator/devices"),
  });
}

export function useApproveDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/administrator/devices/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["administrator", "devices"] }),
  });
}

export interface AnomalyRow {
  id: string;
  ruleCode: string;
  severity: string;
  description: string;
  entityType: string | null;
  entityId: string | null;
  detectedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export function useAnomalies(onlyUnreviewed = false) {
  return useQuery({
    queryKey: ["administrator", "anomalies", onlyUnreviewed],
    queryFn: () => api.get<{ rows: AnomalyRow[] }>(`/administrator/anomalies?onlyUnreviewed=${onlyUnreviewed}`),
  });
}

export function useReviewAnomaly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/administrator/anomalies/${id}/review`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["administrator", "anomalies"] }),
  });
}

export interface Diagnostics {
  appVersion: string;
  dbFilePath: string;
  dbSizeBytes: number;
  integrityOk: boolean;
  userCount: number;
  sessionCount: number;
  unreviewedAnomalyCount: number;
}

export function useDiagnostics() {
  return useQuery({
    queryKey: ["administrator", "diagnostics"],
    queryFn: () => api.get<{ diagnostics: Diagnostics }>("/administrator/diagnostics"),
  });
}

export function useRepairData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { table: string; id: string; patch: Record<string, unknown>; reason: string }) =>
      api.post<{ ok: true }>("/administrator/repair", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["administrator"] }),
  });
}
