export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";
export type StatementType = "balance_sheet" | "income_statement" | "cash_flow";

export type CashFlowActivity = "operating" | "investing" | "financing";

export interface Account {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  accountSubtype: string | null;
  normalBalance: NormalBalance;
  parentAccountId: string | null;
  isActive: boolean;
  cashFlowActivity: CashFlowActivity | null;
  isCash: boolean;
  subledgerType: "payable" | "receivable" | null;
  /** Baris laporan (Neraca/Laba-Rugi) tempat akun ini di-total-kan --
   * null hanya untuk akun yang belum sempat ditautkan (seharusnya tidak
   * pernah terjadi, lihat statement-line-fallback.ts). Dipakai halaman
   * Pengaturan > Mapping Akun. */
  statementLineId: string | null;
  statementLineCode: string | null;
  statementLineLabel: string | null;
}

// ---- Import Chart of Accounts + Saldo Awal dari Excel ----
// (fitur BARU, tidak ada di versi online -- konsultan yg pindah dari
// software lama sering sudah punya daftar akun+saldo lengkap sendiri,
// jadi lebih cepat diimpor sekaligus drpd input manual satu-satu lewat
// modal "Tambah Akun".)

export interface ParsedAccountRow {
  rowNumber: number;
  code: string;
  name: string;
  accountType: string; // divalidasi & dinormalisasi di preview (raw dari Excel)
  accountSubtype: string;
  normalBalance: string; // raw, divalidasi jadi "debit"|"credit" di preview
  cashFlowActivity: string; // raw, opsional
  isCash: boolean;
  subledgerType: string; // raw, opsional ("payable"|"receivable"|"")
  openingBalance: number; // 0 kalau tidak diisi
  errors: string[];
  /** true kalau kode ini SUDAH ADA di Chart of Accounts perusahaan --
   * BUKAN error, baris ini otomatis DILEWATI saat commit (tidak menimpa
   * akun yang sudah ada), sama seperti pola "alreadyExists" di import jurnal. */
  alreadyExists: boolean;
}

export interface AccountsImportPreviewResult {
  rows: ParsedAccountRow[];
  fileErrors: string[];
  /** Tanggal saldo awal (satu tanggal berlaku utk SEMUA baris yang punya
   * openingBalance > 0 dalam file ini) -- dibaca dari sel metadata di
   * template, null kalau tidak ada/tidak valid. */
  openingDate: string | null;
  /** true kalau semua baris BARU (blm ada di DB) valid (tanpa error) DAN
   * openingDate terisi kalau ada baris dgn saldo awal > 0. */
  allValid: boolean;
}

export interface AccountsImportCommitRow {
  code: string;
  name: string;
  accountType: AccountType;
  accountSubtype: string;
  normalBalance: NormalBalance;
  cashFlowActivity?: CashFlowActivity;
  isCash?: boolean;
  subledgerType?: "payable" | "receivable" | null;
  openingBalance?: number;
}

export interface AccountsImportCommitInput {
  /** Wajib diisi kalau ADA baris dgn openingBalance > 0. */
  openingDate?: string;
  rows: AccountsImportCommitRow[];
}

export interface StatementLineOption {
  id: string;
  statementType: StatementType;
  lineCode: string;
  lineLabel: string;
  displayOrder: number;
}

export interface Period {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  periodType: "month" | "quarter" | "year";
  fiscalYear: number;
  isClosed: boolean;
}

export interface StatementLineAccountBreakdown {
  code: string;
  name: string;
  amount: number;
}

export interface StatementLineValue {
  lineCode: string;
  lineLabel: string;
  amount: number;
  displayOrder: number;
  parentLineId: string | null;
  /** Rincian sub-akun yang menyusun baris ini -- terutama penting utk baris
   * "tampungan" (mis. "Aset Lainnya (dari Import)") yang menggabungkan
   * banyak akun berbeda jadi satu total, supaya tetap terlihat akun apa
   * saja isinya, bukan cuma angka gabungan. */
  accounts: StatementLineAccountBreakdown[];
}

export interface StatementResult {
  statementType: StatementType;
  periodId: string;
  periodLabel: string;
  lines: StatementLineValue[];
  generatedAt: string;
}

export interface FinancialTrendPoint {
  periodId: string;
  periodLabel: string;
  periodEndDate: string;
  revenue: number;
  netIncome: number;
  totalAssets: number;
  cash: number;
}

export interface CashFlowResult {
  periodId: string;
  periodLabel: string;
  priorPeriodId: string | null;
  netIncome: number;
  operatingActivities: number;
  investingActivities: number;
  financingActivities: number;
  netChangeInCash: number;
  beginningCash: number;
  endingCash: number;
  generatedAt: string;
}

export interface EquityStatementLine {
  accountId: string;
  code: string;
  name: string;
  beginningBalance: number;
  endingBalance: number;
  delta: number;
}

export interface EquityStatementResult {
  periodId: string;
  periodLabel: string;
  priorPeriodId: string | null;
  lines: EquityStatementLine[];
  totalBeginning: number;
  netIncome: number;
  totalEnding: number;
  generatedAt: string;
}
