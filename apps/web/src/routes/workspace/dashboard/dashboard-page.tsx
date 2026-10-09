import {
  AlertTriangle,
  Banknote,
  Clock,
  Landmark,
  LineChart as LineChartIcon,
  PiggyBank,
  Receipt,
  Scale,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Card, CardHeader } from "../../../components/ui.js";
import { DarkStatCard, DarkTrendCard, DonutCard } from "../../../components/charts.js";
import { formatIDR, formatIDRCompact, formatRatio } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useDashboardSummary } from "../../../features/workspace/use-dashboard.js";
import { DashboardDateFilter, presetToRange, type DatePreset } from "./dashboard-date-filter.js";
import { useReportScope } from "../../../features/workspace/report-scope.js";
import { ReportScopePicker } from "../report-scope/report-scope-picker.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";
import type { DashboardKpi } from "../../../features/workspace/dashboard-types.js";

const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  "journal.create": "Jurnal dibuat (draft)",
  "journal.post": "Jurnal diposting",
  "journal.reverse": "Jurnal di-reversal",
  "journal.import": "Import jurnal",
  "journal.delete_draft": "Draft jurnal dihapus",
  "opening_balance.create": "Saldo awal dibuat",
};

/** `null` = "belum tersedia" (§22 instruksi) -- TIDAK PERNAH ditampilkan
 * sbg "0", beda makna (0 = memang nol, null = datanya tidak ada/tidak
 * bisa dihitung). */
function kpiValueLabel(kpi: DashboardKpi, format: "currency" | "percent"): string {
  if (kpi.value === null) return "Belum tersedia";
  return format === "percent" ? formatRatio(kpi.value, "percent") : formatIDR(kpi.value);
}
function kpiDelta(kpi: DashboardKpi): { label: string; positive: boolean } | undefined {
  // §24: jangan tampilkan comparison kalau periode sebelumnya tidak
  // tersedia ATAU pembagi nol (changePercent sudah null dari backend utk
  // kedua kasus itu) -- dan jangan PERNAH render Infinity%/NaN%.
  if (kpi.changePercent === null || !Number.isFinite(kpi.changePercent)) return undefined;
  const positive = kpi.changePercent >= 0;
  return { label: `${positive ? "+" : ""}${kpi.changePercent.toFixed(1)}%`, positive };
}

export function DashboardPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [preset, setPreset] = useState<DatePreset>("this_month");
  const initial = presetToRange("this_month");
  const [fromDate, setFromDate] = useState(initial.fromDate);
  const [toDate, setToDate] = useState(initial.toDate);

  const [scope, setScope] = useReportScope(company.slug);
  const { data, isLoading, isError, error } = useDashboardSummary(company.slug, fromDate, toDate, scope);

  function handleFilterChange(next: { preset: DatePreset; fromDate: string; toDate: string }) {
    setPreset(next.preset);
    setFromDate(next.fromDate);
    setToDate(next.toDate);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Dashboard</h1>
        <p className="text-sm text-ink/50">Ringkasan kinerja keuangan {company.name}.</p>
      </div>

      <ReportScopePicker companySlug={company.slug} scope={scope} onChange={setScope} />
      <ScopeBanner scope={data?.scope} />

      <DashboardDateFilter preset={preset} fromDate={fromDate} toDate={toDate} onChange={handleFilterChange} />

      {isLoading && <p className="text-sm text-ink/40">Memuat...</p>}
      {isError && (
        <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat dashboard. {(error as Error).message}</Card>
      )}

      {data && (
        <>
          {data.alerts.length > 0 && (
            <div className="flex flex-col gap-2">
              {data.alerts.map((a, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ${
                    a.severity === "warning" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-sky-300 bg-sky-50 text-sky-800"
                  }`}
                >
                  <AlertTriangle size={16} className="shrink-0" />
                  {a.message}
                </div>
              ))}
            </div>
          )}

          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
              Laba Tahun Berjalan (YTD) &middot; {data.ytd.fromDate} s/d {data.ytd.toDate}
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-ink/50">Pendapatan YTD</p>
                <p className="text-lg font-bold tabular-nums text-heading">{formatIDR(data.ytd.revenue)}</p>
              </div>
              <div>
                <p className="text-xs text-ink/50">Beban YTD</p>
                <p className="text-lg font-bold tabular-nums text-heading">{formatIDR(data.ytd.expense)}</p>
              </div>
              <div>
                <p className="text-xs text-ink/50">Laba Tahun Berjalan</p>
                <p className={`text-lg font-bold tabular-nums ${data.ytd.netProfit < 0 ? "text-rose-600" : "text-heading"}`}>{formatIDR(data.ytd.netProfit)}</p>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <DarkStatCard label="Pendapatan" value={kpiValueLabel(data.kpis.revenue, "currency")} fullValue={data.kpis.revenue.value !== null ? formatIDR(data.kpis.revenue.value) : undefined} icon={<TrendingUp size={14} />} deltaLabel={kpiDelta(data.kpis.revenue)?.label} deltaPositive={kpiDelta(data.kpis.revenue)?.positive} sparkline={data.trend.map((t) => ({ label: t.label, value: t.revenue }))} />
            <DarkStatCard label="Beban" value={kpiValueLabel(data.kpis.expense, "currency")} fullValue={data.kpis.expense.value !== null ? formatIDR(data.kpis.expense.value) : undefined} icon={<TrendingDown size={14} />} deltaLabel={kpiDelta(data.kpis.expense)?.label} deltaPositive={kpiDelta(data.kpis.expense) ? !kpiDelta(data.kpis.expense)!.positive : undefined} sparkline={data.trend.map((t) => ({ label: t.label, value: t.expense }))} />
            <DarkStatCard label="Laba Bersih" value={kpiValueLabel(data.kpis.netProfit, "currency")} fullValue={data.kpis.netProfit.value !== null ? formatIDR(data.kpis.netProfit.value) : undefined} icon={<Landmark size={14} />} deltaLabel={kpiDelta(data.kpis.netProfit)?.label} deltaPositive={kpiDelta(data.kpis.netProfit)?.positive} sparkline={data.trend.map((t) => ({ label: t.label, value: t.netProfit }))} />
            <DarkStatCard label="Margin Laba" value={kpiValueLabel(data.kpis.profitMargin, "percent")} icon={<Scale size={14} />} deltaLabel={kpiDelta(data.kpis.profitMargin)?.label} deltaPositive={kpiDelta(data.kpis.profitMargin)?.positive} />
            <DarkStatCard label="Kas & Bank" value={kpiValueLabel(data.kpis.cashAndBank, "currency")} fullValue={data.kpis.cashAndBank.value !== null ? formatIDR(data.kpis.cashAndBank.value) : undefined} icon={<Wallet size={14} />} deltaLabel={kpiDelta(data.kpis.cashAndBank)?.label} deltaPositive={kpiDelta(data.kpis.cashAndBank)?.positive} sparkline={data.trend.map((t) => ({ label: t.label, value: t.endingCash }))} />
            <DarkStatCard label="Total Aset" value={kpiValueLabel(data.kpis.totalAssets, "currency")} fullValue={data.kpis.totalAssets.value !== null ? formatIDR(data.kpis.totalAssets.value) : undefined} icon={<PiggyBank size={14} />} deltaLabel={kpiDelta(data.kpis.totalAssets)?.label} deltaPositive={kpiDelta(data.kpis.totalAssets)?.positive} />
            <DarkStatCard label="Liabilitas" value={kpiValueLabel(data.kpis.totalLiabilities, "currency")} fullValue={data.kpis.totalLiabilities.value !== null ? formatIDR(data.kpis.totalLiabilities.value) : undefined} icon={<Receipt size={14} />} deltaLabel={kpiDelta(data.kpis.totalLiabilities)?.label} deltaPositive={kpiDelta(data.kpis.totalLiabilities) ? !kpiDelta(data.kpis.totalLiabilities)!.positive : undefined} />
            <DarkStatCard label="Ekuitas" value={kpiValueLabel(data.kpis.totalEquity, "currency")} fullValue={data.kpis.totalEquity.value !== null ? formatIDR(data.kpis.totalEquity.value) : undefined} icon={<Banknote size={14} />} deltaLabel={kpiDelta(data.kpis.totalEquity)?.label} deltaPositive={kpiDelta(data.kpis.totalEquity)?.positive} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <DarkTrendCard
              title="Tren Pendapatan vs Beban"
              icon={<LineChartIcon size={16} />}
              series={[
                { key: "revenue", label: "Pendapatan", color: "#3CB371" },
                { key: "expense", label: "Beban", color: "#F87171" },
              ]}
              data={data.trend.map((t) => ({ periodLabel: t.label, revenue: t.revenue, expense: t.expense }))}
            />
            <DarkTrendCard
              title="Tren Laba Bersih & Margin"
              icon={<TrendingUp size={16} />}
              series={[
                { key: "netProfit", label: "Laba Bersih", color: "#60A5FA" },
                { key: "profitMargin", label: "Margin (%)", color: "#FBBF24", axis: "right" },
              ]}
              data={data.trend.map((t) => ({ periodLabel: t.label, netProfit: t.netProfit, profitMargin: t.profitMargin !== null ? Math.round(t.profitMargin * 1000) / 10 : 0 }))}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <DonutCard
              title="Komposisi Beban"
              icon={<Receipt size={16} className="text-heading/60" />}
              centerValue={formatIDRCompact(data.expenseComposition.reduce((s, e) => s + e.amount, 0))}
              centerLabel="Total Beban"
              data={data.expenseComposition.length > 0 ? data.expenseComposition.map((e) => ({ label: e.accountName, value: e.amount })) : [{ label: "Belum ada beban", value: 1 }]}
            />
            <DonutCard
              title="Posisi Keuangan"
              icon={<Scale size={16} className="text-heading/60" />}
              centerValue={formatIDRCompact(data.financialPosition.totalAssets)}
              centerLabel="Total Aset"
              data={[
                { label: "Aset", value: Math.max(data.financialPosition.totalAssets, 0) },
                { label: "Liabilitas", value: Math.max(data.financialPosition.totalLiabilities, 0) },
                { label: "Ekuitas", value: Math.max(data.financialPosition.totalEquity, 0) },
              ]}
            />
            <DarkTrendCard
              title="Tren Kas & Bank"
              icon={<Wallet size={16} />}
              series={[{ key: "endingCash", label: "Kas & Bank", color: "#34D399" }]}
              data={data.trend.map((t) => ({ periodLabel: t.label, endingCash: t.endingCash }))}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Aktivitas Terbaru" icon={<Clock size={16} className="text-heading/60" />} />
              <div className="flex flex-col divide-y divide-line/60">
                {data.recentActivity.length === 0 && <p className="px-5 py-6 text-center text-sm text-ink/40">Belum ada aktivitas.</p>}
                {data.recentActivity.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-heading">{ACTIVITY_ACTION_LABELS[a.action] ?? a.action}</p>
                      <p className="truncate text-xs text-ink/40">{a.actorLabel}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-ink/40">{new Date(a.createdAt).toLocaleString("id-ID")}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader title="Ringkasan Periode" icon={<LineChartIcon size={16} className="text-heading/60" />} />
              <div className="flex flex-col gap-2 p-5 text-sm">
                <p className="text-ink/60">
                  Periode: <span className="font-medium text-heading">{data.period.fromDate}</span> s/d{" "}
                  <span className="font-medium text-heading">{data.period.toDate}</span>
                </p>
                {data.previousPeriod ? (
                  <p className="text-ink/60">
                    Dibandingkan dgn: <span className="font-medium text-heading">{data.previousPeriod.fromDate}</span> s/d{" "}
                    <span className="font-medium text-heading">{data.previousPeriod.toDate}</span>
                  </p>
                ) : (
                  <p className="text-ink/40">Periode sebelumnya belum tersedia utk perbandingan.</p>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
