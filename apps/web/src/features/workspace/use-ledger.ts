import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { AccountLedgerResult } from "./ledger-types.js";
import { scopeKeyParts, scopeParam, type ScopedExtras } from "./report-scope.js";

/** `GET /ledger/:accountId?fromDate=&toDate=` -- ledger per RENTANG TANGGAL
 * (kedua ujung inklusif). Dipanggil hanya setelah pengguna menekan Tampilkan. */
export function useAccountLedger(companySlug: string, accountId: string | undefined, range: { fromDate: string; toDate: string } | null, scope = "") {
  return useQuery({
    queryKey: ["workspace", "ledger", companySlug, accountId, range?.fromDate, range?.toDate, ...scopeKeyParts(companySlug, scope)],
    queryFn: () => companyApi.get<AccountLedgerResult & ScopedExtras>(`/${companySlug}/ledger/${accountId}?fromDate=${range!.fromDate}&toDate=${range!.toDate}${scopeParam(scope)}`),
    enabled: Boolean(companySlug && accountId && range),
  });
}
