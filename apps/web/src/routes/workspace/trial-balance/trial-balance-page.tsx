import { useState } from "react";
import { ReportExportControl } from "../reports/report-export-control.js";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Badge, Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { usePeriodOptions } from "../../../features/workspace/use-journal.js";
import { useTrialBalance } from "../../../features/workspace/use-trial-balance.js";
import { isComparisonResponse, isComparisonScope, useReportScope } from "../../../features/workspace/report-scope.js";
import { ReportScopePicker } from "../report-scope/report-scope-picker.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";
import { TrialBalanceComparison } from "../report-scope/comparison-view.js";

/**
 * Trial Balance (TASK-DB-ARCH-017 §7-8) -- frontend MURNI consumer dari
 * `trial-balance-service.ts` (TIDAK diubah). PERIOD-based (bukan date-
 * range), sama alasannya dgn Ledger. `isBalanced`/`difference` SELALU
 * dari response backend, TIDAK dihitung ulang (§22/§23).
 *
 * Drill-down (§16): baris akun bisa diklik -> Ledger akun+periode yang
 * SAMA (keduanya sudah period-scoped, nol tebakan/endpoint baru -- BEDA
 * dari Report (date-range) yang TIDAK aman di-drill-down ke Ledger
 * [period-based] tanpa resolusi periode yang backend tidak sediakan,
 * lihat limitation di Final Report).
 */
export function TrialBalancePage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const navigate = useNavigate();
  const { data: periodsData } = usePeriodOptions(company.slug);
  const periods = periodsData?.periods ?? [];
  const [periodId, setPeriodId] = useState("");
  const [scope, setScope] = useReportScope(company.slug);

  const { data, isLoading, isError, error } = useTrialBalance(company.slug, periodId || undefined, scope);
  const selectedPeriod = periods.find((p) => p.id === periodId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Trial Balance</h1>
        <p className="text-sm text-ink/50">Neraca saldo per periode untuk {company.name}.</p>
      </div>

      <ReportScopePicker companySlug={company.slug} scope={scope} onChange={setScope} allowComparison />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink/60">Periode</label>
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="input-base w-48">
            <option value="">Pilih periode</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <ReportExportControl companySlug={company.slug} kind="trial-balance" params={scope ? { periodId, scope } : { periodId }} disabled={!periodId || isComparisonScope(scope)} />
      </Card>

      {!periodId ? (
        <Card className="p-10 text-center text-sm text-ink/40">Pilih periode untuk melihat Trial Balance.</Card>
      ) : isLoading ? (
        <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>
      ) : isError ? (
        <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat Trial Balance. {(error as Error).message}</Card>
      ) : data && isComparisonResponse(data) ? (
        <>
          <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
          <TrialBalanceComparison res={data} />
        </>
      ) : data ? (
        <>
          <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
          <div className="grid gap-4 sm:grid-cols-4">
            <SummaryCard label="Periode" value={selectedPeriod?.label ?? "-"} />
            <SummaryCard label="Total Debit" value={formatIDR(data.totalDebit)} />
            <SummaryCard label="Total Credit" value={formatIDR(data.totalCredit)} />
            <Card className="p-4">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">Status</p>
              <div className="flex items-center gap-2">
                <Badge tone={data.isBalanced ? "success" : "danger"}>{data.isBalanced ? "BALANCED" : "NOT BALANCED"}</Badge>
                {!data.isBalanced && <span className="text-xs text-rose-600">Selisih {formatIDR(data.difference)}</span>}
              </div>
            </Card>
          </div>

          {!data.isBalanced && (
            <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
              Trial Balance TIDAK balance -- ini mengindikasikan masalah integritas data akuntansi. Segera laporkan ke konsultan/admin, jangan diabaikan.
            </div>
          )}

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                  <tr>
                    <th className="px-4 py-2.5">Kode</th>
                    <th className="px-4 py-2.5">Nama Akun</th>
                    <th className="px-4 py-2.5 text-right">Debit</th>
                    <th className="px-4 py-2.5 text-right">Kredit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr
                      key={r.accountId}
                      onClick={r.isBridge ? undefined : () => navigate(`/workspace/${company.slug}/ledger?accountId=${r.accountId}&periodId=${periodId}`)}
                      className={r.isBridge ? "border-t border-line/60 italic text-ink/70" : "cursor-pointer border-t border-line/60 hover:bg-surface-2/60"}
                      title={r.isBridge ? "Akumulasi laba (rugi) periode sebelumnya yang belum ditutup. Bukan akun, tidak punya ledger." : "Lihat Ledger akun ini"}
                    >
                      <td className="px-4 py-2 tabular-nums">{r.code}</td>
                      <td className="px-4 py-2">{r.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.debit ? formatIDR(r.debit) : ""}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.credit ? formatIDR(r.credit) : ""}</td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-sm text-ink/40">
                        Belum ada data accounting untuk periode ini.
                      </td>
                    </tr>
                  )}
                </tbody>
                {data.rows.length > 0 && (
                  <tfoot>
                    <tr className="border-t border-line bg-surface-2/60 font-semibold">
                      <td className="px-4 py-2" colSpan={2}>
                        Total
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatIDR(data.totalDebit)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatIDR(data.totalCredit)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">{label}</p>
      <p className="text-sm font-bold tabular-nums text-heading">{value}</p>
    </Card>
  );
}
