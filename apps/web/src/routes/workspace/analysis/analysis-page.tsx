import { Fragment, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import { formatRatio } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useRatioAnalysis } from "../../../features/workspace/use-analysis.js";
import { DashboardDateFilter, presetToRange, type DatePreset } from "../dashboard/dashboard-date-filter.js";
import type { RatioValue } from "../../../features/workspace/analysis-types.js";

/**
 * Analisis (TASK-023 §10) -- PENGGANTI UI legacy `/c/:slug/ratios`.
 * Frontend MURNI consumer dari `GET /analysis` (reuse Balance Sheet +
 * Income Statement yang SAMA dgn Dashboard/Laporan Keuangan). Rasio yang
 * datanya tidak valid (currentRatio) ditampilkan "Belum tersedia" --
 * BUKAN 0, BUKAN dikosongkan diam-diam.
 */
export function AnalysisPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [preset, setPreset] = useState<DatePreset>("this_month");
  const [range, setRange] = useState(() => presetToRange("this_month"));

  const { data, isLoading, isError, error } = useRatioAnalysis(company.slug, range.fromDate, range.toDate);

  const rows: Array<{ section: string; items: Array<[string, RatioValue, "percent" | "times"]> }> = data
    ? [
        {
          section: "Profitabilitas",
          items: [
            ["Margin Laba Kotor", data.profitability.grossProfitMargin, "percent"],
            ["Margin Laba Operasi", data.profitability.operatingMargin, "percent"],
            ["Margin Laba Bersih", data.profitability.netProfitMargin, "percent"],
            ["Return on Assets (ROA)", data.profitability.returnOnAssets, "percent"],
            ["Return on Equity (ROE)", data.profitability.returnOnEquity, "percent"],
          ],
        },
        {
          section: "Solvabilitas",
          items: [
            ["Debt to Equity", data.solvency.debtToEquity, "times"],
            ["Debt to Assets", data.solvency.debtToAssets, "times"],
          ],
        },
        {
          section: "Likuiditas",
          items: [["Current Ratio", data.liquidity.currentRatio, "times"]],
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Analisis</h1>
        <p className="text-sm text-ink/50">Rasio keuangan {company.name} berdasarkan laporan periode terpilih.</p>
      </div>

      <DashboardDateFilter
        preset={preset}
        fromDate={range.fromDate}
        toDate={range.toDate}
        onChange={(next) => {
          setPreset(next.preset);
          setRange({ fromDate: next.fromDate, toDate: next.toDate });
        }}
      />

      {isLoading && <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>}
      {isError && <Card className="p-10 text-center text-sm text-rose-600">{(error as Error).message}</Card>}

      {!isLoading && !isError && data && (
        <Card>
          <table className="w-full text-sm">
            <tbody>
              {rows.map((group) => (
                <Fragment key={group.section}>
                  <tr className="border-t border-line/60 bg-surface-2/60 first:border-t-0">
                    <td colSpan={2} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink/50">
                      {group.section}
                    </td>
                  </tr>
                  {group.items.map(([label, ratio, format]) => (
                    <tr key={label} className="border-t border-line/60">
                      <td className="px-4 py-2.5 text-ink/70">{label}</td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums text-heading" title={ratio.unavailableReason}>
                        {ratio.value === null ? <span className="font-normal text-ink/40">Belum tersedia</span> : formatRatio(ratio.value, format)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
