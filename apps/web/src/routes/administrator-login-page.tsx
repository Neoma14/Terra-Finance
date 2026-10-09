import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAdministratorLogin } from "../features/administrator/use-administrator.js";

/**
 * TIDAK ditautkan dari menu/nav manapun yang dilihat user klien -- hanya
 * bisa diakses lewat URL langsung `/administrator/login`. License key +
 * token diketik manual oleh TTD saat kunjungan maintenance (token
 * dihitung lewat scripts/compute-admin-token.ts di laptop TTD sendiri,
 * lihat modules/administrator/auth.ts).
 */
export function AdministratorLoginPage() {
  const navigate = useNavigate();
  const login = useAdministratorLogin();
  const [licenseKey, setLicenseKey] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ licenseKey: licenseKey.trim(), token: token.trim() });
      navigate("/administrator", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0B1319] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#243746] p-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center text-white">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
            <ShieldAlert size={22} />
          </div>
          <h1 className="text-lg font-bold">Akses Administrator</h1>
          <p className="text-xs text-white/50">Terra Teknologi Digital -- kunjungan maintenance</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/50">License Key Instalasi</label>
            <input
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 font-mono text-sm text-white outline-none focus:border-amber-400"
              placeholder="TFO2-..."
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/50">Token Administrator</label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 font-mono text-sm text-white outline-none focus:border-amber-400"
              placeholder="Token dari vendor"
            />
          </div>

          {error && (
            <p className="rounded-lg border border-rose-400/30 bg-rose-500/15 px-3 py-2 text-sm text-rose-300">{error}</p>
          )}

          <button
            type="submit"
            disabled={login.isPending || !licenseKey || !token}
            className="mt-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-[#0B1319] hover:bg-amber-400 disabled:opacity-50"
          >
            {login.isPending ? "Memverifikasi..." : "Masuk sebagai Administrator"}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-white/30">
          Setiap aksi lewat akses ini tercatat di audit trail yang sama seperti user lain.
        </p>
      </div>
    </div>
  );
}
