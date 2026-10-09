import { useState, type ReactNode } from "react";
import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useAccountList } from "../../../features/workspace/use-accounts.js";
import { usePeriodOptions } from "../../../features/workspace/use-journal.js";
import { useAccountLedger } from "../../../features/workspace/use-ledger.js";
import { useReportScope } from "../../../features/workspace/report-scope.js";
import { ReportScopePicker } from "../report-scope/report-scope-picker.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";

/**
 * Buku Kas/Bank (TASK-023 §5) -- BUKAN tabel/engine baru. Query ledger
 * yang SAMA dgn Buku Besar (`getAccountLedger`, ledger-service.ts), cuma
 * daftar akun difilter ke `isCash === true` di frontend. Kalau tidak ada
 * akun yang ditandai kas/setara kas, halaman bilang itu apa adanya --
 * bukan menyembunyikan atau memaksa akun lain tampil sbg "kas".
 */
export function CashBankView({ companySlug }: { companySlug: string }) {
  const { data: accountsData } = useAccountList(companySlug, { isActive: true, pageSize: 1000 });
  const { data: periodsData } = usePeriodOptions(companySlug);
  const cashAccounts = (accountsData?.accounts ?? []).filter((a) => a.isCash);
  const periods = periodsData?.periods ?? [];

  const [accountId, setAccountId] = useState("");
  const [periodId, setPeriodId] = useState("");

  // Ledger berbasis rentang tanggal: periode yang dipilih diterjemahkan ke tanggal awal/akhirnya.
  const selectedPeriod = periods.find((p) => p.id === periodId);
  const range = selectedPeriod ? { fromDate: selectedPeriod.startDate.slice(0, 10), toDate: selectedPeriod.endDate.slice(0, 10) } : null;
  const [scope, setScope] = useReportScope(companySlug);
  const { data: ledger, isLoading, isError, error } = useAccountLedger(companySlug, accountId || undefined, range, scope);
  const totalDebit = ledger?.lines.reduce((s, l) => s + l.debit, 0) ?? 0;
  const totalCredit = ledger?.lines.reduce((s, l) => s + l.credit, 0) ?? 0;

  if (cashAccounts.length === 0) {
    return <Card className="p-10 text-center text-sm text-ink/40">Belum ada akun yang ditandai sebagai kas/setara kas. Tandai akun lewat Chart of Accounts.</Card>;
  }

  return (
    <div className="flex flex-col gap-4">
      <ReportScopePicker companySlug={companySlug} scope={scope} onChange={setScope} />
      <ScopeBanner scope={ledger?.scope} />
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Kas / Bank">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="input-base w-64">
            <option value="">Pilih akun kas/bank</option>
            {cashAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} - {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Periode">
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="input-base w-48">
            <option value="">Pilih periode</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      {!accountId || !periodId ? (
        <Card className="p-10 text-center text-sm text-ink/40">Pilih akun kas/bank dan periode.</Card>
      ) : isLoading ? (
        <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>
      ) : isError ? (
        <Card className="p-10 text-center text-sm text-rose-600">{(error as Error).message}</Card>
      ) : ledger ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <SummaryCard label="Saldo Awal" value={formatIDR(ledger.openingBalance)} />
            <SummaryCard label="Mutasi Masuk / Keluar" value={`${formatIDR(totalDebit)} / ${formatIDR(totalCredit)}`} />
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
                    <th className="px-4 py-2.5 text-right">Masuk</th>
                    <th className="px-4 py-2.5 text-right">Keluar</th>
                    <th className="px-4 py-2.5 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.lines.map((l, i) => (
                    <tr key={`${l.journalEntryId}-${i}`} className="border-t border-line/60">
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
                        Belum ada mutasi untuk periode ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
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
