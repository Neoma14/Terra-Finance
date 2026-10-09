import { parseExcelDate } from "../../lib/calendar-date.js";
import ExcelJS from "exceljs";
import { loadUploadedWorkbook } from "../../lib/excel-upload.js";
import type { ParsedAccountRow } from "@konsultan/shared";

const HEADER_ALIASES = {
  code: ["kode"],
  name: ["nama akun", "nama"],
  accountType: ["tipe"],
  accountSubtype: ["sub tipe", "subtipe"],
  normalBalance: ["saldo normal"],
  isCash: ["kas (ya/tidak)", "kas"],
  cashFlowActivity: ["aktivitas arus kas"],
  subledgerType: ["kartu (hutang/piutang)", "kartu"],
  openingBalance: ["saldo awal"],
} as const;

type ColumnKey = keyof typeof HEADER_ALIASES;

const TYPE_MAP: Record<string, string> = {
  aset: "asset",
  asset: "asset",
  liabilitas: "liability",
  liability: "liability",
  ekuitas: "equity",
  equity: "equity",
  pendapatan: "revenue",
  revenue: "revenue",
  beban: "expense",
  expense: "expense",
};

const BALANCE_MAP: Record<string, string> = {
  debit: "debit",
  debet: "debit",
  kredit: "credit",
  credit: "credit",
};

const ACTIVITY_MAP: Record<string, string> = {
  operasi: "operating",
  operating: "operating",
  investasi: "investing",
  investing: "investing",
  pendanaan: "financing",
  financing: "financing",
};

const SUBLEDGER_MAP: Record<string, string> = {
  hutang: "payable",
  payable: "payable",
  piutang: "receivable",
  receivable: "receivable",
};

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

function excelSerialToIsoDate(serial: number): string {
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toIsoDate(value: unknown): string | null {
  return parseExcelDate(value);
}

export interface ParsedAccountsFile {
  rows: ParsedAccountRow[];
  fileErrors: string[];
  openingDate: string | null;
}

export async function parseAccountsExcel(buffer: Buffer): Promise<ParsedAccountsFile> {
  const workbook = await loadUploadedWorkbook(buffer);

  const sheet = workbook.getWorksheet("Akun") ?? workbook.worksheets[0];
  if (!sheet) return { rows: [], fileErrors: ['Sheet "Akun" tidak ditemukan di file ini.'], openingDate: null };

  // Cari sel "Tanggal Saldo Awal:" di 5 baris pertama, tanggal ada di sel sebelah kanannya.
  let openingDate: string | null = null;
  for (let r = 1; r <= 5; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      const text = toText(resolveCellValue(row.getCell(c))).toLowerCase();
      if (text.startsWith("tanggal saldo awal")) {
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
    if (found.code && found.name && found.accountType && found.normalBalance) {
      headerRowNumber = r;
      columnIndex = found;
      break;
    }
  }

  if (headerRowNumber === -1) {
    return {
      rows: [],
      fileErrors: ['Baris header (harus ada kolom "Kode", "Nama Akun", "Tipe", "Saldo Normal") tidak ditemukan di 20 baris pertama sheet "Akun".'],
      openingDate,
    };
  }

  const rows: ParsedAccountRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const code = toText(columnIndex.code ? resolveCellValue(row.getCell(columnIndex.code)) : "");
    const name = toText(columnIndex.name ? resolveCellValue(row.getCell(columnIndex.name)) : "");
    if (!code && !name) return; // baris kosong, lewati

    const typeRaw = toText(columnIndex.accountType ? resolveCellValue(row.getCell(columnIndex.accountType)) : "").toLowerCase();
    const subtype = toText(columnIndex.accountSubtype ? resolveCellValue(row.getCell(columnIndex.accountSubtype)) : "");
    const balanceRaw = toText(columnIndex.normalBalance ? resolveCellValue(row.getCell(columnIndex.normalBalance)) : "").toLowerCase();
    const isCashRaw = toText(columnIndex.isCash ? resolveCellValue(row.getCell(columnIndex.isCash)) : "").toLowerCase();
    const activityRaw = toText(columnIndex.cashFlowActivity ? resolveCellValue(row.getCell(columnIndex.cashFlowActivity)) : "").toLowerCase();
    const subledgerRaw = toText(columnIndex.subledgerType ? resolveCellValue(row.getCell(columnIndex.subledgerType)) : "").toLowerCase();
    const openingBalance = columnIndex.openingBalance ? toNumber(resolveCellValue(row.getCell(columnIndex.openingBalance))) : 0;

    const errors: string[] = [];
    if (!code) errors.push("Kode wajib diisi");
    if (!name) errors.push("Nama Akun wajib diisi");
    const accountType = TYPE_MAP[typeRaw] ?? "";
    if (!accountType) errors.push(`Tipe "${typeRaw}" tidak dikenal (harus Aset/Liabilitas/Ekuitas/Pendapatan/Beban)`);
    if (!subtype) errors.push("Sub Tipe wajib diisi");
    const normalBalance = BALANCE_MAP[balanceRaw] ?? "";
    if (!normalBalance) errors.push(`Saldo Normal "${balanceRaw}" tidak dikenal (harus Debit/Kredit)`);
    const cashFlowActivity = activityRaw ? (ACTIVITY_MAP[activityRaw] ?? "") : "";
    if (activityRaw && !cashFlowActivity) errors.push(`Aktivitas Arus Kas "${activityRaw}" tidak dikenal (harus Operasi/Investasi/Pendanaan/kosong)`);
    const subledgerType = subledgerRaw ? (SUBLEDGER_MAP[subledgerRaw] ?? "") : "";
    if (subledgerRaw && !subledgerType) errors.push(`Kartu "${subledgerRaw}" tidak dikenal (harus Hutang/Piutang/kosong)`);
    if (openingBalance < 0) errors.push("Saldo Awal tidak boleh negatif");
    if (openingBalance > 0 && !openingDate) errors.push('Baris ini punya Saldo Awal tapi "Tanggal Saldo Awal" di atas sheet belum diisi/tidak valid');

    rows.push({
      rowNumber,
      code,
      name,
      accountType,
      accountSubtype: subtype,
      normalBalance,
      cashFlowActivity,
      isCash: isCashRaw === "ya" || isCashRaw === "yes" || isCashRaw === "true",
      subledgerType,
      openingBalance,
      errors,
      alreadyExists: false, // diisi route setelah cek ke tabel accounts
    });
  });

  const fileErrors: string[] = [];
  if (rows.length === 0) fileErrors.push("Tidak ada baris akun yang terbaca (cek format file).");

  const codeCount = new Map<string, number>();
  for (const r of rows) codeCount.set(r.code, (codeCount.get(r.code) ?? 0) + 1);
  for (const r of rows) {
    if (r.code && (codeCount.get(r.code) ?? 0) > 1) r.errors.push(`Kode "${r.code}" muncul lebih dari sekali di file ini`);
  }

  return { rows, fileErrors, openingDate };
}
