import { CheckCircle2, Download, History, UploadCloud, XCircle } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { Card, CardHeader } from "../../../components/ui.js";
import {
  useCommitAccountImport,
  useAccountImportHistory,
  useDownloadAccountImportTemplate,
  usePreviewAccountImport,
} from "../../../features/workspace/use-account-import.js";
import type { AccountImportStatus } from "../../../features/workspace/account-types.js";

const STATUS_STYLE: Record<AccountImportStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  NEW: { icon: CheckCircle2, className: "text-emerald-600", label: "Baru" },
  EXISTING: { icon: CheckCircle2, className: "text-ink/50", label: "Sudah Ada (dilewati)" },
  WARNING: { icon: CheckCircle2, className: "text-amber-600", label: "Warning (dilewati)" },
  ERROR: { icon: XCircle, className: "text-rose-600", label: "Error" },
};

/** COA Import UI (TASK-DB-ARCH-015 §10-16). Pola SAMA dgn
 * `journal-import-tab.tsx` (TASK-DB-ARCH-014, "TERRA Import Standard"). */
export function AccountImportTab({ companySlug }: { companySlug: string }) {
  const [file, setFile] = useState<File | null>(null);
  const preview = usePreviewAccountImport(companySlug);
  const commit = useCommitAccountImport(companySlug);
  const downloadTemplate = useDownloadAccountImportTemplate(companySlug);
  const history = useAccountImportHistory(companySlug);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    preview.mutate(f);
  }

  async function handleCommit() {
    if (!file || !preview.data?.canCommit) return;
    await commit.mutateAsync(file);
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
          <span className="text-xs text-ink/50">Pakai tombol "Download Template" di atas supaya format pasti sesuai.</span>
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
              <span className="text-emerald-600">{result.newCount} baru</span>
              <span className="text-ink/50">{result.existingCount} sudah ada</span>
              {result.warningCount > 0 && <span className="text-amber-600">{result.warningCount} warning</span>}
              {result.errorCount > 0 && <span className="text-rose-600">{result.errorCount} error</span>}
            </div>

            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                  <tr>
                    <th className="px-3 py-2">Kode</th>
                    <th className="px-3 py-2">Nama Akun</th>
                    <th className="px-3 py-2">Tipe</th>
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
                        <td className="px-3 py-1.5 text-ink/60">{row.accountTypeCode ?? "-"}</td>
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
                {commit.isPending ? "Menyimpan..." : "Import / Commit"}
              </button>
              {result.errorCount > 0 && <p className="text-xs text-rose-600">Perbaiki dulu baris ERROR sebelum commit (SUBMIT dinonaktifkan).</p>}
              {result.errorCount === 0 && !result.canCommit && <p className="text-xs text-ink/40">Tidak ada akun baru untuk di-commit.</p>}
            </div>
            {commit.isError && <p className="text-sm text-rose-600">{(commit.error as Error).message} -- file tetap tersimpan, Anda bisa coba lagi.</p>}
            {commit.isSuccess && (
              <p className="text-sm text-emerald-600">
                {commit.data.createdCount} akun berhasil dibuat.
                {commit.data.skippedCount > 0 && ` ${commit.data.skippedCount} dilewati (sudah ada/warning).`}
              </p>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Riwayat Import" icon={<History size={16} className="text-ink/40" />} />
        <div className="overflow-x-auto p-5 pt-0">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="px-3 py-2">Waktu</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2 text-right">Dibuat</th>
                <th className="px-3 py-2 text-right">Dilewati</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.history.map((h) => (
                <tr key={h.id} className="border-t border-line/60">
                  <td className="px-3 py-1.5 tabular-nums">{new Date(h.createdAt).toLocaleString("id-ID")}</td>
                  <td className="px-3 py-1.5">{h.actorLabel}</td>
                  <td className="px-3 py-1.5">{h.fileName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{h.createdCount}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{h.skippedCount}</td>
                </tr>
              ))}
              {history.isError && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-rose-600">
                    Gagal memuat riwayat import. {(history.error as Error).message}
                  </td>
                </tr>
              )}
              {!history.isError && (!history.data || history.data.history.length === 0) && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-ink/40">
                    Belum ada riwayat import.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
