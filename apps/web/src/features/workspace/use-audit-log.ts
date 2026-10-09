import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { AuditLogListResult } from "./audit-log-types.js";

export interface AuditLogFilters {
  page: number;
  pageSize: number;
  entityType?: string;
  fromDate?: string;
  toDate?: string;
}

function buildQueryString(filters: AuditLogFilters): string {
  const params = new URLSearchParams();
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  if (filters.entityType) params.set("entityType", filters.entityType);
  if (filters.fromDate) params.set("fromDate", filters.fromDate);
  if (filters.toDate) params.set("toDate", filters.toDate);
  return params.toString();
}

export function useCompanyAuditLog(companySlug: string, filters: AuditLogFilters) {
  return useQuery({
    queryKey: ["workspace", "audit-log", companySlug, filters],
    queryFn: () => companyApi.get<AuditLogListResult>(`/${companySlug}/audit-log?${buildQueryString(filters)}`),
    enabled: Boolean(companySlug),
  });
}
