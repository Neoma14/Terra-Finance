import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useIncomeStatementReport } from "../../../features/workspace/use-reports.js";
import { ReportSectionTable } from "./report-section-table.js";
import { isComparisonResponse } from "../../../features/workspace/report-scope.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";
import { SectionComparison } from "../report-scope/comparison-view.js";
import type { IncomeStatementReport } from "../../../features/workspace/report-types.js";

/** Income Statement (TASK-DB-ARCH-017 §12) -- murni consumer
 * `income-statement-service.ts`. Classification (Revenue/COGS/Expense/
 * Other Income/Expense) PERSIS dari backend, tidak bergantung nama akun
 * di frontend (§12/§22). */
export function IncomeStatementTab({ companySlug, fromDate, toDate, scope = "" }: { companySlug: string; fromDate: string; toDate: string; scope?: string }) {
  const { data, isLoading, isError, error } = useIncomeStatementReport(companySlug, fromDate, toDate, scope);

  if (isLoading) return <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>;
  if (isError) return <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat Income Statement. {(error as Error).message}</Card>;
  if (!data) return null;

  if (isComparisonResponse(data)) {
    return (
      <div className="flex flex-col gap-4">
        <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
        <SectionComparison<IncomeStatementReport>
          res={data}
          sections={[
            { label: "Revenue", pick: (r) => r.revenue },
            { label: "Cost of Goods Sold", pick: (r) => r.cogs },
            { label: "Operating Expenses", pick: (r) => r.operatingExpenses },
            { label: "Other Income", pick: (r) => r.otherIncome },
            { label: "Other Expense", pick: (r) => r.otherExpense },
          ]}
          totals={[
            { label: "Gross Profit", pick: (r) => r.grossProfit },
            { label: "Operating Profit", pick: (r) => r.operatingProfit },
            { label: "Net Profit / Loss", pick: (r) => r.netProfit },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Gross Profit" value={formatIDR(data.grossProfit)} />
        <SummaryCard label="Operating Profit" value={formatIDR(data.operatingProfit)} />
        <SummaryCard label="Net Profit / Loss" value={formatIDR(data.netProfit)} tone={data.netProfit >= 0 ? "positive" : "negative"} />
      </div>

      <ReportSectionTable section={data.revenue} />
      <ReportSectionTable section={data.cogs} />
      <div className="rounded-lg bg-surface-2/60 px-4 py-2 text-sm font-semibold text-heading">Gross Profit: {formatIDR(data.grossProfit)}</div>
      <ReportSectionTable section={data.operatingExpenses} />
      <div className="rounded-lg bg-surface-2/60 px-4 py-2 text-sm font-semibold text-heading">Operating Profit: {formatIDR(data.operatingProfit)}</div>
      <ReportSectionTable section={data.otherIncome} />
      <ReportSectionTable section={data.otherExpense} />
      <div className="rounded-lg bg-navy-700 px-4 py-3 text-sm font-bold text-white">Net Profit / Loss: {formatIDR(data.netProfit)}</div>
    </div>
  );
}

function SummaryCard({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "positive" | "negative" }) {
  const toneClass = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-rose-600" : "text-heading";
  return (
    <Card className="p-4">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${toneClass}`}>{value}</p>
    </Card>
  );
}
