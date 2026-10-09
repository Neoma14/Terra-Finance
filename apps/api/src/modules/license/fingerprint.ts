import crypto from "node:crypto";
import os from "node:os";

/**
 * "Sidik jari" mesin ini -- kombinasi hostname + platform + MAC address
 * interface jaringan pertama yang bukan internal/loopback, di-hash supaya
 * ringkas & tidak membocorkan MAC address mentah kalau fingerprint ini
 * ditampilkan di UI. TIDAK sempurna (MAC bisa berubah kalau ganti kartu
 * jaringan, hostname bisa diganti user) -- cukup utk tujuan "satu
 * license_key tidak bisa dipakai ulang begitu saja di komputer lain",
 * bukan DRM yang tidak bisa ditembus sama sekali.
 */
export function computeInstanceFingerprint(): string {
  const interfaces = os.networkInterfaces();
  let mac = "";
  for (const list of Object.values(interfaces)) {
    const found = list?.find((i) => !i.internal && i.mac && i.mac !== "00:00:00:00:00:00");
    if (found) {
      mac = found.mac;
      break;
    }
  }
  const raw = `${os.hostname()}|${os.platform()}|${mac}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}
