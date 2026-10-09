import ExcelJS from "exceljs";
import type { RatioValue } from "@konsultan/shared";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";

function formatRatioValue(value: number, format: RatioValue["format"]): string {
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

/** Export Rasio Keuangan (rentang tanggal bebas) ke .xlsx -- sama persis
 * logikanya & stylingnya dgn versi online. */
export async function buildRatiosWorkbook(companyName: string, periodLabel: string, ratios: RatioValue[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rasio Keuangan");

  sheet.mergeCells(1, 1, 1, 3);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = "RASIO KEUANGAN";
  titleCell.font = { bold: true, size: 14, color: { argb: WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = companyName;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };
  sheet.getCell(3, 1).value = `Periode: ${periodLabel}  |  Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  sheet.getCell(3, 1).font = { size: 9, color: { argb: MUTED } };

  const headerRow = sheet.getRow(5);
  headerRow.values = ["Rasio", "Nilai", "Catatan"];
  headerRow.font = { bold: true, color: { argb: NAVY } };
  for (let c = 1; c <= 3; c++) headerRow.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };

  ratios.forEach((r, i) => {
    const row = sheet.getRow(6 + i);
    row.values = [r.label, formatRatioValue(r.value, r.format), r.note ?? ""];
    if (i % 2 === 1) {
      for (let c = 1; c <= 3; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
    }
  });

  const footerRowNum = 6 + ratios.length + 2;
  sheet.mergeCells(footerRowNum, 1, footerRowNum, 3);
  const footerCell = sheet.getCell(footerRowNum, 1);
  footerCell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  footerCell.font = { size: 8, italic: true, color: { argb: MUTED } };

  sheet.columns = [{ width: 34 }, { width: 18 }, { width: 50 }];
  sheet.views = [{ showGridLines: false }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
