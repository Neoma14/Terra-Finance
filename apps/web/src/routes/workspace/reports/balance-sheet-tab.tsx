import { Badge, Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useBalanceSheetReport } from "../../../features/workspace/use-reports.js";
import { ReportSectionTable } from "./report-section-table.js";
import { isComparisonResponse } from "../../../features/workspace/report-scope.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";
import { SectionComparison } from "../report-scope/comparison-view.js";
import type { BalanceSheetReport } from "../../../features/workspace/report-types.js";

/**
 * Balance Sheet (TASK-DB-ARCH-017 §11) -- murni consumer
 * `balance-sheet-service.ts` (TIDAK diubah). TIDAK ADA breakdown current/
 * non-current aset/liabilitas -- backend tidak menyediakan klasifikasi
 * itu per baris (lihat `report-types.ts`), jadi TIDAK dibuat pemisahan
 * palsu di frontend (§11/§22 instruksi eksplisit). Baris "Laba (Rugi)
 * Belum Ditutup" di section Equity ADALAH bridge resmi dari backend
 * (lihat Change_Log.md TASK-DB-ARCH-012) -- ditampilkan apa adanya.
 */
export function BalanceSheetTab({ companySlug, fromDate, toDate, scope = "" }: { companySlug: string; fromDate: string; toDate: string; scope?: string }) {
  const { data, isLoading, isError, error } = useBalanceSheetReport(companySlug, fromDate, toDate, scope);

  if (isLoading) return <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>;
  if (isError) return <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat Balance Sheet. {(error as Error).message}</Card>;
  if (!data) return null;

  if (isComparisonResponse(data)) {
    return (
      <div className="flex flex-col gap-4">
        <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
        <SectionComparison<BalanceSheetReport>
          res={data}
          sections={[
            { label: "Assets", pick: (r) => r.assets },
            { label: "Liabilities", pick: (r) => r.liabilities },
            { label: "Equity", pick: (r) => r.equity },
          ]}
          totals={[
            { label: "Total Assets", pick: (r) => r.totalAssets },
            { label: "Total Liabilities + Equity", pick: (r) => r.totalLiabilities + r.totalEquity },
          ]}
        />
      </div>
    );
  }

  const totalLiabilitiesPlusEquity = data.totalLiabilities + data.totalEquity;

  return (
    <div className="flex flex-col gap-4">
      <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Total Assets" value={formatIDR(data.totalAssets)} />
        <SummaryCard label="Total Liabilities + Equity" value={formatIDR(totalLiabilitiesPlusEquity)} />
        <Card className="p-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">Status</p>
          <div className="flex items-center gap-2">
            <Badge tone={data.isBalanced ? "success" : "danger"}>{data.isBalanced ? "BALANCED" : "NOT BALANCED"}</Badge>
            {!data.isBalanced && <span className="text-xs text-rose-600">Selisih {formatIDR(data.balanceDifference)}</span>}
          </div>
        </Card>
      </div>

      {!data.isBalanced && (
        <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
          Balance Sheet TIDAK balance -- backend melaporkan ini sbg indikasi masalah integritas data, bukan kondisi laporan yang valid. Laporkan ke admin/konsultan.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <ReportSectionTable section={data.assets} />
        </div>
        <div className="flex flex-col gap-4">
          <ReportSectionTable section={data.liabilities} />
          <ReportSectionTable section={data.equity} />
        </div>
      </div>
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
