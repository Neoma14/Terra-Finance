import type { Knex } from "knex";
import type { IndustryTemplate, RatioResult, RatioTrendPoint } from "@konsultan/shared";
import { findPeriodsInRange } from "../periods/date-range.js";
import { RATIO_TEMPLATES, type RatioContext } from "./templates.js";

const FLOW_TYPES = new Set(["revenue", "expense"]);

async function buildContext(masterDb: Knex, companyId: string, periodId: string): Promise<RatioContext> {
  const rows = await masterDb("trial_balance_snapshots as tbs")
    .join("accounts as a", "a.id", "tbs.account_id")
    .where("tbs.period_id", periodId)
    .andWhere("a.company_id", companyId)
    .select("a.code", "a.account_type as accountType", "tbs.ending_balance as endingBalance");

  const balances = new Map<string, number>();
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  let totalRevenue = 0;
  let totalExpense = 0;

  for (const row of rows as any[]) {
    const amount = Number(row.endingBalance);
    balances.set(row.code, amount);
    switch (row.accountType) {
      case "asset":
        totalAssets += amount;
        break;
      case "liability":
        totalLiabilities += amount;
        break;
      case "equity":
        totalEquity += amount;
        break;
      case "revenue":
        totalRevenue += amount;
        break;
      case "expense":
        totalExpense += amount;
        break;
    }
  }

  return { balances, totalAssets, totalLiabilities, totalEquity, netIncome: totalRevenue - totalExpense, totalRevenue };
}

export async function getRatios(
  masterDb: Knex,
  companyId: string,
  industryTemplate: IndustryTemplate,
  periodId: string,
  periodLabel: string,
): Promise<RatioResult> {
  const ctx = await buildContext(masterDb, companyId, periodId);
  return buildRatioResult(ctx, industryTemplate, periodId, periodLabel);
}

/** Sama seperti buildContext, tapi untuk rentang tanggal bebas -- sama
 * persis logikanya dgn versi online (lihat komentar di sana), scoped
 * `company_id`. */
export async function buildContextForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<RatioContext> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");
  const lastPeriodId = periods[periods.length - 1].id;

  const rows = await masterDb("trial_balance_snapshots as tbs")
    .join("accounts as a", "a.id", "tbs.account_id")
    .whereIn(
      "tbs.period_id",
      periods.map((p) => p.id),
    )
    .andWhere("a.company_id", companyId)
    .select("a.code", "a.account_type as accountType", "tbs.period_id as periodId", "tbs.ending_balance as endingBalance");

  const balances = new Map<string, number>();
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  let totalRevenue = 0;
  let totalExpense = 0;

  for (const row of rows as any[]) {
    const amount = Number(row.endingBalance);
    const isFlow = FLOW_TYPES.has(row.accountType);
    if (!isFlow) {
      if (row.periodId !== lastPeriodId) continue;
      balances.set(row.code, amount);
      switch (row.accountType) {
        case "asset":
          totalAssets += amount;
          break;
        case "liability":
          totalLiabilities += amount;
          break;
        case "equity":
          totalEquity += amount;
          break;
      }
    } else {
      balances.set(row.code, (balances.get(row.code) ?? 0) + amount);
      if (row.accountType === "revenue") totalRevenue += amount;
      if (row.accountType === "expense") totalExpense += amount;
    }
  }

  return { balances, totalAssets, totalLiabilities, totalEquity, netIncome: totalRevenue - totalExpense, totalRevenue };
}

export async function getRatiosForRange(
  masterDb: Knex,
  companyId: string,
  industryTemplate: IndustryTemplate,
  fromDate: string,
  toDate: string,
): Promise<RatioResult> {
  const ctx = await buildContextForRange(masterDb, companyId, fromDate, toDate);
  return buildRatioResult(ctx, industryTemplate, "range", `${fromDate} s/d ${toDate}`);
}

/** Metrik universal (Pendapatan, Laba Bersih, Total Aset, dst) yang selalu
 * ada & bisa dibandingkan lintas industri apapun -- dipakai modul
 * Benchmarking, sama persis logikanya dgn versi online. */
export function getUniversalMetrics(ctx: RatioContext): { code: string; value: number }[] {
  return [
    { code: "revenue", value: ctx.totalRevenue },
    { code: "net_income", value: ctx.netIncome },
    { code: "total_assets", value: ctx.totalAssets },
    { code: "total_liabilities", value: ctx.totalLiabilities },
    { code: "total_equity", value: ctx.totalEquity },
  ];
}

function buildRatioResult(ctx: RatioContext, industryTemplate: IndustryTemplate, periodId: string, periodLabel: string): RatioResult {
  const definitions = RATIO_TEMPLATES[industryTemplate];
  const ratios = definitions.map((def) => ({
    code: def.code,
    label: def.label,
    format: def.format,
    note: def.note,
    value: def.compute(ctx),
  }));
  return { periodId, periodLabel, ratios, generatedAt: new Date().toISOString() };
}

/** Dipakai chart tren -- satu titik data per periode yang sudah ada, scoped
 * `company_id`. */
export async function getRatioTrend(masterDb: Knex, companyId: string, industryTemplate: IndustryTemplate): Promise<RatioTrendPoint[]> {
  const periods = await masterDb("periods").where({ company_id: companyId }).orderBy("end_date", "asc");

  const points: RatioTrendPoint[] = [];
  for (const period of periods as any[]) {
    const result = await getRatios(masterDb, companyId, industryTemplate, period.id, period.label);
    const ratiosRecord: Record<string, number> = {};
    for (const r of result.ratios) ratiosRecord[r.code] = r.value;
    points.push({
      periodId: period.id,
      periodLabel: period.label,
      periodEndDate: period.end_date,
      ratios: ratiosRecord,
    });
  }
  return points;
}
