import { Info, TriangleAlert } from "lucide-react";
import { formatIDR } from "../../../lib/format.js";
import type { InterBranchPosition, ReportScopeInfo } from "../../../features/workspace/report-scope.js";

/**
 * Keterangan cakupan yang DIJAWABKAN SERVER (judul + peringatan). Gabungan/komparasi selalu menyatakan secara eksplisit
 * bahwa saldo antar-kantor belum dieliminasi dan bukan laporan konsolidasi final; UI tidak mengarang atau menghapus teks itu.
 * Perusahaan tanpa multi-cabang (mode COMPANY) tidak menampilkan apa pun.
 */
export function ScopeBanner({ scope, interBranch }: { scope: ReportScopeInfo | undefined; interBranch?: InterBranchPosition | null }) {
  if (!scope || scope.mode === "COMPANY") return null;
  const combined = scope.eliminationStatus === "NOT_ELIMINATED";

  if (!combined) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2/60 px-4 py-2.5 text-sm" data-testid="scope-banner" data-scope-mode={scope.mode}>
        <p className="flex items-center gap-2 font-medium text-heading">
          <Info size={14} aria-hidden /> Cakupan: {scope.label.title}
        </p>
        {scope.label.warnings.length > 0 && (
          <details className="text-xs text-ink/70">
            <summary className="cursor-pointer">Catatan cakupan</summary>
            <ul className="mt-1 list-disc pl-5">
              {scope.label.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  return (
    <div
      role="note"
      className="flex flex-col gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      data-testid="scope-banner"
      data-scope-mode={scope.mode}
    >
      <p className="flex items-start gap-2 font-semibold">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {scope.label.title}
      </p>
      <ul className="list-disc pl-9 text-xs">
        {scope.label.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      {interBranch && (
        <p className="pl-6 text-xs" data-testid="inter-branch-position">
          Saldo antar-kantor dalam cakupan ini (per {interBranch.asOf}): aset bruto {formatIDR(interBranch.receivableGross)}, liabilitas bruto {formatIDR(interBranch.payableGross)}, selisih{" "}
          {formatIDR(interBranch.netDifference)}. Belum dieliminasi.
        </p>
      )}
    </div>
  );
}
