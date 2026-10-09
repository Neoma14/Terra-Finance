import type { Knex } from "knex";
import type { IncomeStatementReport, FinancialReportSection } from "./reporting-types.js";
import { classifyAccounts, getAccountMovementInRange, signedAmount, toCanonicalSign, validateDateRange } from "./reporting-utils.js";
import type { AccountRow } from "../account-service.js";
import type { AuthorizedScope } from "../report-scope.js";

/**
 * Income Statement (TASK-DB-ARCH-012 §7). Laporan RENTANG (`fromDate`..
 * `toDate` inklusif), bukan snapshot -- berbeda dari Balance Sheet.
 * Sumber: movement akun flow (REVENUE/COGS/EXPENSE/OTHER_INCOME/
 * OTHER_EXPENSE) dalam rentang tsb saja (§31/§32 ledger-service.ts: flow
 * account TIDAK carry-forward, jadi "movement dalam rentang" = seluruh
 * nilainya utk rentang itu, tidak ada opening balance yang relevan).
 *
 * Presentasi: `signedAmount` mengembalikan angka POSITIF saat searah
 * `normal_balance` akun (REVENUE/OTHER_INCOME normal_balance=credit;
 * COGS/EXPENSE/OTHER_EXPENSE normal_balance=debit, lihat C0002 seed) --
 * jadi akun NORMAL (bukan kontra) SELALU tampil positif, tidak pernah
 * dibalik krn representasi debit/kredit internal (§8 instruksi, larangan
 * eksplisit). PENGECUALIAN DISENGAJA: kontra-akun dlm section yg sama
 * (mis. "Retur & Potongan Penjualan", tipe REVENUE tapi normal_balance
 * DEBIT, krn SENGAJA mengurangi pendapatan) HARUS tampil NEGATIF supaya
 * `total` section (dan `grossProfit`/`netProfit` yg menurunkannya) benar
 * -- lihat `toCanonicalSign` (BUG NYATA yg diperbaiki, sebelumnya kontra-
 * akun ikut TERTAMBAH bukannya TERKURANG dari total section).
 */

async function buildFlowSection(db: Knex, accounts: AccountRow[], fromDate: string, toDate: string, label: string, canonicalNormal: "debit" | "credit", scope?: AuthorizedScope): Promise<FinancialReportSection> {
  const lines = [];
  let total = 0;
  for (const account of accounts) {
    const { debit, credit } = await getAccountMovementInRange(db, account.id, fromDate, toDate, scope);
    const ownSigned = signedAmount(account.normalBalance, debit, credit);
    if (ownSigned === 0) continue;
    const amount = toCanonicalSign(account.normalBalance, canonicalNormal, ownSigned);
    lines.push({ accountId: account.id, accountCode: account.code, accountName: account.name, amount });
    total += amount;
  }
  return { label, lines, total };
}

export async function getIncomeStatement(db: Knex, fromDate: string, toDate: string, scope?: AuthorizedScope): Promise<IncomeStatementReport> {
  validateDateRange(fromDate, toDate);

  const { byTypeCode, typeNormalBalanceByCode } = await classifyAccounts(db);
  const canonical = (code: string): "debit" | "credit" => typeNormalBalanceByCode.get(code) ?? "credit";

  const revenue = await buildFlowSection(db, byTypeCode.get("REVENUE") ?? [], fromDate, toDate, "Revenue", canonical("REVENUE"), scope);
  const cogs = await buildFlowSection(db, byTypeCode.get("COGS") ?? [], fromDate, toDate, "Cost of Goods Sold", canonical("COGS"), scope);
  const operatingExpenses = await buildFlowSection(db, byTypeCode.get("EXPENSE") ?? [], fromDate, toDate, "Operating Expenses", canonical("EXPENSE"), scope);
  const otherIncome = await buildFlowSection(db, byTypeCode.get("OTHER_INCOME") ?? [], fromDate, toDate, "Other Income", canonical("OTHER_INCOME"), scope);
  const otherExpense = await buildFlowSection(db, byTypeCode.get("OTHER_EXPENSE") ?? [], fromDate, toDate, "Other Expense", canonical("OTHER_EXPENSE"), scope);

  const grossProfit = revenue.total - cogs.total;
  const operatingProfit = grossProfit - operatingExpenses.total;
  const netProfit = operatingProfit + otherIncome.total - otherExpense.total;

  return {
    period: { fromDate, toDate },
    revenue,
    cogs,
    grossProfit,
    operatingExpenses,
    operatingProfit,
    otherIncome,
    otherExpense,
    netProfit,
  };
}
