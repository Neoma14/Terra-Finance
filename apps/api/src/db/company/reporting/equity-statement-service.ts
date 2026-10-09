import type { Knex } from "knex";
import type { EquityStatementReport } from "./reporting-types.js";
import { getAccountBalanceBeforeDate as ledgerBalanceBeforeDate } from "../ledger-service.js";
import { classifyAccounts, getFlowAccountCumulativeTotal, getAccountMovementInRange, profitContributionSign, signedAmount, toCanonicalSign, validateDateRange, FLOW_ACCOUNT_TYPE_CODES } from "./reporting-utils.js";
import { getIncomeStatement } from "./income-statement-service.js";
import type { AuthorizedScope } from "../report-scope.js";

/**
 * Statement of Changes in Equity (TASK-DB-ARCH-012 §8). Menjembatani
 * Balance Sheet (snapshot, §"RE-BRIDGE" di balance-sheet-service.ts) dan
 * Income Statement (rentang) ke SATU narasi: openingEquity -> + netProfit
 * -> +/- additionalCapitalOrDrawings -> closingEquity.
 *
 * `openingEquity` = saldo akun EQUITY murni SEBELUM `fromDate` (exclusive,
 * reuse `getAccountBalanceBeforeDate` ledger-service.ts langsung) +
 * akumulasi KUMULATIF flow account SEBELUM `fromDate` (bridge yang sama
 * konsepnya dgn balance-sheet-service.ts, tapi exclusive thd `fromDate`
 * krn ini adalah SALDO AWAL periode, bukan "as of toDate").
 *
 * `additionalCapitalOrDrawings` = movement akun EQUITY (BUKAN flow
 * account) dalam rentang `fromDate..toDate` -- mis. setoran modal/
 * prive/dividen yang dicatat LANGSUNG ke akun EQUITY (bukan lewat akun
 * flow). §9 LIMITATION (didokumentasikan, bukan diam-diam): skema
 * `accounts`/`account_types` TIDAK memiliki sub-klasifikasi "capital
 * injection" vs "drawing" vs "prior-period adjustment" di level akun --
 * seluruh movement akun EQUITY-type dalam rentang digabung jadi SATU
 * baris. Memisahkannya butuh field/klasifikasi baru di `accounts` (mis.
 * `equity_movement_type`), yang DILARANG task ini ("jangan migration baru
 * kecuali benar-benar diperlukan").
 *
 * `closingEquity` = openingEquity + netProfit + additionalCapitalOrDrawings.
 * Konsistensi: closingEquity HARUS persis sama dgn `totalEquity` Balance
 * Sheet pada `toDate` yang sama (dibuktikan test cross-consistency) --
 * ini adalah identitas matematis langsung dari cara kedua bridge disusun,
 * bukan koinsidensi.
 */

export async function getEquityStatement(db: Knex, fromDate: string, toDate: string, scope?: AuthorizedScope): Promise<EquityStatementReport> {
  validateDateRange(fromDate, toDate);

  const { byTypeCode, typeNormalBalanceByCode } = await classifyAccounts(db);
  const equityAccounts = byTypeCode.get("EQUITY") ?? [];
  const equityCanonical = typeNormalBalanceByCode.get("EQUITY") ?? "credit";

  // Kontra-equity (mis. Dividen Dibagikan, normal_balance DEBIT) HARUS
  // mengurangi opening/closing equity, bukan menambah -- toCanonicalSign,
  // sama akar bug dgn balance-sheet-service.ts/income-statement-service.ts.
  let openingEquityAccountsOnly = 0;
  for (const account of equityAccounts) {
    const ownSigned = await ledgerBalanceBeforeDate(db, account.id, fromDate, scope);
    openingEquityAccountsOnly += toCanonicalSign(account.normalBalance, equityCanonical, ownSigned);
  }

  let openingProfitLossBridge = 0;
  for (const code of FLOW_ACCOUNT_TYPE_CODES) {
    const sign = profitContributionSign(code);
    const canonicalNormal = typeNormalBalanceByCode.get(code) ?? "credit";
    for (const account of byTypeCode.get(code) ?? []) {
      const ownSigned = await getFlowAccountCumulativeTotal(db, account.id, account.normalBalance, fromDate, false, scope);
      openingProfitLossBridge += sign * toCanonicalSign(account.normalBalance, canonicalNormal, ownSigned);
    }
  }

  const openingEquity = openingEquityAccountsOnly + openingProfitLossBridge;

  let additionalCapitalOrDrawings = 0;
  for (const account of equityAccounts) {
    const { debit, credit } = await getAccountMovementInRange(db, account.id, fromDate, toDate, scope);
    const ownSigned = signedAmount(account.normalBalance, debit, credit);
    additionalCapitalOrDrawings += toCanonicalSign(account.normalBalance, equityCanonical, ownSigned);
  }

  const incomeStatement = await getIncomeStatement(db, fromDate, toDate, scope);
  const netProfit = incomeStatement.netProfit;

  const closingEquity = openingEquity + netProfit + additionalCapitalOrDrawings;

  return {
    period: { fromDate, toDate },
    openingEquity,
    additionalCapitalOrDrawings,
    netProfit,
    closingEquity,
  };
}
