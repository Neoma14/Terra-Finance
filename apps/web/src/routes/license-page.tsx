import { CheckCircle2, KeyRound } from "lucide-react";
import { useState } from "react";
import { Badge, Card, CardHeader } from "../components/ui.js";
import { useMe } from "../features/auth/use-auth.js";
import {
  LICENSE_WARN_DAYS,
  formatLicenseDate,
  useInspectLicense,
  useLicenseStatus,
  useReplaceLicense,
  type LicenseInspectionDto,
  type LicenseStatusDto,
} from "../features/license/use-license.js";

const STATUS_LABEL: Record<string, { text: string; tone: "success" | "warning" | "danger" }> = {
  active: { text: "Aktif", tone: "success" },
  expired: { text: "Kedaluwarsa", tone: "danger" },
  invalid: { text: "Tidak valid", tone: "danger" },
  device_mismatch: { text: "Terikat komputer lain", tone: "danger" },
};

function remainingText(lic: LicenseStatusDto): string {
  if (lic.status !== "active" && lic.status !== "expired") return "-";
  if (lic.daysRemaining === null) return "Tanpa batas waktu";
  if (lic.daysRemaining < 0) return `Sudah lewat ${Math.abs(lic.daysRemaining)} hari`;
  if (lic.daysRemaining === 0) return "Berakhir hari ini";
  return `${lic.daysRemaining} hari lagi`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-ink/50">{label}</dt>
      <dd className="text-sm font-medium text-heading">{children}</dd>
    </div>
  );
}

/**
 * Menu Lisensi: status lisensi terpasang + Perpanjang / Ganti Lisensi. Berada di
 * bawah AppShell (hanya butuh login, tidak memanggil API perusahaan), sehingga
 * tetap bisa dibuka saat lisensi sudah habis -- justru saat itulah dibutuhkan.
 * Hanya admin aplikasi yang boleh menerapkan kunci baru (ditegakkan di server).
 */
export function LicensePage() {
  const { data: me } = useMe();
  const { data, isLoading, isError } = useLicenseStatus();
  const inspect = useInspectLicense();
  const replace = useReplaceLicense();
  const [key, setKey] = useState("");
  const [inspection, setInspection] = useState<LicenseInspectionDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<{ clientName: string; expiry: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = me?.user.role === "admin";
  const lic = data?.license;

  function reset() {
    setInspection(null);
    setConfirmed(false);
    setError(null);
  }

  async function handleInspect() {
    reset();
    setDone(null);
    const trimmed = key.trim();
    if (!trimmed) return setError("Tempel kunci lisensi terlebih dahulu.");
    try {
      const res = await inspect.mutateAsync(trimmed);
      setInspection(res.inspection);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleApply() {
    setError(null);
    try {
      const res = await replace.mutateAsync(key.trim());
      setDone({ clientName: res.clientName, expiry: res.expiry });
      setKey("");
      setInspection(null);
      setConfirmed(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const needsConfirm = inspection?.valid === true && (inspection.sameClient === false || inspection.shorterThanCurrent);
  const canApply = inspection?.valid === true && !inspection.expired && (!needsConfirm || confirmed) && !replace.isPending;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Lisensi</h1>
        <p className="text-sm text-ink/50">Status lisensi TERRA FINANCE di komputer ini dan cara memperpanjangnya.</p>
      </div>

      <Card>
        <CardHeader title="Lisensi terpasang" icon={<KeyRound size={16} className="text-ink/50" />} />
        <div className="p-5">
          {isLoading && <p className="text-sm text-ink/40">Memuat...</p>}
          {isError && <p className="text-sm text-rose-600">Gagal memuat status lisensi.</p>}
          {lic && !lic.activated && <p className="text-sm text-ink/60">Belum ada lisensi terpasang di komputer ini.</p>}
          {lic?.activated && (
            <dl className="flex flex-col gap-3">
              <Row label="Klien">{lic.clientName ?? "-"}</Row>
              <Row label="Status">
                <Badge tone={STATUS_LABEL[lic.status ?? "invalid"]?.tone ?? "danger"}>{STATUS_LABEL[lic.status ?? "invalid"]?.text ?? lic.status}</Badge>
              </Row>
              <Row label="Berlaku sampai">{formatLicenseDate(lic.expiresAt)}</Row>
              <Row label="Sisa masa berlaku">{remainingText(lic)}</Row>
              <Row label="Kebijakan aktivasi">{lic.activationDevices ?? "-"} device</Row>
              {lic.reason && <Row label="Keterangan">{lic.reason}</Row>}
            </dl>
          )}
          {lic?.status === "expired" && (
            <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              Fitur akuntansi dikunci selama lisensi kedaluwarsa. <strong>Data Anda tidak hilang</strong> dan akan bisa dipakai lagi setelah lisensi diperpanjang.
            </p>
          )}
          {lic?.status === "device_mismatch" && (
            <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              Lisensi tercatat untuk komputer lain. Jika Anda memindahkan aplikasi ke komputer ini, minta kunci lisensi untuk komputer ini ke Terra Teknologi Digital, lalu masukkan di bawah. <strong>Data Anda tidak hilang.</strong>
            </p>
          )}
          {lic?.status === "active" && lic.daysRemaining !== null && lic.daysRemaining <= LICENSE_WARN_DAYS && (
            <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">Lisensi akan segera habis. Hubungi Terra Teknologi Digital untuk mendapatkan kunci perpanjangan.</p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Perpanjang / ganti lisensi" />
        <div className="flex flex-col gap-4 p-5">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink/70">
            <li>Hubungi Terra Teknologi Digital untuk meminta kunci lisensi baru (nama klien harus sama).</li>
            <li>Tempel kunci (diawali <code>TFO2-</code>) di bawah, lalu klik <em>Periksa kunci</em>.</li>
            <li>Pastikan isinya benar, lalu klik <em>Terapkan lisensi</em>.</li>
          </ol>

          {!isAdmin && me && (
            <p className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink/70">
              Hanya <strong>admin</strong> aplikasi yang dapat memperpanjang lisensi. Minta admin Anda untuk membuka halaman ini.
            </p>
          )}

          {isAdmin && (
            <>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-heading">
                Kunci lisensi
                <textarea
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    reset();
                  }}
                  rows={4}
                  spellCheck={false}
                  placeholder="TFO2-..."
                  className="input-base font-mono text-xs"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleInspect}
                  disabled={inspect.isPending || !key.trim()}
                  className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-heading hover:bg-surface-2 disabled:opacity-50"
                >
                  {inspect.isPending ? "Memeriksa..." : "Periksa kunci"}
                </button>
              </div>

              {error && (
                <p role="alert" className="text-sm text-rose-600">
                  {error}
                </p>
              )}

              {inspection && !inspection.valid && (
                <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                  Kunci tidak dapat dipakai: {inspection.reason}
                </p>
              )}

              {inspection?.valid && (
                <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4">
                  <p className="text-sm font-semibold text-heading">Isi kunci lisensi</p>
                  <dl className="flex flex-col gap-2">
                    <Row label="Klien">{inspection.payload.clientName}</Row>
                    <Row label="Berlaku sampai">{formatLicenseDate(inspection.payload.expiry)}</Row>
                    <Row label="Kebijakan aktivasi">{inspection.payload.devices} device</Row>
                    <Row label="ID lisensi">{inspection.payload.licenseId}</Row>
                  </dl>

                  {inspection.expired && (
                    <p role="alert" className="text-sm font-medium text-rose-600">
                      Kunci ini sudah kedaluwarsa dan tidak bisa diterapkan. Minta kunci yang baru.
                    </p>
                  )}
                  {inspection.sameClient === false && (
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      ⚠ Nama klien pada kunci ini <strong>berbeda</strong> dari lisensi terpasang ({lic?.clientName}). Pastikan ini kunci milik Anda.
                    </p>
                  )}
                  {inspection.shorterThanCurrent && (
                    <p className="text-sm text-amber-700 dark:text-amber-300">⚠ Masa berlaku kunci ini <strong>lebih singkat</strong> daripada lisensi terpasang.</p>
                  )}
                  {needsConfirm && !inspection.expired && (
                    <label className="flex items-start gap-2 text-sm text-ink/80">
                      <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
                      Saya paham dan yakin ingin mengganti lisensi dengan kunci ini.
                    </label>
                  )}

                  <div>
                    <button
                      type="button"
                      onClick={handleApply}
                      disabled={!canApply}
                      className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
                    >
                      {replace.isPending ? "Menerapkan..." : "Terapkan lisensi"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {done && (
            <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              <span>
                Lisensi untuk <strong>{done.clientName}</strong> berhasil diterapkan. Berlaku sampai {formatLicenseDate(done.expiry)}.
              </span>
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
