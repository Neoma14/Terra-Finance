import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import type { CashFlowDetailResult, CashFlowResult, EquityStatementResult, StatementLineValue, StatementResult } from "@konsultan/shared";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
/** Tint hijau lebih pekat dari BAND, dipakai sub-jumlah kelompok Neraca
 * (mis. "Total Aset Lancar") -- hierarki warna tint sedang -> charcoal
 * solid, bukan sekadar dekorasi. */
const BAND_STRONG = "FFCFE3F0";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";
const GREEN = "FF3CB371";
const NUM_FMT = "#,##0;(#,##0)";
const SIDEBAR_COL_WIDTH = 26;

const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/terra-logo.png");

function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

interface SidebarInfo {
  companyName: string;
  reportTitle: string;
  periodLabel: string;
  preparedBy: string;
  highlights: string[];
}

/**
 * Sidebar charcoal solid di kolom A + identitas TERRA (logo, nama, warna
 * brand) -- sama persis logikanya dgn versi online.
 */
function addSidebar(sheet: ExcelJS.Worksheet, logoImageId: number | null, info: SidebarInfo, totalRows: number) {
  for (let r = 1; r <= totalRows; r++) {
    sheet.getCell(r, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  }

  if (logoImageId !== null) {
    sheet.addImage(logoImageId, { tl: { col: 0.15, row: 0.3 }, ext: { width: 34, height: 34 } });
  }
  sheet.getCell(3, 1).value = "TERRA FINANCE";
  sheet.getCell(3, 1).font = { bold: true, size: 12, color: { argb: WHITE } };

  sheet.getCell(5, 1).value = info.companyName;
  sheet.getCell(5, 1).font = { bold: true, size: 11, color: { argb: WHITE } };
  sheet.getCell(5, 1).alignment = { wrapText: true, vertical: "top" };
  sheet.mergeCells(5, 1, 6, 1);

  sheet.getCell(8, 1).value = info.reportTitle.toUpperCase();
  sheet.getCell(8, 1).font = { bold: true, size: 9, color: { argb: GREEN } };
  sheet.getCell(9, 1).value = `Periode: ${info.periodLabel}`;
  sheet.getCell(9, 1).font = { size: 9, color: { argb: WHITE } };

  let row = 12;
  if (info.highlights.length > 0) {
    sheet.getCell(row, 1).value = "KEY HIGHLIGHTS";
    sheet.getCell(row, 1).font = { bold: true, size: 9, color: { argb: GREEN } };
    row += 1;
    for (const h of info.highlights) {
      sheet.getCell(row, 1).value = `•  ${h}`;
      sheet.getCell(row, 1).font = { size: 9, color: { argb: WHITE } };
      sheet.getCell(row, 1).alignment = { wrapText: true, vertical: "top" };
      row += 1;
    }
    row += 1;
  }

  sheet.getCell(row, 1).value = "PREPARED BY";
  sheet.getCell(row, 1).font = { bold: true, size: 9, color: { argb: GREEN } };
  row += 1;
  sheet.getCell(row, 1).value = info.preparedBy;
  sheet.getCell(row, 1).font = { size: 9, color: { argb: WHITE } };
  row += 1;
  sheet.getCell(row, 1).value = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
  sheet.getCell(row, 1).font = { size: 8, color: { argb: "FFB7C5D8" } };
}

function addContentHeader(sheet: ExcelJS.Worksheet, title: string, periodLabel: string, priorPeriodLabel: string | null) {
  sheet.getCell(1, 2).value = title;
  sheet.getCell(1, 2).font = { bold: true, size: 16, color: { argb: NAVY } };
  sheet.getCell(2, 2).value = priorPeriodLabel ? `${periodLabel} vs ${priorPeriodLabel}` : `Untuk Periode ${periodLabel}`;
  sheet.getCell(2, 2).font = { size: 10, color: { argb: MUTED } };
  sheet.getCell(3, 2).value = "Seluruh nilai dalam Rupiah (Rp)";
  sheet.getCell(3, 2).font = { size: 9, italic: true, color: { argb: MUTED } };
}

function styleHeaderRow(row: ExcelJS.Row, fromCol: number, toCol: number) {
  row.font = { bold: true, color: { argb: NAVY } };
  for (let c = fromCol; c <= toCol; c++) {
    row.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };
  }
}

function styleBandRow(row: ExcelJS.Row, fromCol: number, toCol: number) {
  row.font = { bold: true };
  for (let c = fromCol; c <= toCol; c++) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
  }
}

function styleTotalRow(row: ExcelJS.Row, fromCol: number, toCol: number) {
  for (let c = fromCol; c <= toCol; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.font = { bold: true, color: { argb: WHITE } };
  }
}

function styleStrongBandRow(row: ExcelJS.Row, fromCol: number, toCol: number) {
  row.font = { bold: true };
  for (let c = fromCol; c <= toCol; c++) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND_STRONG } };
  }
}

function styleSectionBand(row: ExcelJS.Row, fromCol: number, toCol: number) {
  for (let c = fromCol; c <= toCol; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.font = { bold: true, color: { argb: WHITE } };
  }
}

function addFooter(sheet: ExcelJS.Worksheet, row: number, fromCol: number, toCol: number) {
  sheet.mergeCells(row, fromCol, row, toCol);
  const cell = sheet.getCell(row, fromCol);
  cell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  cell.font = { size: 8, italic: true, color: { argb: MUTED } };
}

/** Satu baris data comparative: label, nilai periode ini, nilai periode
 * lalu (opsional), %perubahan (dihitung otomatis dari keduanya). */
function writeCompareRow(sheet: ExcelJS.Worksheet, row: number, label: string, current: number, prior: number | null) {
  const c2 = 2; // kolom "Pos" = B
  sheet.getCell(row, c2).value = label;
  sheet.getCell(row, c2 + 1).value = current;
  sheet.getCell(row, c2 + 1).numFmt = NUM_FMT;
  if (prior !== null) {
    sheet.getCell(row, c2 + 2).value = prior;
    sheet.getCell(row, c2 + 2).numFmt = NUM_FMT;
    const change = pctChange(current, prior);
    sheet.getCell(row, c2 + 3).value = change === null ? "-" : change;
    if (change !== null) sheet.getCell(row, c2 + 3).numFmt = "+0.0%;-0.0%";
  }
}

function splitBalanceSheet(lines: StatementLineValue[]) {
  const assetLines = lines.filter((l) => l.lineCode.startsWith("a_") || l.lineCode.startsWith("ca_") || l.lineCode.startsWith("fa_"));
  const liabEquityLines = lines.filter((l) => !assetLines.includes(l));
  return { assetLines, liabEquityLines, totalAssets: assetLines.reduce((s, l) => s + l.amount, 0), totalLiabEquity: liabEquityLines.reduce((s, l) => s + l.amount, 0) };
}

interface BsLineGroup {
  label: string;
  lines: StatementLineValue[];
}

/** Sama persis dgn statement-table.tsx (frontend) -- Excel & tampilan layar
 * harus menampilkan pengelompokan yang identik. */
function groupAssetLines(lines: StatementLineValue[]): BsLineGroup[] {
  const current = lines.filter((l) => l.lineCode.startsWith("ca_"));
  const fixed = lines.filter((l) => l.lineCode.startsWith("fa_"));
  const other = lines.filter((l) => !current.includes(l) && !fixed.includes(l));
  const groups: BsLineGroup[] = [];
  if (current.length > 0) groups.push({ label: "Aset Lancar", lines: current });
  if (fixed.length > 0) groups.push({ label: "Aset Tetap", lines: fixed });
  if (other.length > 0) groups.push({ label: "Aset Lainnya", lines: other });
  return groups;
}

function groupLiabEquityLines(lines: StatementLineValue[]): BsLineGroup[] {
  const equity = lines.filter((l) => l.lineCode.startsWith("eq_"));
  const nonEquity = lines.filter((l) => !equity.includes(l));
  const current = nonEquity.filter((l) => l.lineCode.startsWith("cl_"));
  const longTerm = nonEquity.filter((l) => l.lineCode.startsWith("ll_"));
  const otherLiab = nonEquity.filter((l) => !current.includes(l) && !longTerm.includes(l));
  const groups: BsLineGroup[] = [];
  if (current.length > 0) groups.push({ label: "Liabilitas Lancar", lines: current });
  if (longTerm.length > 0) groups.push({ label: "Liabilitas Jangka Panjang", lines: longTerm });
  if (otherLiab.length > 0) groups.push({ label: "Liabilitas Lainnya", lines: otherLiab });
  if (equity.length > 0) groups.push({ label: "Modal", lines: equity });
  return groups;
}

function splitIncomeStatement(lines: StatementLineValue[]) {
  const revenueLines = lines.filter((l) => l.lineCode.startsWith("is_revenue"));
  const expenseLines = lines.filter((l) => !revenueLines.includes(l));
  return { revenueLines, expenseLines, totalRevenue: revenueLines.reduce((s, l) => s + l.amount, 0), totalExpense: expenseLines.reduce((s, l) => s + l.amount, 0) };
}

function amountByCode(lines: StatementLineValue[] | undefined, code: string): number | null {
  if (!lines) return null;
  return lines.find((l) => l.lineCode === code)?.amount ?? 0;
}

/** Sama seperti shouldShowBreakdown di frontend (components/statement-table.tsx)
 * -- rincian sub-akun hanya ditulis kalau memang >1 akun, atau 1 akun
 * dengan nama beda dari label baris. */
function shouldShowBreakdown(line: StatementLineValue): boolean {
  if (line.accounts.length > 1) return true;
  if (line.accounts.length === 1 && line.accounts[0].name !== line.lineLabel) return true;
  return false;
}

/** Baris rincian sub-akun di bawah satu baris pos laporan -- diindent,
 * italic & abu-abu supaya jelas ini rincian, bukan pos sejajar. */
function writeAccountBreakdownRows(sheet: ExcelJS.Worksheet, startRow: number, line: StatementLineValue): number {
  let row = startRow;
  if (!shouldShowBreakdown(line)) return row;
  for (const a of line.accounts) {
    const cell = sheet.getCell(row, 2);
    cell.value = `    ${a.code} - ${a.name}`;
    cell.font = { italic: true, size: 9, color: { argb: MUTED } };
    const valueCell = sheet.getCell(row, 3);
    valueCell.value = a.amount;
    valueCell.numFmt = NUM_FMT;
    valueCell.font = { italic: true, size: 9, color: { argb: MUTED } };
    row++;
  }
  return row;
}

function writeBalanceSheetSection(sheet: ExcelJS.Worksheet, startRow: number, lines: StatementLineValue[], priorLines?: StatementLineValue[]): number {
  const { assetLines, liabEquityLines, totalAssets, totalLiabEquity } = splitBalanceSheet(lines);
  const prior = priorLines ? splitBalanceSheet(priorLines) : null;
  const lastCol = priorLines ? 5 : 3;

  let row = startRow;
  sheet.mergeCells(row, 2, row, lastCol);
  sheet.getCell(row, 2).value = "ASET";
  styleSectionBand(sheet.getRow(row), 2, lastCol);
  row++;
  for (const group of groupAssetLines(assetLines)) {
    sheet.getCell(row, 2).value = group.label;
    sheet.getCell(row, 2).font = { bold: true, size: 9, color: { argb: NAVY } };
    row++;
    for (const line of group.lines) {
      writeCompareRow(sheet, row, line.lineLabel, line.amount, priorLines ? amountByCode(priorLines, line.lineCode) : null);
      row++;
      row = writeAccountBreakdownRows(sheet, row, line);
    }
    const groupTotal = group.lines.reduce((s, l) => s + l.amount, 0);
    const priorGroupTotal = priorLines ? group.lines.reduce((s, l) => s + (amountByCode(priorLines, l.lineCode) ?? 0), 0) : null;
    writeCompareRow(sheet, row, `Total ${group.label}`, groupTotal, priorGroupTotal);
    styleStrongBandRow(sheet.getRow(row), 2, lastCol);
    row++;
  }
  writeCompareRow(sheet, row, "Total Aset", totalAssets, prior ? prior.totalAssets : null);
  styleTotalRow(sheet.getRow(row), 2, lastCol);
  row += 2;

  sheet.mergeCells(row, 2, row, lastCol);
  sheet.getCell(row, 2).value = "LIABILITAS & EKUITAS";
  styleSectionBand(sheet.getRow(row), 2, lastCol);
  row++;
  for (const group of groupLiabEquityLines(liabEquityLines)) {
    sheet.getCell(row, 2).value = group.label;
    sheet.getCell(row, 2).font = { bold: true, size: 9, color: { argb: NAVY } };
    row++;
    for (const line of group.lines) {
      writeCompareRow(sheet, row, line.lineLabel, line.amount, priorLines ? amountByCode(priorLines, line.lineCode) : null);
      row++;
      row = writeAccountBreakdownRows(sheet, row, line);
    }
    const groupTotal = group.lines.reduce((s, l) => s + l.amount, 0);
    const priorGroupTotal = priorLines ? group.lines.reduce((s, l) => s + (amountByCode(priorLines, l.lineCode) ?? 0), 0) : null;
    writeCompareRow(sheet, row, `Total ${group.label}`, groupTotal, priorGroupTotal);
    styleStrongBandRow(sheet.getRow(row), 2, lastCol);
    row++;
  }
  writeCompareRow(sheet, row, "Total Liabilitas & Ekuitas", totalLiabEquity, prior ? prior.totalLiabEquity : null);
  styleTotalRow(sheet.getRow(row), 2, lastCol);
  row += 2;

  return row;
}

function writeIncomeStatementSection(sheet: ExcelJS.Worksheet, startRow: number, lines: StatementLineValue[], priorLines?: StatementLineValue[]): number {
  const { revenueLines, expenseLines, totalRevenue, totalExpense } = splitIncomeStatement(lines);
  const prior = priorLines ? splitIncomeStatement(priorLines) : null;
  const lastCol = priorLines ? 5 : 3;

  let row = startRow;
  sheet.getCell(row, 2).value = "PENDAPATAN";
  sheet.getCell(row, 2).font = { bold: true, color: { argb: NAVY } };
  row++;
  for (const line of revenueLines) {
    writeCompareRow(sheet, row, line.lineLabel, line.amount, priorLines ? amountByCode(priorLines, line.lineCode) : null);
    row++;
    row = writeAccountBreakdownRows(sheet, row, line);
  }
  writeCompareRow(sheet, row, "Total Pendapatan", totalRevenue, prior ? prior.totalRevenue : null);
  styleBandRow(sheet.getRow(row), 2, lastCol);
  row += 2;

  sheet.getCell(row, 2).value = "BEBAN";
  sheet.getCell(row, 2).font = { bold: true, color: { argb: NAVY } };
  row++;
  for (const line of expenseLines) {
    writeCompareRow(sheet, row, line.lineLabel, line.amount, priorLines ? amountByCode(priorLines, line.lineCode) : null);
    row++;
    row = writeAccountBreakdownRows(sheet, row, line);
  }
  writeCompareRow(sheet, row, "Total Beban", totalExpense, prior ? prior.totalExpense : null);
  styleBandRow(sheet.getRow(row), 2, lastCol);
  row += 2;

  writeCompareRow(sheet, row, "LABA BERSIH", totalRevenue - totalExpense, prior ? prior.totalRevenue - prior.totalExpense : null);
  styleTotalRow(sheet.getRow(row), 2, lastCol);
  row += 2;

  return row;
}

function growthHighlight(label: string, current: number, prior: number): string | null {
  const change = pctChange(current, prior);
  if (change === null) return null;
  const arrow = change >= 0 ? "Naik" : "Turun";
  return `${label} ${arrow} ${Math.abs(change * 100).toFixed(1)}%`;
}

/**
 * Export gabungan 4 laporan (Neraca, Laba Rugi, Perubahan Ekuitas, Arus
 * Kas) rentang tanggal bebas jadi satu file .xlsx multi-sheet -- sama
 * persis logikanya dgn versi online (angka diambil apa adanya dari
 * kalkulator yang sama dgn UI, bukan dihitung ulang), warna letterhead
 * disesuaikan brand charcoal/green TERRA.
 */
export async function buildStatementsWorkbook(
  companyName: string,
  periodLabel: string,
  data: {
    balanceSheet: StatementResult;
    incomeStatement: StatementResult;
    equityStatement: EquityStatementResult;
    cashFlow: CashFlowResult;
    cashFlowDetail?: CashFlowDetailResult;
    balanceSheetPrior: StatementResult | null;
    incomeStatementPrior: StatementResult | null;
    priorPeriodLabel: string | null;
    preparedBy: string;
  },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  let logoImageId: number | null = null;
  try {
    const logoBuffer = fs.readFileSync(LOGO_PATH);
    logoImageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
  } catch {
    logoImageId = null; // logo opsional -- laporan tetap valid tanpa gambar kalau file tidak ketemu.
  }

  const bsPrior = data.balanceSheetPrior?.lines;
  const isPrior = data.incomeStatementPrior?.lines;
  const bsCurrent = splitBalanceSheet(data.balanceSheet.lines);
  const bsPriorSplit = bsPrior ? splitBalanceSheet(bsPrior) : null;
  const isCurrent = splitIncomeStatement(data.incomeStatement.lines);
  const isPriorSplit = isPrior ? splitIncomeStatement(isPrior) : null;

  const highlights = [
    bsPriorSplit && growthHighlight("Total Aset", bsCurrent.totalAssets, bsPriorSplit.totalAssets),
    isPriorSplit && growthHighlight("Pendapatan", isCurrent.totalRevenue, isPriorSplit.totalRevenue),
    isPriorSplit &&
      growthHighlight(
        "Laba Bersih",
        isCurrent.totalRevenue - isCurrent.totalExpense,
        isPriorSplit.totalRevenue - isPriorSplit.totalExpense,
      ),
  ].filter((x): x is string => Boolean(x));

  // --- Neraca ---
  const bsSheet = workbook.addWorksheet("Neraca");
  const bsHeaderRow = bsSheet.getRow(4);
  bsHeaderRow.values = data.priorPeriodLabel
    ? [null, "Pos", periodLabel, data.priorPeriodLabel, "% Perubahan"]
    : [null, "Pos", "Jumlah (Rp)"];
  styleHeaderRow(bsHeaderRow, 2, data.priorPeriodLabel ? 5 : 3);
  addContentHeader(bsSheet, "LAPORAN POSISI KEUANGAN (NERACA)", periodLabel, data.priorPeriodLabel);
  const bsEndRow = writeBalanceSheetSection(bsSheet, 5, data.balanceSheet.lines, bsPrior);
  addFooter(bsSheet, bsEndRow, 2, data.priorPeriodLabel ? 5 : 3);
  addSidebar(bsSheet, logoImageId, { companyName, reportTitle: "Neraca", periodLabel, preparedBy: data.preparedBy, highlights }, bsEndRow);
  bsSheet.columns = [{ width: SIDEBAR_COL_WIDTH }, { width: 36 }, { width: 18 }, { width: 18 }, { width: 14 }];
  bsSheet.views = [{ showGridLines: false }];

  // --- Laba Rugi ---
  const isSheet = workbook.addWorksheet("Laba Rugi");
  const isHeaderRow = isSheet.getRow(4);
  isHeaderRow.values = data.priorPeriodLabel
    ? [null, "Pos", periodLabel, data.priorPeriodLabel, "% Perubahan"]
    : [null, "Pos", "Jumlah (Rp)"];
  styleHeaderRow(isHeaderRow, 2, data.priorPeriodLabel ? 5 : 3);
  addContentHeader(isSheet, "LAPORAN LABA RUGI", periodLabel, data.priorPeriodLabel);
  const isEndRow = writeIncomeStatementSection(isSheet, 5, data.incomeStatement.lines, isPrior);
  addFooter(isSheet, isEndRow, 2, data.priorPeriodLabel ? 5 : 3);
  addSidebar(isSheet, logoImageId, { companyName, reportTitle: "Laba Rugi", periodLabel, preparedBy: data.preparedBy, highlights }, isEndRow);
  isSheet.columns = [{ width: SIDEBAR_COL_WIDTH }, { width: 36 }, { width: 18 }, { width: 18 }, { width: 14 }];
  isSheet.views = [{ showGridLines: false }];

  // --- Perubahan Ekuitas ---
  const equitySheet = workbook.addWorksheet("Perubahan Ekuitas");
  addContentHeader(equitySheet, "LAPORAN PERUBAHAN EKUITAS", periodLabel, null);
  const equityHeader = equitySheet.getRow(4);
  equityHeader.values = [null, "Akun", "Saldo Awal", "Saldo Akhir", "Perubahan"];
  styleHeaderRow(equityHeader, 2, 5);
  data.equityStatement.lines.forEach((line, i) => {
    const row = equitySheet.getRow(5 + i);
    row.values = [null, `${line.code} - ${line.name}`, line.beginningBalance, line.endingBalance, line.delta];
    row.getCell(3).numFmt = NUM_FMT;
    row.getCell(4).numFmt = NUM_FMT;
    row.getCell(5).numFmt = NUM_FMT;
  });
  const equityTotalRowNum = 5 + data.equityStatement.lines.length;
  const equityTotalRow = equitySheet.getRow(equityTotalRowNum);
  equityTotalRow.values = [
    null,
    "Total Ekuitas",
    data.equityStatement.totalBeginning,
    data.equityStatement.totalEnding,
    data.equityStatement.totalEnding - data.equityStatement.totalBeginning,
  ];
  equityTotalRow.getCell(3).numFmt = NUM_FMT;
  equityTotalRow.getCell(4).numFmt = NUM_FMT;
  equityTotalRow.getCell(5).numFmt = NUM_FMT;
  styleTotalRow(equityTotalRow, 2, 5);
  const netIncomeRow = equitySheet.getRow(equityTotalRowNum + 1);
  netIncomeRow.values = [null, "Laba bersih periode berjalan (info, sudah termasuk di atas)", null, null, data.equityStatement.netIncome];
  netIncomeRow.getCell(2).font = { italic: true, size: 9, color: { argb: MUTED } };
  netIncomeRow.getCell(5).numFmt = NUM_FMT;
  netIncomeRow.getCell(5).font = { italic: true, size: 9, color: { argb: MUTED } };
  addFooter(equitySheet, equityTotalRowNum + 3, 2, 5);
  addSidebar(equitySheet, logoImageId, { companyName, reportTitle: "Perubahan Ekuitas", periodLabel, preparedBy: data.preparedBy, highlights }, equityTotalRowNum + 3);
  equitySheet.columns = [{ width: SIDEBAR_COL_WIDTH }, { width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }];
  equitySheet.views = [{ showGridLines: false }];

  // --- Arus Kas -- RINCI per-akun (bukan cuma 3 angka lump-sum), daftar
  // akunnya otomatis menyesuaikan jenis usaha karena diambil langsung dari
  // akun cash_flow_activity milik masing-masing perusahaan. Akun tanpa
  // mutasi (delta 0) disembunyikan. ---
  const cfSheet = workbook.addWorksheet("Arus Kas");
  addContentHeader(cfSheet, "LAPORAN ARUS KAS (METODE TIDAK LANGSUNG)", periodLabel, null);
  const cfHeader = cfSheet.getRow(4);
  cfHeader.values = [null, "Pos", "Jumlah (Rp)"];
  styleHeaderRow(cfHeader, 2, 3);

  const detail = data.cashFlowDetail;
  const operating = (detail?.operating ?? []).filter((a) => a.delta !== 0);
  const investing = (detail?.investing ?? []).filter((a) => a.delta !== 0);
  const financing = (detail?.financing ?? []).filter((a) => a.delta !== 0);

  let cfRowNum = 5;
  function sectionHeader(label: string) {
    const row = cfSheet.getRow(cfRowNum++);
    row.values = [null, label];
    cfSheet.mergeCells(row.number, 2, row.number, 3);
    styleTotalRow(row, 2, 3);
  }
  function itemRow(label: string, amount: number, indent = true) {
    const row = cfSheet.getRow(cfRowNum++);
    row.values = [null, indent ? `   ${label}` : label, amount];
    row.getCell(3).numFmt = NUM_FMT;
  }
  function subtotalRow(label: string, amount: number) {
    const row = cfSheet.getRow(cfRowNum++);
    row.values = [null, label, amount];
    row.getCell(3).numFmt = NUM_FMT;
    styleBandRow(row, 2, 3);
  }

  sectionHeader("Arus Kas dari Aktivitas Operasi");
  itemRow("Laba Bersih", data.cashFlow.netIncome, false);
  if (operating.length > 0) {
    const row = cfSheet.getRow(cfRowNum++);
    row.values = [null, "Penyesuaian untuk:"];
    row.font = { italic: true, size: 9, color: { argb: MUTED } };
  }
  for (const a of operating) itemRow(a.name, a.contribution);
  subtotalRow("Arus Kas Neto dari Aktivitas Operasi", data.cashFlow.operatingActivities);

  sectionHeader("Arus Kas dari Aktivitas Investasi");
  if (investing.length === 0) itemRow("Tidak ada mutasi", 0);
  else for (const a of investing) itemRow(a.name, a.contribution);
  subtotalRow("Arus Kas Neto dari Aktivitas Investasi", data.cashFlow.investingActivities);

  sectionHeader("Arus Kas dari Aktivitas Pendanaan");
  if (financing.length === 0) itemRow("Tidak ada mutasi", 0);
  else for (const a of financing) itemRow(a.name, a.contribution);
  subtotalRow("Arus Kas Neto dari Aktivitas Pendanaan", data.cashFlow.financingActivities);

  subtotalRow("Kenaikan (Penurunan) Bersih Kas dan Setara Kas", data.cashFlow.netChangeInCash);
  itemRow("Kas dan Setara Kas pada Awal Periode", data.cashFlow.beginningCash, false);
  const endingCashRow = cfSheet.getRow(cfRowNum++);
  endingCashRow.values = [null, "Kas dan Setara Kas pada Akhir Periode", data.cashFlow.endingCash];
  endingCashRow.getCell(3).numFmt = NUM_FMT;
  styleTotalRow(endingCashRow, 2, 3);

  addFooter(cfSheet, cfRowNum + 1, 2, 3);
  addSidebar(cfSheet, logoImageId, { companyName, reportTitle: "Arus Kas", periodLabel, preparedBy: data.preparedBy, highlights }, cfRowNum + 1);
  cfSheet.columns = [{ width: SIDEBAR_COL_WIDTH }, { width: 40 }, { width: 20 }];
  cfSheet.views = [{ showGridLines: false }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
