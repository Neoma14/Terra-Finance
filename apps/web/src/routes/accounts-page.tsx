import type { Account, ParsedAccountRow } from "@konsultan/shared";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Plus, Printer, Trash2, Upload, UploadCloud, X, XCircle } from "lucide-react";
import { useEffect, useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";
import { AddAccountModal } from "../components/add-account-modal.js";
import { PrintReportFooter, PrintReportHeader } from "../components/print-report-chrome.js";
import { BackToCompanyLink, Badge, Card, CardHeader } from "../components/ui.js";
import {
  useAccounts,
  useCommitAccountsImport,
  useDeleteAccount,
  useDownloadAccountsExcelRange,
  useDownloadAccountsImportTemplate,
  usePreviewAccountsImport,
  useUpdateAccount,
} from "../features/accounts/use-accounts.js";
import { useCompanies } from "../features/companies/use-companies.js";
import { useLedgerBalancesRange } from "../features/ledger/use-ledger.js";
import { usePeriods } from "../features/statements/use-statements.js";
import { formatIDR } from "../lib/format.js";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: "Aset",
  liability: "Liabilitas",
  equity: "Ekuitas",
  revenue: "Pendapatan",
  expense: "Beban",
};

/**
 * Sama persis dgn AccountsPage versi online (daftar akun + kolom saldo
 * awal/mutasi/saldo akhir utk rentang tanggal pilihan + Print/PDF), PLUS
 * fitur BARU "Import dari Excel" & "Hapus Akun" (tidak ada di versi
 * online) -- utk konsultan yg pindah dari software lama & sudah punya
 * daftar akun+saldo sendiri, drpd input manual satu-satu lewat modal
 * "Tambah Akun".
 */
export function AccountsPage() {
  const { companySlug = "" } = useParams();
  const { data: companiesData } = useCompanies();
  const company = companiesData?.companies.find((c) => c.slug === companySlug);
  const companyName = company?.name ?? companySlug;
  const { data: accountsData, isLoading } = useAccounts(companySlug);
  const { data: periodsData } = usePeriods(companySlug);
  const periods = periodsData?.periods ?? [];
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const { data: balancesData, isLoading: balancesLoading } = useLedgerBalancesRange(companySlug, from, to);
  const updateAccount = useUpdateAccount(companySlug);
  const deleteAccount = useDeleteAccount(companySlug);
  const downloadExcel = useDownloadAccountsExcelRange(companySlug);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    if (!from && !to && periods.length > 0) {
      setFrom(periods[0].startDate.slice(0, 10));
      setTo(periods[0].endDate.slice(0, 10));
    }
  }, [periods, from, to]);

  const accounts = accountsData?.accounts ?? [];
  const balanceByAccountId = new Map((balancesData?.balances ?? []).map((b) => [b.accountId, b]));
  const rangeLabel = from && to ? `${from} s/d ${to}` : "";
  const totals = accounts.reduce(
    (acc, a) => {
      const b = balanceByAccountId.get(a.id);
      acc.beginning += b?.beginningBalance ?? 0;
      acc.debit += b?.debitTotal ?? 0;
      acc.credit += b?.creditTotal ?? 0;
      acc.ending += b?.endingBalance ?? 0;
      return acc;
    },
    { beginning: 0, debit: 0, credit: 0, ending: 0 },
  );

  async function handleDelete(a: Account) {
    if (!window.confirm(`Hapus akun "${a.code} - ${a.name}"? Tindakan ini tidak bisa dibatalkan.`)) return;
    setDeleteError(undefined);
    try {
      await deleteAccount.mutateAsync(a.id);
    } catch (err) {
      setDeleteError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <BackToCompanyLink companySlug={companySlug} />
      </div>
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Chart of Accounts</h1>
          <p className="text-sm text-ink/50">Daftar akun beserta saldo awal, mutasi, dan saldo akhir untuk rentang tanggal pilihan.</p>
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
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-heading hover:border-accent disabled:opacity-50"
            >
              <Download size={14} /> {downloadExcel.isPending ? "Menyiapkan..." : "Download Excel"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-heading hover:border-accent"
          >
            <Upload size={14} /> {showImport ? "Tutup Import" : "Import dari Excel"}
          </button>
          <button
            type="button"
            onClick={() => setShowAddAccount(true)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white hover:bg-accent-600"
          >
            <Plus size={14} /> Tambah Akun
          </button>
        </div>
      </div>

      {showImport && (
        <div className="no-print">
          <AccountsImportPanel companySlug={companySlug} onClose={() => setShowImport(false)} />
        </div>
      )}

      {showAddAccount && <AddAccountModal companySlug={companySlug} onClose={() => setShowAddAccount(false)} />}

      {deleteError && (
        <div className="no-print flex items-center gap-2 rounded-lg bg-rose-50 px-4 py-2.5 text-sm text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
          <AlertTriangle size={16} />
          {deleteError}
        </div>
      )}

      {isLoading || balancesLoading ? (
        <p className="text-sm text-ink/40">Memuat...</p>
      ) : (
        <div className="print-area">
          <PrintReportHeader
            companyName={companyName}
            companyLogoUrl={company?.logoUrl}
            industryTemplate={company?.industryTemplate ?? "general"}
            reportTitle="Chart of Accounts"
            rangeLabel={rangeLabel}
          />
          <Card>
            <CardHeader title="Daftar Akun" icon={<FileSpreadsheet size={16} className="text-heading/60" />} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-navy-700 text-left text-white">
                    <th className="px-5 py-2.5 font-semibold">Kode</th>
                    <th className="px-5 py-2.5 font-semibold">Nama Akun</th>
                    <th className="px-5 py-2.5 font-semibold">Tipe</th>
                    <th className="px-5 py-2.5 font-semibold">Sub Tipe</th>
                    <th className="px-5 py-2.5 font-semibold text-right">Saldo Awal</th>
                    <th className="px-5 py-2.5 font-semibold text-right">Mutasi Debit</th>
                    <th className="px-5 py-2.5 font-semibold text-right">Mutasi Kredit</th>
                    <th className="px-5 py-2.5 font-semibold text-right">Saldo Akhir</th>
                    <th className="px-5 py-2.5 font-semibold no-print">Status</th>
                    <th className="px-5 py-2.5 font-semibold text-right no-print">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const b = balanceByAccountId.get(a.id);
                    return (
                      <tr key={a.id} className="border-b border-line/60 last:border-0 hover:bg-surface-2/40">
                        <td className="px-5 py-2 tabular-nums text-ink/70">{a.code}</td>
                        <td className="px-5 py-2 font-medium text-ink">{a.name}</td>
                        <td className="px-5 py-2 text-ink/60">{ACCOUNT_TYPE_LABELS[a.accountType] ?? a.accountType}</td>
                        <td className="px-5 py-2 text-ink/60">{a.accountSubtype ?? "-"}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink/70">{formatIDR(b?.beginningBalance ?? 0)}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink/70">{formatIDR(b?.debitTotal ?? 0)}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-ink/70">{formatIDR(b?.creditTotal ?? 0)}</td>
                        <td className="px-5 py-2 text-right tabular-nums font-medium text-heading">{formatIDR(b?.endingBalance ?? 0)}</td>
                        <td className="px-5 py-2 no-print">
                          <Badge tone={a.isActive ? "success" : "danger"}>{a.isActive ? "Aktif" : "Nonaktif"}</Badge>
                        </td>
                        <td className="px-5 py-2 text-right no-print">
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => updateAccount.mutate({ id: a.id, input: { isActive: !a.isActive } })}
                              disabled={updateAccount.isPending}
                              className="text-xs font-semibold text-ink/60 underline hover:text-ink disabled:opacity-50"
                            >
                              {a.isActive ? "Nonaktifkan" : "Aktifkan"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(a)}
                              disabled={deleteAccount.isPending}
                              title="Hapus akun (hanya bisa kalau belum pernah dipakai di jurnal)"
                              className="text-ink/40 hover:text-rose-600 disabled:opacity-50"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-5 py-4 text-center text-ink/40">
                        Belum ada akun.
                      </td>
                    </tr>
                  )}
                </tbody>
                {accounts.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
                      <td className="px-5 py-2.5" colSpan={4}>Total</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(totals.beginning)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(totals.debit)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(totals.credit)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(totals.ending)}</td>
                      <td className="no-print" />
                      <td className="no-print" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </Card>
          <PrintReportFooter />
        </div>
      )}
    </div>
  );
}

/** Import Chart of Accounts + Saldo Awal dari Excel -- fitur BARU (tidak
 * ada di versi online). Alur sama seperti Upload Excel di halaman Jurnal:
 * download template -> upload -> preview (validasi) -> commit. */
function AccountsImportPanel({ companySlug, onClose }: { companySlug: string; onClose: () => void }) {
  const downloadTemplate = useDownloadAccountsImportTemplate(companySlug);
  const preview = usePreviewAccountsImport(companySlug);
  const commit = useCommitAccountsImport(companySlug);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) preview.mutate(file);
  }

  const rows = preview.data?.rows ?? [];
  const newCount = rows.filter((r) => !r.alreadyExists).length;
  const alreadyExistsCount = rows.filter((r) => r.alreadyExists).length;
  const problemRows = rows.filter((r) => !r.alreadyExists && r.errors.length > 0);
  const canCommit = Boolean(preview.data?.allValid) && newCount > 0;

  async function handleCommit() {
    if (!preview.data || !canCommit) return;
    await commit.mutateAsync({
      openingDate: preview.data.openingDate ?? undefined,
      rows: preview.data.rows
        .filter((r) => !r.alreadyExists)
        .map((r) => ({
          code: r.code,
          name: r.name,
          accountType: r.accountType as "asset" | "liability" | "equity" | "revenue" | "expense",
          accountSubtype: r.accountSubtype,
          normalBalance: r.normalBalance as "debit" | "credit",
          cashFlowActivity: (r.cashFlowActivity || undefined) as "operating" | "investing" | "financing" | undefined,
          isCash: r.isCash,
          subledgerType: (r.subledgerType || undefined) as "payable" | "receivable" | undefined,
          openingBalance: r.openingBalance || undefined,
        })),
    });
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-heading">Import Chart of Accounts + Saldo Awal</h2>
        <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
          <X size={16} />
        </button>
      </div>

      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => downloadTemplate.mutate()}
          disabled={downloadTemplate.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent disabled:opacity-50"
        >
          <Download size={14} />
          {downloadTemplate.isPending ? "Menyiapkan..." : "Download Template"}
        </button>
      </div>

      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-6 py-8 text-center hover:border-accent hover:bg-accent-50/40">
        <UploadCloud size={26} className="text-heading/40" />
        <span className="text-sm font-medium text-heading">Klik untuk pilih file .xlsx (sheet "Akun")</span>
        <span className="text-xs text-ink/50">
          Header: <strong>Kode</strong>, <strong>Nama Akun</strong>, <strong>Tipe</strong>, <strong>Sub Tipe</strong>, <strong>Saldo Normal</strong> --
          kolom <strong>Saldo Awal</strong> opsional (isi "Tanggal Saldo Awal" di atas sheet kalau dipakai). Kode yang sudah ada di aplikasi akan
          dilewati otomatis. Pakai tombol "Download Template" di atas untuk contoh & referensi nilai yang diterima.
        </span>
        <input type="file" accept=".xlsx" onChange={handleFile} className="hidden" />
      </label>
      {preview.isPending && <p className="mt-3 text-sm text-ink/50">Membaca file...</p>}
      {preview.isError && <p className="mt-3 text-sm text-rose-600">{(preview.error as Error).message}</p>}
      {downloadTemplate.isError && <p className="mt-3 text-sm text-rose-600">{(downloadTemplate.error as Error).message}</p>}

      {preview.data && (
        <div className="mt-4 flex flex-col gap-3">
          {preview.data.fileErrors.map((e, i) => (
            <p key={i} className="text-sm text-rose-600">
              {e}
            </p>
          ))}

          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2/60 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-1.5 text-emerald-600">
              <CheckCircle2 size={14} /> {newCount} baru & siap
            </span>
            {alreadyExistsCount > 0 && <span className="flex items-center gap-1.5 text-ink/50">• {alreadyExistsCount} sudah ada (dilewati)</span>}
            {problemRows.length > 0 && <span className="flex items-center gap-1.5 text-rose-600">• {problemRows.length} bermasalah</span>}
            {preview.data.openingDate && <span className="text-ink/50">• Tanggal Saldo Awal: {preview.data.openingDate}</span>}
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-left uppercase tracking-wide text-ink/40">
                <tr>
                  <th className="px-3 py-2">Kode</th>
                  <th className="px-3 py-2">Nama</th>
                  <th className="px-3 py-2">Tipe</th>
                  <th className="px-3 py-2">Sub Tipe</th>
                  <th className="px-3 py-2">Saldo Normal</th>
                  <th className="px-3 py-2 text-right">Saldo Awal</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: ParsedAccountRow) => (
                  <tr
                    key={r.rowNumber}
                    className={`border-t border-line/60 ${r.alreadyExists ? "opacity-60" : r.errors.length > 0 ? "bg-rose-50/50 dark:bg-rose-500/10" : ""}`}
                  >
                    <td className="px-3 py-1.5 tabular-nums">{r.code}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5">{ACCOUNT_TYPE_LABELS[r.accountType] ?? r.accountType}</td>
                    <td className="px-3 py-1.5">{r.accountSubtype}</td>
                    <td className="px-3 py-1.5 capitalize">{r.normalBalance}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.openingBalance ? formatIDR(r.openingBalance) : ""}</td>
                    <td className="px-3 py-1.5">
                      {r.alreadyExists ? (
                        <span className="text-ink/50">Sudah Ada</span>
                      ) : r.errors.length === 0 ? (
                        <span className="flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 size={12} /> Siap
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-rose-600" title={r.errors.join("; ")}>
                          <XCircle size={12} /> {r.errors[0]}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-1 flex items-center gap-3">
            <button
              type="button"
              disabled={!canCommit || commit.isPending}
              onClick={handleCommit}
              className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
            >
              {commit.isPending ? "Menyimpan..." : `Import ${newCount} Akun Baru`}
            </button>
            {!preview.data.allValid && <p className="text-xs text-rose-600">Perbaiki dulu baris yang bermasalah sebelum import.</p>}
          </div>
          {commit.isError && <p className="text-sm text-rose-600">{(commit.error as Error).message}</p>}
          {commit.isSuccess && (
            <p className="text-sm text-emerald-600">
              {commit.data.createdCount} akun berhasil diimpor.
              {commit.data.skippedCount > 0 && ` ${commit.data.skippedCount} dilewati (sudah ada).`}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
