import ExcelJS from "exceljs";
import type { TaxEstimateResult } from "@konsultan/shared";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";
const NUM_FMT = "#,##0;(#,##0)";

/** Export Estimasi Pajak (rentang tanggal bebas) ke .xlsx -- sama persis
 * logikanya & stylingnya dgn versi online. */
export async function buildTaxEstimateWorkbook(companyName: string, estimate: TaxEstimateResult): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Estimasi Pajak");

  sheet.mergeCells(1, 1, 1, 2);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = "ESTIMASI PAJAK";
  titleCell.font = { bold: true, size: 14, color: { argb: WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = companyName;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };
  sheet.getCell(3, 1).value = `Periode: ${estimate.periodLabel}  |  Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  sheet.getCell(3, 1).font = { size: 9, color: { argb: MUTED } };

  let r = 5;
  function sectionHeader(label: string) {
    const row = sheet.getRow(r++);
    row.values = [label];
    row.font = { bold: true, color: { argb: NAVY } };
    row.getCell(1).border = { bottom: { style: "medium", color: { argb: NAVY } } };
    sheet.mergeCells(row.number, 1, row.number, 2);
  }
  function line(label: string, value: number | string, bold = false) {
    const row = sheet.getRow(r++);
    row.values = [label, value];
    if (typeof value === "number") row.getCell(2).numFmt = NUM_FMT;
    if (bold) {
      row.font = { bold: true };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
    }
  }

  sectionHeader("Ringkasan");
  line("Pendapatan Bruto", estimate.grossRevenue);
  line("Net Income (akuntansi)", estimate.netIncome);
  line("Rekomendasi", estimate.recommendation === "umkm_final" ? "PPh Final UMKM (0.5%)" : "PPh Badan Normal (Pasal 31E)");
  r++;

  sectionHeader("PPh Badan Normal (Pasal 31E)");
  line("PKP (pendekatan)", estimate.pphNormal.taxableIncome);
  line("Fasilitas Diterapkan", estimate.pphNormal.facilityApplied === "full" ? "Penuh (omzet <= Rp4,8 M)" : estimate.pphNormal.facilityApplied === "partial" ? "Sebagian (omzet Rp4,8-50 M)" : "Tidak dapat fasilitas (omzet > Rp50 M)");
  for (const b of estimate.pphNormal.brackets) {
    line(`  ${b.label} (${(b.rate * 100).toFixed(1)}%)`, b.amount * b.rate);
  }
  line("PPh Terutang", estimate.pphNormal.amountDue, true);
  r++;

  sectionHeader("PPh Final UMKM (PP 55/2022)");
  line("Status", estimate.pphUmkmFinal.eligible ? "Memenuhi syarat" : "Tidak memenuhi syarat");
  line("PPh Terutang (0.5% x Omzet)", estimate.pphUmkmFinal.amountDue, true);
  r++;

  const disclaimerRow = sheet.getRow(r++);
  disclaimerRow.values = [estimate.disclaimer];
  disclaimerRow.font = { size: 8, italic: true, color: { argb: MUTED } };
  sheet.mergeCells(disclaimerRow.number, 1, disclaimerRow.number, 2);
  disclaimerRow.getCell(1).alignment = { wrapText: true };
  sheet.getRow(disclaimerRow.number).height = 40;

  r += 1;
  sheet.mergeCells(r, 1, r, 2);
  const footerCell = sheet.getCell(r, 1);
  footerCell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  footerCell.font = { size: 8, italic: true, color: { argb: MUTED } };

  sheet.columns = [{ width: 40 }, { width: 22 }];
  sheet.views = [{ showGridLines: false }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
