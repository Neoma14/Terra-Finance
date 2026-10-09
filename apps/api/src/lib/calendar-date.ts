import { z } from "zod";

/**
 * SATU-SATUNYA validator tanggal kalender untuk semua jalur akuntansi
 * (jurnal, reversal, saldo awal, import, laporan, periode). Ketat:
 * hanya "YYYY-MM-DD" yang benar-benar ada di kalender. "2026-02-30",
 * "2025-02-29", "2026-04-31" ditolak; 2024-02-29 (kabisat) diterima.
 *
 * JANGAN memakai `new Date(text)` / `Date.parse` untuk memvalidasi: JavaScript
 * menormalisasi tanggal mustahil (2026-02-30 menjadi 2026-03-02) dan menebak
 * format lokal ("1/2/2026"), sehingga tanggal salah tersimpan diam-diam.
 *
 * Pemeriksaan kalender (tanggal nyata) DIPISAHKAN dari aturan bisnis
 * (tidak boleh masa depan, batas backdate, periode OPEN) yang ada di
 * journal-policy.ts / fiscal-period.ts dan baru dijalankan sesudah tanggal valid.
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

const EXCEL_SERIAL_MIN = 1; // 1900-01-01
const EXCEL_SERIAL_MAX = 2958465; // 9999-12-31

function fromSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < EXCEL_SERIAL_MIN || serial > EXCEL_SERIAL_MAX) return null;
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  const iso = `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * Nilai sel Excel -> "YYYY-MM-DD" atau null bila BUKAN tanggal kalender nyata.
 * Diterima: objek Date (sel bertipe tanggal), serial Excel, teks ISO
 * "YYYY-MM-DD" (boleh dengan jam 00:00). Tidak ada tebakan format lokal.
 */
export function parseExcelDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString().slice(0, 10);
    return isValidIsoDate(iso) ? iso : null;
  }
  if (typeof value === "number") return fromSerial(value);
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return fromSerial(Number(text));
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?Z?)?$/.exec(text);
  return m && isValidIsoDate(m[1]) ? m[1] : null;
}

/** Skema zod untuk body/query: wajib tanggal kalender nyata. */
export const isoDateSchema = z.string().refine(isValidIsoDate, { message: "Tanggal tidak valid. Gunakan tanggal kalender yang nyata dengan format YYYY-MM-DD." });
