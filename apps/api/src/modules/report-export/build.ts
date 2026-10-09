import type { Knex } from "knex";
import { getBalanceSheet } from "../../db/company/reporting/balance-sheet-service.js";
import { getIncomeStatement } from "../../db/company/reporting/income-statement-service.js";
import { getEquityStatement } from "../../db/company/reporting/equity-statement-service.js";
import { getCashFlowStatement } from "../../db/company/reporting/cash-flow-service.js";
import { getTrialBalance } from "../../db/company/trial-balance-service.js";
import { getAccountLedger, getAccountLedgerByRange } from "../../db/company/ledger-service.js";
import { getAccount } from "../../db/company/account-service.js";
import type { AuthorizedScope } from "../../db/company/report-scope.js";
import {
  balanceSheetDocument,
  buildFileBase,
  cashFlowDocument,
  equityDocument,
  formatPeriodRange,
  scopeFileSuffix,
  scopeLabelFor,
  incomeStatementDocument,
  ledgerDocument,
  trialBalanceDocument,
  type ExportKind,
  type ReportDocument,
} from "./document.js";

/** Error yang aman ditampilkan ke client (validasi parameter). */
export class ExportParamError extends Error {
  constructor(
    public readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface ExportParams {
  fromDate?: string;
  toDate?: string;
  periodId?: string;
  accountId?: string;
}

const DATE_RANGE_KINDS: ReadonlySet<ExportKind> = new Set(["balance-sheet", "income-statement", "equity", "cash-flow"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Menyusun model dokumen untuk satu jenis laporan. Sumbernya WAJIB service
 * yang sama dengan endpoint laporan UI (`/reports/*`, `/trial-balance`,
 * `/ledger/:accountId`) -- tidak ada perhitungan kedua di sini.
 */
export async function buildExportDocument(db: Knex, kind: ExportKind, params: ExportParams, companyName: string, scope?: AuthorizedScope): Promise<ReportDocument> {
  const scopeLabel = scopeLabelFor(scope);
  const suffix = scopeFileSuffix(scope);
  if (DATE_RANGE_KINDS.has(kind)) {
    const { fromDate, toDate } = params;
    if (!fromDate || !toDate || !ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) {
      throw new ExportParamError(400, "fromDate dan toDate wajib diisi dengan format YYYY-MM-DD.");
    }
    const base = {
      companyName,
      periodLabel: formatPeriodRange(fromDate, toDate),
      scopeLabel,
      fileBase: buildFileBase(companyName, kind, fromDate, toDate) + suffix,
    };
    switch (kind) {
      case "balance-sheet":
        return balanceSheetDocument(await getBalanceSheet(db, fromDate, toDate, scope), base);
      case "income-statement":
        return incomeStatementDocument(await getIncomeStatement(db, fromDate, toDate, scope), base);
      case "equity":
        return equityDocument(await getEquityStatement(db, fromDate, toDate, scope), base);
      case "cash-flow":
        return cashFlowDocument(await getCashFlowStatement(db, fromDate, toDate, scope), base);
    }
  }

  const { periodId, accountId, fromDate, toDate } = params;

  if (kind === "ledger" && fromDate && toDate) {
    // Ledger per rentang tanggal -- service yang sama dengan endpoint UI.
    if (!accountId) throw new ExportParamError(400, "accountId wajib diisi.");
    const account = await getAccount(db, accountId);
    if (!account) throw new ExportParamError(404, "Akun tidak ditemukan.");
    const ledger = await getAccountLedgerByRange(db, accountId, fromDate, toDate, scope);
    return ledgerDocument(ledger, { code: account.code, name: account.name }, {
      companyName,
      periodLabel: formatPeriodRange(fromDate, toDate),
      scopeLabel,
      fileBase: buildFileBase(companyName, kind, fromDate, toDate, account.code) + suffix,
    });
  }

  if (!periodId) throw new ExportParamError(400, "periodId wajib diisi.");
  const period = await db("periods").where({ id: periodId }).first();
  if (!period) throw new ExportParamError(404, "Periode tidak ditemukan.");

  const startDate = String(period.start_date).slice(0, 10);
  const endDate = String(period.end_date).slice(0, 10);
  const base = {
    companyName,
    periodLabel: `${period.label} (${formatPeriodRange(startDate, endDate)})`,
    scopeLabel,
    fileBase: buildFileBase(companyName, kind, startDate, endDate) + suffix,
  };

  if (kind === "trial-balance") {
    return trialBalanceDocument(await getTrialBalance(db, periodId, scope), base);
  }

  // kind === "ledger"
  if (!accountId) throw new ExportParamError(400, "accountId wajib diisi.");
  const account = await getAccount(db, accountId);
  if (!account) throw new ExportParamError(404, "Akun tidak ditemukan.");
  const ledger = await getAccountLedger(db, accountId, periodId, scope);
  return ledgerDocument(ledger, { code: account.code, name: account.name }, {
    ...base,
    fileBase: buildFileBase(companyName, kind, startDate, endDate, account.code) + suffix,
  });
}
