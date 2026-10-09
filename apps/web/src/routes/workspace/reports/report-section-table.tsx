import { formatIDR } from "../../../lib/format.js";
import type { FinancialReportSection } from "../../../features/workspace/report-types.js";

/** Render satu `FinancialReportSection` (Assets/Liabilities/Equity/
 * Revenue/COGS/dll) -- dipakai Balance Sheet & Income Statement tab,
 * SATU komponen bukan diduplikasi. Baris & total PERSIS dari backend,
 * tidak dihitung ulang (TASK-DB-ARCH-017 §22). */
export function ReportSectionTable({ section }: { section: FinancialReportSection }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="bg-surface-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink/60">{section.label}</div>
      <table className="w-full text-sm">
        <tbody>
          {section.lines.map((l) => (
            <tr key={l.accountId} className="border-t border-line/60">
              <td className="px-4 py-1.5 tabular-nums text-ink/50">{l.accountCode}</td>
              <td className="px-4 py-1.5">{l.accountName}</td>
              <td className="px-4 py-1.5 text-right tabular-nums">{formatIDR(l.amount)}</td>
            </tr>
          ))}
          {section.lines.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-4 text-center text-xs text-ink/40">
                Tidak ada saldo.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-surface-2/60 font-semibold">
            <td className="px-4 py-2" colSpan={2}>
              Total {section.label}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{formatIDR(section.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
