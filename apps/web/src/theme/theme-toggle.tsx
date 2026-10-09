import { Moon, Sun } from "lucide-react";
import { useTheme } from "./use-theme.js";

export function ThemeToggle({ variant = "light" }: { variant?: "light" | "dark" }) {
  const { theme, toggle } = useTheme();
  const isLight = variant === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === "dark" ? "Ganti ke mode terang" : "Ganti ke mode gelap"}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        isLight ? "text-ink/60 hover:bg-surface-2" : "text-white/60 hover:bg-white/10 hover:text-white"
      }`}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
