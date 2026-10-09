import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

/** Preferensi tersimpan user: "system" berarti ikut OS terus-menerus
 * (bukan cuma dibaca sekali saat load). "light"/"dark" adalah pilihan
 * eksplisit yang mengalahkan OS sampai user reset ke "system". */
export type ThemeMode = "light" | "dark" | "system";
/** Tema yang benar-benar diterapkan ke DOM setelah "system" diresolusi. */
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "konsultan-theme";

function getSystemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function getInitialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // localStorage tidak tersedia (mis. private mode) -- default ke system.
  }
  return "system";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? (getSystemPrefersDark() ? "dark" : "light") : mode;
}

function applyResolvedTheme(theme: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const ThemeContext = createContext<{
  mode: ThemeMode;
  theme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
} | null>(null);

/**
 * Theme system tri-state (Light/Dark/System) -- "system" TERUS mengikuti
 * perubahan preferensi OS secara live (listener matchMedia), bukan cuma
 * dibaca sekali saat mount. Preferensi eksplisit (light/dark) disimpan dan
 * dipakai lagi saat aplikasi dibuka ulang; kalau belum pernah memilih,
 * default-nya "system" (lihat brief redesign: "gunakan System Theme
 * sebagai default jika pengguna belum pernah menentukan pilihan sendiri").
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolve(mode));

  useEffect(() => {
    const resolved = resolve(mode);
    setTheme(resolved);
    applyResolvedTheme(resolved);

    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Abaikan -- preferensi cukup berlaku untuk sesi ini saja.
    }

    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const next = getSystemPrefersDark() ? "dark" : "light";
      setTheme(next);
      applyResolvedTheme(next);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggle = useCallback(() => setModeState((m) => (resolve(m) === "dark" ? "light" : "dark")), []);

  const value = useMemo(() => ({ mode, theme, setMode, toggle }), [mode, theme, setMode, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme dipanggil di luar <ThemeProvider>");
  return ctx;
}
