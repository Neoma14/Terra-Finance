import type { Knex } from "knex";
import { BalanceSheetNotBalancedError, type BalanceSheetReport, type FinancialReportSection } from "./reporting-types.js";
import { classifyAccounts, getAccountBalanceAsOfInclusive, getCumulativeUnclosedProfitLoss, toCanonicalSign, UNCLOSED_PROFIT_LOSS_CODE, validateDateRange } from "./reporting-utils.js";
import type { AccountRow } from "../account-service.js";
import type { AuthorizedScope } from "../report-scope.js";

/**
 * Balance Sheet (TASK-DB-ARCH-012 §6). "As of" `toDate` -- bukan laporan
 * rentang (`fromDate` tetap divalidasi & dikembalikan di `period` utk
 * konsistensi kontrak API §14, tapi TIDAK memengaruhi perhitungan saldo,
 * sama seperti Balance Sheet akuntansi pada umumnya: snapshot satu titik
 * waktu, bukan rentang).
 *
 * MASALAH YANG DIPECAHKAN -- "Current Period Profit/Loss" bridge:
 * TERRA tidak memiliki proses closing (tutup buku akhir periode ke
 * Retained Earnings) -- instruksi TASK-DB-ARCH-012 melarang membuatnya di
 * task ini (reporting read-only, tidak boleh menulis apa pun). Tanpa
 * proses closing, akun EQUITY di tabel `accounts` TIDAK PERNAH berisi
 * akumulasi laba/rugi historis -- itu "tersimpan" di akun REVENUE/EXPENSE/
 * COGS/OTHER_INCOME/OTHER_EXPENSE yang notabene flow account (reset ke 0
 * tiap periode secara LEDGER, tapi datanya sendiri tidak pernah hilang
 * dari `journal_entry_lines`).
 *
 * Secara matematis: krn SETIAP journal entry SELALU balanced (debit=kredit,
 * CHECK constraint C0009 + validasi journal-service.ts), maka utk SELURUH
 * baris jurnal yang pernah ada (status POSTED+REVERSED, SELURUH waktu):
 *     SUM(signed ASSET) + SUM(signed LIABILITY) + SUM(signed EQUITY)
 *       + SUM(signed REVENUE/COGS/EXPENSE/OTHER_INCOME/OTHER_EXPENSE) = 0
 * Jadi utk Assets = Liabilities + Equity benar scr matematis TANPA proses
 * closing, akumulasi KUMULATIF (sejak baris jurnal pertama, bukan hanya
 * sejak `fromDate`) seluruh akun flow SAMPAI `toDate` HARUS ditambahkan
 * sbg satu baris sintetis di section Equity -- ini BUKAN tebakan/heuristik,
 * melainkan konsekuensi matematis langsung dari double-entry constraint
 * yang sudah ada di schema. Didokumentasikan jelas di `Change_Log.md` &
 * `Architecture_Contract.md` sbg keputusan desain yang disengaja.
 *
 * Jika setelah bridge ini Assets masih != Liabilities + Equity, itu bukan
 * "kondisi laporan yang valid" -- itu BUG INTEGRITAS DATA (mis. baris
 * jurnal ter-insert di luar `journal-service.ts`, bypass CHECK constraint
 * scr langsung ke DB). §Fail-safe: jangan menyembunyikan/menyesuaikan diam-
 * diam -- lempar `BalanceSheetNotBalancedError` dgn diagnostic lengkap,
 * bukan mengembalikan angka yang salah.
 */

const RETAINED_EARNINGS_BRIDGE_ACCOUNT_CODE = UNCLOSED_PROFIT_LOSS_CODE;
const RETAINED_EARNINGS_BRIDGE_LABEL = "Laba (Rugi) Belum Ditutup ke Retained Earnings (kumulatif s/d toDate)";

async function buildSection(db: Knex, accounts: AccountRow[], toDate: string, label: string, canonicalNormal: "debit" | "credit", scope?: AuthorizedScope): Promise<FinancialReportSection> {
  const lines = [];
  let total = 0;
  for (const account of accounts) {
    const ownSigned = await getAccountBalanceAsOfInclusive(db, account.id, toDate, scope);
    if (ownSigned === 0) continue; // konsisten dgn trial-balance-service.ts: akun tanpa saldo tidak ditampilkan
    // kontra-akun (mis. Akumulasi Penyusutan di section Assets) harus
    // MENGURANGI total section, bukan menambah -- lihat toCanonicalSign.
    const amount = toCanonicalSign(account.normalBalance, canonicalNormal, ownSigned);
    lines.push({ accountId: account.id, accountCode: account.code, accountName: account.name, amount });
    total += amount;
  }
  return { label, lines, total };
}

export async function getBalanceSheet(db: Knex, fromDate: string, toDate: string, scope?: AuthorizedScope): Promise<BalanceSheetReport> {
  validateDateRange(fromDate, toDate);

  const { byTypeCode, typeNormalBalanceByCode } = await classifyAccounts(db);

  const assets = await buildSection(db, byTypeCode.get("ASSET") ?? [], toDate, "Assets", "debit", scope);
  const liabilities = await buildSection(db, byTypeCode.get("LIABILITY") ?? [], toDate, "Liabilities", "credit", scope);
  const equity = await buildSection(db, byTypeCode.get("EQUITY") ?? [], toDate, "Equity", "credit", scope);

  const cumulativeProfitLoss = await getCumulativeUnclosedProfitLoss(db, { byTypeCode, typeNormalBalanceByCode }, toDate, true, scope);
  if (cumulativeProfitLoss !== 0) {
    equity.lines.push({
      accountId: RETAINED_EARNINGS_BRIDGE_ACCOUNT_CODE,
      accountCode: RETAINED_EARNINGS_BRIDGE_ACCOUNT_CODE,
      accountName: RETAINED_EARNINGS_BRIDGE_LABEL,
      amount: cumulativeProfitLoss,
    });
    equity.total += cumulativeProfitLoss;
  }

  const totalAssets = assets.total;
  const totalLiabilities = liabilities.total;
  const totalEquity = equity.total;
  const balanceDifference = totalAssets - (totalLiabilities + totalEquity);
  const isBalanced = balanceDifference === 0;

  if (!isBalanced) {
    throw new BalanceSheetNotBalancedError(
      `Balance Sheet tidak seimbang: Assets (${totalAssets}) != Liabilities + Equity (${totalLiabilities + totalEquity}), selisih ${balanceDifference}. Ini mengindikasikan bug integritas data (jurnal tidak balanced di luar journal-service.ts), bukan kondisi laporan yang valid.`,
      totalAssets,
      totalLiabilities,
      totalEquity,
      balanceDifference,
    );
  }

  return {
    period: { fromDate, toDate },
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanceDifference,
    isBalanced,
  };
}
