import ExcelJS from "exceljs";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const MUTED = "FF6B7280";
const WHITE = "FFFFFFFF";
const NUM_FMT = "#,##0;(#,##0)";

export interface AccountBalanceRow {
  code: string;
  name: string;
  accountType: string;
  beginningBalance: number;
  debitTotal: number;
  creditTotal: number;
  endingBalance: number;
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  asset: "Aset",
  liability: "Liabilitas",
  equity: "Ekuitas",
  revenue: "Pendapatan",
  expense: "Beban",
};

/**
 * Export Chart of Accounts + saldo (awal/mutasi/akhir) rentang tanggal
 * bebas ke .xlsx -- sama persis logikanya & stylingnya dgn versi online
 * (warna letterhead disesuaikan brand charcoal/green TERRA).
 */
export async function buildAccountsWorkbook(companyName: string, periodLabel: string, rows: AccountBalanceRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Chart of Accounts");

  sheet.mergeCells(1, 1, 1, 7);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = "CHART OF ACCOUNTS";
  titleCell.font = { bold: true, size: 14, color: { argb: WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = companyName;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };
  sheet.getCell(3, 1).value = `Periode: ${periodLabel}  |  Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}`;
  sheet.getCell(3, 1).font = { size: 9, color: { argb: MUTED } };

  const headerRow = sheet.getRow(5);
  headerRow.values = ["Kode", "Nama Akun", "Tipe", "Saldo Awal", "Mutasi Debit", "Mutasi Kredit", "Saldo Akhir"];
  headerRow.font = { bold: true, color: { argb: NAVY } };
  for (let c = 1; c <= 7; c++) headerRow.getCell(c).border = { bottom: { style: "medium", color: { argb: NAVY } } };

  let totalBeginning = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  let totalEnding = 0;

  rows.forEach((r, i) => {
    const row = sheet.getRow(6 + i);
    row.values = [
      r.code,
      r.name,
      ACCOUNT_TYPE_LABEL[r.accountType] ?? r.accountType,
      r.beginningBalance,
      r.debitTotal,
      r.creditTotal,
      r.endingBalance,
    ];
    row.getCell(4).numFmt = NUM_FMT;
    row.getCell(5).numFmt = NUM_FMT;
    row.getCell(6).numFmt = NUM_FMT;
    row.getCell(7).numFmt = NUM_FMT;
    totalBeginning += r.beginningBalance;
    totalDebit += r.debitTotal;
    totalCredit += r.creditTotal;
    totalEnding += r.endingBalance;
  });

  const totalRowNum = 6 + rows.length;
  const totalRow = sheet.getRow(totalRowNum);
  totalRow.values = ["", "Total", "", totalBeginning, totalDebit, totalCredit, totalEnding];
  for (let c = 1; c <= 7; c++) {
    const cell = totalRow.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
    cell.font = { bold: true };
  }
  totalRow.getCell(4).numFmt = NUM_FMT;
  totalRow.getCell(5).numFmt = NUM_FMT;
  totalRow.getCell(6).numFmt = NUM_FMT;
  totalRow.getCell(7).numFmt = NUM_FMT;

  sheet.mergeCells(totalRowNum + 2, 1, totalRowNum + 2, 7);
  const footerCell = sheet.getCell(totalRowNum + 2, 1);
  footerCell.value = "Dibuat otomatis melalui TERRA FINANCE -- Terra Teknologi Digital";
  footerCell.font = { size: 8, italic: true, color: { argb: MUTED } };

  sheet.columns = [{ width: 12 }, { width: 34 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  sheet.views = [{ showGridLines: false }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
