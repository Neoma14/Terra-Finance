import type { Knex } from "knex";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { getIncomeStatement } from "./reporting/income-statement-service.js";

/**
 * Analisis / Rasio Keuangan versi company-db (TASK-023 §10) -- PENGGANTI
 * UI utk legacy `/c/:slug/ratios` (`modules/ratios/calculator.ts`,
 * masterDb). TIDAK reuse calculator itu langsung krn basisnya
 * `trial_balance_snapshots` yang TIDAK PERNAH diisi oleh service company-
 * db manapun (lihat komentar trial-balance-service.ts -- Trial Balance
 * company-db live-computed, bukan dari snapshot table). Rasio di sini
 * dihitung ULANG dari `getBalanceSheet`/`getIncomeStatement` yang SAMA
 * persis dipakai Dashboard & Laporan Keuangan -- bukan formula/sumber
 * data kedua, cuma pembagian angka yang sudah direkonsiliasi.
 *
 * Rasio likuiditas klasik (Current Ratio, Quick Ratio) SENGAJA tidak
 * dihitung -- skema accounts (account_types) tidak membedakan aset/
 * liabilitas LANCAR vs TIDAK LANCAR, jadi angka itu akan mengada-ada
 * kalau dipaksa. Ditandai `null` ("Belum tersedia"), bukan dihitung
 * dgn asumsi yang tidak berdasar.
 */

export interface RatioValue {
  value: number | null;
  label: string;
  unavailableReason?: string;
}

export interface RatioAnalysis {
  period: { fromDate: string; toDate: string };
  profitability: {
    grossProfitMargin: RatioValue;
    operatingMargin: RatioValue;
    netProfitMargin: RatioValue;
    returnOnAssets: RatioValue;
    returnOnEquity: RatioValue;
  };
  solvency: {
    debtToEquity: RatioValue;
    debtToAssets: RatioValue;
  };
  liquidity: {
    currentRatio: RatioValue;
  };
}

function ratio(numerator: number, denominator: number, label: string): RatioValue {
  if (denominator === 0) return { value: null, label };
  return { value: numerator / denominator, label };
}

export async function getRatioAnalysis(db: Knex, fromDate: string, toDate: string): Promise<RatioAnalysis> {
  const [balanceSheet, income] = await Promise.all([getBalanceSheet(db, fromDate, toDate), getIncomeStatement(db, fromDate, toDate)]);
  const revenue = income.revenue.total;

  return {
    period: { fromDate, toDate },
    profitability: {
      grossProfitMargin: ratio(income.grossProfit, revenue, "Margin Laba Kotor"),
      operatingMargin: ratio(income.operatingProfit, revenue, "Margin Laba Operasi"),
      netProfitMargin: ratio(income.netProfit, revenue, "Margin Laba Bersih"),
      returnOnAssets: ratio(income.netProfit, balanceSheet.totalAssets, "Return on Assets (ROA)"),
      returnOnEquity: ratio(income.netProfit, balanceSheet.totalEquity, "Return on Equity (ROE)"),
    },
    solvency: {
      debtToEquity: ratio(balanceSheet.totalLiabilities, balanceSheet.totalEquity, "Debt to Equity"),
      debtToAssets: ratio(balanceSheet.totalLiabilities, balanceSheet.totalAssets, "Debt to Assets"),
    },
    liquidity: {
      currentRatio: {
        value: null,
        label: "Current Ratio",
        unavailableReason: "Skema akun belum membedakan aset/liabilitas lancar vs tidak lancar.",
      },
    },
  };
}
