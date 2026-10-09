import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/logo.js";
import { useCompleteSetup } from "../features/setup/use-setup.js";

/**
 * Wizard first-run -- muncul otomatis saat `GET /api/setup/status`
 * bilang `needsSetup: true` (lihat App.tsx). Sekali sukses, endpoint ini
 * tidak bisa dipanggil ulang (backend menolak kalau `users`/`company_profile`
 * sudah terisi) -- tidak perlu proteksi tambahan di sisi frontend.
 */
export function SetupWizardPage() {
  const navigate = useNavigate();
  const completeSetup = useCompleteSetup();

  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [adminFullName, setAdminFullName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Alasan tombol submit nonaktif -- ditampilkan LANGSUNG di form (bukan
  // cuma tombol abu-abu tanpa penjelasan) supaya user tidak bingung kenapa
  // tidak bisa lanjut, terutama syarat panjang password yang tidak
  // kelihatan dari titik-titik password field.
  const validationMessage = !companyName.trim()
    ? "Nama perusahaan wajib diisi"
    : !licenseKey.trim()
      ? "Kode lisensi wajib diisi"
      : !adminFullName.trim()
        ? "Nama admin wajib diisi"
        : !adminEmail.trim()
          ? "Email/username admin wajib diisi"
          : adminPassword.length < 8
            ? `Password minimal 8 karakter (saat ini ${adminPassword.length})`
            : adminPassword !== adminPasswordConfirm
              ? "Konfirmasi password belum sama dengan password"
              : null;
  const canSubmit = validationMessage === null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (adminPassword !== adminPasswordConfirm) {
      setError("Konfirmasi password tidak sama");
      return;
    }
    try {
      await completeSetup.mutateAsync({
        companyName: companyName.trim(),
        industry: industry.trim() || undefined,
        licenseKey: licenseKey.trim(),
        adminEmail: adminEmail.trim(),
        adminPassword,
        adminFullName: adminFullName.trim(),
      });
      navigate("/login", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo size={36} />
          <h1 className="text-xl font-bold text-heading">Setup Awal TERRA FINANCE</h1>
          <p className="text-sm text-ink/50">Instalasi baru -- lengkapi data di bawah untuk mulai memakai aplikasi.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink/50">Nama Perusahaan</label>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="input-base w-full" placeholder="mis. PT Contoh Klien" />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink/50">Jenis Usaha (opsional)</label>
            <input value={industry} onChange={(e) => setIndustry(e.target.value)} className="input-base w-full" placeholder="mis. Retail, Restoran, dst" />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink/50">Kode Lisensi</label>
            <input
              value={licenseKey}
              // Kunci lisensi (TFO2-...) peka huruf besar/kecil -- jangan diubah.
              onChange={(e) => setLicenseKey(e.target.value)}
              className="input-base w-full font-mono tracking-wide"
              placeholder="TFO2-..."
            />
            <p className="mt-1 text-xs text-ink/40">Diberikan oleh Terra Teknologi Digital saat pembelian.</p>
          </div>

          <div className="border-t border-line pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink/50">Akun Admin Pertama</p>
            <div className="flex flex-col gap-3">
              <input value={adminFullName} onChange={(e) => setAdminFullName(e.target.value)} className="input-base w-full" placeholder="Nama Lengkap" />
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                className="input-base w-full"
                placeholder="Email/Username"
              />
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className="input-base w-full"
                placeholder="Password (minimal 8 karakter)"
              />
              <input
                type="password"
                value={adminPasswordConfirm}
                onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                className="input-base w-full"
                placeholder="Konfirmasi Password"
              />
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-300">
              {error}
            </p>
          )}

          {!error && validationMessage && (companyName || licenseKey || adminFullName || adminEmail || adminPassword) && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{validationMessage}</p>
          )}

          <button
            type="submit"
            disabled={!canSubmit || completeSetup.isPending}
            className="mt-2 rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {completeSetup.isPending ? "Menyiapkan..." : "Selesaikan Setup"}
          </button>
        </form>
      </div>
    </div>
  );
}
