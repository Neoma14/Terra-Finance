import type { BenchmarkCompany } from "@konsultan/shared";
import { BarChart3, Building2, Download, Printer, TrendingUp, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { DarkStatCard } from "../components/charts.js";
import { PrintReportFooter, PrintReportHeader } from "../components/print-report-chrome.js";
import { Card, CardHeader, INDUSTRY_ICONS, IndustryBadge } from "../components/ui.js";
import { useCompanies } from "../features/companies/use-companies.js";
import { useBenchmark, useDownloadBenchmarkExcel } from "../features/benchmark/use-benchmark.js";
import { formatIDR, formatIDRCompact, formatRatio } from "../lib/format.js";

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function metricValue(c: BenchmarkCompany, code: string): number {
  return c.universalMetrics.find((m) => m.code === code)?.value ?? 0;
}

/** Benchmarking lintas-perusahaan -- sama persis logikanya dgn versi
 * online (routes/benchmark-page.tsx), termasuk Print/PDF & Download Excel.
 * BEDA: TIDAK ADA "Pilih Perusahaan" yang dibatasi akses per-user (semua
 * user di instalasi ini lihat semua perusahaan), header/logo/theme-menu
 * sendiri dihilangkan krn halaman ini sudah dirender di dalam AppShell spt
 * halaman lain. */
export function BenchmarkPage() {
  const { data: companiesData } = useCompanies();
  const companies = companiesData?.companies ?? [];

  const [{ from, to }, setRange] = useState(defaultRange);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const { data: benchmarkData, isLoading } = useBenchmark(from, to, selectedIds);
  const downloadExcel = useDownloadBenchmarkExcel();
  const result = benchmarkData?.companies ?? [];
  const rangeLabel = `${from} s/d ${to}`;

  const groupedByIndustry = useMemo(() => {
    const groups = new Map<string, BenchmarkCompany[]>();
    for (const c of result) {
      const list = groups.get(c.industryTemplate) ?? [];
      list.push(c);
      groups.set(c.industryTemplate, list);
    }
    return groups;
  }, [result]);

  const totals = useMemo(
    () => ({
      totalAssets: result.reduce((s, c) => s + metricValue(c, "total_assets"), 0),
      totalRevenue: result.reduce((s, c) => s + metricValue(c, "revenue"), 0),
      totalNetIncome: result.reduce((s, c) => s + metricValue(c, "net_income"), 0),
    }),
    [result],
  );

  function toggleCompany(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Benchmarking Antar Perusahaan</h1>
          <p className="text-sm text-ink/50">Bandingkan metrik universal & rasio spesifik industri antar perusahaan klien.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
            <label className="text-xs font-medium text-ink/50">Dari</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="bg-transparent text-sm font-medium text-heading outline-none"
            />
            <span className="text-ink/30">-</span>
            <label className="text-xs font-medium text-ink/50">Sampai</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="bg-transparent text-sm font-medium text-heading outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            title="Print / Simpan sebagai PDF"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent"
          >
            <Printer size={14} /> Print / PDF
          </button>
          <button
            type="button"
            onClick={() => downloadExcel.mutate({ from, to, companyIds: selectedIds })}
            disabled={downloadExcel.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            <Download size={14} /> {downloadExcel.isPending ? "Menyiapkan..." : "Download Excel"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="no-print h-fit p-4">
          <h2 className="mb-2 text-sm font-semibold text-heading">Pilih Perusahaan</h2>
          <p className="mb-3 text-xs text-ink/40">Kosongkan semua untuk menampilkan seluruh perusahaan.</p>
          <div className="flex flex-col gap-1.5">
            {companies.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => toggleCompany(c.id)} className="accent-accent" />
                <span className="truncate text-ink">{c.name}</span>
              </label>
            ))}
          </div>
        </Card>

        <div className="print-area flex flex-col gap-4">
          <PrintReportHeader companyName="Seluruh Portofolio Klien" industryTemplate="general" reportTitle="Benchmarking Antar Perusahaan" rangeLabel={rangeLabel} />

          {isLoading && <p className="text-ink/50">Memuat...</p>}

          {!isLoading && result.length === 0 && (
            <Card className="p-10 text-center text-sm text-ink/50">
              Belum ada data untuk rentang tanggal ini. Pastikan perusahaan yang dipilih punya periode/jurnal yang beririsan dengan rentang di atas.
            </Card>
          )}

          {result.length > 0 && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <DarkStatCard label="Perusahaan Dibandingkan" value={String(result.length)} icon={<Building2 size={13} />} />
                <DarkStatCard label="Total Aset Gabungan" value={formatIDRCompact(totals.totalAssets)} fullValue={formatIDR(totals.totalAssets)} icon={<Wallet size={13} />} />
                <DarkStatCard
                  label="Total Laba Bersih Gabungan"
                  value={formatIDRCompact(totals.totalNetIncome)}
                  fullValue={formatIDR(totals.totalNetIncome)}
                  icon={<TrendingUp size={13} />}
                />
              </div>

              <Card>
                <CardHeader title="Perbandingan Metrik Universal" icon={<BarChart3 size={16} className="text-heading/60" />} />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-navy-700 text-left text-xs uppercase tracking-wide text-white">
                        <th className="px-5 py-2.5">Metrik</th>
                        {result.map((c) => (
                          <th key={c.companyId} className="px-5 py-2.5">
                            <div className="flex items-center gap-1.5 normal-case tracking-normal text-white">{c.companyName}</div>
                            <IndustryBadge template={c.industryTemplate} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result[0].universalMetrics.map((m, i) => (
                        <tr key={m.code} className="border-b border-line/60 last:border-0">
                          <td className="px-5 py-2 text-ink/70">{m.label}</td>
                          {result.map((c) => (
                            <td key={c.companyId} className="px-5 py-2 tabular-nums text-ink">
                              {formatRatio(c.universalMetrics[i]?.value ?? 0, m.format)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {[...groupedByIndustry.entries()].map(([template, group]) => {
                const Icon = INDUSTRY_ICONS[template as keyof typeof INDUSTRY_ICONS];
                return (
                  <Card key={template}>
                    <CardHeader title={`Rasio Spesifik Industri: ${group.length} Perusahaan`} icon={<Icon size={16} className="text-heading/60" />} />
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-navy-700 text-left text-xs uppercase tracking-wide text-white">
                            <th className="px-5 py-2.5">Rasio</th>
                            {group.map((c) => (
                              <th key={c.companyId} className="px-5 py-2.5 normal-case tracking-normal text-white">
                                {c.companyName}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {group[0].industryMetrics.map((m, i) => (
                            <tr key={m.code} className="border-b border-line/60 last:border-0">
                              <td className="px-5 py-2 text-ink/70">{m.label}</td>
                              {group.map((c) => (
                                <td key={c.companyId} className="px-5 py-2 tabular-nums text-ink">
                                  {formatRatio(c.industryMetrics[i]?.value ?? 0, m.format)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="border-t border-line px-5 py-2.5 text-xs text-ink/40">Rasio ini hanya bermakna dibandingkan sesama template industri yang sama.</p>
                  </Card>
                );
              })}
            </>
          )}

          <PrintReportFooter />
        </div>
      </div>
    </div>
  );
}
