import { useEffect, type RefObject } from "react";

/**
 * Deteksi klik DI LUAR elemen `ref` dan panggil `onOutside` -- dipakai buat
 * nutup dropdown/popover (ThemeMenu, CompanySwitcher). Sengaja TIDAK pakai
 * pola lama "overlay tak-kasat-mata fixed inset-0 di atas seluruh layar":
 * kalau overlay itu gagal ter-unmount bersih (mis. re-render aneh, StrictMode
 * double-invoke, dsb), dia bisa "menyerap" SEMUA klik berikutnya di halaman
 * -- termasuk tombol lain yang terasa "tidak berfungsi" padahal listener-nya
 * baik-baik saja. Listener di document ini jauh lebih robust: tidak pernah
 * menghalangi elemen lain secara visual/interaksi, dan otomatis lepas saat
 * `active` jadi false atau komponen unmount.
 */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [active, ref, onOutside]);
}
