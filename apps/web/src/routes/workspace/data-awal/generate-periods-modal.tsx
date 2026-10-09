import { X } from "lucide-react";
import { useState } from "react";
import { useGenerateMonthlyPeriods } from "../../../features/workspace/use-periods.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import type { GenerateMonthlyPeriodsResult } from "../../../features/workspace/use-periods.js";

/**
 * TASK-023 hotfix -- sebelumnya TIDAK ADA cara sama sekali membuat
 * periode akuntansi di arsitektur company-db (lihat komentar
 * `fiscal-period.ts` createPeriod). Modal ini generate SATU periode
 * bulanan utk tiap bulan dalam rentang tanggal, supaya import data
 * historis bertahun-tahun (kasus nyata: Jan 2023 - Sep 2026) tidak perlu
 * bikin periode satu-satu lewat form manual.
 */
export function GeneratePeriodsModal({ companySlug, onClose }: { companySlug: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  const generate = useGenerateMonthlyPeriods(companySlug);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [result, setResult] = useState<GenerateMonthlyPeriodsResult | null>(null);

  const canSubmit = fromDate && toDate && fromDate <= toDate;

  async function handleSubmit() {
    if (!canSubmit) return;
    const res = await generate.mutateAsync({ fromDate, toDate });
    setResult(res);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Buat Periode Bulanan</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          <p className="text-xs text-ink/50">
            Membuat satu periode akuntansi (status Terbuka) untuk tiap bulan dalam rentang tanggal di bawah. Bulan yang sudah punya periode akan
            dilewati otomatis, aman dijalankan berulang.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Dari Tanggal</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input-base w-full" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Sampai Tanggal</label>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input-base w-full" />
            </div>
          </div>

          {generate.isError && <p className="text-sm text-rose-600">{(generate.error as Error).message}</p>}
          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
              ✓ {result.created} periode baru dibuat, {result.skipped} dilewati (sudah ada).
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            disabled={!canSubmit || generate.isPending}
            onClick={handleSubmit}
            className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {generate.isPending ? "Membuat..." : "Buat Periode"}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            {result ? "Selesai" : "Batal"}
          </button>
        </div>
      </div>
    </div>
  );
}
