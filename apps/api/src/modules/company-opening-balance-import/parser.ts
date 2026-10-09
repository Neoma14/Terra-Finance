import { parseExcelDate } from "../../lib/calendar-date.js";
import ExcelJS from "exceljs";
import { loadUploadedWorkbook } from "../../lib/excel-upload.js";

/**
 * Parser import Opening Balance (TASK-DB-ARCH-016 §10-11) -- fungsi
 * MURNI, tanpa akses DB. BARU (bukan reuse `modules/journal/parser.ts`)
 * krn Opening Balance secara struktural BEDA dari Journal import: SELURUH
 * baris di file adalah baris dari SATU journal entry yang sama (tidak ada
 * grouping per-transaksi via baris kosong/No Jurnal) -- `parseJournalExcel`
 * akan salah mengelompokkan baris jadi banyak "transaksi" terpisah kalau
 * dipakai di sini. Satu tanggal ("Tanggal Saldo Awal") utk SELURUH file,
 * BUKAN per baris -- konsisten dgn `journal_entries.entry_date` yang
 * memang satu nilai per entry (bukan per baris), schema TIDAK diubah utk
 * menampung tanggal per-baris.
 */

const HEADER_ALIASES = {
  code: ["kode akun", "kode"],
  name: ["nama akun", "nama"],
  debit: ["debet", "debit"],
  credit: ["kredit", "credit"],
  memo: ["keterangan", "deskripsi", "description"],
} as const;

type ColumnKey = keyof typeof HEADER_ALIASES;

function resolveCellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as any;
  if (v && typeof v === "object" && "result" in v) return v.result;
  return v;
}
function toText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value == null || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function excelSerialToIsoDate(serial: number): string {
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function toIsoDate(value: unknown): string | null {
  return parseExcelDate(value);
}

export interface ParsedOpeningBalanceRow {
  rowNumber: number;
  code: string;
  name: string;
  debit: number;
  credit: number;
  memo: string;
}

export interface ParsedOpeningBalanceFile {
  openingDate: string | null;
  rows: ParsedOpeningBalanceRow[];
  fileErrors: string[];
}

export async function parseOpeningBalanceExcel(buffer: Buffer): Promise<ParsedOpeningBalanceFile> {
  const workbook = await loadUploadedWorkbook(buffer);

  const sheet = workbook.getWorksheet("Saldo Awal") ?? workbook.worksheets[0];
  if (!sheet) return { openingDate: null, rows: [], fileErrors: ['Sheet "Saldo Awal" tidak ditemukan di file ini.'] };

  let openingDate: string | null = null;
  for (let r = 1; r <= 5; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      if (toText(resolveCellValue(row.getCell(c))).toLowerCase().startsWith("tanggal saldo awal")) {
        openingDate = toIsoDate(resolveCellValue(row.getCell(c + 1)));
      }
    }
  }

  let headerRowNumber = -1;
  let columnIndex: Partial<Record<ColumnKey, number>> = {};
  const maxScanRow = Math.min(sheet.rowCount, 20);
  for (let r = 1; r <= maxScanRow; r++) {
    const row = sheet.getRow(r);
    const found: Partial<Record<ColumnKey, number>> = {};
    row.eachCell((cell, colNumber) => {
      const text = toText(resolveCellValue(cell)).toLowerCase();
      for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColumnKey, readonly string[]][]) {
        if ((aliases as readonly string[]).includes(text)) found[key] = colNumber;
      }
    });
    if (found.code && (found.debit || found.credit)) {
      headerRowNumber = r;
      columnIndex = found;
      break;
    }
  }

  if (headerRowNumber === -1) {
    return { openingDate, rows: [], fileErrors: ['Baris header (harus ada kolom "Kode Akun", "Debet"/"Kredit") tidak ditemukan di 20 baris pertama sheet "Saldo Awal".'] };
  }

  const rows: ParsedOpeningBalanceRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const code = toText(columnIndex.code ? resolveCellValue(row.getCell(columnIndex.code)) : "");
    const debit = columnIndex.debit ? toNumber(resolveCellValue(row.getCell(columnIndex.debit))) : 0;
    const credit = columnIndex.credit ? toNumber(resolveCellValue(row.getCell(columnIndex.credit))) : 0;
    if (!code && debit === 0 && credit === 0) return; // baris kosong, lewati

    rows.push({
      rowNumber,
      code,
      name: toText(columnIndex.name ? resolveCellValue(row.getCell(columnIndex.name)) : ""),
      debit,
      credit,
      memo: toText(columnIndex.memo ? resolveCellValue(row.getCell(columnIndex.memo)) : ""),
    });
  });

  const fileErrors: string[] = [];
  if (rows.length === 0) fileErrors.push("Tidak ada baris saldo awal yang terbaca (cek format file).");

  return { openingDate, rows, fileErrors };
}
