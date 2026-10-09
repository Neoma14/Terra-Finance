import type { CashFlowDetailResult, CashFlowResult } from "@konsultan/shared";
import { INDUSTRY_TEMPLATE_LABELS } from "@konsultan/shared";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Building2,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  LayoutGrid,
  PenLine,
  PieChart,
  Printer,
  Receipt,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CompanyLogo, EditableImage } from "../components/avatar.js";
import { DarkStatCard, DarkTrendCard, DonutCard } from "../components/charts.js";
import { PrintStatementReport } from "../components/print-statement-report.js";
import { StatementTable } from "../components/statement-table.js";
import { Card, CardHeader, IndustryBadge } from "../components/ui.js";
import { useMe } from "../features/auth/use-auth.js";
import { useCompany, useDeleteCompanyLogo, useUploadCompanyLogo } from "../features/companies/use-companies.js";
import {
  useBalanceSheetRange,
  useCashFlowDetailRange,
  useCashFlowRange,
  useDownloadStatementsExcelRange,
  useEquityStatementRange,
  useFinancialTrendRange,
  useIncomeStatementRange,
  usePeriods,
} from "../features/statements/use-statements.js";
import { formatIDR, formatIDRCompact } from "../lib/format.js";

type DashboardTab = "ringkasan" | "laporan";

function toDateInputValue(value: string): string {
  return value.slice(0, 10);
}

/** Detail perusahaan -- header identitas + tombol menu (Chart of Accounts,
 * Jurnal, Buku Besar, Rasio, Estimasi Pajak), PLUS "Dashboard" (KPI +
 * chart + Neraca/Laba-Rugi/Ekuitas/Arus-Kas + Print/PDF) langsung di
 * halaman ini -- sama persis logikanya dgn DashboardPage versi online
 * (tab Ringkasan/Laporan), yang di versi online JUSTRU halaman utama
 * perusahaan (bukan halaman "Laporan Keuangan" terpisah spt yang sempat
 * saya buat sebelumnya -- sudah dihapus, digantikan tab "Laporan" di sini
 * supaya kembali sama persis dgn online). */
export function CompanyDetailPage() {
  const { companySlug = "" } = useParams<{ companySlug: string }>();
  const { data, isLoading } = useCompany(companySlug);
  const { data: me } = useMe();
  const uploadLogo = useUploadCompanyLogo(companySlug);
  const deleteLogo = useDeleteCompanyLogo(companySlug);

  const { data: periodsData, isLoading: periodsLoading } = usePeriods(companySlug);
  const periods = periodsData?.periods ?? [];
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const [tab, setTab] = useState<DashboardTab>("ringkasan");

  useEffect(() => {
    if (!from && !to && periods.length > 0) {
      setFrom(toDateInputValue(periods[0].startDate));
      setTo(toDateInputValue(periods[0].endDate));
    }
  }, [periods, from, to]);

  const balanceSheet = useBalanceSheetRange(companySlug, from, to);
  const incomeStatement = useIncomeStatementRange(companySlug, from, to);
  const equityStatement = useEquityStatementRange(companySlug, from, to);
  const cashFlow = useCashFlowRange(companySlug, from, to);
  const cashFlowDetail = useCashFlowDetailRange(companySlug, from, to);
  const trend = useFinancialTrendRange(companySlug, from, to);
  const downloadExcel = useDownloadStatementsExcelRange(companySlug);

  if (isLoading) return <p className="text-sm text-ink/40">Memuat...</p>;
  if (!data?.company) return <p className="text-sm text-ink/40">Perusahaan tidak ditemukan.</p>;

  const c = data.company;
  const rangeLabel = from && to ? `${from} s/d ${to}` : "";

  const bsLines = balanceSheet.data?.result.lines ?? [];
  const assetLines = bsLines.filter((l) => l.lineCode.startsWith("a_") || l.lineCode.startsWith("ca_") || l.lineCode.startsWith("fa_"));
  const liabEquityLines = bsLines.filter((l) => !assetLines.includes(l));
  const totalAssets = assetLines.reduce((s, l) => s + l.amount, 0);
  const totalLiabEquity = liabEquityLines.reduce((s, l) => s + l.amount, 0);

  const isLines = incomeStatement.data?.result.lines ?? [];
  const revenueLines = isLines.filter((l) => l.lineCode.startsWith("is_revenue"));
  const expenseLines = isLines.filter((l) => !revenueLines.includes(l));
  const netIncome = revenueLines.reduce((s, l) => s + l.amount, 0) - expenseLines.reduce((s, l) => s + l.amount, 0);

  const cf = cashFlow.data?.result;
  const cfDetail = cashFlowDetail.data?.result;
  const equity = equityStatement.data?.result;
  const points = trend.data?.points ?? [];
  const last = points.at(-1);
  const prior = points.at(-2);
  const growth = (curr?: number, prev?: number) => (curr === undefined || prev === undefined || prev === 0 ? undefined : (curr - prev) / Math.abs(prev));
  const formatDelta = (g?: number) => (g === undefined ? undefined : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%`);

  return (
    <div className="flex flex-col gap-6">
      <Link to="/companies" className="no-print flex w-fit items-center gap-1.5 text-sm text-ink/50 hover:text-ink">
        <ArrowLeft size={14} /> Kembali ke Daftar Perusahaan
      </Link>

      <div className="no-print flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <EditableImage
            imageUrl={c.logoUrl}
            fallback={<CompanyLogo industryTemplate={c.industryTemplate} logoUrl={null} size={72} />}
            onUpload={(file) => uploadLogo.mutate(file)}
            onRemove={c.logoUrl ? () => deleteLogo.mutate() : undefined}
            isUploading={uploadLogo.isPending}
            size={72}
            shape="square"
          />
          <div>
            <h1 className="text-xl font-bold text-heading">{c.name}</h1>
            <p className="text-sm text-ink/50">{c.industry || "-"}</p>
            <div className="mt-1.5">
              <IndustryBadge template={c.industryTemplate} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            to={`/c/${companySlug}/accounts`}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-600"
          >
            <FileSpreadsheet size={16} />
            Chart of Accounts
          </Link>
          <Link
            to={`/c/${companySlug}/journal`}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-heading hover:border-accent"
          >
            <PenLine size={16} />
            Jurnal
          </Link>
          <Link
            to={`/c/${companySlug}/ledger`}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-heading hover:border-accent"
          >
            <BookOpen size={16} />
            Buku Besar
          </Link>
          <Link
            to={`/c/${companySlug}/ratios`}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-heading hover:border-accent"
          >
            <PieChart size={16} />
            Rasio Keuangan
          </Link>
          <Link
            to={`/c/${companySlug}/tax`}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-heading hover:border-accent"
          >
            <Receipt size={16} />
            Estimasi Pajak
          </Link>
        </div>
      </div>

      <Card className="no-print">
        <CardHeader title="Informasi Perusahaan" icon={<Building2 size={16} className="text-heading/60" />} />
        <div className="grid grid-cols-2 gap-4 p-5 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/40">Template Industri</p>
            <p className="mt-1 font-medium text-heading">{INDUSTRY_TEMPLATE_LABELS[c.industryTemplate]}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/40">Mata Uang</p>
            <p className="mt-1 font-medium text-heading">{c.currency}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/40">Awal Tahun Fiskal</p>
            <p className="mt-1 font-medium text-heading">Bulan ke-{c.fiscalYearStartMonth}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/40">Status</p>
            <p className="mt-1 font-medium text-heading">{c.status === "active" ? "Aktif" : "Diarsipkan"}</p>
          </div>
        </div>
      </Card>

      {periodsLoading ? (
        <p className="text-sm text-ink/50">Memuat...</p>
      ) : periods.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 border-dashed p-12 text-center">
          <AlertTriangle className="text-amber-500" size={28} />
          <h2 className="text-lg font-semibold text-heading">Belum ada data</h2>
          <p className="max-w-sm text-sm text-ink/60">Posting jurnal dulu lewat menu "Jurnal" supaya dashboard & laporan keuangan bisa dihitung.</p>
        </Card>
      ) : (
        <>
          <div className="no-print flex flex-wrap items-center justify-between gap-3">
            <h2 className="vt-page-title text-lg font-bold text-heading">Dashboard</h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
                <label className="text-xs font-medium text-ink/50">Dari</label>
                <input type="date" value={from ?? ""} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
                <span className="text-ink/30">-</span>
                <label className="text-xs font-medium text-ink/50">Sampai</label>
                <input type="date" value={to ?? ""} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
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
                onClick={() => from && to && downloadExcel.mutate({ from, to })}
                disabled={!from || !to || downloadExcel.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
              >
                <Download size={14} /> {downloadExcel.isPending ? "Menyiapkan..." : "Download Excel"}
              </button>
            </div>
          </div>

          <div className="no-print flex w-fit gap-1 rounded-full bg-surface-2 p-1">
            {[
              { key: "ringkasan" as const, label: "Ringkasan", icon: LayoutGrid },
              { key: "laporan" as const, label: "Laporan", icon: FileText },
            ].map(({ key, label, icon: Icon }) => (
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

          <div className="print-area flex flex-col gap-6">
            {tab === "ringkasan" ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <DarkStatCard
                    label="Total Aset"
                    value={formatIDRCompact(totalAssets)}
                    fullValue={formatIDR(totalAssets)}
                    icon={<Landmark size={13} />}
                    deltaLabel={formatDelta(growth(last?.totalAssets, prior?.totalAssets))}
                    deltaPositive={(growth(last?.totalAssets, prior?.totalAssets) ?? 0) >= 0}
                    sparkline={points.map((p) => ({ label: p.periodLabel, value: p.totalAssets }))}
                  />
                  <DarkStatCard
                    label="Laba Bersih"
                    value={formatIDRCompact(netIncome)}
                    fullValue={formatIDR(netIncome)}
                    icon={<TrendingUp size={13} />}
                    deltaLabel={formatDelta(growth(last?.netIncome, prior?.netIncome))}
                    deltaPositive={(growth(last?.netIncome, prior?.netIncome) ?? 0) >= 0}
                    sparkline={points.map((p) => ({ label: p.periodLabel, value: p.netIncome }))}
                  />
                  <DarkStatCard
                    label="Kas Awal Periode"
                    value={cf ? formatIDRCompact(cf.beginningCash) : "-"}
                    fullValue={cf ? formatIDR(cf.beginningCash) : undefined}
                    icon={<Wallet size={13} />}
                  />
                  <DarkStatCard
                    label="Kas Akhir Periode"
                    value={cf ? formatIDRCompact(cf.endingCash) : "-"}
                    fullValue={cf ? formatIDR(cf.endingCash) : undefined}
                    icon={<Wallet size={13} />}
                    deltaLabel={formatDelta(growth(last?.cash, prior?.cash))}
                    deltaPositive={(growth(last?.cash, prior?.cash) ?? 0) >= 0}
                    sparkline={points.map((p) => ({ label: p.periodLabel, value: p.cash }))}
                  />
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  <DonutCard
                    title="Komposisi Aset"
                    icon={<PieChart size={16} className="text-heading/60" />}
                    centerValue={formatIDRCompact(totalAssets)}
                    centerLabel="Total Aset"
                    data={assetLines.map((l) => ({ label: l.lineLabel, value: l.amount }))}
                  />
                  <div className="lg:col-span-2">
                    <DarkTrendCard
                      title="Tren Kinerja"
                      icon={<TrendingUp size={16} className="text-white/70" />}
                      series={[
                        { key: "revenue", label: "Pendapatan", color: "#33495C" },
                        { key: "netIncome", label: "Laba Bersih", color: "#3CB371", axis: "right" },
                      ]}
                      data={points.map((p) => ({ periodLabel: p.periodLabel, revenue: p.revenue, netIncome: p.netIncome }))}
                    />
                  </div>
                </div>

                {Math.abs(totalAssets - totalLiabEquity) > 1 && (
                  <div className="flex items-center gap-2 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                    <AlertTriangle size={16} />
                    Neraca tidak balance (selisih {formatIDR(totalAssets - totalLiabEquity)}). Cek data jurnal untuk rentang ini.
                  </div>
                )}
              </>
            ) : balanceSheet.isLoading || incomeStatement.isLoading ? (
              <p className="text-ink/50">Memuat...</p>
            ) : (
              <>
                <div className="hidden print:block">
                  <PrintStatementReport
                    companyName={c.name}
                    companyLogoUrl={c.logoUrl}
                    industryTemplate={c.industryTemplate}
                    preparedBy={me?.user.fullName ?? ""}
                    periodLabel={rangeLabel}
                    balanceSheet={balanceSheet.data?.result}
                    incomeStatement={incomeStatement.data?.result}
                    equity={equity}
                    cashFlow={cf}
                    cashFlowDetail={cfDetail}
                  />
                </div>

                <div className="grid gap-4 print:hidden lg:grid-cols-2">
                  <StatementTable title="Neraca: Aset" icon={<Landmark size={16} className="text-heading/60" />} lines={assetLines} total={totalAssets} />
                  <StatementTable title="Neraca: Liabilitas & Ekuitas" icon={<Landmark size={16} className="text-heading/60" />} lines={liabEquityLines} total={totalLiabEquity} />
                </div>

                <Card className="print:hidden">
                  <CardHeader title="Laba Rugi" icon={<Receipt size={16} className="text-heading/60" />} />
                  <table className="w-full text-sm">
                    <tbody>
                      <tr>
                        <td colSpan={2} className="px-5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-ink/40">
                          Pendapatan
                        </td>
                      </tr>
                      {revenueLines.map((line) => (
                        <tr key={line.lineCode} className="border-b border-line/60">
                          <td className="px-5 py-1.5 text-ink/70">{line.lineLabel}</td>
                          <td className="px-5 py-1.5 text-right tabular-nums text-ink">{formatIDR(line.amount)}</td>
                        </tr>
                      ))}
                      {revenueLines.length === 0 && (
                        <tr>
                          <td colSpan={2} className="px-5 py-2 text-sm text-ink/40">Belum ada data pendapatan</td>
                        </tr>
                      )}

                      <tr>
                        <td colSpan={2} className="px-5 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-ink/40">
                          Beban (termasuk PPh)
                        </td>
                      </tr>
                      {expenseLines.map((line) => (
                        <tr key={line.lineCode} className="border-b border-line/60">
                          <td className="px-5 py-1.5 text-ink/70">{line.lineLabel}</td>
                          <td className="px-5 py-1.5 text-right tabular-nums text-ink">{formatIDR(line.amount)}</td>
                        </tr>
                      ))}
                      {expenseLines.length === 0 && (
                        <tr>
                          <td colSpan={2} className="px-5 py-2 text-sm text-ink/40">Belum ada data beban</td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
                        <td className="px-5 py-2.5">Laba Bersih</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(netIncome)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </Card>

                <Card className="print:hidden">
                  <CardHeader title="Laporan Perubahan Ekuitas" icon={<Landmark size={16} className="text-heading/60" />} />
                  {equityStatement.isLoading ? (
                    <p className="p-5 text-sm text-ink/50">Memuat...</p>
                  ) : !equity ? (
                    <p className="p-5 text-sm text-ink/50">Data Kosong</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-ink/40">
                          <th className="px-5 py-2">Akun</th>
                          <th className="px-5 py-2 text-right">Saldo Awal</th>
                          <th className="px-5 py-2 text-right">Perubahan</th>
                          <th className="px-5 py-2 text-right">Saldo Akhir</th>
                        </tr>
                      </thead>
                      <tbody>
                        {equity.lines.map((l) => (
                          <tr key={l.accountId} className="border-t border-line/60">
                            <td className="px-5 py-2 text-ink/70">{l.code} - {l.name}</td>
                            <td className="px-5 py-2 text-right tabular-nums text-ink">{formatIDR(l.beginningBalance)}</td>
                            <td className={`px-5 py-2 text-right tabular-nums ${l.delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatIDR(l.delta)}</td>
                            <td className="px-5 py-2 text-right tabular-nums text-ink">{formatIDR(l.endingBalance)}</td>
                          </tr>
                        ))}
                        {equity.lines.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-5 py-6 text-center text-sm text-ink/40">Belum ada akun ekuitas untuk periode ini</td>
                          </tr>
                        )}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
                          <td className="px-5 py-2.5">Total Ekuitas</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(equity.totalBeginning)}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(equity.totalEnding - equity.totalBeginning)}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(equity.totalEnding)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                  {equity && (
                    <p className="border-t border-line/60 px-5 py-3 text-xs text-ink/50">
                      Laba bersih periode berjalan (Rp {formatIDR(equity.netIncome)}) sudah otomatis termasuk dalam perubahan saldo laba ditahan di atas.
                    </p>
                  )}
                </Card>

                <Card className="print:hidden">
                  <CardHeader title="Laporan Arus Kas (Metode Tidak Langsung)" icon={<Wallet size={16} className="text-heading/60" />} />
                  {cashFlow.isLoading || cashFlowDetail.isLoading ? (
                    <p className="p-5 text-sm text-ink/50">Memuat...</p>
                  ) : !cf ? (
                    <p className="p-5 text-sm text-ink/50">Data Kosong</p>
                  ) : !cf.priorPeriodId ? (
                    <p className="p-5 text-sm text-ink/50">Ini periode pertama perusahaan -- arus kas butuh minimal 1 periode sebelumnya untuk dihitung.</p>
                  ) : (
                    <CashFlowDetailTable cashFlow={cf} detail={cfDetail} />
                  )}
                </Card>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Laporan Arus Kas metode tidak langsung, RINCI per-akun (bukan cuma 3
 * angka lump-sum) -- sama persis logikanya dgn versi online. */
function CashFlowDetailTable({ cashFlow, detail }: { cashFlow: CashFlowResult; detail?: CashFlowDetailResult }) {
  const operating = (detail?.operating ?? []).filter((a) => a.delta !== 0);
  const investing = (detail?.investing ?? []).filter((a) => a.delta !== 0);
  const financing = (detail?.financing ?? []).filter((a) => a.delta !== 0);

  return (
    <table className="w-full text-sm">
      <tbody>
        <tr className="bg-navy-700 text-white">
          <td className="px-5 py-2 font-semibold" colSpan={2}>Arus Kas dari Aktivitas Operasi</td>
        </tr>
        <tr className="border-b border-line/60">
          <td className="px-5 py-2 text-ink/70">Laba Bersih</td>
          <td className="px-5 py-2 text-right tabular-nums text-ink">{formatIDR(cashFlow.netIncome)}</td>
        </tr>
        {operating.length > 0 && (
          <tr>
            <td className="px-5 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-ink/40" colSpan={2}>
              Penyesuaian untuk:
            </td>
          </tr>
        )}
        {operating.map((a) => (
          <tr key={a.accountId} className="border-b border-line/60">
            <td className="px-5 py-1.5 pl-8 text-ink/70">{a.name}</td>
            <td className="px-5 py-1.5 text-right tabular-nums text-ink">{formatIDR(a.contribution)}</td>
          </tr>
        ))}
        <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
          <td className="px-5 py-2.5">Arus Kas Neto dari Aktivitas Operasi</td>
          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(cashFlow.operatingActivities)}</td>
        </tr>

        <tr className="bg-navy-700 text-white">
          <td className="px-5 py-2 font-semibold" colSpan={2}>Arus Kas dari Aktivitas Investasi</td>
        </tr>
        {investing.length === 0 ? (
          <tr>
            <td className="px-5 py-1.5 pl-8 text-ink/40" colSpan={2}>Tidak ada mutasi</td>
          </tr>
        ) : (
          investing.map((a) => (
            <tr key={a.accountId} className="border-b border-line/60">
              <td className="px-5 py-1.5 pl-8 text-ink/70">{a.name}</td>
              <td className="px-5 py-1.5 text-right tabular-nums text-ink">{formatIDR(a.contribution)}</td>
            </tr>
          ))
        )}
        <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
          <td className="px-5 py-2.5">Arus Kas Neto dari Aktivitas Investasi</td>
          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(cashFlow.investingActivities)}</td>
        </tr>

        <tr className="bg-navy-700 text-white">
          <td className="px-5 py-2 font-semibold" colSpan={2}>Arus Kas dari Aktivitas Pendanaan</td>
        </tr>
        {financing.length === 0 ? (
          <tr>
            <td className="px-5 py-1.5 pl-8 text-ink/40" colSpan={2}>Tidak ada mutasi</td>
          </tr>
        ) : (
          financing.map((a) => (
            <tr key={a.accountId} className="border-b border-line/60">
              <td className="px-5 py-1.5 pl-8 text-ink/70">{a.name}</td>
              <td className="px-5 py-1.5 text-right tabular-nums text-ink">{formatIDR(a.contribution)}</td>
            </tr>
          ))
        )}
        <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
          <td className="px-5 py-2.5">Arus Kas Neto dari Aktivitas Pendanaan</td>
          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(cashFlow.financingActivities)}</td>
        </tr>

        <tr className="border-t-2 border-line bg-accent-50 font-semibold text-heading dark:bg-accent/10">
          <td className="px-5 py-2.5">Kenaikan (Penurunan) Bersih Kas dan Setara Kas</td>
          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(cashFlow.netChangeInCash)}</td>
        </tr>
        <tr className="bg-accent-50 font-medium text-heading dark:bg-accent/10">
          <td className="px-5 py-2 text-ink/70">Kas dan Setara Kas pada Awal Periode</td>
          <td className="px-5 py-2 text-right tabular-nums">{formatIDR(cashFlow.beginningCash)}</td>
        </tr>
        <tr className="bg-navy-700 font-bold text-white">
          <td className="px-5 py-2.5">Kas dan Setara Kas pada Akhir Periode</td>
          <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(cashFlow.endingCash)}</td>
        </tr>
      </tbody>
    </table>
  );
}
