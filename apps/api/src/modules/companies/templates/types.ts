import type { AccountType, CashFlowActivity, NormalBalance } from "@konsultan/shared";
import type { IndustryTemplate } from "@konsultan/shared";

export interface TemplateAccount {
  code: string;
  name: string;
  accountType: AccountType;
  accountSubtype: string;
  normalBalance: NormalBalance;
  statementType: "balance_sheet" | "income_statement";
  lineCode: string;
  lineLabel: string;
  /** Kosongkan untuk akun Kas, akun revenue/expense, dan akun retained
   * earnings/SHU (pergerakannya sudah terwakili lewat Net Income). */
  cashFlowActivity?: CashFlowActivity;
  isCash?: boolean;
  /** Tandai akun kontrol AP/AR untuk Kartu Hutang/Piutang (lihat
   * modules/subledger). Kosongkan untuk akun yang bukan kontrol AP/AR. */
  subledgerType?: "payable" | "receivable";
}

export interface ChartOfAccountsTemplate {
  key: IndustryTemplate;
  accounts: TemplateAccount[];
  /** Satu-satunya akun ekuitas yang dijadikan "plug" penyeimbang Neraca saat
   * generate data contoh (lihat modules/statements/sample-data.ts) --
   * account lain (termasuk akun ekuitas lain kalau ada lebih dari 2, mis.
   * koperasi) harus diberi target eksplisit. */
  balancingAccountCode: string;
  /** Akun laba ditahan / SHU -- saldo akhirnya SELALU dihitung otomatis
   * sebagai saldo awal + Net Income periode berjalan (tidak boleh diberi
   * target manual di sample data). */
  retainedEarningsAccountCode: string;
}
