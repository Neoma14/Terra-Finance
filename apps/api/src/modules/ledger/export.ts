import ExcelJS from "exceljs";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";
const NUM_FMT = "#,##0;(#,##0)";

export interface LedgerExportLine {
  entryDate: string;
  referenceNo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
  isReversed: boolean;
}

/** Export Buku Besar satu akun (rentang tanggal bebas) ke .xlsx -- sama
 * persis logikanya & stylingnya dgn versi online (warna letterhead
 * disesuaikan brand charcoal/green TERRA). */
export async function buildLedgerWorkbook(
  companyName: string,
  accountCode: string,
  accountName: string,
  periodLabel: string,
  beginningBalance: number,
  endingBalance: number,
  lines: LedgerExportLine[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Buku Besar");

  sheet.mergeCells(1, 1, 1, 6);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = "BUKU BESAR";
  titleCell.font = { bold: true, size: 14, color: { argb: WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = companyName;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };
  sheet.getCell(3, 1).value = `${accountCode} - ${accountName}`;
  sheet.getCell(3, 1).font = { bold: true, size: 10, color: { argb: NAVY } };
  sheet.getCell(4, 1).value = `Periode: ${periodLabel}  |  Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  sheet.getCell(4, 1).font = { size: 9, color: { argb: MUTED } };

  const headerRow = sheet.getRow(6);
  headerRow.values = ["Tanggal", "No. Jurnal", "Keterangan", "Debit", "Kredit", "Saldo"];
  headerRow.font = { bold: true, color: { argb: NAVY } };
  for (let c = 1; c <= 6; c++) headerRow.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };

  let r = 7;
  const beginningRow = sheet.getRow(r++);
  beginningRow.values = ["", "", "Saldo Awal", "", "", beginningBalance];
  beginningRow.font = { bold: true };
  beginningRow.getCell(6).numFmt = NUM_FMT;
  for (let c = 1; c <= 6; c++) beginningRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };

  for (const line of lines) {
    const row = sheet.getRow(r++);
    row.values = [
      line.entryDate.slice(0, 10),
      line.referenceNo ?? "",
      (line.description ?? "") + (line.isReversed ? " (di-reversal)" : ""),
      line.debit || null,
      line.credit || null,
      line.runningBalance,
    ];
    row.getCell(4).numFmt = NUM_FMT;
    row.getCell(5).numFmt = NUM_FMT;
    row.getCell(6).numFmt = NUM_FMT;
    if (line.isReversed) row.font = { italic: true, color: { argb: MUTED } };
  }

  const endingRow = sheet.getRow(r);
  endingRow.values = ["", "", "Saldo Akhir", "", "", endingBalance];
  endingRow.font = { bold: true };
  endingRow.getCell(6).numFmt = NUM_FMT;
  for (let c = 1; c <= 6; c++) endingRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };

  sheet.mergeCells(r + 2, 1, r + 2, 6);
  const footerCell = sheet.getCell(r + 2, 1);
  footerCell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  footerCell.font = { size: 8, italic: true, color: { argb: MUTED } };

  sheet.columns = [{ width: 14 }, { width: 16 }, { width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }];
  sheet.views = [{ showGridLines: false }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
