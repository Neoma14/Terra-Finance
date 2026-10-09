import type {
  BalanceSheetReport,
  CashFlowReport,
  EquityStatementReport,
  FinancialReportSection,
  IncomeStatementReport,
} from "../../db/company/reporting/reporting-types.js";
import type { AccountLedgerResult } from "../../db/company/ledger-service.js";
import type { TrialBalanceResult } from "../../db/company/trial-balance-service.js";
import type { AuthorizedScope, ScopeLabel } from "../../db/company/report-scope.js";

/**
 * Model dokumen export (TASK-EXPORT). SATU bentuk tabel dibangun dari
 * hasil service laporan yang SAMA dengan yang dipakai UI -- Excel dan PDF
 * hanya merender ulang model ini. Tidak ada rumus baru di sini: setiap
 * angka diambil langsung dari field service (mis. `totalAssets`,
 * `netProfit`), tidak dihitung ulang.
 */

export const EXPORT_KINDS = ["balance-sheet", "income-statement", "equity", "cash-flow", "trial-balance", "ledger"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export type ExportFormat = "xlsx" | "pdf";

export interface DocColumn {
  header: string;
  width: number;
  align: "left" | "right";
  type: "text" | "number";
}

export type DocRowStyle = "section" | "line" | "subtotal" | "total" | "note";

export interface DocRow {
  style: DocRowStyle;
  cells: (string | number | null)[];
}

export interface ReportDocument {
  title: string;
  companyName: string;
  periodLabel: string;
  /** Label cakupan (Phase 5): judul + peringatan wajib untuk laporan per cabang/gabungan; null = seluruh perusahaan (perilaku lama). */
  scopeLabel: ScopeLabel | null;
  /** Bagian nama file tanpa ekstensi, sudah aman utk filesystem. */
  fileBase: string;
  columns: DocColumn[];
  rows: DocRow[];
}

const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** "2026-01-31" -> "31 Januari 2026". Tanpa zona waktu: tanggal ISO murni. */
export function formatLongDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MONTHS_ID[m - 1]} ${y}`;
}

export function formatPeriodRange(fromDate: string, toDate: string): string {
  // Aturan frontend (rules/frontend-05 bagian 9.G): tanda pisah en dash/em dash dilarang; rentang tanggal memakai tanda hubung biasa.
  return `${formatLongDate(fromDate)} - ${formatLongDate(toDate)}`;
}

/** Nama file aman: huruf/angka dipertahankan, selain itu jadi "-". */
export function slugForFileName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const REPORT_TITLES: Record<ExportKind, string> = {
  "balance-sheet": "Neraca (Balance Sheet)",
  "income-statement": "Laporan Laba Rugi (Income Statement)",
  equity: "Laporan Perubahan Ekuitas (Equity)",
  "cash-flow": "Laporan Arus Kas (Cash Flow)",
  "trial-balance": "Neraca Saldo (Trial Balance)",
  ledger: "Buku Besar (Ledger)",
};

const REPORT_FILE_LABELS: Record<ExportKind, string> = {
  "balance-sheet": "Neraca",
  "income-statement": "Laba-Rugi",
  equity: "Perubahan-Ekuitas",
  "cash-flow": "Arus-Kas",
  "trial-balance": "Neraca-Saldo",
  ledger: "Buku-Besar",
};

export function reportTitle(kind: ExportKind): string {
  return REPORT_TITLES[kind];
}

/** Pola nama file: `PT-ABDI-WARDHANA-Neraca-2026-01-01-2026-01-31`. */
export function buildFileBase(companyName: string, kind: ExportKind, fromDate: string, toDate: string, ledgerCode?: string): string {
  const parts = [slugForFileName(companyName), REPORT_FILE_LABELS[kind]];
  if (kind === "ledger" && ledgerCode) parts.push(slugForFileName(ledgerCode));
  parts.push(fromDate, toDate);
  return parts.join("-");
}

/**
 * Label cakupan untuk dokumen dan nama file (Phase 5). Cakupan seluruh perusahaan (flag OFF) tidak diberi label sehingga
 * dokumen dan nama file identik dengan sebelum Phase 5. Gabungan SELALU memuat "Belum-Dieliminasi" di nama file.
 */
export function scopeLabelFor(scope: AuthorizedScope | undefined): ScopeLabel | null {
  if (!scope || scope.mode === "COMPANY") return null;
  return scope.label;
}
export function scopeFileSuffix(scope: AuthorizedScope | undefined): string {
  if (!scope || scope.mode === "COMPANY") return "";
  if (scope.mode === "SINGLE") return `-Cabang-${slugForFileName(scope.branches[0]?.name ?? "Cabang")}`;
  if (scope.mode === "COMBINED_ALL") return "-Gabungan-Seluruh-Cabang-Belum-Dieliminasi";
  return "-Gabungan-Cabang-Terpilih-Belum-Dieliminasi";
}

const SECTION_COLUMNS: DocColumn[] = [
  { header: "Kode", width: 14, align: "left", type: "text" },
  { header: "Nama Akun", width: 60, align: "left", type: "text" },
  { header: "Jumlah (IDR)", width: 26, align: "right", type: "number" },
];

function pushSection(rows: DocRow[], section: FinancialReportSection) {
  rows.push({ style: "section", cells: [null, section.label, null] });
  if (section.lines.length === 0) {
    rows.push({ style: "note", cells: [null, "Tidak ada saldo.", null] });
  }
  for (const line of section.lines) {
    rows.push({ style: "line", cells: [line.accountCode, line.accountName, line.amount] });
  }
  rows.push({ style: "subtotal", cells: [null, `Total ${section.label}`, section.total] });
}

function pushAmount(rows: DocRow[], style: DocRowStyle, label: string, amount: number) {
  rows.push({ style, cells: [null, label, amount] });
}

export function balanceSheetDocument(report: BalanceSheetReport, base: Omit<ReportDocument, "columns" | "rows" | "title">): ReportDocument {
  const rows: DocRow[] = [];
  pushSection(rows, report.assets);
  pushSection(rows, report.liabilities);
  pushSection(rows, report.equity);
  pushAmount(rows, "total", "Total Assets", report.totalAssets);
  pushAmount(rows, "total", "Total Liabilities + Equity", report.totalLiabilities + report.totalEquity);
  rows.push({
    style: "note",
    cells: [null, report.isBalanced ? "Status: BALANCED" : `Status: NOT BALANCED (selisih ${report.balanceDifference})`, null],
  });
  return { ...base, title: reportTitle("balance-sheet"), columns: SECTION_COLUMNS, rows };
}

export function incomeStatementDocument(report: IncomeStatementReport, base: Omit<ReportDocument, "columns" | "rows" | "title">): ReportDocument {
  const rows: DocRow[] = [];
  pushSection(rows, report.revenue);
  pushSection(rows, report.cogs);
  pushAmount(rows, "total", "Gross Profit", report.grossProfit);
  pushSection(rows, report.operatingExpenses);
  pushAmount(rows, "total", "Operating Profit", report.operatingProfit);
  pushSection(rows, report.otherIncome);
  pushSection(rows, report.otherExpense);
  pushAmount(rows, "total", "Net Profit / Loss", report.netProfit);
  return { ...base, title: reportTitle("income-statement"), columns: SECTION_COLUMNS, rows };
}

const SUMMARY_COLUMNS: DocColumn[] = [
  { header: "Keterangan", width: 74, align: "left", type: "text" },
  { header: "Jumlah (IDR)", width: 26, align: "right", type: "number" },
];

export function equityDocument(report: EquityStatementReport, base: Omit<ReportDocument, "columns" | "rows" | "title">): ReportDocument {
  const rows: DocRow[] = [
    { style: "line", cells: ["Opening Equity", report.openingEquity] },
    { style: "line", cells: ["Setoran Modal / Prive (gabungan)", report.additionalCapitalOrDrawings] },
    { style: "line", cells: ["Net Profit / Loss", report.netProfit] },
    { style: "total", cells: ["Closing Equity", report.closingEquity] },
  ];
  return { ...base, title: reportTitle("equity"), columns: SUMMARY_COLUMNS, rows };
}

export function cashFlowDocument(report: CashFlowReport, base: Omit<ReportDocument, "columns" | "rows" | "title">): ReportDocument {
  const rows: DocRow[] = [
    { style: "line", cells: [report.operating.label, report.operating.amount] },
    { style: "line", cells: [report.investing.label, report.investing.amount] },
    { style: "line", cells: [report.financing.label, report.financing.amount] },
  ];
  if (report.unclassifiedAmount !== 0) {
    rows.push({ style: "line", cells: ["Belum Terklasifikasi", report.unclassifiedAmount] });
  }
  rows.push({ style: "total", cells: ["Net Change in Cash", report.netChangeInCash] });
  rows.push({ style: "line", cells: ["Beginning Cash", report.beginningCash] });
  rows.push({ style: "total", cells: ["Ending Cash", report.endingCash] });
  return { ...base, title: reportTitle("cash-flow"), columns: SUMMARY_COLUMNS, rows };
}

const TRIAL_COLUMNS: DocColumn[] = [
  { header: "Kode", width: 14, align: "left", type: "text" },
  { header: "Nama Akun", width: 46, align: "left", type: "text" },
  { header: "Debit (IDR)", width: 20, align: "right", type: "number" },
  { header: "Kredit (IDR)", width: 20, align: "right", type: "number" },
];

export function trialBalanceDocument(result: TrialBalanceResult, base: Omit<ReportDocument, "columns" | "rows" | "title">): ReportDocument {
  const rows: DocRow[] = result.rows.map((r) => ({ style: "line", cells: [r.code, r.name, r.debit, r.credit] }));
  rows.push({ style: "total", cells: [null, "Total", result.totalDebit, result.totalCredit] });
  rows.push({
    style: "note",
    cells: [null, result.isBalanced ? "Status: BALANCED" : `Status: NOT BALANCED (selisih ${result.difference})`, null, null],
  });
  return { ...base, title: reportTitle("trial-balance"), columns: TRIAL_COLUMNS, rows };
}

const LEDGER_COLUMNS: DocColumn[] = [
  { header: "Tanggal", width: 14, align: "left", type: "text" },
  { header: "No. Referensi", width: 20, align: "left", type: "text" },
  { header: "Keterangan", width: 34, align: "left", type: "text" },
  { header: "Debit (IDR)", width: 16, align: "right", type: "number" },
  { header: "Kredit (IDR)", width: 16, align: "right", type: "number" },
  { header: "Saldo (IDR)", width: 18, align: "right", type: "number" },
];

export function ledgerDocument(
  result: AccountLedgerResult,
  account: { code: string; name: string },
  base: Omit<ReportDocument, "columns" | "rows" | "title">,
): ReportDocument {
  const rows: DocRow[] = [
    { style: "subtotal", cells: [null, null, "Saldo Awal", null, null, result.openingBalance] },
  ];
  for (const line of result.lines) {
    rows.push({
      style: "line",
      cells: [line.entryDate, line.referenceNo ?? "", line.memo ?? "", line.debit, line.credit, line.runningBalance],
    });
  }
  rows.push({ style: "total", cells: [null, null, "Saldo Akhir", null, null, result.endingBalance] });
  return {
    ...base,
    title: `${reportTitle("ledger")}: ${account.code} - ${account.name}`,
    columns: LEDGER_COLUMNS,
    rows,
  };
}
