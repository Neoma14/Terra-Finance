import { Laptop, Moon, Sun } from "lucide-react";
import { useRef, useState } from "react";
import { useClickOutside } from "../lib/use-click-outside.js";
import { useTheme, type ThemeMode } from "./use-theme.js";

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Terang", icon: Sun },
  { mode: "dark", label: "Gelap", icon: Moon },
  { mode: "system", label: "Sistem", icon: Laptop },
];

/**
 * Pemilih tema tiga-status (Light/Dark/System) -- dipasang di footer
 * sidebar maupun header halaman lain. "Sistem" terus mengikuti preferensi
 * OS secara live (lihat use-theme.tsx), bukan cuma dibaca sekali.
 * `variant="dark"` dipakai di permukaan yang selalu gelap terlepas dari
 * tema situs (mis. sidebar). `placement` menentukan arah popover mekar --
 * "up" untuk tombol di BAWAH layar (sidebar footer, popover perlu ke atas
 * supaya tidak terpotong viewport), "down" (default) untuk tombol di
 * header/atas halaman.
 */
export function ThemeMenu({
  variant = "light",
  placement = "down",
}: {
  variant?: "light" | "dark";
  placement?: "up" | "down";
}) {
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setOpen(false), open);
  const isDarkChrome = variant === "dark";
  const ActiveIcon = OPTIONS.find((o) => o.mode === mode)?.icon ?? Laptop;

  return (
    <div className="relative z-40" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Pilih tema"
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
          isDarkChrome ? "text-white/60 hover:bg-white/10 hover:text-white" : "text-ink/60 hover:bg-surface-2"
        }`}
      >
        <ActiveIcon size={16} />
      </button>

      {open && (
        <div
          className={`absolute left-0 z-40 flex flex-col gap-0.5 rounded-lg border p-1 transition-colors duration-200 ${
            placement === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          } ${isDarkChrome ? "border-white/10 bg-[#243746]" : "border-line bg-surface"}`}
        >
          {OPTIONS.map(({ mode: m, label, icon: Icon }) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
              className={`flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                mode === m
                  ? isDarkChrome
                    ? "bg-white/10 text-cyan-300"
                    : "bg-cyan-500/10 text-cyan-600"
                  : isDarkChrome
                    ? "text-white/60 hover:bg-white/5"
                    : "text-ink/60 hover:bg-surface-2"
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
