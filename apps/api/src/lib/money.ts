/**
 * Aritmetika nominal untuk validasi akuntansi. Jurnal HARUS seimbang PERSIS
 * (tanpa toleransi): total debit = total kredit. Perbandingan dilakukan dalam
 * satuan sen (bilangan bulat) supaya selisih floating-point murni dari
 * penjumlahan (mis. 0.1 + 0.2 vs 0.3) tidak dianggap selisih, sedangkan
 * selisih nyata sekecil Rp 0,01 pun ditolak.
 */
export function toCents(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

export function sumCents(amounts: number[]): bigint {
  let total = 0n;
  for (const a of amounts) total += toCents(a);
  return total;
}

/** Sen -> nominal Rupiah. Hasil bagi 100 dari bilangan bulat selalu nilai
 * double terdekat dari desimal 2 digit (mis. 123456 -> 1234.56), tanpa noise. */
export function fromCents(cents: bigint): number {
  return Number(cents) / 100;
}

/**
 * Alokasi proporsional `total` ke bobot `weights` dalam bilangan bulat, dengan
 * kelipatan `unit` (mis. 100n = Rupiah utuh, 1n = sen). Metode sisa terbesar
 * (largest remainder): jumlah hasil SELALU persis sama dengan `total`, dan
 * deterministik (seri sisa dimenangkan indeks terkecil). `total` harus
 * kelipatan `unit` dan bobot tidak boleh semuanya nol.
 */
export function allocateProRata(total: bigint, weights: bigint[], unit: bigint): bigint[] {
  const sign = total < 0n ? -1n : 1n;
  const units = (total < 0n ? -total : total) / unit;
  const sumW = weights.reduce((a, b) => a + b, 0n);
  const base = weights.map((w) => (units * w) / sumW);
  const rem = weights.map((w) => (units * w) % sumW);
  let left = units - base.reduce((a, b) => a + b, 0n);
  const order = weights.map((_, i) => i).sort((a, b) => (rem[b] === rem[a] ? a - b : rem[b] > rem[a] ? 1 : -1));
  for (const i of order) {
    if (left <= 0n) break;
    base[i] += 1n;
    left -= 1n;
  }
  return base.map((u) => sign * u * unit);
}

/** Dua total (hasil penjumlahan float) dianggap sama bila sama dalam sen. */
export function totalsEqual(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}
