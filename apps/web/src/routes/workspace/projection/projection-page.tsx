import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import { DarkTrendCard } from "../../../components/charts.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useProjection } from "../../../features/workspace/use-projection.js";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Proyeksi (TASK-023 §11) -- reuse LANGSUNG data tren Dashboard (lihat
 * `db/company/projection-service.ts`), metode growth-based sederhana &
 * SELALU ditampilkan apa adanya ke user (bukan diklaim prediksi pasti).
 * Kalau data historis belum cukup, halaman bilang itu apa adanya --
 * tidak pernah menampilkan angka fiktif.
 */
export function ProjectionPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [monthsAhead, setMonthsAhead] = useState(3);
  const { data, isLoading, isError, error } = useProjection(company.slug, todayISO(), monthsAhead);

  const chartData = data
    ? [...data.historical, ...data.projected].map((p) => ({
        periodLabel: p.isProjected ? `${p.label} (proyeksi)` : p.label,
        Revenue: p.revenue,
        Expense: p.expense,
      }))
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Proyeksi</h1>
          <p className="text-sm text-ink/50">Ekstrapolasi tren historis {company.name} -- bukan prediksi pasti.</p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink/60">Proyeksi berapa bulan ke depan</label>
          <select value={monthsAhead} onChange={(e) => setMonthsAhead(Number(e.target.value))} className="input-base">
            {[1, 2, 3, 6].map((m) => (
              <option key={m} value={m}>
                {m} bulan
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <Card className="p-10 text-center text-sm text-ink/40">Memuat...</Card>}
      {isError && <Card className="p-10 text-center text-sm text-rose-600">{(error as Error).message}</Card>}

      {!isLoading && !isError && data && !data.sufficientData && (
        <Card className="p-10 text-center text-sm text-ink/40">Belum cukup data historis untuk membuat proyeksi.</Card>
      )}

      {!isLoading && !isError && data && data.sufficientData && (
        <>
          <DarkTrendCard
            title="Tren Revenue & Expense (Historis + Proyeksi)"
            series={[
              { key: "Revenue", label: "Revenue", color: "#3CB371" },
              { key: "Expense", label: "Expense", color: "#F87171" },
            ]}
            data={chartData}
          />

          <Card className="p-4">
            <p className="text-xs text-ink/50">{data.method}</p>
          </Card>

          <Card>
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                <tr>
                  <th className="px-4 py-2.5">Periode</th>
                  <th className="px-4 py-2.5 text-right">Revenue</th>
                  <th className="px-4 py-2.5 text-right">Expense</th>
                  <th className="px-4 py-2.5 text-right">Net Profit</th>
                </tr>
              </thead>
              <tbody>
                {[...data.historical, ...data.projected].map((p, i) => (
                  <tr key={i} className={`border-t border-line/60 ${p.isProjected ? "bg-accent-50/40 dark:bg-accent-500/5" : ""}`}>
                    <td className="px-4 py-2 font-medium text-heading">
                      {p.label} {p.isProjected && <span className="text-xs font-normal text-ink/40">(proyeksi)</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatIDR(p.revenue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatIDR(p.expense)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatIDR(p.netProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
