import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client.js";

export interface LicenseStatusDto {
  activated: boolean;
  clientName: string | null;
  product: string | null;
  status: "active" | "expired" | "invalid" | "device_mismatch" | null;
  expiresAt: string | null;
  activationDevices: number | null;
  fingerprintMatches: boolean | null;
  reason: string | null;
  /** Sisa hari penuh; null = Lifetime / belum aktif; negatif = sudah lewat. */
  daysRemaining: number | null;
}

export type LicenseInspectionDto =
  | { valid: false; reason: string }
  | {
      valid: true;
      payload: { licenseId: string; clientName: string; expiry: string | null; devices: number; issued: string };
      expired: boolean;
      daysRemaining: number | null;
      sameClient: boolean | null;
      shorterThanCurrent: boolean;
    };

export function useLicenseStatus() {
  return useQuery({
    queryKey: ["license", "status"],
    queryFn: () => api.get<{ license: LicenseStatusDto }>("/license/status"),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });
}

/** Periksa kunci TANPA menyimpan -- menampilkan isinya sebelum diterapkan. */
export function useInspectLicense() {
  return useMutation({
    mutationFn: (licenseKey: string) => api.post<{ inspection: LicenseInspectionDto }>("/license/inspect", { licenseKey }),
  });
}

export function useReplaceLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (licenseKey: string) =>
      api.post<{ ok: true; clientName: string; expiry: string | null; license: LicenseStatusDto }>("/license/replace", { licenseKey }),
    // Banyak query sempat gagal (403 LICENSE_INVALID) selama lisensi habis;
    // setelah lisensi baru aktif, muat ulang semuanya.
    onSuccess: async () => {
      await qc.invalidateQueries();
    },
  });
}

/** "6 Oktober 2026" dari "2026-10-06" (tanggal kalender murni, tanpa zona waktu). */
export function formatLicenseDate(isoDate: string | null): string {
  if (!isoDate) return "Tanpa batas waktu (Lifetime)";
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Ambang peringatan "akan habis" (hari). */
export const LICENSE_WARN_DAYS = 30;
