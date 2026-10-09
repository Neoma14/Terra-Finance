import { useEffect } from "react";

/**
 * Auto-logout setelah 15 menit tanpa aktivitas PENGGUNA.
 *
 * - Aktivitas = mouse, keyboard, scroll, sentuh (bukan polling/request latar).
 * - Penanda aktivitas terakhir disimpan di localStorage sehingga SEMUA tab
 *   (dan refresh halaman) memakai jam yang sama: aktif di satu tab menjaga
 *   semua tab; tab yang dibuka kembali setelah >15 menit langsung keluar.
 * - Server menegakkan batas yang sama (sesi idle ditolak 401). Klien hanya
 *   mengirim ping aktivitas (maks 1x/menit) setelah interaksi nyata.
 * - Logout di satu tab disiarkan ke tab lain lewat event storage.
 */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVITY_KEY = "terra.lastActivityAt";
const LOGOUT_KEY = "terra.loggedOutAt";
const CHECK_INTERVAL_MS = 15 * 1000;
const WRITE_THROTTLE_MS = 1000;
const PING_INTERVAL_MS = 60 * 1000;

function readActivity(): number | null {
  try {
    const v = Number(localStorage.getItem(ACTIVITY_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeActivity(ts: number) {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(ts));
  } catch {
    // localStorage tidak tersedia -- timer tab ini tetap jalan lewat memori.
  }
}

async function endSession(reason: "idle" | "other-tab") {
  try {
    localStorage.setItem(LOGOUT_KEY, String(Date.now()));
    localStorage.removeItem(ACTIVITY_KEY);
  } catch {
    // diabaikan
  }
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    // Redirect tetap dijalankan; server juga menolak sesi idle sendiri.
  }
  window.location.href = reason === "idle" ? "/login?reason=idle" : "/login";
}

export function useIdleLogout(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let lastLocal = Date.now();
    let lastWrite = 0;
    let lastPing = 0;
    let ended = false;

    // Refresh / tab baru: bila aktivitas terakhir sudah > 15 menit, keluar.
    // Penanda lama bisa tersisa dari tab yang ditutup tanpa logout, jadi
    // kasus "basi" dikonfirmasi ke server (sumber kebenaran): sesi idle
    // ditolak 401, sesi baru (login ulang) diterima.
    const stored = readActivity();
    if (stored !== null && Date.now() - stored >= IDLE_TIMEOUT_MS) {
      lastLocal = 0; // jangan anggap aktif sampai server mengonfirmasi
      fetch("/api/auth/activity", { method: "POST", credentials: "include" })
        .then((res) => {
          if (res.ok) {
            lastLocal = Date.now();
            writeActivity(lastLocal);
          } else if (!ended) {
            ended = true;
            void endSession("idle");
          }
        })
        .catch(() => {
          lastLocal = Date.now();
        });
    } else {
      writeActivity(lastLocal);
    }

    function onActivity() {
      const now = Date.now();
      lastLocal = now;
      if (now - lastWrite >= WRITE_THROTTLE_MS) {
        lastWrite = now;
        writeActivity(now);
      }
      if (now - lastPing >= PING_INTERVAL_MS && !document.hidden) {
        lastPing = now;
        fetch("/api/auth/activity", { method: "POST", credentials: "include" })
          .then((res) => {
            if (res.status === 401 && !ended) {
              ended = true;
              void endSession("idle");
            }
          })
          .catch(() => {
            // jaringan sesaat -- diabaikan, ping berikutnya mencoba lagi
          });
      }
    }

    function check() {
      if (ended) return;
      const last = Math.max(lastLocal, readActivity() ?? 0);
      if (Date.now() - last >= IDLE_TIMEOUT_MS) {
        ended = true;
        void endSession("idle");
      }
    }

    function onStorage(e: StorageEvent) {
      if (e.key === LOGOUT_KEY && e.newValue && !ended) {
        ended = true;
        window.location.href = "/login";
      }
    }

    const events: Array<keyof WindowEventMap> = ["mousedown", "mousemove", "keydown", "wheel", "touchstart", "scroll"];
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", check);

    return () => {
      for (const ev of events) window.removeEventListener(ev, onActivity);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [enabled]);
}
