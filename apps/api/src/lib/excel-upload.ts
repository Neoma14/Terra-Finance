import ExcelJS from "exceljs";

/** File upload bukan .xlsx yang bisa dibaca (rusak, bukan Excel, .xls lama).
 * `statusCode` 400 dipakai error handler global (server.ts) supaya user
 * menerima pesan yang jelas, bukan HTTP 500 dengan pesan mentah library. */
export class UnreadableExcelFileError extends Error {
  readonly code = "UNREADABLE_EXCEL_FILE" as const;
  readonly statusCode = 400;
  constructor() {
    super("File tidak dapat dibaca. Pastikan file berformat Excel (.xlsx) dan tidak rusak.");
  }
}

/** Satu-satunya pintu membaca workbook dari file upload user. */
export async function loadUploadedWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new UnreadableExcelFileError();
  }
  return workbook;
}
