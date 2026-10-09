import type { Knex } from "knex";

export interface PeriodRangeRow {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
}

/** Cari semua periode yang beririsan dgn rentang [fromDate, toDate] --
 * sama persis logikanya dgn findPeriodsInRange versi online
 * (modules/statements/date-range-calculator.ts), BEDA: scoped `company_id`. */
export async function findPeriodsInRange(masterDb: Knex, companyId: string, fromDate: string, toDate: string): Promise<PeriodRangeRow[]> {
  return masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("start_date", "<=", toDate)
    .andWhere("end_date", ">=", fromDate)
    .orderBy("start_date")
    .select("id", "label", "start_date as startDate", "end_date as endDate");
}
