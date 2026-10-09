function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Tanggal kalender LOKAL (YYYY-MM-DD). `toISOString()` memakai UTC sehingga
 * dini hari WIB menghasilkan tanggal kemarin -- jangan dipakai untuk "hari ini". */
export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Awal bulan berjalan (YYYY-MM-01), lokal. */
export function startOfMonthLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
}
