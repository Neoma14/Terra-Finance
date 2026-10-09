import type { Knex } from "knex";
import type { IndustryTemplate, TaxEstimateResult } from "@konsultan/shared";
import { findPeriodsInRange } from "../periods/date-range.js";
import { calculatePphBadanNormal, calculatePphUmkmFinal } from "./pph-badan-calculator.js";
import { getTaxReferenceSettings } from "./settings.js";

async function getIncomeFigures(masterDb: Knex, companyId: string, periodId: string): Promise<{ netIncome: number; grossRevenue: number }> {
  const rows = await masterDb("trial_balance_snapshots as tbs")
    .join("accounts as a", "a.id", "tbs.account_id")
    .where("tbs.period_id", periodId)
    .andWhere("a.company_id", companyId)
    .whereIn("a.account_type", ["revenue", "expense"])
    .select("a.account_type as accountType", "tbs.ending_balance as endingBalance");

  let grossRevenue = 0;
  let totalExpense = 0;
  for (const row of rows as any[]) {
    const amount = Number(row.endingBalance);
    if (row.accountType === "revenue") grossRevenue += amount;
    else totalExpense += amount;
  }
  return { netIncome: grossRevenue - totalExpense, grossRevenue };
}

/** Sama seperti getIncomeFigures, tapi SUM ending_balance revenue/expense
 * di SELURUH periode dalam rentang tanggal -- valid krn akun flow tidak
 * carry-forward (ending_balance per periode = aktivitas periode itu saja),
 * sama persis logikanya dgn versi online, scoped `company_id`. */
async function getIncomeFiguresForRange(
  masterDb: Knex,
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<{ netIncome: number; grossRevenue: number }> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");

  const rows = await masterDb("trial_balance_snapshots as tbs")
    .join("accounts as a", "a.id", "tbs.account_id")
    .whereIn(
      "tbs.period_id",
      periods.map((p) => p.id),
    )
    .andWhere("a.company_id", companyId)
    .whereIn("a.account_type", ["revenue", "expense"])
    .select("a.account_type as accountType", "tbs.ending_balance as endingBalance");

  let grossRevenue = 0;
  let totalExpense = 0;
  for (const row of rows as any[]) {
    const amount = Number(row.endingBalance);
    if (row.accountType === "revenue") grossRevenue += amount;
    else totalExpense += amount;
  }
  return { netIncome: grossRevenue - totalExpense, grossRevenue };
}

const DISCLAIMER =
  "Estimasi ini memakai Net Income akuntansi sebagai pendekatan Penghasilan Kena Pajak (PKP) -- BELUM memperhitungkan koreksi fiskal (biaya non-deductible, penyusutan fiskal, kompensasi kerugian, dll). Gunakan sebagai gambaran awal, bukan pengganti perhitungan SPT Tahunan PPh Badan.";

export async function getTaxEstimate(
  masterDb: Knex,
  companyId: string,
  industryTemplate: IndustryTemplate,
  periodId: string,
  periodLabel: string,
): Promise<TaxEstimateResult> {
  const { netIncome, grossRevenue } = await getIncomeFigures(masterDb, companyId, periodId);
  const reference = await getTaxReferenceSettings(masterDb, companyId, industryTemplate);

  const pphNormal = calculatePphBadanNormal(netIncome, grossRevenue);
  const pphUmkmFinal = calculatePphUmkmFinal(grossRevenue, reference.umkmFacilityYears);

  const recommendation: "normal" | "umkm_final" =
    pphUmkmFinal.eligible && pphUmkmFinal.amountDue < pphNormal.amountDue ? "umkm_final" : "normal";

  return {
    periodId,
    periodLabel,
    netIncome,
    grossRevenue,
    pphNormal,
    pphUmkmFinal,
    recommendation,
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}

export async function getTaxEstimateForRange(
  masterDb: Knex,
  companyId: string,
  industryTemplate: IndustryTemplate,
  fromDate: string,
  toDate: string,
): Promise<TaxEstimateResult> {
  const { netIncome, grossRevenue } = await getIncomeFiguresForRange(masterDb, companyId, fromDate, toDate);
  const reference = await getTaxReferenceSettings(masterDb, companyId, industryTemplate);

  const pphNormal = calculatePphBadanNormal(netIncome, grossRevenue);
  const pphUmkmFinal = calculatePphUmkmFinal(grossRevenue, reference.umkmFacilityYears);

  const recommendation: "normal" | "umkm_final" =
    pphUmkmFinal.eligible && pphUmkmFinal.amountDue < pphNormal.amountDue ? "umkm_final" : "normal";

  return {
    periodId: "range",
    periodLabel: `${fromDate} s/d ${toDate}`,
    netIncome,
    grossRevenue,
    pphNormal,
    pphUmkmFinal,
    recommendation,
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
