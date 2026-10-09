import { useTheme } from "./use-theme.js";

/**
 * Recharts butuh string warna literal (SVG attributes), tidak bisa pakai
 * class Tailwind/CSS variable langsung -- jadi nilai di sini SENGAJA
 * duplikat dari token di theme/tokens.css. Identitas brand TERRA baru: Dark
 * Charcoal/Navy (#1C2B3A) + Forest Green (#1F7A52/#3CB371) sebagai
 * SATU-SATUNYA aksen non-navy, dipakai secukupnya untuk highlight (bukan
 * warna dominan). Kalau tokens.css berubah, sesuaikan juga di sini.
 */
const LIGHT = {
  accent: "#33495C",
  accentSoft: "#4A6478",
  muted: "#6b7f94",
  gridline: "#d7e4eb",
  surface: "#ffffff",
  ink: "#233046",
};

const DARK = {
  accent: "#4A6478",
  accentSoft: "#3CB371",
  muted: "#9fb4c6",
  gridline: "#233642",
  surface: "#1C2B3A",
  ink: "#d6e0eb",
};

/** Dipakai chart di kartu SURFACE biasa (ikut tema situs, terang/gelap). */
export function useChartColors() {
  const { theme } = useTheme();
  return theme === "dark" ? DARK : LIGHT;
}

/** Palet kategorikal untuk chart multi-seri di kartu surface (donut, dsb) --
 * urutan tetap, gradasi navy->slate->hijau supaya tetap dalam identitas
 * brand tapi masing-masing seri gampang dibedakan (hijau dipakai di ujung
 * sebagai highlight, bukan warna paling dominan). */
export function useCategoricalPalette(): string[] {
  const { theme } = useTheme();
  return theme === "dark"
    ? ["#4A6478", "#3CB371", "#33495C", "#1F7A52", "#9fb4c6"]
    : ["#1C2B3A", "#33495C", "#1F7A52", "#4A6478", "#3CB371"];
}

/** Dipakai chart di kartu yang SENGAJA selalu gelap (bg-navy-700) terlepas
 * dari tema situs -- sama seperti sidebar, warnanya tetap (bukan adaptif). */
export const ON_DARK_CHART = {
  accent: "#4A6478",
  accentSoft: "#3CB371",
  text: "rgba(255,255,255,0.92)",
  muted: "rgba(255,255,255,0.5)",
  gridline: "rgba(255,255,255,0.08)",
  areaFillFrom: "rgba(60,179,113,0.30)",
  areaFillTo: "rgba(60,179,113,0)",
};
