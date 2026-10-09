import { CheckCircle2, Download, History, UploadCloud, XCircle } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { Card, CardHeader } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import {
  useCommitJournalImport,
  useDownloadJournalImportTemplate,
  useJournalImportHistory,
  usePreviewJournalImport,
} from "../../../features/workspace/use-journal-import.js";
import type { ImportValidatedTransaction } from "../../../features/workspace/journal-types.js";

const STATUS_STYLE: Record<ImportValidatedTransaction["status"], { icon: typeof CheckCircle2; className: string; label: string }> = {
  VALID: { icon: CheckCircle2, className: "text-emerald-600", label: "Valid" },
  WARNING: { icon: CheckCircle2, className: "text-amber-600", label: "Sudah Pernah Diinput" },
  ERROR: { icon: XCircle, className: "text-rose-600", label: "Error" },
};

/**
 * Journal Import UI (TASK-DB-ARCH-014 §2-6, "TERRA Import Standard" §7):
 * UPLOAD -> PARSE -> VALIDATE -> PREVIEW -> USER CONFIRM -> COMMIT ->
 * AUDIT. `File` yang sudah dipilih DIPERTAHANKAN di state React (bukan
 * cuma hasil preview) -- kalau commit gagal, user tidak perlu pilih file
 * ulang (§5 "pertahankan data preview/import session bila memungkinkan"),
 * cukup tekan Commit lagi (backend re-validasi file yang sama dari awal).
 */
export function JournalImportTab({ companySlug }: { companySlug: string }) {
  const [file, setFile] = useState<File | null>(null);
  const preview = usePreviewJournalImport(companySlug);
  const commit = useCommitJournalImport(companySlug);
  const downloadTemplate = useDownloadJournalImportTemplate(companySlug);
  const history = useJournalImportHistory(companySlug);

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
          <span className="text-xs text-ink/50">
            Satu transaksi = satu blok baris, dipisah baris kosong; tanpa No Jurnal, tanggal berbeda otomatis jadi transaksi terpisah. Pakai tombol "Download Template" di atas supaya format pasti sesuai.
          </span>
          <input type="file" accept=".xlsx" onChange={handleFile} className="hidden" />
        </label>
        {file && <p className="mt-3 text-xs text-ink/50">File terpilih: {file.name}</p>}
        {preview.isPending && <p className="mt-3 text-sm text-ink/50">Membaca & memvalidasi file...</p>}
        {preview.isError && <p className="mt-3 text-sm text-rose-600">{(preview.error as Error).message}</p>}
        {downloadTemplate.isError && <p className="mt-3 text-sm text-rose-600">{(downloadTemplate.error as Error).message}</p>}
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
              <span>{result.totalTransactions} transaksi</span>
              <span>{result.totalLines} baris</span>
              <span>Debit {formatIDR(result.totalDebit)}</span>
              <span>Kredit {formatIDR(result.totalCredit)}</span>
              <span className="flex items-center gap-1 text-emerald-600">
                <CheckCircle2 size={14} /> {result.validCount} valid
              </span>
              {result.warningCount > 0 && <span className="text-amber-600">• {result.warningCount} warning</span>}
              {result.errorCount > 0 && (
                <span className="flex items-center gap-1 text-rose-600">
                  <XCircle size={14} /> {result.errorCount} error
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {result.transactions.map((t) => {
                const style = STATUS_STYLE[t.status];
                const Icon = style.icon;
                return (
                  <details key={t.index} className={`rounded-lg border p-3 ${t.status === "ERROR" ? "border-rose-300 bg-rose-50/50 dark:bg-rose-500/10" : "border-line"}`}>
                    <summary className="flex cursor-pointer items-center justify-between text-sm">
                      <span className="font-medium text-heading">
                        {t.date} {t.referenceNo && `- ${t.referenceNo}`}
                        {t.periodLabel && <span className="ml-2 font-normal text-ink/40">→ {t.periodLabel}</span>}
                      </span>
                      <span className={`flex items-center gap-1 ${style.className}`}>
                        <Icon size={14} /> {style.label}
                      </span>
                    </summary>
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        {t.lines.map((l) => (
                          <tr key={l.rowNumber} className={l.issues.length > 0 ? "text-rose-600" : ""}>
                            <td className="py-0.5 pr-2 tabular-nums">{l.accountCode}</td>
                            <td className="py-0.5 pr-2">{l.accountName}</td>
                            <td className="py-0.5 pr-2 text-right tabular-nums">{l.debit ? formatIDR(l.debit) : ""}</td>
                            <td className="py-0.5 pr-2 text-right tabular-nums">{l.credit ? formatIDR(l.credit) : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {t.issues.length > 0 && (
                      <ul className="mt-1 list-inside list-disc text-xs text-rose-600">
                        {t.issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </details>
                );
              })}
            </div>

            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={!result.canCommit || commit.isPending}
                onClick={handleCommit}
                className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
              >
                {commit.isPending ? "Menyimpan..." : "Submit Journal"}
              </button>
              {result.errorCount > 0 && <p className="text-xs text-rose-600">Perbaiki dulu transaksi ERROR sebelum submit (SUBMIT dinonaktifkan).</p>}
              {result.errorCount === 0 && !result.canCommit && <p className="text-xs text-ink/40">Tidak ada transaksi baru untuk di-commit.</p>}
            </div>
            {commit.isError && <p className="text-sm text-rose-600">{(commit.error as Error).message} -- file tetap tersimpan, Anda bisa coba Submit lagi.</p>}
            {commit.isSuccess && (
              <p className="text-sm text-emerald-600">
                {commit.data.committedCount} jurnal berhasil di-import & diposting.
                {commit.data.skippedCount > 0 && ` ${commit.data.skippedCount} dilewati (sudah pernah diinput).`}
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
                <th className="px-3 py-2 text-right">Berhasil</th>
                <th className="px-3 py-2 text-right">Dilewati</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.history.map((h) => (
                <tr key={h.id} className="border-t border-line/60">
                  <td className="px-3 py-1.5 tabular-nums">{new Date(h.createdAt).toLocaleString("id-ID")}</td>
                  <td className="px-3 py-1.5">{h.actorLabel}</td>
                  <td className="px-3 py-1.5">{h.fileName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{h.committedCount}</td>
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
