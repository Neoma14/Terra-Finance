import { useEffect, useState, type ReactNode } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useAccountList } from "../../../features/workspace/use-accounts.js";
import { usePeriodOptions } from "../../../features/workspace/use-journal.js";
import { startOfMonthLocal, todayLocal } from "../../../lib/date.js";
import { useAccountLedger } from "../../../features/workspace/use-ledger.js";
import { JournalDetailModal } from "../journal/journal-detail-modal.js";
import { ReportExportControl } from "../reports/report-export-control.js";
import { useReportScope } from "../../../features/workspace/report-scope.js";
import { ReportScopePicker } from "../report-scope/report-scope-picker.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";

/**
 * Ledger / Buku Besar (TASK-DB-ARCH-017 §4-6) -- frontend MURNI consumer
 * dari `ledger-service.ts` (TIDAK diubah). Backend contract adalah
 * PERIOD-based (`GET /ledger/:accountId?periodId=`, BUKAN date-range) --
 * selector di sini mengikuti itu apa adanya, bukan asumsi baru (§2/§22).
 * Drill-down ke detail transaksi REUSE `JournalDetailModal` (TASK-DB-
 * ARCH-014) apa adanya -- TIDAK ADA detail journal kedua (§6).
 */
export function LedgerPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const { data: accountsData } = useAccountList(company.slug, { pageSize: 1000 });
  const { data: periodsData } = usePeriodOptions(company.slug);
  const accounts = accountsData?.accounts ?? [];
  const periods = periodsData?.periods ?? [];

  const [searchParams] = useSearchParams();
  // §16 drill-down: Trial Balance (period-scoped, sama contract dgn
  // Ledger) bisa membawa accountId+periodId lewat query string.
  const [accountId, setAccountId] = useState(() => searchParams.get("accountId") ?? "");
  const periodParam = searchParams.get("periodId") ?? "";
  const [fromDate, setFromDate] = useState(startOfMonthLocal());
  const [toDate, setToDate] = useState(todayLocal());
  // Rentang yang sedang ditampilkan -- hanya berubah saat "Tampilkan" ditekan.
  const [applied, setApplied] = useState<{ fromDate: string; toDate: string } | null>(null);
  const [detailJournalId, setDetailJournalId] = useState<string | null>(null);

  // Drill-down dari Trial Balance membawa periodId -> pakai rentang tanggal periode itu.
  useEffect(() => {
    if (!periodParam || applied) return;
    const p = periods.find((x) => x.id === periodParam);
    if (p && p.startDate && p.endDate) {
      setFromDate(p.startDate.slice(0, 10));
      setToDate(p.endDate.slice(0, 10));
      setApplied({ fromDate: p.startDate.slice(0, 10), toDate: p.endDate.slice(0, 10) });
    }
  }, [periodParam, periods, applied]);

  const rangeError = !fromDate || !toDate ? "Tanggal Dari dan Tanggal Sampai wajib diisi." : fromDate > toDate ? "Tanggal Dari tidak boleh setelah Tanggal Sampai." : null;
  const [scope, setScope] = useReportScope(company.slug);
  const { data: ledger, isLoading, isError, error } = useAccountLedger(company.slug, accountId || undefined, applied, scope);
  const selectedAccount = accounts.find((a) => a.id === accountId);

  const totalDebit = ledger?.lines.reduce((s, l) => s + l.debit, 0) ?? 0;
  const totalCredit = ledger?.lines.reduce((s, l) => s + l.credit, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Buku Besar / Ledger</h1>
        <p className="text-sm text-ink/50">Mutasi akun per rentang tanggal untuk {company.name}.</p>
      </div>

      <ReportScopePicker companySlug={company.slug} scope={scope} onChange={setScope} />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Akun">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="input-base w-64">
            <option value="">Pilih akun</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} - {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tanggal Dari">
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input-base w-40" />
        </Field>
        <Field label="Tanggal Sampai">
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input-base w-40" />
        </Field>
        <button
          type="button"
          disabled={!accountId || Boolean(rangeError)}
          onClick={() => setApplied({ fromDate, toDate })}
          className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
        >
          Tampilkan
        </button>
        <ReportExportControl
          companySlug={company.slug}
          kind="ledger"
          params={{ fromDate: applied?.fromDate ?? "", toDate: applied?.toDate ?? "", accountId, ...(scope ? { scope } : {}) }}
          disabled={!accountId || !applied}
        />
        {rangeError && <p className="basis-full text-xs text-rose-600">{rangeError}</p>}
      </Card>

      {!accountId || !applied ? (
        <Card className="p-10 text-center text-sm text-ink/40">Pilih akun dan rentang tanggal, lalu tekan Tampilkan.</Card>
      ) : isLoading ? (
        <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>
      ) : isError ? (
        <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat Ledger. {(error as Error).message}</Card>
      ) : ledger ? (
        <>
          <ScopeBanner scope={ledger.scope} />
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <SummaryCard label="Akun" value={selectedAccount ? `${selectedAccount.code} - ${selectedAccount.name}` : "-"} />
            <SummaryCard label="Rentang" value={`${ledger.fromDate} s/d ${ledger.toDate}`} />
            <SummaryCard label="Saldo Awal" value={formatIDR(ledger.openingBalance)} />
            <SummaryCard label="Total Debit / Kredit" value={`${formatIDR(totalDebit)} / ${formatIDR(totalCredit)}`} />
            <SummaryCard label="Saldo Akhir" value={formatIDR(ledger.endingBalance)} />
          </div>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                  <tr>
                    <th className="px-4 py-2.5">Tanggal</th>
                    <th className="px-4 py-2.5">No Jurnal</th>
                    <th className="px-4 py-2.5">Keterangan</th>
                    <th className="px-4 py-2.5 text-right">Debit</th>
                    <th className="px-4 py-2.5 text-right">Kredit</th>
                    <th className="px-4 py-2.5 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-line/60 bg-surface-2/40 font-medium">
                    <td className="px-4 py-2" colSpan={5}>
                      Saldo Awal
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatIDR(ledger.openingBalance)}</td>
                  </tr>
                  {ledger.lines.map((l, i) => (
                    <tr key={`${l.journalEntryId}-${i}`} onClick={() => setDetailJournalId(l.journalEntryId)} className="cursor-pointer border-t border-line/60 hover:bg-surface-2/60">
                      <td className="px-4 py-2 tabular-nums">{l.entryDate.slice(0, 10)}</td>
                      <td className="px-4 py-2 font-medium text-heading">{l.referenceNo ?? "-"}</td>
                      <td className="px-4 py-2">{l.memo ?? "-"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{l.debit ? formatIDR(l.debit) : ""}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{l.credit ? formatIDR(l.credit) : ""}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatIDR(l.runningBalance)}</td>
                    </tr>
                  ))}
                  {ledger.lines.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-ink/40">
                        Tidak ada transaksi pada rentang tanggal ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}

      {detailJournalId && <JournalDetailModal companySlug={company.slug} journalId={detailJournalId} onClose={() => setDetailJournalId(null)} onEdit={() => setDetailJournalId(null)} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink/60">{label}</label>
      {children}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">{label}</p>
      <p className="truncate text-sm font-bold text-heading" title={value}>
        {value}
      </p>
    </Card>
  );
}
