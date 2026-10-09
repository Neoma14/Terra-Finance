import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useEquityStatementReport } from "../../../features/workspace/use-reports.js";
import { isComparisonResponse } from "../../../features/workspace/report-scope.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";
import { ScalarComparison } from "../report-scope/comparison-view.js";
import type { EquityStatementReport } from "../../../features/workspace/report-types.js";

/**
 * Statement of Changes in Equity (TASK-DB-ARCH-017 §13) -- murni
 * consumer `equity-statement-service.ts`. Backend MENGGABUNGKAN setoran
 * modal & prive jadi satu field `additionalCapitalOrDrawings` (limitasi
 * terdokumentasi sejak TASK-DB-ARCH-012 §9 -- skema tidak punya sub-
 * klasifikasi) -- frontend TIDAK memisahkannya scr sepihak (§13 instruksi
 * eksplisit: "jangan membuat pemisahan palsu").
 */
export function EquityTab({ companySlug, fromDate, toDate, scope = "" }: { companySlug: string; fromDate: string; toDate: string; scope?: string }) {
  const { data, isLoading, isError, error } = useEquityStatementReport(companySlug, fromDate, toDate, scope);

  if (isLoading) return <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>;
  if (isError) return <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat Equity Statement. {(error as Error).message}</Card>;
  if (!data) return null;

  if (isComparisonResponse(data)) {
    return (
      <div className="flex flex-col gap-4">
        <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
        <ScalarComparison<EquityStatementReport>
          res={data}
          rows={[
            { label: "Opening Equity", pick: (r) => r.openingEquity },
            { label: "Setoran Modal / Prive (gabungan)", pick: (r) => r.additionalCapitalOrDrawings },
            { label: "Net Profit / Loss", pick: (r) => r.netProfit },
            { label: "Closing Equity", pick: (r) => r.closingEquity, strong: true },
          ]}
        />
      </div>
    );
  }

  const rows = [
    { label: "Opening Equity", value: data.openingEquity },
    { label: "Setoran Modal / Prive (gabungan)", value: data.additionalCapitalOrDrawings },
    { label: "Net Profit / Loss", value: data.netProfit },
  ];

  return (
    <div className="flex flex-col gap-4">
    <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
    <Card>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line/60">
              <td className="px-4 py-2.5">{r.label}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{formatIDR(r.value)}</td>
            </tr>
          ))}
          <tr className="bg-navy-700 font-bold text-white">
            <td className="px-4 py-3">Closing Equity</td>
            <td className="px-4 py-3 text-right tabular-nums">{formatIDR(data.closingEquity)}</td>
          </tr>
        </tbody>
      </table>
      <p className="px-4 py-3 text-xs text-ink/40">
        "Setoran Modal / Prive" merupakan nilai gabungan (belum dipisah per jenis) -- lihat limitasi pada dokumentasi Financial Reporting Engine.
      </p>
    </Card>
    </div>
  );
}
