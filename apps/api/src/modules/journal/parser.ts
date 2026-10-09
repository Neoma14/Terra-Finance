import ExcelJS from "exceljs";
import { loadUploadedWorkbook } from "../../lib/excel-upload.js";
import { totalsEqual } from "../../lib/money.js";
import { parseExcelDate } from "../../lib/calendar-date.js";
import type { ParsedJournalEntry, ParsedJournalLine } from "@konsultan/shared";

/** Fungsi murni, tanpa akses DB -- copy verbatim dari versi online
 * (modules/journal/parser.ts), tidak ada yang perlu diubah utk SQLite. */
const HEADER_ALIASES = {
  code: ["kode akun", "kode"],
  journalNo: ["no jurnal", "nomor jurnal", "no. jurnal", "no.jurnal"],
  date: ["tgl", "tanggal"],
  accountName: ["akun buku besar", "nama akun", "akun"],
  keterangan: ["keterangan", "memo"],
  debit: ["debet", "debit"],
  credit: ["kredit", "credit"],
  counterpartyName: ["vendor/pelanggan", "vendor / pelanggan", "vendor", "pelanggan", "counterparty"],
} as const;

type ColumnKey = keyof typeof HEADER_ALIASES;

function resolveCellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as any;
  if (v && typeof v === "object" && "result" in v) return v.result;
  return v;
}

function toText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value == null || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Nilai sel tanggal -> "YYYY-MM-DD" ketat. Bila BUKAN tanggal kalender nyata
 * (mis. 2026-02-30, "1/2/2026"), teks aslinya dikembalikan apa adanya supaya
 * tahap validasi menolaknya dengan pesan yang jelas -- TIDAK PERNAH
 * dinormalisasi ke tanggal lain (UAT-003). */
function toIsoDate(value: unknown): string {
  return parseExcelDate(value) ?? toText(value);
}

interface RawRow {
  rowNumber: number;
  code: string;
  journalNo: string;
  date: string;
  accountName: string;
  keterangan: string;
  debit: number;
  credit: number;
  counterpartyName: string;
}

export interface ParsedJournalFile {
  entries: ParsedJournalEntry[];
  fileErrors: string[];
}

export async function parseJournalExcel(buffer: Buffer): Promise<ParsedJournalFile> {
  const workbook = await loadUploadedWorkbook(buffer);

  const sheet = workbook.getWorksheet("Jurnal") ?? workbook.worksheets[0];
  if (!sheet) return { entries: [], fileErrors: ['Sheet "Jurnal" tidak ditemukan di file ini.'] };

  // Cari baris header secara dinamis -- baris metadata di atasnya jumlahnya bebas.
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
    if (found.code && found.date && (found.debit || found.credit)) {
      headerRowNumber = r;
      columnIndex = found;
      break;
    }
  }

  if (headerRowNumber === -1) {
    return {
      entries: [],
      fileErrors: ['Baris header (harus ada kolom "Kode Akun", "Tgl", "Debet"/"Kredit") tidak ditemukan di 20 baris pertama sheet "Jurnal".'],
    };
  }

  const rawRows: (RawRow | null)[] = []; // null = baris pemisah/kosong
  // includeEmpty: baris yang benar-benar kosong juga dikunjungi supaya berfungsi sbg
  // pemisah transaksi (eachRow biasa melewatinya sehingga dua transaksi menyatu).
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const code = toText(columnIndex.code ? resolveCellValue(row.getCell(columnIndex.code)) : "");
    const debit = columnIndex.debit ? toNumber(resolveCellValue(row.getCell(columnIndex.debit))) : 0;
    const credit = columnIndex.credit ? toNumber(resolveCellValue(row.getCell(columnIndex.credit))) : 0;

    if (!code || (debit === 0 && credit === 0)) {
      rawRows.push(null); // pemisah antar transaksi (baris kosong / "???")
      return;
    }

    rawRows.push({
      rowNumber,
      code,
      journalNo: toText(columnIndex.journalNo ? resolveCellValue(row.getCell(columnIndex.journalNo)) : ""),
      date: toIsoDate(columnIndex.date ? resolveCellValue(row.getCell(columnIndex.date)) : ""),
      accountName: toText(columnIndex.accountName ? resolveCellValue(row.getCell(columnIndex.accountName)) : ""),
      keterangan: toText(columnIndex.keterangan ? resolveCellValue(row.getCell(columnIndex.keterangan)) : ""),
      debit,
      credit,
      counterpartyName: toText(
        columnIndex.counterpartyName ? resolveCellValue(row.getCell(columnIndex.counterpartyName)) : "",
      ),
    });
  });

  // Baris dengan "Nomor Jurnal" eksplisit dikelompokkan by nomor itu (bisa
  // tidak berurutan); sisanya dikelompokkan by blok-berurutan-dipisah-baris-
  // kosong atau tanggal berubah (tetap didukung untuk file tanpa kolom itu).
  const explicitGroups = new Map<string, RawRow[]>();
  const implicitStream: (RawRow | null)[] = [];

  for (const row of rawRows) {
    if (row && row.journalNo) {
      if (!explicitGroups.has(row.journalNo)) explicitGroups.set(row.journalNo, []);
      explicitGroups.get(row.journalNo)!.push(row);
    } else {
      implicitStream.push(row);
    }
  }

  const implicitGroups: RawRow[][] = [];
  let current: RawRow[] = [];
  for (const item of implicitStream) {
    if (item === null) {
      if (current.length) implicitGroups.push(current);
      current = [];
    } else {
      // Tanpa kolom "No Jurnal": baris berurutan dikelompokkan PER TANGGAL --
      // tanggal berbeda = transaksi berbeda. Tanpa aturan ini, file ribuan
      // baris tanpa pemisah menjadi SATU jurnal raksasa (gagal disimpan, dan
      // tanggal semua baris dipaksa ke tanggal baris pertama).
      if (current.length && current[current.length - 1].date !== item.date) {
        implicitGroups.push(current);
        current = [];
      }
      current.push(item);
    }
  }
  if (current.length) implicitGroups.push(current);

  const allGroups: { referenceNo: string | null; rows: RawRow[] }[] = [
    ...[...explicitGroups.entries()].map(([journalNo, rows]) => ({ referenceNo: journalNo, rows })),
    ...implicitGroups.map((rows) => ({ referenceNo: null, rows })),
  ];

  const entries: ParsedJournalEntry[] = allGroups
    .map(({ referenceNo, rows }) => {
      const lines: ParsedJournalLine[] = rows.map((r) => ({
        rowNumber: r.rowNumber,
        code: r.code,
        accountName: r.accountName,
        keterangan: r.keterangan,
        debit: r.debit,
        credit: r.credit,
        counterpartyName: r.counterpartyName,
      }));
      const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
      return {
        referenceNo,
        date: rows[0]?.date ?? "",
        lines,
        totalDebit,
        totalCredit,
        isBalanced: totalsEqual(totalDebit, totalCredit), // UAT-002: tanpa toleransi
        unknownAccountCodes: [], // diisi route setelah cek ke tabel accounts
        alreadyExists: false, // diisi route setelah cek referenceNo ke tabel journal_entries
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const fileErrors: string[] = [];
  if (entries.length === 0) fileErrors.push("Tidak ada baris jurnal yang terbaca (cek format file).");

  return { entries, fileErrors };
}
