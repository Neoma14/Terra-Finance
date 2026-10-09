import type { IndustryTemplate, RatioFormat } from "@konsultan/shared";

export interface RatioContext {
  balances: Map<string, number>;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  netIncome: number;
  totalRevenue: number;
}

export interface RatioDefinition {
  code: string;
  label: string;
  format: RatioFormat;
  note?: string;
  compute: (ctx: RatioContext) => number;
}

function b(ctx: RatioContext, code: string): number {
  return ctx.balances.get(code) ?? 0;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

/**
 * Rasio DIBEDAKAN per template industri (bukan satu set generik) karena
 * makna & rumusnya memang berbeda secara fundamental -- rasio korporat
 * biasa (current ratio, debt-to-equity) tidak relevan untuk bank (yang
 * pakai LDR/NIM) atau koperasi (yang pakai rasio SHU terhadap simpanan
 * anggota). Kode akun yang dirujuk di sini HARUS sinkron dengan
 * modules/companies/templates/*.ts.
 */
const GENERAL_RATIOS: RatioDefinition[] = [
  {
    code: "current_ratio",
    label: "Rasio Lancar (Current Ratio)",
    format: "times",
    compute: (ctx) => safeDiv(b(ctx, "1100") + b(ctx, "1200") + b(ctx, "1300"), b(ctx, "2100") + b(ctx, "2200")),
  },
  { code: "debt_to_equity", label: "Debt to Equity Ratio", format: "times", compute: (ctx) => safeDiv(ctx.totalLiabilities, ctx.totalEquity) },
  { code: "debt_ratio", label: "Rasio Utang terhadap Aset", format: "percent", compute: (ctx) => safeDiv(ctx.totalLiabilities, ctx.totalAssets) },
  { code: "net_margin", label: "Margin Laba Bersih", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalRevenue) },
  { code: "roa", label: "Return on Assets (ROA)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalAssets) },
  { code: "roe", label: "Return on Equity (ROE)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalEquity) },
  { code: "asset_turnover", label: "Perputaran Aset", format: "times", compute: (ctx) => safeDiv(ctx.totalRevenue, ctx.totalAssets) },
];

const HOSPITAL_RATIOS: RatioDefinition[] = [
  {
    code: "current_ratio",
    label: "Rasio Lancar (Current Ratio)",
    format: "times",
    compute: (ctx) => safeDiv(b(ctx, "1100") + b(ctx, "1200") + b(ctx, "1300"), b(ctx, "2100") + b(ctx, "2200")),
  },
  { code: "debt_to_equity", label: "Debt to Equity Ratio", format: "times", compute: (ctx) => safeDiv(ctx.totalLiabilities, ctx.totalEquity) },
  { code: "net_margin", label: "Margin Laba Bersih", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalRevenue) },
  { code: "roa", label: "Return on Assets (ROA)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalAssets) },
  { code: "roe", label: "Return on Equity (ROE)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalEquity) },
  {
    code: "days_receivable",
    label: "Rata-rata Umur Piutang (hari)",
    format: "ratio",
    note: "Piutang Pasien & BPJS/Asuransi dibagi pendapatan tahunan x 365 -- indikator kecepatan klaim cair.",
    compute: (ctx) => safeDiv(b(ctx, "1200"), ctx.totalRevenue) * 365,
  },
];

const BANKING_RATIOS: RatioDefinition[] = [
  {
    code: "ldr",
    label: "Loan to Deposit Ratio (LDR)",
    format: "percent",
    compute: (ctx) => safeDiv(b(ctx, "1400"), b(ctx, "2100") + b(ctx, "2200") + b(ctx, "2300")),
  },
  {
    code: "nim",
    label: "Net Interest Margin (NIM)",
    format: "percent",
    note: "Disederhanakan: pembagi memakai saldo Kredit akhir periode, bukan rata-rata aset produktif seperti NIM baku.",
    compute: (ctx) => safeDiv(b(ctx, "4100") - b(ctx, "5100"), b(ctx, "1400")),
  },
  {
    code: "capital_ratio",
    label: "Rasio Modal terhadap Aset",
    format: "percent",
    note: "Proksi sederhana, BUKAN CAR (Capital Adequacy Ratio) sesungguhnya yang memakai ATMR (aset tertimbang menurut risiko).",
    compute: (ctx) => safeDiv(ctx.totalEquity, ctx.totalAssets),
  },
  { code: "roa", label: "Return on Assets (ROA)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalAssets) },
  { code: "roe", label: "Return on Equity (ROE)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalEquity) },
  {
    code: "cost_to_income",
    label: "Cost to Income Ratio (BOPO)",
    format: "percent",
    compute: (ctx) => safeDiv(b(ctx, "5100") + b(ctx, "5200"), b(ctx, "4100") + b(ctx, "4200")),
  },
];

const COOPERATIVE_RATIOS: RatioDefinition[] = [
  {
    code: "current_ratio",
    label: "Rasio Lancar (Current Ratio)",
    format: "times",
    compute: (ctx) => safeDiv(b(ctx, "1100"), b(ctx, "2100") + b(ctx, "2200")),
  },
  {
    code: "shu_to_member_equity",
    label: "Rasio SHU terhadap Simpanan Anggota",
    format: "percent",
    compute: (ctx) => safeDiv(ctx.netIncome, b(ctx, "3100") + b(ctx, "3200")),
  },
  {
    code: "self_capital_ratio",
    label: "Rasio Modal Sendiri terhadap Aset",
    format: "percent",
    compute: (ctx) => safeDiv(b(ctx, "3100") + b(ctx, "3200") + b(ctx, "3300"), ctx.totalAssets),
  },
  { code: "roa", label: "Return on Assets (ROA)", format: "percent", compute: (ctx) => safeDiv(ctx.netIncome, ctx.totalAssets) },
  {
    code: "loan_to_asset",
    label: "Porsi Piutang Pinjaman Anggota terhadap Aset",
    format: "percent",
    compute: (ctx) => safeDiv(b(ctx, "1200"), ctx.totalAssets),
  },
];

export const RATIO_TEMPLATES: Record<IndustryTemplate, RatioDefinition[]> = {
  general: GENERAL_RATIOS,
  hospital: HOSPITAL_RATIOS,
  banking: BANKING_RATIOS,
  cooperative: COOPERATIVE_RATIOS,
};
