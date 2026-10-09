import type { Period } from "@konsultan/shared";

/** Cari periode yang mencakup tanggal tsb -- dipakai supaya halaman-halaman
 * yang butuh SATU periode (Buku Besar, Chart of Accounts, Riwayat Jurnal,
 * Kartu Hutang/Piutang, Rasio) bisa pakai SATU date picker alih-alih
 * dropdown "Pilih Periode" terpisah -- user pilih tanggal, periode yang
 * sesuai otomatis terdeteksi di baliknya. */
export function detectPeriod(periods: Period[], date: string): Period | undefined {
  return periods.find((p) => date <= p.endDate && date >= p.startDate);
}

/** Tanggal default yang masuk akal utk date picker satu-periode -- ujung
 * (endDate) periode yang paling baru, supaya begitu halaman dibuka user
 * langsung melihat data terbaru yang tersedia. */
export function defaultDateForPeriods(periods: Period[]): string {
  return periods[0]?.endDate.slice(0, 10) ?? "";
}
