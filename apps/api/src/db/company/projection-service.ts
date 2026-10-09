import type { Knex } from "knex";
import { getDashboardSummary, type DashboardTrendPoint } from "./dashboard-service.js";

/**
 * Proyeksi (TASK-023 §11) -- reuse LANGSUNG `getDashboardSummary().trend`
 * (sumber yang SAMA dgn Dashboard, 6 bulan historis revenue/expense/
 * netProfit) sbg basis, BUKAN query accounting baru. Metode proyeksi
 * SENGAJA sederhana & transparan (growth rate rata-rata antar bucket
 * historis, diterapkan majemuk ke bucket terakhir) -- bukan model
 * statistik rumit yang sulit dijelaskan ke user non-teknis, dan metodenya
 * SELALU disertakan di response supaya tidak diklaim sbg "prediksi pasti"
 * (§11 instruksi eksplisit).
 */

export interface ProjectionPoint {
  label: string;
  revenue: number;
  expense: number;
  netProfit: number;
  isProjected: boolean;
}

export interface ProjectionResult {
  method: string;
  sufficientData: boolean;
  historical: ProjectionPoint[];
  projected: ProjectionPoint[];
}

const MIN_HISTORICAL_POINTS = 3;

function averageGrowthRate(values: number[]): number | null {
  const rates: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (prev === 0) continue;
    rates.push((values[i] - prev) / prev);
  }
  if (rates.length === 0) return null;
  return rates.reduce((s, r) => s + r, 0) / rates.length;
}

/** `DashboardTrendPoint.label` adalah string locale ("Jan 2026", lihat
 * `monthBucketsEndingAt` dashboard-service.ts) -- TIDAK bisa di-parse
 * balik jadi tanggal. Dihitung dari `toDate` (ISO "YYYY-MM-DD") bucket
 * terakhir, bukan dari label-nya, dgn format locale yang SAMA. */
function monthLabelAfter(lastToDate: string, offset: number): string {
  const base = new Date(`${lastToDate}T00:00:00Z`);
  const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
  return date.toLocaleDateString("id-ID", { month: "short", year: "numeric", timeZone: "UTC" });
}

export async function getProjection(db: Knex, asOfDate: string, monthsAhead: number): Promise<ProjectionResult> {
  const summary = await getDashboardSummary(db, asOfDate, asOfDate);
  const trend = summary.trend;

  const historical: ProjectionPoint[] = trend.map((t: DashboardTrendPoint) => ({
    label: t.label,
    revenue: t.revenue,
    expense: t.expense,
    netProfit: t.netProfit,
    isProjected: false,
  }));

  if (historical.length < MIN_HISTORICAL_POINTS) {
    return { method: "Data historis belum cukup (minimal 3 bulan) untuk membuat proyeksi.", sufficientData: false, historical, projected: [] };
  }

  const revenueGrowthRaw = averageGrowthRate(historical.map((h) => h.revenue));
  const expenseGrowthRaw = averageGrowthRate(historical.map((h) => h.expense));
  if (revenueGrowthRaw === null && expenseGrowthRaw === null) {
    // Revenue DAN expense sama-sama nol sepanjang jendela historis --
    // literally tidak ada aktivitas keuangan utk diekstrapolasi, bukan
    // cuma satu sisi yang kosong (lihat komentar `??` di bawah).
    return { method: "Data historis belum cukup (belum ada aktivitas keuangan tercatat) untuk menghitung tren pertumbuhan.", sufficientData: false, historical, projected: [] };
  }
  // Salah satu sisi bisa valid secara bisnis sementara sisi lain nol
  // sepanjang jendela (mis. baru mulai jualan, belum ada beban tercatat)
  // -- diasumsikan growth 0 (flat) utk sisi itu SAJA, bukan gagal total.
  const revenueGrowth = revenueGrowthRaw ?? 0;
  const expenseGrowth = expenseGrowthRaw ?? 0;

  const lastToDate = trend[trend.length - 1].toDate;
  let lastRevenue = historical[historical.length - 1].revenue;
  let lastExpense = historical[historical.length - 1].expense;
  const projected: ProjectionPoint[] = [];

  for (let i = 1; i <= monthsAhead; i++) {
    lastRevenue = lastRevenue * (1 + revenueGrowth);
    lastExpense = lastExpense * (1 + expenseGrowth);
    projected.push({
      label: monthLabelAfter(lastToDate, i),
      revenue: lastRevenue,
      expense: lastExpense,
      netProfit: lastRevenue - lastExpense,
      isProjected: true,
    });
  }

  return {
    method: `Proyeksi growth-based: rata-rata pertumbuhan bulanan historis (revenue ${(revenueGrowth * 100).toFixed(1)}%, expense ${(expenseGrowth * 100).toFixed(1)}%) diterapkan majemuk ke bulan berikutnya. Bukan prediksi pasti -- hanya ekstrapolasi tren historis.`,
    sufficientData: true,
    historical,
    projected,
  };
}
