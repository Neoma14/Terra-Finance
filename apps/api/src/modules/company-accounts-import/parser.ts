import ExcelJS from "exceljs";
import { loadUploadedWorkbook } from "../../lib/excel-upload.js";

/**
 * Parser COA import (TASK-DB-ARCH-015 §10-11) -- fungsi MURNI, tanpa akses
 * DB (pola sama dgn `modules/journal/parser.ts`). SENGAJA BARU, bukan
 * reuse `modules/accounts/import-parser.ts` (legacy shared-DB): legacy
 * itu (1) hanya kenal 5 account_type ("asset/liability/equity/revenue/
 * expense", schema lama) sedangkan Company DB punya 9 (`account_types`
 * C0002: ASSET/LIABILITY/EQUITY/REVENUE/COGS/EXPENSE/OTHER_INCOME/
 * OTHER_EXPENSE/TAX) -- vocabulary BERBEDA, bukan subset; (2) TIDAK punya
 * konsep "Kode Induk" (parent_account_id tidak ada di schema lama sama
 * sekali); (3) membundel workflow Saldo Awal yg EKSPLISIT DILARANG task
 * ini & task-task sebelumnya ("jangan implementasikan workflow kalkulasi
 * saldo awal"). Menduplikasi/memodifikasi parser lama berisiko lebih
 * besar drpd menulis versi scoped-tepat utk skema yang sebenarnya dipakai.
 */

const HEADER_ALIASES = {
  code: ["kode", "kode akun", "account code"],
  name: ["nama akun", "nama", "account name"],
  accountType: ["tipe", "tipe akun", "account type"],
  parentCode: ["kode induk", "parent code"],
  normalBalance: ["saldo normal", "normal balance"],
  isActive: ["aktif (ya/tidak)", "aktif", "is active"],
  isCash: ["kas (ya/tidak)", "kas", "is cash"],
  cashFlowActivity: ["aktivitas arus kas", "cash flow activity"],
  subledgerType: ["kartu (hutang/piutang)", "kartu", "subledger type"],
} as const;

type ColumnKey = keyof typeof HEADER_ALIASES;

/** 9 `account_types` C0002 -- alias Indonesia + kode mentah (power user
 * yang langsung isi "ASSET" dst tetap diterima). */
const TYPE_ALIASES: Record<string, string> = {
  aset: "ASSET",
  aktiva: "ASSET",
  asset: "ASSET",
  liabilitas: "LIABILITY",
  kewajiban: "LIABILITY",
  liability: "LIABILITY",
  ekuitas: "EQUITY",
  modal: "EQUITY",
  equity: "EQUITY",
  pendapatan: "REVENUE",
  revenue: "REVENUE",
  hpp: "COGS",
  "harga pokok penjualan": "COGS",
  cogs: "COGS",
  beban: "EXPENSE",
  biaya: "EXPENSE",
  expense: "EXPENSE",
  "pendapatan lain": "OTHER_INCOME",
  "pendapatan lain-lain": "OTHER_INCOME",
  other_income: "OTHER_INCOME",
  "beban lain": "OTHER_EXPENSE",
  "beban lain-lain": "OTHER_EXPENSE",
  other_expense: "OTHER_EXPENSE",
  pajak: "TAX",
  tax: "TAX",
};

const BALANCE_ALIASES: Record<string, "debit" | "credit"> = { debit: "debit", debet: "debit", kredit: "credit", credit: "credit" };
const ACTIVITY_ALIASES: Record<string, string> = { operasi: "operating", operating: "operating", investasi: "investing", investing: "investing", pendanaan: "financing", financing: "financing" };
const SUBLEDGER_ALIASES: Record<string, string> = { hutang: "payable", payable: "payable", piutang: "receivable", receivable: "receivable" };

function resolveCellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as any;
  if (v && typeof v === "object" && "result" in v) return v.result;
  return v;
}
function toText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
function toBoolYesNo(value: unknown): boolean {
  const t = toText(value).toLowerCase();
  return t === "ya" || t === "yes" || t === "true" || t === "1";
}

export interface ParsedAccountRow {
  rowNumber: number;
  code: string;
  name: string;
  /** null = tidak dikenal/kosong -- dibedakan dari string kosong supaya
   * validator bisa bedakan "tidak diisi" vs "diisi tapi salah". */
  accountTypeCode: string | null;
  accountTypeRaw: string;
  parentCode: string | null;
  /** null = kolom kosong -> validator akan default ke normal_balance
   * default tipe akun (account_types.normal_balance) -- BUKAN tebakan
   * bebas, melainkan default resmi yang sudah ada di seed data C0002. */
  normalBalance: "debit" | "credit" | null;
  normalBalanceRaw: string;
  isActive: boolean;
  isCash: boolean;
  cashFlowActivity: string | null;
  cashFlowActivityRaw: string;
  subledgerType: string | null;
  subledgerTypeRaw: string;
}

export interface ParsedAccountsFile {
  rows: ParsedAccountRow[];
  fileErrors: string[];
}

export async function parseAccountsImportExcel(buffer: Buffer): Promise<ParsedAccountsFile> {
  const workbook = await loadUploadedWorkbook(buffer);

  const sheet = workbook.getWorksheet("Akun") ?? workbook.worksheets[0];
  if (!sheet) return { rows: [], fileErrors: ['Sheet "Akun" tidak ditemukan di file ini.'] };

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
    if (found.code && found.name && found.accountType) {
      headerRowNumber = r;
      columnIndex = found;
      break;
    }
  }

  if (headerRowNumber === -1) {
    return { rows: [], fileErrors: ['Baris header (harus ada kolom "Kode", "Nama Akun", "Tipe") tidak ditemukan di 20 baris pertama sheet "Akun".'] };
  }

  const rows: ParsedAccountRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const code = toText(columnIndex.code ? resolveCellValue(row.getCell(columnIndex.code)) : "");
    const name = toText(columnIndex.name ? resolveCellValue(row.getCell(columnIndex.name)) : "");
    if (!code && !name) return; // baris kosong, lewati

    const accountTypeRaw = toText(columnIndex.accountType ? resolveCellValue(row.getCell(columnIndex.accountType)) : "");
    const normalBalanceRaw = toText(columnIndex.normalBalance ? resolveCellValue(row.getCell(columnIndex.normalBalance)) : "");
    const cashFlowActivityRaw = toText(columnIndex.cashFlowActivity ? resolveCellValue(row.getCell(columnIndex.cashFlowActivity)) : "");
    const subledgerTypeRaw = toText(columnIndex.subledgerType ? resolveCellValue(row.getCell(columnIndex.subledgerType)) : "");
    const isActiveRaw = columnIndex.isActive ? resolveCellValue(row.getCell(columnIndex.isActive)) : null;

    rows.push({
      rowNumber,
      code,
      name,
      accountTypeCode: TYPE_ALIASES[accountTypeRaw.toLowerCase()] ?? (accountTypeRaw ? accountTypeRaw.toUpperCase() : null),
      accountTypeRaw,
      parentCode: toText(columnIndex.parentCode ? resolveCellValue(row.getCell(columnIndex.parentCode)) : "") || null,
      normalBalance: BALANCE_ALIASES[normalBalanceRaw.toLowerCase()] ?? null,
      normalBalanceRaw,
      // Kolom "Aktif" kosong -> default true (akun baru wajar aktif) --
      // HANYA "Tidak"/"No"/"False" eksplisit yang membuatnya false.
      isActive: isActiveRaw == null || toText(isActiveRaw) === "" ? true : toBoolYesNo(isActiveRaw),
      isCash: columnIndex.isCash ? toBoolYesNo(resolveCellValue(row.getCell(columnIndex.isCash))) : false,
      cashFlowActivity: cashFlowActivityRaw ? ACTIVITY_ALIASES[cashFlowActivityRaw.toLowerCase()] ?? null : null,
      cashFlowActivityRaw,
      subledgerType: subledgerTypeRaw ? SUBLEDGER_ALIASES[subledgerTypeRaw.toLowerCase()] ?? null : null,
      subledgerTypeRaw,
    });
  });

  const fileErrors: string[] = [];
  if (rows.length === 0) fileErrors.push("Tidak ada baris akun yang terbaca (cek format file).");

  return { rows, fileErrors };
}
