import { CheckCircle2, Download, UploadCloud, XCircle } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { Card, CardHeader } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import {
  useCommitOpeningBalanceImport,
  useDownloadOpeningBalanceTemplate,
  usePreviewOpeningBalanceImport,
} from "../../../features/workspace/use-opening-balance-import.js";
import type { OpeningBalanceImportRowStatus } from "../../../features/workspace/opening-balance-types.js";

const STATUS_STYLE: Record<OpeningBalanceImportRowStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  VALID: { icon: CheckCircle2, className: "text-emerald-600", label: "Valid" },
  WARNING: { icon: CheckCircle2, className: "text-amber-600", label: "Warning" },
  ERROR: { icon: XCircle, className: "text-rose-600", label: "Error" },
};

/** Opening Balance Import UI (TASK-DB-ARCH-016 §10-17). Pola SAMA dgn
 * `journal-import-tab.tsx`/`account-import-tab.tsx` ("TERRA Import
 * Standard"). */
export function OpeningBalanceImportTab({ companySlug, onCommitted }: { companySlug: string; onCommitted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const preview = usePreviewOpeningBalanceImport(companySlug);
  const commit = useCommitOpeningBalanceImport(companySlug);
  const downloadTemplate = useDownloadOpeningBalanceTemplate(companySlug);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    preview.mutate(f);
  }

  async function handleCommit() {
    if (!file || !preview.data?.canCommit) return;
    try {
      await commit.mutateAsync(file);
      onCommitted();
    } catch {
      // Gagal ditangani via `commit.isError`/`commit.error` (react-query
      // state, dibaca di render di bawah) -- catch di sini HANYA mencegah
      // unhandled promise rejection, bukan logika penanganan error ganda.
    }
  }

  const result = preview.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
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

      <Card className="p-6">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-6 py-10 text-center hover:border-accent hover:bg-accent-50/40">
          <UploadCloud size={28} className="text-heading/40" />
          <span className="text-sm font-medium text-heading">Klik untuk pilih file .xlsx</span>
          <span className="text-xs text-ink/50">Pakai tombol "Download Template" di atas supaya format pasti sesuai -- SATU tanggal berlaku utk seluruh baris.</span>
          <input type="file" accept=".xlsx" onChange={handleFile} className="hidden" />
        </label>
        {file && <p className="mt-3 text-xs text-ink/50">File terpilih: {file.name}</p>}
        {preview.isPending && <p className="mt-3 text-sm text-ink/50">Membaca & memvalidasi file...</p>}
        {preview.isError && <p className="mt-3 text-sm text-rose-600">{(preview.error as Error).message}</p>}
      </Card>

      {result && (
        <Card>
          <CardHeader title={`Preview -- ${result.fileName}`} />
          <div className="flex flex-col gap-3 p-5 pt-0">
            {result.fileErrors.map((e, i) => (
              <p key={i} className="text-sm text-rose-600">
                {e}
              </p>
            ))}

            <div className="flex flex-wrap items-center gap-4 rounded-lg bg-surface-2/60 px-4 py-2.5 text-sm">
              <span>{result.totalRows} baris</span>
              <span className="text-emerald-600">{result.validCount} valid</span>
              {result.warningCount > 0 && <span className="text-amber-600">{result.warningCount} warning</span>}
              {result.errorCount > 0 && <span className="text-rose-600">{result.errorCount} error</span>}
              <span>Debit {formatIDR(result.totalDebit)}</span>
              <span>Kredit {formatIDR(result.totalCredit)}</span>
              <span className={result.isBalanced ? "text-emerald-600" : "text-rose-600"}>
                Selisih {formatIDR(result.difference)} -- {result.isBalanced ? "BALANCED" : "NOT BALANCED"}
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                  <tr>
                    <th className="px-3 py-2">Kode</th>
                    <th className="px-3 py-2">Nama Akun</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Kredit</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => {
                    const style = STATUS_STYLE[row.status];
                    const Icon = style.icon;
                    return (
                      <tr key={row.rowNumber} className="border-t border-line/60">
                        <td className="px-3 py-1.5 tabular-nums">{row.code}</td>
                        <td className="px-3 py-1.5">{row.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{row.debit ? formatIDR(row.debit) : ""}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{row.credit ? formatIDR(row.credit) : ""}</td>
                        <td className="px-3 py-1.5">
                          <span className={`flex items-center gap-1 ${style.className}`}>
                            <Icon size={14} /> {style.label}
                          </span>
                          {row.issues.map((issue, i) => (
                            <p key={i} className="mt-0.5 text-xs text-rose-600">
                              {issue}
                            </p>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={!result.canCommit || commit.isPending}
                onClick={handleCommit}
                className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
              >
                {commit.isPending ? "Menyimpan..." : "Confirm & Import"}
              </button>
              {result.errorCount > 0 && <p className="text-xs text-rose-600">Perbaiki dulu baris ERROR sebelum commit.</p>}
              {!result.isBalanced && result.errorCount === 0 && <p className="text-xs text-rose-600">Opening Balance is not balanced -- commit dinonaktifkan.</p>}
            </div>
            {commit.isError && <p className="text-sm text-rose-600">{(commit.error as Error).message} -- file tetap tersimpan, Anda bisa coba lagi.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
