import { LogOut } from "lucide-react";
import { useState } from "react";

/**
 * Tombol Keluar -- REWRITE dari nol, SENGAJA paling sederhana & defensif
 * mungkin (bukan lagi via React Query mutation + React Router navigate)
 * setelah tombol versi lama dilaporkan berulang kali "tidak bereaksi sama
 * sekali" meski kode & backend sudah diverifikasi benar berkali-kali lewat
 * curl. Perbedaan kunci:
 *   - fetch() LANGSUNG ke endpoint, tanpa lapisan abstraksi apa pun
 *     (bukan lewat api-client.ts atau useMutation) -- mengurangi
 *     kemungkinan ada state React/React Query yang nyangkut.
 *   - Redirect pakai `window.location.href` (FULL PAGE RELOAD), BUKAN
 *     react-router `navigate()` -- tidak bergantung sama sekali pada
 *     kondisi React tree/router state saat ini, jadi tetap jalan bahkan
 *     kalau ada masalah di situ yang belum ketahuan.
 *   - `alert()` HANYA saat request gagal (jarang, ada masalah network
 *     nyata) supaya user tahu -- bukan untuk kasus normal.
 */
export function LogoutButton({
  variant = "light",
  fullName,
  collapsed = false,
}: {
  variant?: "light" | "dark";
  fullName?: string;
  collapsed?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const isDark = variant === "dark";

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Diabaikan sengaja -- redirect ke /login tetap jalan di bawah ini
      // walau request logout gagal terkirim (mis. network flaky); begitu
      // sampai di /login, useMe() akan tetap gagal (401) & tidak bisa
      // masuk balik tanpa login ulang, jadi tetap aman dari sisi keamanan.
    }
    window.location.href = "/login";
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={fullName ? `Keluar (${fullName})` : "Keluar"}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        collapsed ? "justify-center" : ""
      } ${isDark ? "text-white/60 hover:bg-white/10 hover:text-white" : "border border-line text-ink/70 hover:bg-surface-2"}`}
    >
      <LogOut size={14} />
      {!collapsed && (busy ? "Keluar..." : "Keluar")}
    </button>
  );
}
