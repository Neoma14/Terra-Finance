import type { Knex } from "knex";
import type { CashFlowResult, EquityStatementResult, StatementLineValue, StatementResult, StatementType } from "@konsultan/shared";

/**
 * SUM ending_balance dari SATU ATAU LEBIH period_id sekaligus per baris
 * laporan -- sama persis logikanya dgn versi online (lihat komentar di
 * sana ttg VALID utk Laba Rugi tapi TIDAK VALID utk Neraca kalau dipanggil
 * dgn banyak periodId), scoped `company_id`.
 */
export async function getStatementLinesForPeriods(
  masterDb: Knex,
  companyId: string,
  statementType: StatementType,
  periodIds: string[],
): Promise<StatementLineValue[]> {
  const lineRows = await masterDb("statement_lines as sl")
    .leftJoin("statement_line_accounts as sla", "sla.statement_line_id", "sl.id")
    .leftJoin("trial_balance_snapshots as tbs", function () {
      this.on("tbs.account_id", "=", "sla.account_id").andOn(
        masterDb.raw(`tbs.period_id IN (${periodIds.map(() => "?").join(",")})`, periodIds),
      );
    })
    .where("sl.company_id", companyId)
    .andWhere("sl.statement_type", statementType)
    .groupBy("sl.id", "sl.line_code", "sl.line_label", "sl.display_order", "sl.parent_line_id")
    .orderBy("sl.display_order")
    .select(
      "sl.id as statementLineId",
      "sl.line_code as lineCode",
      "sl.line_label as lineLabel",
      "sl.display_order as displayOrder",
      "sl.parent_line_id as parentLineId",
      masterDb.raw("COALESCE(SUM(tbs.ending_balance), 0) as amount"),
    );

  // Rincian PER SUB-AKUN yang menyusun tiap baris laporan -- sama persis
  // logikanya dgn versi online (lihat komentar di sana).
  const accountRows = await masterDb("statement_lines as sl")
    .join("statement_line_accounts as sla", "sla.statement_line_id", "sl.id")
    .join("accounts as a", "a.id", "sla.account_id")
    .leftJoin("trial_balance_snapshots as tbs", function () {
      this.on("tbs.account_id", "=", "sla.account_id").andOn(
        masterDb.raw(`tbs.period_id IN (${periodIds.map(() => "?").join(",")})`, periodIds),
      );
    })
    .where("sl.company_id", companyId)
    .andWhere("sl.statement_type", statementType)
    .groupBy("sl.id", "a.id", "a.code", "a.name")
    .orderBy("a.code")
    .select("sl.id as statementLineId", "a.code as code", "a.name as name", masterDb.raw("COALESCE(SUM(tbs.ending_balance), 0) as amount"));

  const accountsByLine = new Map<string, { code: string; name: string; amount: number }[]>();
  for (const r of accountRows as any[]) {
    const list = accountsByLine.get(r.statementLineId) ?? [];
    list.push({ code: r.code, name: r.name, amount: Number(r.amount) });
    accountsByLine.set(r.statementLineId, list);
  }

  return lineRows.map((r: any) => ({
    lineCode: r.lineCode,
    lineLabel: r.lineLabel,
    amount: Number(r.amount),
    displayOrder: r.displayOrder,
    parentLineId: r.parentLineId,
    accounts: accountsByLine.get(r.statementLineId) ?? [],
  }));
}

async function getStatementLines(masterDb: Knex, companyId: string, statementType: StatementType, periodId: string): Promise<StatementLineValue[]> {
  return getStatementLinesForPeriods(masterDb, companyId, statementType, [periodId]);
}

export async function getBalanceSheet(masterDb: Knex, companyId: string, periodId: string, periodLabel: string): Promise<StatementResult> {
  const lines = await getStatementLines(masterDb, companyId, "balance_sheet", periodId);
  return { statementType: "balance_sheet", periodId, periodLabel, lines, generatedAt: new Date().toISOString() };
}

export async function getIncomeStatement(masterDb: Knex, companyId: string, periodId: string, periodLabel: string): Promise<StatementResult> {
  const lines = await getStatementLines(masterDb, companyId, "income_statement", periodId);
  return { statementType: "income_statement", periodId, periodLabel, lines, generatedAt: new Date().toISOString() };
}

/** Konvensi: baris revenue berkode awalan "is_revenue" adalah penambah,
 * sisanya pengurang -- sama persis logikanya dgn versi online. */
export function netIncomeFromLines(lines: StatementLineValue[]): number {
  return lines.reduce((sum, l) => (l.lineCode.startsWith("is_revenue") ? sum + l.amount : sum - l.amount), 0);
}

/**
 * Laporan Perubahan Ekuitas -- sama persis logikanya dgn versi online
 * (lihat komentar di sana ttg laba/rugi periode berjalan sudah otomatis
 * masuk ke saldo akhir retained earnings/SHU lewat closing entry di
 * recomputeTrialBalanceForPeriod), scoped `company_id`.
 */
export async function getEquityStatement(
  masterDb: Knex,
  companyId: string,
  periodId: string,
  periodLabel: string,
  priorPeriodId: string | null,
): Promise<EquityStatementResult> {
  const [endingRows, beginningRows, incomeLines] = await Promise.all([
    masterDb("trial_balance_snapshots as tbs")
      .join("accounts as a", "a.id", "tbs.account_id")
      .where("tbs.period_id", periodId)
      .andWhere("a.company_id", companyId)
      .andWhere("a.account_type", "equity")
      .orderBy("a.code")
      .select("a.id as accountId", "a.code", "a.name", "tbs.ending_balance as endingBalance"),
    priorPeriodId
      ? masterDb("trial_balance_snapshots").where({ period_id: priorPeriodId }).select("account_id", "ending_balance")
      : Promise.resolve([]),
    getStatementLines(masterDb, companyId, "income_statement", periodId),
  ]);

  const beginningByAccount = new Map(beginningRows.map((r: any) => [r.account_id, Number(r.ending_balance)]));
  const lines = (endingRows as any[]).map((r) => {
    const beginningBalance = beginningByAccount.get(r.accountId) ?? 0;
    const endingBalance = Number(r.endingBalance);
    return { accountId: r.accountId, code: r.code, name: r.name, beginningBalance, endingBalance, delta: endingBalance - beginningBalance };
  });

  return {
    periodId,
    periodLabel,
    priorPeriodId,
    lines,
    totalBeginning: lines.reduce((s, l) => s + l.beginningBalance, 0),
    netIncome: netIncomeFromLines(incomeLines),
    totalEnding: lines.reduce((s, l) => s + l.endingBalance, 0),
    generatedAt: new Date().toISOString(),
  };
}

export interface ActivityBucket {
  debitNormal: number;
  creditNormal: number;
}

export interface ActivityBalances {
  cash: number;
  byActivity: Record<"operating" | "investing" | "financing", ActivityBucket>;
}

export function emptyActivityBalances(): ActivityBalances {
  return {
    cash: 0,
    byActivity: {
      operating: { debitNormal: 0, creditNormal: 0 },
      investing: { debitNormal: 0, creditNormal: 0 },
      financing: { debitNormal: 0, creditNormal: 0 },
    },
  };
}

/** Sama persis logikanya dgn versi online (lihat komentar panjang di sana
 * ttg kenapa is_cash/cash_flow_activity dipakai, bukan menebak dari
 * account_subtype), scoped `company_id`. */
export async function getActivityBalances(masterDb: Knex, companyId: string, periodId: string): Promise<ActivityBalances> {
  const rows = await masterDb("trial_balance_snapshots as tbs")
    .join("accounts as a", "a.id", "tbs.account_id")
    .where("tbs.period_id", periodId)
    .andWhere("a.company_id", companyId)
    .select("a.is_cash as isCash", "a.cash_flow_activity as activity", "a.normal_balance as normalBalance", "tbs.ending_balance as endingBalance");

  const balances = emptyActivityBalances();
  for (const row of rows as any[]) {
    const amount = Number(row.endingBalance);
    if (row.isCash) {
      balances.cash += amount;
      continue;
    }
    if (row.activity === "operating" || row.activity === "investing" || row.activity === "financing") {
      const bucket = balances.byActivity[row.activity as "operating" | "investing" | "financing"];
      if (row.normalBalance === "debit") bucket.debitNormal += amount;
      else bucket.creditNormal += amount;
    }
  }
  return balances;
}

/** Arus kas metode indirect, industry-agnostic lewat is_cash/cash_flow_activity
 * -- sama persis logikanya dgn versi online (lihat komentar panjang di
 * sana), scoped `company_id`. */
export async function getCashFlow(
  masterDb: Knex,
  companyId: string,
  periodId: string,
  periodLabel: string,
  priorPeriodId: string | null,
): Promise<CashFlowResult> {
  const [incomeLines, ending, beginning] = await Promise.all([
    getStatementLines(masterDb, companyId, "income_statement", periodId),
    getActivityBalances(masterDb, companyId, periodId),
    priorPeriodId ? getActivityBalances(masterDb, companyId, priorPeriodId) : Promise.resolve(emptyActivityBalances()),
  ]);

  const netIncome = netIncomeFromLines(incomeLines);

  const contribution = (activity: "operating" | "investing" | "financing") =>
    ending.byActivity[activity].debitNormal * -1 +
    ending.byActivity[activity].creditNormal -
    (beginning.byActivity[activity].debitNormal * -1 + beginning.byActivity[activity].creditNormal);

  const operatingActivities = netIncome + contribution("operating");
  const investingActivities = contribution("investing");
  const financingActivities = contribution("financing");
  const netChangeInCash = operatingActivities + investingActivities + financingActivities;

  return {
    periodId,
    periodLabel,
    priorPeriodId,
    netIncome,
    operatingActivities,
    investingActivities,
    financingActivities,
    netChangeInCash,
    beginningCash: beginning.cash,
    endingCash: ending.cash,
    generatedAt: new Date().toISOString(),
  };
}
