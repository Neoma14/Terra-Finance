import ExcelJS from "exceljs";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";
const NUM_FMT = "#,##0;(#,##0)";

export interface JournalHistoryExportRow {
  accountCode: string;
  accountName: string;
  entryDate: string | Date;
  referenceNo: string | null;
  description: string | null;
  isReversed: boolean;
  reversalOfId: string | null;
  debit: number;
  credit: number;
}

function toDateOnly(value: string | Date): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/** Export Riwayat Jurnal (rentang tanggal bebas) ke .xlsx -- SATU BARIS PER
 * journal_entry_line, meniru persis layout template upload jurnal (Kode
 * Akun, Tgl, No Jurnal, Akun Buku Besar, Keterangan, Debet, Kredit) supaya
 * konsultan bisa langsung cocokkan dengan Excel yang biasa mereka pakai --
 * sama persis logikanya & stylingnya dgn versi online. */
export async function buildJournalHistoryWorkbook(companyName: string, periodLabel: string, rows: JournalHistoryExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Riwayat Jurnal");

  sheet.mergeCells(1, 1, 1, 7);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = "RIWAYAT JURNAL";
  titleCell.font = { bold: true, size: 14, color: { argb: WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = companyName;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };
  sheet.getCell(3, 1).value = `Periode: ${periodLabel}  |  Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  sheet.getCell(3, 1).font = { size: 9, color: { argb: MUTED } };

  const headerRow = sheet.getRow(5);
  headerRow.values = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"];
  headerRow.font = { bold: true, color: { argb: NAVY } };
  for (let c = 1; c <= 7; c++) headerRow.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };

  let totalDebit = 0;
  let totalCredit = 0;

  rows.forEach((r, i) => {
    const row = sheet.getRow(6 + i);
    const keterangan = (r.description ?? "") + (r.isReversed ? " (di-reversal)" : r.reversalOfId ? " (reversal)" : "");
    row.values = [r.accountCode, toDateOnly(r.entryDate), r.referenceNo ?? "", r.accountName, keterangan, r.debit || null, r.credit || null];
    row.getCell(6).numFmt = NUM_FMT;
    row.getCell(7).numFmt = NUM_FMT;
    if (r.isReversed) row.font = { italic: true, color: { argb: MUTED } };
    totalDebit += r.debit;
    totalCredit += r.credit;
  });

  const totalRowNum = 6 + Math.max(rows.length, 1);
  if (rows.length === 0) {
    sheet.getCell(6, 1).value = "Tidak ada jurnal untuk rentang ini.";
    sheet.getCell(6, 1).font = { italic: true, color: { argb: MUTED } };
  }
  const totalRow = sheet.getRow(totalRowNum);
  totalRow.values = ["", "", "", "", "Total", totalDebit, totalCredit];
  for (let c = 1; c <= 7; c++) {
    const cell = totalRow.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
    cell.font = { bold: true };
  }
  totalRow.getCell(6).numFmt = NUM_FMT;
  totalRow.getCell(7).numFmt = NUM_FMT;

  sheet.mergeCells(totalRowNum + 2, 1, totalRowNum + 2, 7);
  const footerCell = sheet.getCell(totalRowNum + 2, 1);
  footerCell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  footerCell.font = { size: 8, italic: true, color: { argb: MUTED } };

  sheet.columns = [{ width: 12 }, { width: 12 }, { width: 16 }, { width: 28 }, { width: 34 }, { width: 18 }, { width: 18 }];
  sheet.views = [{ showGridLines: false }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
