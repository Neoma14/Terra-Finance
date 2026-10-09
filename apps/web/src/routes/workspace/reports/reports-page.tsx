import { FileBarChart, LineChart, Scale, Wallet } from "lucide-react";
import { todayLocal } from "../../../lib/date.js";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { BalanceSheetTab } from "./balance-sheet-tab.js";
import { CashFlowTab } from "./cash-flow-tab.js";
import { EquityTab } from "./equity-tab.js";
import { IncomeStatementTab } from "./income-statement-tab.js";
import { ReportDateFilter } from "./report-date-filter.js";
import { ReportExportControl } from "./report-export-control.js";
import { isComparisonScope, useReportScope } from "../../../features/workspace/report-scope.js";
import { ReportScopePicker } from "../report-scope/report-scope-picker.js";

type Tab = "balance-sheet" | "income-statement" | "equity" | "cash-flow";

const TABS: { key: Tab; label: string; icon: typeof FileBarChart }[] = [
  { key: "balance-sheet", label: "Balance Sheet", icon: Scale },
  { key: "income-statement", label: "Income Statement", icon: FileBarChart },
  { key: "equity", label: "Equity", icon: LineChart },
  { key: "cash-flow", label: "Cash Flow", icon: Wallet },
];

function defaultFromDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-01-01`;
}
function defaultToDate(): string {
  return todayLocal();
}

/**
 * Financial Reports (TASK-DB-ARCH-017 §9-15) -- hub 4 laporan di atas
 * `reporting-utils.ts`/4 report service (TASK-DB-ARCH-012, TIDAK diubah).
 * SATU filter tanggal dipakai bersama (`fromDate`/`toDate`), hanya tab
 * yang AKTIF yang benar-benar fetch (§24: satu request per filter).
 */
export function ReportsPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [tab, setTab] = useState<Tab>("balance-sheet");
  const [fromDate, setFromDate] = useState(defaultFromDate());
  const [toDate, setToDate] = useState(defaultToDate());
  const [scope, setScope] = useReportScope(company.slug);

  const dateRangeInvalid = fromDate > toDate;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Laporan Keuangan</h1>
        <p className="text-sm text-ink/50">Balance Sheet, Income Statement, Equity, dan Cash Flow untuk {company.name}.</p>
      </div>

      <ReportDateFilter fromDate={fromDate} toDate={toDate} onChange={({ fromDate: f, toDate: t }) => { setFromDate(f); setToDate(t); }} />
      {dateRangeInvalid && <p className="text-sm text-rose-600">Dari Tanggal tidak boleh setelah Sampai Tanggal.</p>}

      <ReportScopePicker companySlug={company.slug} scope={scope} onChange={setScope} allowComparison />

      <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <ReportExportControl
        companySlug={company.slug}
        kind={tab}
        params={scope ? { fromDate, toDate, scope } : { fromDate, toDate }}
        disabled={dateRangeInvalid || isComparisonScope(scope)}
      />
      {isComparisonScope(scope) && <p className="text-xs text-ink/60">Ekspor komparasi per cabang belum tersedia. Pilih satu cabang atau gabungan untuk mengunduh.</p>}

      {!dateRangeInvalid && (
        <>
          {tab === "balance-sheet" && <BalanceSheetTab companySlug={company.slug} fromDate={fromDate} toDate={toDate} scope={scope} />}
          {tab === "income-statement" && <IncomeStatementTab companySlug={company.slug} fromDate={fromDate} toDate={toDate} scope={scope} />}
          {tab === "equity" && <EquityTab companySlug={company.slug} fromDate={fromDate} toDate={toDate} scope={scope} />}
          {tab === "cash-flow" && <CashFlowTab companySlug={company.slug} fromDate={fromDate} toDate={toDate} scope={scope} />}
        </>
      )}
    </div>
  );
}
