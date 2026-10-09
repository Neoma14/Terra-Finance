import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { DashboardSummary } from "./dashboard-types.js";
import { scopeKeyParts, scopeParam, type ScopedExtras } from "./report-scope.js";

/** `GET /dashboard?fromDate=&toDate=` -- nol logic di sini, murni fetch
 * (pola sama dgn use-reports.ts, TASK-DB-ARCH-017 §3: backend adalah
 * satu-satunya source of truth). */
export function useDashboardSummary(companySlug: string, fromDate: string, toDate: string, scope = "") {
  return useQuery({
    queryKey: ["workspace", "dashboard", companySlug, fromDate, toDate, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<DashboardSummary & ScopedExtras>(`/${companySlug}/dashboard?fromDate=${fromDate}&toDate=${toDate}${scopeParam(scope)}`),
    enabled: Boolean(companySlug && fromDate && toDate),
  });
}
