import { isValidIsoDate } from "../../../lib/calendar-date.js";
import type { Knex } from "knex";
import { listAccounts, type AccountRow } from "../account-service.js";
import { getAccountBalanceBeforeDate } from "../ledger-service.js";
import { InvalidDateRangeError } from "./reporting-types.js";
import { applyBranchScope, type AuthorizedScope } from "../report-scope.js";

/**
 * Shared reporting logic (TASK-DB-ARCH-012 §16) -- SATU tempat utk
 * klasifikasi akun, filter status jurnal, dan perhitungan saldo, dipakai
 * SEMUA 4 service laporan supaya Ledger/Trial Balance/Reports konsisten.
 *
 * REUSE, bukan duplikasi: `getAccountBalanceBeforeDate` (ledger-service.ts,
 * TASK-DB-ARCH-011, TIDAK diubah) dipakai LANGSUNG utk "saldo akun
 * balance-sheet sebelum tanggal X" -- fungsi itu SUDAH benar (exclusive,
 * status POSTED+REVERSED, flow-account=0) dan sudah diuji.
 *
 * Satu-satunya hal yang DIDUPLIKASI SENGAJA (bukan di-reuse via export
 * baru dari ledger-service.ts): daftar kode account_type "flow"
 * (`FLOW_ACCOUNT_TYPE_CODES`). Instruksi TASK-DB-ARCH-012 §2 melarang
 * mengubah `ledger-service.ts`/`trial-balance-service.ts` "hanya untuk
 * mempermudah reporting" -- meng-export helper privat di sana (walau
 * trivial) termasuk "mengubah utk reporting". Duplikasi ini AMAN krn
 * sumber datanya (`account_types.code`) satu-satunya, kedua tempat query
 * persis sama, tidak ada risiko drift NILAI, hanya duplikasi BARIS KODE.
 */

export const FLOW_ACCOUNT_TYPE_CODES = new Set(["REVENUE", "EXPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"]);

const INCOME_LIKE_TYPE_CODES = new Set(["REVENUE", "OTHER_INCOME"]);

/**
 * Kontribusi tipe akun flow thd LABA/RUGI (bukan thd "arah normalnya
 * sendiri"). `getFlowAccountCumulativeTotal`/`signedAmount` mengembalikan
 * angka POSITIF saat movement searah `normal_balance` AKUN ITU SENDIRI --
 * utk REVENUE/OTHER_INCOME (normal credit) itu MEMANG menambah laba, tapi
 * utk COGS/EXPENSE/OTHER_EXPENSE (normal debit) arah normalnya adalah
 * "besar beban", yang MENGURANGI laba, bukan menambah. Dipakai di
 * balance-sheet-service.ts (bridge Retained Earnings) & equity-statement-
 * service.ts (opening equity bridge) supaya TIDAK mengulang bug "expense
 * positif malah menambah equity" -- income-statement-service.ts sendiri
 * sudah benar krn formula grossProfit/operatingProfit/netProfit SECARA
 * EKSPLISIT mengurangkan cogs/operatingExpenses/otherExpense (bukan
 * menjumlahkan membabi buta), jadi tidak butuh fungsi ini.
 */
export function profitContributionSign(accountTypeCode: string): 1 | -1 {
  return INCOME_LIKE_TYPE_CODES.has(accountTypeCode) ? 1 : -1;
}

const STATUS_INCLUDED_IN_REPORTS = ["POSTED", "REVERSED"] as const; // §3: DRAFT & VOID EXCLUDED

export function validateDateRange(fromDate: string, toDate: string): void {
  if (!fromDate) throw new InvalidDateRangeError("fromDate wajib diisi.");
  if (!toDate) throw new InvalidDateRangeError("toDate wajib diisi.");
  // Strict (UAT-003/004): hanya tanggal kalender nyata YYYY-MM-DD. Date.parse
  // dulu meloloskan "2025", "1/1/2025" dan menormalisasi 2025-02-30.
  if (!isValidIsoDate(fromDate)) throw new InvalidDateRangeError(`fromDate "${fromDate}" bukan tanggal yang valid (format YYYY-MM-DD).`);
  if (!isValidIsoDate(toDate)) throw new InvalidDateRangeError(`toDate "${toDate}" bukan tanggal yang valid (format YYYY-MM-DD).`);
  if (fromDate > toDate) throw new InvalidDateRangeError(`fromDate (${fromDate}) tidak boleh setelah toDate (${toDate}).`);
}

/** "YYYY-MM-DD" + 1 hari -- dipakai utk mengubah batas EXCLUSIVE
 * `getAccountBalanceBeforeDate` jadi efektif INCLUSIVE thd satu tanggal
 * tertentu (Balance Sheet/Cash Flow "as of toDate"), tanpa menambah
 * parameter/varian baru ke ledger-service.ts. */
export function dayAfter(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function getAccountType(db: Knex, accountTypeId: string): Promise<{ id: string; code: string } | undefined> {
  return db("account_types").where({ id: accountTypeId }).first();
}

export function isFlowTypeCode(code: string): boolean {
  return FLOW_ACCOUNT_TYPE_CODES.has(code);
}

export function signedAmount(normalBalance: "debit" | "credit", debit: number, credit: number): number {
  return normalBalance === "debit" ? debit - credit : credit - debit;
}

/** BUG NYATA (ditemukan dari data riil PT MIGAS WARDHANA, Okt 2026):
 * `signedAmount`/`getAccountBalance*` menandatangani saldo akun terhadap
 * `normal_balance` AKUN ITU SENDIRI -- itu BENAR utk Ledger/Trial Balance
 * (saldo natural akun itu apa adanya). TAPI saat baris-baris itu DIJUMLAH
 * jadi SATU total section (Balance Sheet Assets/Equity, Income Statement
 * Revenue/dst, RE-bridge, opening-equity bridge), kontra-akun (akun yang
 * SENGAJA `normal_balance`-nya BERLAWANAN dgn tipe induknya -- Akumulasi
 * Penyusutan/Amortisasi [tipe ASSET, normal_balance CREDIT], Dividen
 * Dibagikan [tipe EQUITY, normal_balance DEBIT], Retur & Potongan
 * Penjualan [tipe REVENUE, normal_balance DEBIT] -- SEMUA pola akuntansi
 * standar, bukan kasus aneh) jadi TERTAMBAH bukannya TERKURANG, krn
 * `signedAmount` akan mengembalikan angka POSITIF saat saldo kontra-akun
 * itu searah normal_balance-nya SENDIRI, padahal arah itu BERLAWANAN dgn
 * arah kanonis section-nya.
 *
 * Fix: sebelum menjumlahkan ke total section, re-tandatangani angka yg
 * SUDAH disign-by-own-normal-balance itu ke arah KANONIS tipe section-nya
 * (bukan arah akun itu sendiri) -- kalau beda, baliknya. Dibuktikan
 * menutup selisih Balance Sheet Rp 6.452.507.058 persis ke 0 pada data
 * riil (10 kontra-akun: 8 akumulasi penyusutan/amortisasi + dividen +
 * retur penjualan), lihat balance-sheet-service.test.ts/income-statement-
 * service.test.ts/equity-statement-service.test.ts utk regression test. */
export function toCanonicalSign(accountNormalBalance: "debit" | "credit", canonicalNormalBalance: "debit" | "credit", ownSignedAmount: number): number {
  return accountNormalBalance === canonicalNormalBalance ? ownSignedAmount : -ownSignedAmount;
}

/** Saldo akun (non-flow) INCLUSIVE sampai `asOfDate` -- reuse
 * `getAccountBalanceBeforeDate` lewat trik `dayAfter` (lihat komentar di
 * atas), BUKAN reimplementasi query. */
export async function getAccountBalanceAsOfInclusive(db: Knex, accountId: string, asOfDate: string, scope?: AuthorizedScope): Promise<number> {
  return getAccountBalanceBeforeDate(db, accountId, dayAfter(asOfDate), scope);
}

/** Movement SATU akun dalam rentang [fromDate, toDate] INCLUSIVE --
 * dipakai Income Statement (flow account, yang nilainya MEMANG hanya
 * movement periode, tidak punya "saldo") dan Cash Flow (identifikasi
 * pergerakan kas per entry). Query BARU (bukan duplikasi) -- period-based
 * query di ledger-service.ts TIDAK bisa dipakai krn butuh `periodId`,
 * sedangkan reporting butuh rentang tanggal arbitrary (§4). */
export async function getAccountMovementInRange(
  db: Knex,
  accountId: string,
  fromDate: string,
  toDate: string,
  scope?: AuthorizedScope,
): Promise<{ debit: number; credit: number }> {
  const movementQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .where("jel.account_id", accountId)
    .whereIn("je.status", STATUS_INCLUDED_IN_REPORTS)
    .andWhere("je.entry_date", ">=", fromDate)
    .andWhere("je.entry_date", "<=", toDate);
  const row = await applyBranchScope(movementQuery, scope)
    .select(db.raw("COALESCE(SUM(jel.debit), 0) as debitTotal"), db.raw("COALESCE(SUM(jel.credit), 0) as creditTotal"))
    .first();
  return { debit: Number((row as any)?.debitTotal ?? 0), credit: Number((row as any)?.creditTotal ?? 0) };
}

/** Total KUMULATIF (sejak baris jurnal PERTAMA yang pernah ada, bukan
 * sejak awal periode) akun FLOW, melalui `throughDate` INCLUSIVE --
 * BERBEDA dari konsep "opening balance" ledger-service.ts (yang SELALU 0
 * utk flow account, krn flow account reset tiap periode). Dipakai KHUSUS
 * utk menjembatani Balance Sheet/Equity Statement: akumulasi laba/rugi
 * SEJAK AWAL BERDIRI yang BELUM di-closing ke Retained Earnings (TERRA
 * tidak punya proses closing-ke-RE otomatis, §10 instruksi melarangnya)
 * -- lihat komentar panjang di balance-sheet-service.ts §"Current Period
 * Profit/Loss" ttg KENAPA ini diperlukan agar Assets = Liabilities + Equity
 * benar secara matematis. */
export async function getFlowAccountCumulativeTotal(
  db: Knex,
  accountId: string,
  normalBalance: "debit" | "credit",
  throughDate: string,
  inclusive: boolean = true,
  scope?: AuthorizedScope,
): Promise<number> {
  const cumulativeQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .where("jel.account_id", accountId)
    .whereIn("je.status", STATUS_INCLUDED_IN_REPORTS)
    .andWhere("je.entry_date", inclusive ? "<=" : "<", throughDate);
  const row = await applyBranchScope(cumulativeQuery, scope)
    .select(db.raw("COALESCE(SUM(jel.debit), 0) as debitTotal"), db.raw("COALESCE(SUM(jel.credit), 0) as creditTotal"))
    .first();
  return signedAmount(normalBalance, Number((row as any)?.debitTotal ?? 0), Number((row as any)?.creditTotal ?? 0));
}

export interface ClassifiedAccounts {
  byTypeCode: Map<string, AccountRow[]>;
  accountTypeCodeById: Map<string, string>;
  /** Arah normal KANONIS tiap kode tipe (dari `account_types.normal_balance`
   * -- SATU-SATUNYA sumber, bukan hardcode terpisah) -- dipakai `toCanonicalSign`
   * utk mengoreksi kontra-akun saat menjumlahkan total section, lihat
   * komentar panjang di `toCanonicalSign`. */
  typeNormalBalanceByCode: Map<string, "debit" | "credit">;
}

/** Satu query utk ambil SEMUA akun + tipe-nya, dipakai tiap service
 * laporan -- menghindari N query "cari tipe akun ini apa" per akun. */
export async function classifyAccounts(db: Knex): Promise<ClassifiedAccounts> {
  const accounts = await listAccounts(db);
  const accountTypes = await db("account_types").select("id", "code", "normal_balance");
  const codeByTypeId = new Map(accountTypes.map((t: any) => [t.id, t.code]));
  const typeNormalBalanceByCode = new Map<string, "debit" | "credit">(accountTypes.map((t: any) => [t.code, t.normal_balance]));

  const byTypeCode = new Map<string, AccountRow[]>();
  const accountTypeCodeById = new Map<string, string>();
  for (const account of accounts) {
    const code = codeByTypeId.get(account.accountTypeId) ?? "UNKNOWN";
    accountTypeCodeById.set(account.id, code);
    if (!byTypeCode.has(code)) byTypeCode.set(code, []);
    byTypeCode.get(code)!.push(account);
  }
  return { byTypeCode, accountTypeCodeById, typeNormalBalanceByCode };
}

/** Kode & label baris sintetis "laba (rugi) belum ditutup" -- SATU definisi
 * utk Neraca dan Trial Balance supaya keduanya memakai istilah yang sama. */
export const UNCLOSED_PROFIT_LOSS_CODE = "RE-BRIDGE";

/**
 * Laba (rugi) KUMULATIF seluruh akun flow sejak jurnal pertama sampai
 * `throughDate` (inclusive atau exclusive) yang belum ditutup ke Retained
 * Earnings. SATU-SATUNYA sumber angka ini: dipakai Neraca (s/d toDate,
 * inclusive) dan Trial Balance (sebelum awal periode, exclusive). Read-only;
 * tidak menulis jurnal apa pun. Positif = laba, negatif = rugi.
 */
export async function getCumulativeUnclosedProfitLoss(
  db: Knex,
  classified: Pick<ClassifiedAccounts, "byTypeCode" | "typeNormalBalanceByCode">,
  throughDate: string,
  inclusive: boolean,
  scope?: AuthorizedScope,
): Promise<number> {
  let cumulativeProfitLoss = 0;
  for (const code of FLOW_ACCOUNT_TYPE_CODES) {
    const sign = profitContributionSign(code);
    const canonicalNormal = classified.typeNormalBalanceByCode.get(code) ?? "credit";
    for (const account of classified.byTypeCode.get(code) ?? []) {
      const ownSigned = await getFlowAccountCumulativeTotal(db, account.id, account.normalBalance, throughDate, inclusive, scope);
      cumulativeProfitLoss += sign * toCanonicalSign(account.normalBalance, canonicalNormal, ownSigned);
    }
  }
  return cumulativeProfitLoss;
}
