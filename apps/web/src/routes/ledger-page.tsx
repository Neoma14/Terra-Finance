import { ArrowDownCircle, ArrowUpCircle, BookOpen, Download, Printer, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PrintReportFooter, PrintReportHeader } from "../components/print-report-chrome.js";
import { BackToCompanyLink, Card, CardHeader, KpiCard } from "../components/ui.js";
import { useAccounts } from "../features/accounts/use-accounts.js";
import { useCompanies } from "../features/companies/use-companies.js";
import { useDownloadLedgerExcelRange, useLedgerRange } from "../features/ledger/use-ledger.js";
import { usePeriods } from "../features/statements/use-statements.js";
import { formatIDR } from "../lib/format.js";

/** Buku Besar -- saldo awal/mutasi/saldo akhir + rincian mutasi per akun
 * untuk rentang tanggal bebas, sama persis logikanya dgn versi online,
 * termasuk Print/PDF. */
export function LedgerPage() {
  const { companySlug = "" } = useParams();
  const { data: companiesData } = useCompanies();
  const company = companiesData?.companies.find((c) => c.slug === companySlug);
  const companyName = company?.name ?? companySlug;
  const { data: periodsData } = usePeriods(companySlug);
  const { data: accountsData } = useAccounts(companySlug);
  const periods = periodsData?.periods ?? [];
  const accounts = accountsData?.accounts ?? [];

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");

  useEffect(() => {
    if (!from && !to && periods.length > 0) {
      setFrom(periods[0].startDate.slice(0, 10));
      setTo(periods[0].endDate.slice(0, 10));
    }
  }, [periods, from, to]);
  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const { data, isLoading } = useLedgerRange(companySlug, accountId, from, to);
  const downloadExcel = useDownloadLedgerExcelRange(companySlug);
  const result = data?.result;
  const debitTotal = result?.lines.reduce((s, l) => s + l.debit, 0) ?? 0;
  const creditTotal = result?.lines.reduce((s, l) => s + l.credit, 0) ?? 0;
  const rangeLabel = from && to ? `${from} s/d ${to}` : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <BackToCompanyLink companySlug={companySlug} />
      </div>
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Buku Besar</h1>
          <p className="text-sm text-ink/50">Saldo awal, mutasi, saldo akhir, dan rincian transaksi per akun untuk rentang tanggal pilihan.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="input-base">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} - {a.name}
              </option>
            ))}
          </select>
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
          {accountId && from && to && (
            <button
              type="button"
              onClick={() => downloadExcel.mutate({ accountId, from, to })}
              disabled={downloadExcel.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent disabled:opacity-50"
            >
              <Download size={14} /> {downloadExcel.isPending ? "Menyiapkan..." : "Download Excel"}
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-ink/50">Memuat...</p>
      ) : !result ? (
        <p className="text-sm text-ink/50">Data Kosong</p>
      ) : (
        <div className="print-area flex flex-col gap-6">
          <PrintReportHeader
            companyName={companyName}
            companyLogoUrl={company?.logoUrl}
            industryTemplate={company?.industryTemplate ?? "general"}
            reportTitle={`Buku Besar - ${result.accountCode} ${result.accountName}`}
            rangeLabel={rangeLabel}
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Saldo Awal" value={formatIDR(result.beginningBalance)} icon={<Wallet size={14} />} />
            <KpiCard label="Total Debit" value={formatIDR(debitTotal)} icon={<ArrowUpCircle size={14} />} />
            <KpiCard label="Total Kredit" value={formatIDR(creditTotal)} icon={<ArrowDownCircle size={14} />} />
            <KpiCard label="Saldo Akhir" value={formatIDR(result.endingBalance)} icon={<Wallet size={14} />} tone="positive" />
          </div>

          <Card>
            <CardHeader title={`${result.accountCode} - ${result.accountName}`} icon={<BookOpen size={16} className="text-heading/60" />} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-navy-700 text-left text-xs uppercase tracking-wide text-white">
                  <tr>
                    <th className="px-5 py-2">Tanggal</th>
                    <th className="px-5 py-2">No. Jurnal</th>
                    <th className="px-5 py-2">Keterangan</th>
                    <th className="px-5 py-2 text-right">Debit</th>
                    <th className="px-5 py-2 text-right">Kredit</th>
                    <th className="px-5 py-2 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-line bg-accent-50 font-medium text-heading">
                    <td className="px-5 py-2" colSpan={5}>
                      Saldo Awal
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">{formatIDR(result.beginningBalance)}</td>
                  </tr>
                  {result.lines.map((l) => (
                    <tr key={l.journalEntryId} className={`border-t border-line/60 ${l.isReversed ? "opacity-50 line-through" : ""}`}>
                      <td className="px-5 py-1.5 tabular-nums">{l.entryDate.slice(0, 10)}</td>
                      <td className="px-5 py-1.5 tabular-nums">{l.referenceNo}</td>
                      <td className="px-5 py-1.5">{l.description}</td>
                      <td className="px-5 py-1.5 text-right tabular-nums">{l.debit ? formatIDR(l.debit) : ""}</td>
                      <td className="px-5 py-1.5 text-right tabular-nums">{l.credit ? formatIDR(l.credit) : ""}</td>
                      <td className="px-5 py-1.5 text-right tabular-nums">{formatIDR(l.runningBalance)}</td>
                    </tr>
                  ))}
                  {result.lines.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-4 text-center text-ink/40">
                        Data Kosong
                      </td>
                    </tr>
                  )}
                  <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
                    <td className="px-5 py-2" colSpan={5}>
                      Saldo Akhir
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">{formatIDR(result.endingBalance)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          <PrintReportFooter />
        </div>
      )}
    </div>
  );
}
