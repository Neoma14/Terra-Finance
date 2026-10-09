import { useEffect } from "react";

/** TASK-021 -- modal/dialog overlay di seluruh app (add-account-modal,
 * account-detail-modal, journal-detail-modal, users-page) TIDAK menutup
 * lewat tombol Escape, hanya klik overlay/tombol X. Hook kecil ini
 * dipasang sekali per modal supaya konsisten, tanpa menulis ulang
 * markup/komponen modal masing-masing. */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
}
