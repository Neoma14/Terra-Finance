const idrFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function formatIDR(value: number): string {
  return idrFormatter.format(value);
}

/** Versi ringkas untuk label sumbu chart (mis. "Rp400jt") -- formatIDR
 * penuh terlalu panjang untuk ruang sumbu Y yang sempit. */
export function formatIDRCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `Rp${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (abs >= 1_000_000_000) return `Rp${(value / 1_000_000_000).toFixed(1)}M`;
  if (abs >= 1_000_000) return `Rp${(value / 1_000_000).toFixed(0)}jt`;
  if (abs >= 1_000) return `Rp${(value / 1_000).toFixed(0)}rb`;
  return formatIDR(value);
}

export function formatRatio(value: number, format: "ratio" | "percent" | "currency" | "times"): string {
  switch (format) {
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    case "times":
      return `${value.toFixed(2)}x`;
    case "currency":
      return formatIDR(value);
    default:
      return value.toFixed(1);
  }
}
