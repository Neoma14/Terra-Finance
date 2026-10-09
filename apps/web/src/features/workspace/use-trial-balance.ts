import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { TrialBalanceResult } from "./trial-balance-types.js";
import { scopeKeyParts, scopeParam, type ScopedResponse } from "./report-scope.js";

/** `GET /trial-balance?periodId=` -- PERIOD-based, sama alasannya dgn
 * `use-ledger.ts`. */
export function useTrialBalance(companySlug: string, periodId: string | undefined, scope = "") {
  return useQuery({
    queryKey: ["workspace", "trial-balance", companySlug, periodId, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<ScopedResponse<TrialBalanceResult>>(`/${companySlug}/trial-balance?periodId=${periodId}${scopeParam(scope)}`),
    enabled: Boolean(companySlug && periodId),
  });
}
