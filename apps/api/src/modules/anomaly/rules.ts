export interface AnomalyCandidate {
  ruleCode: string;
  severity: "low" | "medium" | "high";
  description: string;
}

/**
 * Aturan deteksi SEDERHANA (bukan ML) -- murni informational, TIDAK
 * PERNAH memblokir aksi apa pun (lihat komentar plan: "tampilkan sbg
 * daftar flag, bukan otomatis blokir"). Fungsi-fungsi ini SENGAJA murni
 * (pure function, tidak akses DB) supaya gampang dipanggil dari modul
 * transaksi/kasir SESUNGGUHNYA nanti (di luar cakupan fondasi ini) tanpa
 * perlu tahu apa-apa soal skema database.
 */

const BUSINESS_HOURS_START = 6; // 06:00
const BUSINESS_HOURS_END = 22; // 22:00

export function checkOutOfHoursActivity(at: Date, actionLabel: string): AnomalyCandidate | null {
  const hour = at.getHours();
  if (hour >= BUSINESS_HOURS_START && hour < BUSINESS_HOURS_END) return null;
  return {
    ruleCode: "out_of_hours",
    severity: "low",
    description: `${actionLabel} terjadi di luar jam operasional wajar (pukul ${at.toLocaleTimeString("id-ID")})`,
  };
}

/** Nominal jauh di luar pola normal akun -- `average` & `stdDev` dihitung
 * caller dari riwayat transaksi akun ybs (di luar cakupan fondasi ini,
 * disiapkan supaya modul Kasir/transaksi nanti tinggal pakai). */
export function checkAmountOutOfPattern(amount: number, average: number, stdDev: number, label: string): AnomalyCandidate | null {
  if (stdDev <= 0) return null;
  const zScore = Math.abs(amount - average) / stdDev;
  if (zScore < 4) return null;
  return {
    ruleCode: "amount_out_of_pattern",
    severity: zScore >= 8 ? "high" : "medium",
    description: `${label}: nominal ${amount.toLocaleString("id-ID")} jauh di luar pola normal (rata-rata ${average.toLocaleString("id-ID")})`,
  };
}

export function checkLargeManualEntry(amount: number, manualEntryThreshold: number, label: string): AnomalyCandidate | null {
  if (amount < manualEntryThreshold) return null;
  return {
    ruleCode: "large_manual_entry",
    severity: "medium",
    description: `${label}: entri jurnal manual bernilai besar (${amount.toLocaleString("id-ID")})`,
  };
}

export function checkVoidedAfterRecorded(label: string, minutesAfterRecorded: number): AnomalyCandidate | null {
  if (minutesAfterRecorded < 0) return null;
  return {
    ruleCode: "voided_transaction",
    severity: minutesAfterRecorded > 60 ? "high" : "medium",
    description: `${label}: transaksi di-void/dihapus ${minutesAfterRecorded} menit setelah tercatat`,
  };
}

export function checkUnbalancedAccount(accountLabel: string, difference: number): AnomalyCandidate | null {
  if (Math.abs(difference) < 1) return null;
  return {
    ruleCode: "unbalanced_account",
    severity: "high",
    description: `${accountLabel}: saldo debit-kredit tidak balance (selisih ${difference.toLocaleString("id-ID")})`,
  };
}

/** Aksi mode-perbaikan Administrator SELALU dicatat sbg anomali severity
 * "low" -- bukan karena mencurigakan, tapi supaya Admin klien yang buka
 * dashboard Administrator (dashboardnya sendiri bisa dilihat Admin klien
 * dgn izin read-only, transparan) langsung notice tiap kali ada
 * intervensi data dari TTD. */
export function repairModeCandidate(reason: string): AnomalyCandidate {
  return {
    ruleCode: "administrator_repair_mode",
    severity: "low",
    description: `Administrator melakukan mode perbaikan data. Alasan: ${reason}`,
  };
}
