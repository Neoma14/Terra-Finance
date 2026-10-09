import ExcelJS from "exceljs";
import type { ReportDocument } from "./document.js";

const NAVY = "FF1C2B3A";
const BAND = "FFEAF1F7";
const WHITE = "FFFFFFFF";
const MUTED = "FF6B7280";
/** Format akuntansi: angka rata kanan, negatif dalam kurung, nol jadi "-". */
const ACCOUNTING_FORMAT = '#,##0_);(#,##0);"-"_)';

/** Render model dokumen ke .xlsx. Angka disimpan sbg number (bukan teks),
 * supaya bisa dijumlah ulang di Excel/LibreOffice. */
export async function renderXlsx(doc: ReportDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TERRA FINANCE";
  workbook.created = new Date();

  const sheetName = doc.title.split(/[:(]/)[0].trim().slice(0, 31);
  const sheet = workbook.addWorksheet(sheetName, {
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });

  const lastCol = doc.columns.length;
  sheet.columns = doc.columns.map((c) => ({ width: c.width }));

  const titleRows: [string, number, boolean][] = [
    [doc.companyName, 14, true],
    [doc.title, 12, true],
    [`Periode: ${doc.periodLabel}`, 10, false],
  ];
  if (doc.scopeLabel) {
    titleRows.push([`Cakupan: ${doc.scopeLabel.title}`, 10, true]);
    for (const warning of doc.scopeLabel.warnings) titleRows.push([`Catatan: ${warning}`, 9, false]);
  }
  titleRows.forEach(([text, size, bold], idx) => {
    const rowNumber = idx + 1;
    sheet.mergeCells(rowNumber, 1, rowNumber, lastCol);
    const cell = sheet.getCell(rowNumber, 1);
    cell.value = text;
    cell.font = { bold, size, color: { argb: bold ? NAVY : MUTED } };
  });

  const headerRowNumber = titleRows.length + 2;
  const header = sheet.getRow(headerRowNumber);
  doc.columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { horizontal: col.align, vertical: "middle" };
  });
  header.commit();
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];

  let rowNumber = headerRowNumber;
  for (const row of doc.rows) {
    rowNumber += 1;
    const excelRow = sheet.getRow(rowNumber);
    doc.columns.forEach((col, i) => {
      const value = row.cells[i] ?? null;
      const cell = excelRow.getCell(i + 1);
      cell.value = value;
      if (col.type === "number" && typeof value === "number") cell.numFmt = ACCOUNTING_FORMAT;
      cell.alignment = { horizontal: col.align, vertical: "top", wrapText: col.type === "text" };
    });
    if (row.style === "section") {
      excelRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: NAVY } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      });
    } else if (row.style === "subtotal" || row.style === "total") {
      excelRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.border = { top: { style: "thin" }, bottom: row.style === "total" ? { style: "double" } : undefined };
      });
    } else if (row.style === "note") {
      excelRow.eachCell((cell) => {
        cell.font = { italic: true, color: { argb: MUTED } };
      });
    }
    excelRow.commit();
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
