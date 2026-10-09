import { AlertTriangle, Download, Info, LineChart as LineChartIcon, Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useParams } from "react-router-dom";
import { PrintReportFooter, PrintReportHeader } from "../components/print-report-chrome.js";
import { BackToCompanyLink, Card, CardHeader } from "../components/ui.js";
import { useCompanies } from "../features/companies/use-companies.js";
import { formatRatio } from "../lib/format.js";
import { usePeriods } from "../features/statements/use-statements.js";
import { useDownloadRatiosExcelRange, useRatioTrend, useRatiosRange } from "../features/ratios/use-ratios.js";
import { useChartColors } from "../theme/chart-colors.js";

/** Rasio Keuangan per template industri untuk rentang tanggal bebas + tren
 * antar periode -- sama persis logikanya dgn RatiosPage versi online,
 * termasuk Print/PDF. */
export function RatiosPage() {
  const { companySlug = "" } = useParams();
  const chartColors = useChartColors();
  const { data: companiesData } = useCompanies();
  const company = companiesData?.companies.find((c) => c.slug === companySlug);
  const companyName = company?.name ?? companySlug;
  const { data: periodsData, isLoading: periodsLoading } = usePeriods(companySlug);
  const periods = periodsData?.periods ?? [];
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  useEffect(() => {
    if (!from && !to && periods.length > 0) {
      setFrom(periods[0].startDate.slice(0, 10));
      setTo(periods[0].endDate.slice(0, 10));
    }
  }, [periods, from, to]);

  const { data: ratioData, isLoading: ratiosLoading } = useRatiosRange(companySlug, from, to);
  const { data: trendData } = useRatioTrend(companySlug);
  const downloadExcel = useDownloadRatiosExcelRange(companySlug);
  const rangeLabel = from && to ? `${from} s/d ${to}` : "";

  const ratios = ratioData?.result.ratios ?? [];
  const [selectedRatio, setSelectedRatio] = useState<string>();

  useEffect(() => {
    if (!selectedRatio && ratios.length > 0) setSelectedRatio(ratios[0].code);
  }, [ratios, selectedRatio]);

  const chartData = useMemo(() => {
    const points = trendData?.points ?? [];
    return points.map((p) => ({ periodLabel: p.periodLabel, value: p.ratios[selectedRatio ?? ""] ?? 0 }));
  }, [trendData, selectedRatio]);

  const selectedDef = ratios.find((r) => r.code === selectedRatio);

  if (periodsLoading) return <p className="text-sm text-ink/50">Memuat...</p>;

  if (periods.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <BackToCompanyLink companySlug={companySlug} />
        <Card className="flex flex-col items-center gap-2 border-dashed p-12 text-center">
          <AlertTriangle className="text-amber-500" size={28} />
          <h2 className="text-lg font-semibold text-heading">Belum ada data</h2>
          <p className="max-w-sm text-sm text-ink/60">Posting jurnal dulu lewat menu "Jurnal" supaya rasio bisa dihitung.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <BackToCompanyLink companySlug={companySlug} />
      </div>
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Rasio Keuangan</h1>
          <p className="text-sm text-ink/50">Kesehatan keuangan untuk rentang tanggal pilihan, disesuaikan dengan jenis industri.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
            <label className="text-xs font-medium text-ink/50">Dari</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
            <span className="text-ink/30">-</span>
            <label className="text-xs font-medium text-ink/50">Sampai</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            title="Print / Simpan sebagai PDF"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent"
          >
            <Printer size={14} /> Print / PDF
          </button>
          {from && to && (
            <button
              type="button"
              onClick={() => downloadExcel.mutate({ from, to })}
              disabled={downloadExcel.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent disabled:opacity-50"
            >
              <Download size={14} /> {downloadExcel.isPending ? "Menyiapkan..." : "Download Excel"}
            </button>
          )}
        </div>
      </div>

      {ratiosLoading ? (
        <p className="text-sm text-ink/50">Memuat...</p>
      ) : ratios.length === 0 ? (
        <p className="text-sm text-ink/50">Data Kosong</p>
      ) : (
        <div className="print-area">
          <PrintReportHeader
            companyName={companyName}
            companyLogoUrl={company?.logoUrl}
            industryTemplate={company?.industryTemplate ?? "general"}
            reportTitle="Rasio Keuangan"
            rangeLabel={rangeLabel}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ratios.map((r) => (
              <button
                key={r.code}
                onClick={() => setSelectedRatio(r.code)}
                className={`overflow-hidden rounded-xl border bg-surface text-left transition-colors ${
                  selectedRatio === r.code ? "border-accent outline outline-1 outline-accent" : "border-line hover:border-accent/50"
                }`}
              >
                <div className="h-1 w-full bg-[#25A970]" />
                <div className="p-4">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink/50">
                    {r.label}
                    {r.note && <Info size={12} className="shrink-0" aria-label={r.note} />}
                  </div>
                  <p className="text-xl font-bold tabular-nums text-heading">{formatRatio(r.value, r.format)}</p>
                  {r.note && <p className="mt-1 text-xs leading-snug text-ink/40">{r.note}</p>}
                </div>
              </button>
            ))}
          </div>
          <PrintReportFooter />
        </div>
      )}

      <Card className="no-print">
        <CardHeader title={selectedDef ? `Tren: ${selectedDef.label}` : "Tren"} icon={<LineChartIcon size={16} className="text-heading/60" />} />
        <div className="p-5">
          {chartData.length < 2 ? (
            <p className="text-sm text-ink/50">Butuh minimal 2 periode untuk menampilkan tren.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={chartColors.gridline} strokeWidth={1} />
                <XAxis dataKey="periodLabel" tick={{ fill: chartColors.muted, fontSize: 12 }} axisLine={{ stroke: chartColors.gridline }} tickLine={false} />
                <YAxis
                  tick={{ fill: chartColors.muted, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  tickFormatter={(v) => (selectedDef ? formatRatio(v, selectedDef.format) : String(v))}
                />
                <Tooltip
                  formatter={(value: number) => (selectedDef ? formatRatio(value, selectedDef.format) : value)}
                  contentStyle={{ borderRadius: 8, borderColor: chartColors.gridline, background: chartColors.surface, fontSize: 13 }}
                  labelStyle={{ color: chartColors.muted }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={chartColors.accent}
                  strokeWidth={2}
                  dot={{ r: 5, fill: chartColors.accent, stroke: chartColors.surface, strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: chartColors.accent, stroke: chartColors.surface, strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
    </div>
  );
}
