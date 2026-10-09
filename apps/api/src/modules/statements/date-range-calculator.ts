import type { Knex } from "knex";
import type { CashFlowAccountContribution, CashFlowDetailResult, CashFlowResult, EquityStatementResult, FinancialTrendPoint, StatementResult } from "@konsultan/shared";
import { findPeriodsInRange } from "../periods/date-range.js";
import { emptyActivityBalances, getActivityBalances, getStatementLinesForPeriods, netIncomeFromLines } from "./calculator.js";

function rangeLabel(fromDate: string, toDate: string): string {
  return `${fromDate} s/d ${toDate}`;
}

/** Neraca -- SNAPSHOT, pakai periode PALING AKHIR yang beririsan dgn
 * rentang (menjumlahkan neraca antar periode tidak bermakna). Sama persis
 * logikanya dgn versi online, scoped `company_id`. */
export async function getBalanceSheetForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<StatementResult> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");
  const lastPeriod = periods[periods.length - 1];
  const lines = await getStatementLinesForPeriods(masterDb, companyId, "balance_sheet", [lastPeriod.id]);
  return { statementType: "balance_sheet", periodId: lastPeriod.id, periodLabel: rangeLabel(fromDate, toDate), lines, generatedAt: new Date().toISOString() };
}

/** Laba Rugi -- FLOW, SUM ending_balance akun revenue/expense dari SEMUA
 * periode dalam rentang (valid krn ending_balance akun flow per periode =
 * aktivitas periode itu saja). Sama persis logikanya dgn versi online,
 * scoped `company_id`. */
export async function getIncomeStatementForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<StatementResult> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");
  const lines = await getStatementLinesForPeriods(
    masterDb,
    companyId,
    "income_statement",
    periods.map((p) => p.id),
  );
  return {
    statementType: "income_statement",
    periodId: periods[periods.length - 1].id,
    periodLabel: rangeLabel(fromDate, toDate),
    lines,
    generatedAt: new Date().toISOString(),
  };
}

/** Arus kas untuk rentang tanggal bebas -- sama persis logikanya dgn versi
 * online, scoped `company_id`. */
export async function getCashFlowForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<CashFlowResult> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");
  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];

  const priorPeriod = await masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("end_date", "<", firstPeriod.startDate)
    .orderBy("end_date", "desc")
    .first();

  const [incomeLines, ending, beginning] = await Promise.all([
    getStatementLinesForPeriods(
      masterDb,
      companyId,
      "income_statement",
      periods.map((p) => p.id),
    ),
    getActivityBalances(masterDb, companyId, lastPeriod.id),
    priorPeriod ? getActivityBalances(masterDb, companyId, priorPeriod.id) : Promise.resolve(emptyActivityBalances()),
  ]);

  const netIncome = netIncomeFromLines(incomeLines);
  const contribution = (activity: "operating" | "investing" | "financing") =>
    ending.byActivity[activity].debitNormal * -1 +
    ending.byActivity[activity].creditNormal -
    (beginning.byActivity[activity].debitNormal * -1 + beginning.byActivity[activity].creditNormal);

  const operatingActivities = netIncome + contribution("operating");
  const investingActivities = contribution("investing");
  const financingActivities = contribution("financing");

  return {
    periodId: lastPeriod.id,
    periodLabel: rangeLabel(fromDate, toDate),
    priorPeriodId: priorPeriod?.id ?? null,
    netIncome,
    operatingActivities,
    investingActivities,
    financingActivities,
    netChangeInCash: operatingActivities + investingActivities + financingActivities,
    beginningCash: beginning.cash,
    endingCash: ending.cash,
    generatedAt: new Date().toISOString(),
  };
}

/** Rincian kontribusi tiap akun cash_flow_activity ke masing-masing bucket
 * operating/investing/financing untuk rentang tanggal bebas -- dipakai
 * export Excel (sheet "Arus Kas" berisi rincian per-akun, bukan cuma 3
 * angka lump-sum). Total per bucket dijamin identik dgn getCashFlowForRange
 * krn rumus kontribusi per-akunnya sama persis. Sama persis logikanya dgn
 * versi online, scoped `company_id`. */
export async function getCashFlowDetailForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<CashFlowDetailResult> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");
  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];

  const priorPeriod = await masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("end_date", "<", firstPeriod.startDate)
    .orderBy("end_date", "desc")
    .first();

  const [endingRows, beginningRows] = await Promise.all([
    masterDb("trial_balance_snapshots as tbs")
      .join("accounts as a", "a.id", "tbs.account_id")
      .where("tbs.period_id", lastPeriod.id)
      .andWhere("a.company_id", companyId)
      .whereNotNull("a.cash_flow_activity")
      .select("a.id as accountId", "a.code", "a.name", "a.cash_flow_activity as activity", "a.normal_balance as normalBalance", "tbs.ending_balance as endingBalance"),
    priorPeriod
      ? masterDb("trial_balance_snapshots").where({ period_id: priorPeriod.id }).select("account_id", "ending_balance")
      : Promise.resolve([]),
  ]);

  const beginningByAccount = new Map(beginningRows.map((r: any) => [r.account_id, Number(r.ending_balance)]));

  const result: CashFlowDetailResult = { periodId: lastPeriod.id, operating: [], investing: [], financing: [] };
  for (const row of endingRows as any[]) {
    const beginningBalance = beginningByAccount.get(row.accountId) ?? 0;
    const endingBalance = Number(row.endingBalance);
    const delta = endingBalance - beginningBalance;
    const contribution = row.normalBalance === "debit" ? -delta : delta;
    const item: CashFlowAccountContribution = { accountId: row.accountId, code: row.code, name: row.name, beginningBalance, endingBalance, delta, contribution };
    if (row.activity === "operating") result.operating.push(item);
    else if (row.activity === "investing") result.investing.push(item);
    else if (row.activity === "financing") result.financing.push(item);
  }
  return result;
}

/** Tren finansial antar periode (dipakai chart "Tren Kinerja" & sparkline
 * KPI di Dashboard) -- sama persis logikanya dgn versi online, scoped
 * `company_id`. HANYA periode yang beririsan dgn rentang [fromDate,
 * toDate] yang disertakan (beda dgn getFinancialTrend versi PERIOD-based
 * yang menyertakan SEMUA periode perusahaan). */
export async function getFinancialTrendForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<FinancialTrendPoint[]> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) return [];

  const points: FinancialTrendPoint[] = [];
  for (const period of periods) {
    const rows = await masterDb("trial_balance_snapshots as tbs")
      .join("accounts as a", "a.id", "tbs.account_id")
      .where("tbs.period_id", period.id)
      .andWhere("a.company_id", companyId)
      .select("a.account_type as accountType", "a.is_cash as isCash", "tbs.ending_balance as endingBalance");

    let revenue = 0;
    let expense = 0;
    let totalAssets = 0;
    let cash = 0;
    for (const row of rows as any[]) {
      const amount = Number(row.endingBalance);
      if (row.isCash) cash += amount;
      if (row.accountType === "asset") totalAssets += amount;
      if (row.accountType === "revenue") revenue += amount;
      if (row.accountType === "expense") expense += amount;
    }

    points.push({
      periodId: period.id,
      periodLabel: period.label,
      periodEndDate: period.endDate,
      revenue,
      netIncome: revenue - expense,
      totalAssets,
      cash,
    });
  }
  return points;
}

/** Laporan Perubahan Ekuitas untuk rentang tanggal bebas -- sama persis
 * logikanya dgn versi online, scoped `company_id`. */
export async function getEquityStatementForRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<EquityStatementResult> {
  const periods = await findPeriodsInRange(masterDb, companyId, fromDate, toDate);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");
  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];

  const priorPeriod = await masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("end_date", "<", firstPeriod.startDate)
    .orderBy("end_date", "desc")
    .first();

  const [endingRows, beginningRows, incomeLines] = await Promise.all([
    masterDb("trial_balance_snapshots as tbs")
      .join("accounts as a", "a.id", "tbs.account_id")
      .where("tbs.period_id", lastPeriod.id)
      .andWhere("a.company_id", companyId)
      .andWhere("a.account_type", "equity")
      .orderBy("a.code")
      .select("a.id as accountId", "a.code", "a.name", "tbs.ending_balance as endingBalance"),
    priorPeriod
      ? masterDb("trial_balance_snapshots").where({ period_id: priorPeriod.id }).select("account_id", "ending_balance")
      : Promise.resolve([]),
    getStatementLinesForPeriods(
      masterDb,
      companyId,
      "income_statement",
      periods.map((p) => p.id),
    ),
  ]);

  const beginningByAccount = new Map(beginningRows.map((r: any) => [r.account_id, Number(r.ending_balance)]));
  const lines = (endingRows as any[]).map((r) => {
    const beginningBalance = beginningByAccount.get(r.accountId) ?? 0;
    const endingBalance = Number(r.endingBalance);
    return { accountId: r.accountId, code: r.code, name: r.name, beginningBalance, endingBalance, delta: endingBalance - beginningBalance };
  });

  return {
    periodId: lastPeriod.id,
    periodLabel: rangeLabel(fromDate, toDate),
    priorPeriodId: priorPeriod?.id ?? null,
    lines,
    totalBeginning: lines.reduce((s, l) => s + l.beginningBalance, 0),
    netIncome: netIncomeFromLines(incomeLines),
    totalEnding: lines.reduce((s, l) => s + l.endingBalance, 0),
    generatedAt: new Date().toISOString(),
  };
}
