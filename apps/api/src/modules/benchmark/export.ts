import ExcelJS from "exceljs";
import type { BenchmarkCompany } from "@konsultan/shared";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";

function formatMetricValue(value: number, format: string): string {
  switch (format) {
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    case "times":
      return `${value.toFixed(2)}x`;
    case "currency":
      return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
    default:
      return value.toFixed(2);
  }
}

function writeLetterhead(sheet: ExcelJS.Worksheet, title: string, rangeLabel: string, lastCol: number) {
  sheet.mergeCells(1, 1, 1, lastCol);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14, color: { argb: WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = `Rentang: ${rangeLabel}  |  Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  sheet.getCell(2, 1).font = { size: 9, color: { argb: MUTED } };
}

/**
 * Export Benchmarking Antar Perusahaan (rentang tanggal bebas) ke .xlsx --
 * sama persis logikanya & stylingnya dgn versi online: satu sheet
 * "Ringkasan" (metrik universal, bisa dibandingkan lintas industri apapun)
 * + satu sheet per template industri yang muncul di hasil (rasio spesifik
 * industri, HANYA bermakna dibandingkan sesama template).
 */
export async function buildBenchmarkWorkbook(rangeLabel: string, companies: BenchmarkCompany[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  if (companies.length === 0) {
    const sheet = workbook.addWorksheet("Ringkasan");
    sheet.getCell(1, 1).value = "Tidak ada data untuk rentang tanggal & perusahaan yang dipilih.";
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // --- Sheet 1: Ringkasan (metrik universal) ---
  const summarySheet = workbook.addWorksheet("Ringkasan");
  const lastCol = 1 + companies.length;
  writeLetterhead(summarySheet, "BENCHMARKING ANTAR PERUSAHAAN", rangeLabel, lastCol);

  const headerRow = summarySheet.getRow(4);
  headerRow.values = ["Metrik", ...companies.map((c) => c.companyName)];
  headerRow.font = { bold: true, color: { argb: NAVY } };
  for (let c = 1; c <= lastCol; c++) headerRow.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };

  const universalMetrics = companies[0].universalMetrics;
  universalMetrics.forEach((m, i) => {
    const row = summarySheet.getRow(5 + i);
    row.values = [m.label, ...companies.map((c) => formatMetricValue(c.universalMetrics[i]?.value ?? 0, m.format))];
    if (i % 2 === 1) {
      for (let c = 1; c <= lastCol; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
    }
  });

  const summaryFooterRow = 5 + universalMetrics.length + 2;
  summarySheet.mergeCells(summaryFooterRow, 1, summaryFooterRow, lastCol);
  const summaryFooterCell = summarySheet.getCell(summaryFooterRow, 1);
  summaryFooterCell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  summaryFooterCell.font = { size: 8, italic: true, color: { argb: MUTED } };

  summarySheet.columns = [{ width: 28 }, ...companies.map(() => ({ width: 24 }))];
  summarySheet.views = [{ showGridLines: false }];

  // --- Sheet per template industri (rasio spesifik) ---
  const groups = new Map<string, BenchmarkCompany[]>();
  for (const c of companies) {
    const list = groups.get(c.industryTemplate) ?? [];
    list.push(c);
    groups.set(c.industryTemplate, list);
  }

  for (const [template, group] of groups) {
    const sheetName = `Rasio - ${template}`.slice(0, 31); // batas nama sheet Excel
    const sheet = workbook.addWorksheet(sheetName);
    const groupLastCol = 1 + group.length;
    writeLetterhead(sheet, `RASIO SPESIFIK INDUSTRI (${template.toUpperCase()})`, rangeLabel, groupLastCol);

    const gHeaderRow = sheet.getRow(4);
    gHeaderRow.values = ["Rasio", ...group.map((c) => c.companyName)];
    gHeaderRow.font = { bold: true, color: { argb: NAVY } };
    for (let c = 1; c <= groupLastCol; c++) gHeaderRow.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };

    const industryMetrics = group[0].industryMetrics;
    industryMetrics.forEach((m, i) => {
      const row = sheet.getRow(5 + i);
      row.values = [m.label, ...group.map((c) => formatMetricValue(c.industryMetrics[i]?.value ?? 0, m.format))];
      if (i % 2 === 1) {
        for (let c = 1; c <= groupLastCol; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      }
    });

    const gFooterRow = 5 + industryMetrics.length + 2;
    sheet.mergeCells(gFooterRow, 1, gFooterRow, groupLastCol);
    const gFooterCell = sheet.getCell(gFooterRow, 1);
    gFooterCell.value = "Rasio ini hanya bermakna dibandingkan sesama template industri yang sama.";
    gFooterCell.font = { size: 8, italic: true, color: { argb: MUTED } };

    sheet.columns = [{ width: 34 }, ...group.map(() => ({ width: 24 }))];
    sheet.views = [{ showGridLines: false }];
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
