import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useCashFlowReport } from "../../../features/workspace/use-reports.js";
import { isComparisonScope } from "../../../features/workspace/report-scope.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";

/**
 * Cash Flow Statement (TASK-DB-ARCH-017 §14) -- murni consumer
 * `cash-flow-service.ts`. Klasifikasi Operating/Investing/Financing
 * SEPENUHNYA dari backend (`accounts.is_cash`/`accounts.cash_flow_
 * activity`) -- TIDAK ADA heuristic nama akun di frontend (§14 instruksi
 * eksplisit). `unclassifiedAmount` ditampilkan terpisah, bukan
 * disembunyikan/digabung ke salah satu kategori (jujur thd limitasi
 * backend, bukan ditebak).
 */
export function CashFlowTab({ companySlug, fromDate, toDate, scope = "" }: { companySlug: string; fromDate: string; toDate: string; scope?: string }) {
  const comparison = isComparisonScope(scope);
  // Komparasi Arus Kas belum tersedia (menunggu optimasi, keputusan D8): tidak dikirim ke server agar tidak ada angka palsu.
  const { data, isLoading, isError, error } = useCashFlowReport(companySlug, fromDate, toDate, scope, !comparison);
  if (comparison) {
    return (
      <div data-testid="cashflow-comparison-unavailable">
        <Card className="p-10 text-center text-sm text-ink/60">Komparasi per cabang belum tersedia untuk Arus Kas. Pilih satu cabang atau gabungan cabang terpilih.</Card>
      </div>
    );
  }

  if (isLoading) return <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>;
  if (isError) return <Card className="p-10 text-center text-sm text-rose-600">Gagal memuat Cash Flow Statement. {(error as Error).message}</Card>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <ScopeBanner scope={data.scope} interBranch={data.interBranch} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Beginning Cash" value={formatIDR(data.beginningCash)} />
        <SummaryCard label="Net Change in Cash" value={formatIDR(data.netChangeInCash)} tone={data.netChangeInCash >= 0 ? "positive" : "negative"} />
        <SummaryCard label="Ending Cash" value={formatIDR(data.endingCash)} />
      </div>

      <Card>
        <table className="w-full text-sm">
          <tbody>
            <CategoryRow label={data.operating.label} value={data.operating.amount} />
            <CategoryRow label={data.investing.label} value={data.investing.amount} />
            <CategoryRow label={data.financing.label} value={data.financing.amount} />
            {data.unclassifiedAmount !== 0 && <CategoryRow label="Belum Terklasifikasi" value={data.unclassifiedAmount} muted />}
            <tr className="bg-navy-700 font-bold text-white">
              <td className="px-4 py-3">Net Change in Cash</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatIDR(data.netChangeInCash)}</td>
            </tr>
          </tbody>
        </table>
        {data.unclassifiedAmount !== 0 && (
          <p className="px-4 py-3 text-xs text-ink/40">
            "Belum Terklasifikasi" = transaksi kas yang akun lawannya belum punya Aktivitas Arus Kas yang jelas -- bukan ditebak, periksa Chart of Accounts.
          </p>
        )}
      </Card>
    </div>
  );
}

function CategoryRow({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <tr className={`border-b border-line/60 ${muted ? "text-ink/50" : ""}`}>
      <td className="px-4 py-2.5">{label}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{formatIDR(value)}</td>
    </tr>
  );
}

function SummaryCard({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "positive" | "negative" }) {
  const toneClass = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-rose-600" : "text-heading";
  return (
    <Card className="p-4">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${toneClass}`}>{value}</p>
    </Card>
  );
}
