import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LICENSE_WARN_DAYS, formatLicenseDate, useLicenseStatus } from "../features/license/use-license.js";

const DISMISS_KEY = "terra.license.bannerDismissed";

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Peringatan lisensi di atas halaman: (1) lisensi habis / tidak valid /
 * terikat komputer lain -> merah, tidak bisa ditutup; (2) lisensi aktif tetapi
 * akan habis dalam <= 30 hari -> kuning (<= 7 hari merah), bisa ditutup
 * selama sesi. Lifetime tidak pernah memunculkan banner.
 */
export function LicenseBanner() {
  const { data } = useLicenseStatus();
  const [dismissed, setDismissed] = useState(readDismissed);
  const lic = data?.license;
  if (!lic || !lic.activated) return null;

  const blocked = lic.status === "expired" || lic.status === "invalid" || lic.status === "device_mismatch";
  const expiringSoon = lic.status === "active" && lic.daysRemaining !== null && lic.daysRemaining <= LICENSE_WARN_DAYS;
  if (!blocked && !expiringSoon) return null;

  if (!blocked && dismissed === lic.expiresAt) return null;

  const urgent = blocked || (lic.daysRemaining ?? 99) <= 7;
  const tone = urgent
    ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
    : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";

  let message: string;
  if (lic.status === "expired") message = `Lisensi berakhir pada ${formatLicenseDate(lic.expiresAt)}. Fitur akuntansi dikunci sampai lisensi diperpanjang. Data Anda tetap aman.`;
  else if (lic.status === "device_mismatch") message = "Lisensi ini terikat ke komputer lain. Bila aplikasi ini dipindahkan ke komputer ini, masukkan kunci lisensi untuk komputer ini.";
  else if (lic.status === "invalid") message = `Lisensi tidak valid${lic.reason ? `: ${lic.reason}` : ""}. Fitur akuntansi dikunci.`;
  else if (lic.daysRemaining === 0) message = `Lisensi berakhir HARI INI (${formatLicenseDate(lic.expiresAt)}).`;
  else message = `Lisensi akan habis dalam ${lic.daysRemaining} hari (${formatLicenseDate(lic.expiresAt)}).`;

  return (
    <div role={urgent ? "alert" : "status"} data-testid="license-banner" className={`flex items-start gap-3 border-b px-4 py-2.5 text-sm md:px-6 ${tone}`}>
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <p className="flex-1">
        {message}{" "}
        <Link to="/lisensi" className="font-semibold underline">
          {lic.status === "device_mismatch" ? "Aktifkan di komputer ini" : "Perpanjang lisensi"}
        </Link>
      </p>
      {!blocked && (
        <button
          type="button"
          aria-label="Tutup peringatan"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISS_KEY, lic.expiresAt ?? "");
            } catch {
              /* penyimpanan sesi tidak tersedia -- cukup tutup untuk render ini */
            }
            setDismissed(lic.expiresAt ?? "");
          }}
          className="shrink-0 opacity-60 hover:opacity-100"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
