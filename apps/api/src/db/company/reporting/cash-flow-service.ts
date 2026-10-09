import type { Knex } from "knex";
import type { CashFlowReport } from "./reporting-types.js";
import { getAccountBalanceBeforeDate } from "../ledger-service.js";
import { getAccountBalanceAsOfInclusive, validateDateRange } from "./reporting-utils.js";
import { allocateProRata, fromCents, toCents } from "../../../lib/money.js";
import { applyBranchScope, type AuthorizedScope } from "../report-scope.js";

/**
 * Cash Flow Statement (TASK-DB-ARCH-012 §9). Sumber klasifikasi: field
 * SCHEMA EXISTING `accounts.is_cash` dan `accounts.cash_flow_activity`
 * ('operating'|'investing'|'financing'|null, ada sejak C0003/TASK-003) --
 * TIDAK ADA hardcode nama akun ("Kas"/"Bank"/dst, dilarang eksplisit §9).
 *
 * ALGORITMA (per journal entry, bukan per baris -- krn klasifikasi cash
 * flow adalah properti TRANSAKSI, ditentukan oleh akun LAWAN-nya, bukan
 * oleh akun kas itu sendiri):
 *   1. Ambil entry dlm rentang [fromDate,toDate], status POSTED/REVERSED,
 *      yang punya >=1 baris di akun `is_cash`.
 *   2. Hitung `cashDelta` = net pergerakan KAS entry itu (debit-credit
 *      seluruh baris kas; is_cash account selalu ASSET/normal_balance
 *      debit -- debit menambah kas).
 *   3. Jika SEMUA baris non-kas JUGA kas (transfer kas<->kas, mis. tarik
 *      tunai dari bank) -> entry TIDAK dihitung sbg cash flow eksternal
 *      sama sekali (§11: "jangan hitung transfer kas-ke-kas").
 *   4. (UAT-005: seluruh hitungan dalam BigInt sen; alokasi memakai metode
 *      sisa terbesar sehingga jumlah alokasi == cashDelta entri, persis, dan
 *      hasilnya Rupiah utuh bila nominal jurnal utuh -- tanpa noise float.)
 *      Selain itu, `cashDelta` dialokasikan PROPORSIONAL ke baris non-kas
 *      berdasarkan besaran (|debit-credit|) baris itu -- menangani entry
 *      bercampur (mis. bayar tagihan: sebagian beban operasional, sebagian
 *      pokok utang financing, dlm SATU entry kas keluar). Baris non-kas
 *      dgn `cash_flow_activity` terisi -> porsinya masuk kategori itu;
 *      yang `null` -> masuk `unclassifiedAmount` (§12: dilaporkan apa
 *      adanya, bukan ditebak).
 *
 * `beginningCash`/`endingCash`: reuse LANGSUNG `getAccountBalanceBeforeDate`
 * (ledger-service.ts, tidak diubah) via trik inclusive (reporting-utils.ts)
 * -- bukan reimplementasi query saldo.
 */

const STATUS_INCLUDED_IN_REPORTS = ["POSTED", "REVERSED"] as const;

interface CashFlowLineRow {
  journalEntryId: string;
  accountId: string;
  debit: number;
  credit: number;
  isCash: boolean;
  cashFlowActivity: string | null;
}

export async function getCashFlowStatement(db: Knex, fromDate: string, toDate: string, scope?: AuthorizedScope): Promise<CashFlowReport> {
  validateDateRange(fromDate, toDate);

  const cashAccounts = await db("accounts").where({ is_cash: true }).select("id");

  // UAT-005: seluruh aritmetika uang dalam bilangan bulat sen (BigInt); tidak
  // ada penjumlahan/pembagian float, sehingga tidak ada noise (…000004) dan
  // alokasi pro-rata tidak menghasilkan pecahan liar.
  let beginningC = 0n;
  let endingC = 0n;
  for (const account of cashAccounts) {
    beginningC += toCents(await getAccountBalanceBeforeDate(db, account.id, fromDate, scope));
    endingC += toCents(await getAccountBalanceAsOfInclusive(db, account.id, toDate, scope));
  }

  const cashEntryQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .join("accounts as a", "a.id", "jel.account_id")
    .where("a.is_cash", true)
    .whereIn("je.status", STATUS_INCLUDED_IN_REPORTS)
    .andWhere("je.entry_date", ">=", fromDate)
    .andWhere("je.entry_date", "<=", toDate);
  const cashEntryIds: { journalEntryId: string }[] = await applyBranchScope(cashEntryQuery, scope).distinct("je.id as journalEntryId");

  let operatingC = 0n;
  let investingC = 0n;
  let financingC = 0n;
  let unclassifiedC = 0n;

  for (const { journalEntryId } of cashEntryIds) {
    const lines: CashFlowLineRow[] = await db("journal_entry_lines as jel")
      .join("accounts as a", "a.id", "jel.account_id")
      .where("jel.journal_entry_id", journalEntryId)
      .select(
        "jel.journal_entry_id as journalEntryId",
        "jel.account_id as accountId",
        "jel.debit",
        "jel.credit",
        "a.is_cash as isCash",
        "a.cash_flow_activity as cashFlowActivity",
      );

    const cashLines = lines.filter((l) => l.isCash);
    const nonCashLines = lines.filter((l) => !l.isCash);

    if (nonCashLines.length === 0) continue; // §11: transfer kas<->kas, bukan cash flow eksternal

    const cashDeltaC = cashLines.reduce((sum, l) => sum + toCents(Number(l.debit)) - toCents(Number(l.credit)), 0n);
    if (cashDeltaC === 0n) continue;

    const weights = nonCashLines.map((l) => {
      const w = toCents(Number(l.debit)) - toCents(Number(l.credit));
      return w < 0n ? -w : w;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0n);

    if (totalWeight === 0n) {
      unclassifiedC += cashDeltaC; // tidak ada basis proporsi yang valid -- laporkan apa adanya, jangan ditebak
      continue;
    }

    // Kas entri dibagi ke baris lawan secara proporsional dalam kelipatan
    // Rupiah utuh (atau sen bila kas entri itu sendiri berpecahan). Metode
    // sisa terbesar: jumlah alokasi == cashDelta entri, persis.
    const unit = cashDeltaC % 100n === 0n ? 100n : 1n;
    const parts = allocateProRata(cashDeltaC, weights, unit);
    nonCashLines.forEach((line, i) => {
      if (line.cashFlowActivity === "operating") operatingC += parts[i];
      else if (line.cashFlowActivity === "investing") investingC += parts[i];
      else if (line.cashFlowActivity === "financing") financingC += parts[i];
      else unclassifiedC += parts[i];
    });
  }

  return {
    period: { fromDate, toDate },
    operating: { label: "Operating Activities", amount: fromCents(operatingC) },
    investing: { label: "Investing Activities", amount: fromCents(investingC) },
    financing: { label: "Financing Activities", amount: fromCents(financingC) },
    netChangeInCash: fromCents(endingC - beginningC),
    beginningCash: fromCents(beginningC),
    endingCash: fromCents(endingC),
    unclassifiedAmount: fromCents(unclassifiedC),
  };
}
