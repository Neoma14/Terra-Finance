import { AlertCircle, Loader2, Lock, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LoginRobotTrio } from "../components/login-robots.js";
import { Logo } from "../components/logo.js";
import { useLogin, useMe } from "../features/auth/use-auth.js";
import { ThemeMenu } from "../theme/theme-menu.js";

export function LoginPage() {
  const { data } = useMe();
  const navigate = useNavigate();
  const login = useLogin();
  const [searchParams] = useSearchParams();
  const loggedOutByIdle = searchParams.get("reason") === "idle";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showForgotHint, setShowForgotHint] = useState(false);
  const [readyToRedirect, setReadyToRedirect] = useState(false);

  // Maskot robot bereaksi REAL-TIME per field saat mengetik (bukan cuma
  // menunggu submit) -- tiap field dievaluasi INDEPENDEN begitu ada isinya,
  // tidak perlu menunggu field yang lain juga terisi. Prioritas: hasil
  // submit backend (paling otoritatif) > ada field yg formatnya salah >
  // ada field yg formatnya sudah benar > netral (form masih kosong).
  const emailLooksValid = email.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const emailLooksInvalid = email.length > 0 && !emailLooksValid;
  const passwordLooksValid = password.length >= 8;
  const passwordLooksInvalid = password.length > 0 && !passwordLooksValid;

  const robotMood = login.isSuccess
    ? "happy"
    : login.isError
      ? "sad"
      : emailLooksInvalid || passwordLooksInvalid
        ? "sad"
        : emailLooksValid || passwordLooksValid
          ? "happy"
          : "neutral";

  // Tunda redirect sebentar SETELAH login baru saja berhasil (via form ini)
  // supaya ekspresi gembira robot sempat terlihat -- kalau user memang sudah
  // login dari sebelumnya (buka /login langsung), redirect tetap instan.
  useEffect(() => {
    if (!login.isSuccess) return;
    const t = setTimeout(() => setReadyToRedirect(true), 700);
    return () => clearTimeout(t);
  }, [login.isSuccess]);

  // Redirect via navigate() (bukan <Navigate>) supaya bisa lewat opsi
  // `viewTransition` -- browser me-morph elemen ber-view-transition-name
  // sama (mis. logo TERRA, lihat .vt-terra-logo di index.css) dari posisi di
  // halaman login ke posisi barunya, alih-alih potong instan antar halaman.
  useEffect(() => {
    if (data?.user && (!login.isSuccess || readyToRedirect)) {
      navigate("/", { replace: true, viewTransition: true });
    }
  }, [data?.user, login.isSuccess, readyToRedirect, navigate]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    login.mutate({ email, password });
  }

  function clearErrorOnEdit() {
    if (login.isError) login.reset();
  }

  return (
    <div className="grid min-h-screen bg-bg lg:grid-cols-[58%_42%]">
      {/* Kiri -- brand experience. SENGAJA selalu gelap terlepas dari tema
          situs (identitas hero brand, sama seperti sidebar) -- brief redesign
          eksplisit mengizinkan ini ("boleh menggunakan DARK TERRA sebagai
          hero experience"). Ilustrasi dashboard/analytics di belakang HARUS
          JELAS TERLIHAT (bukan dipudarkan sampai nyaris hilang seperti versi
          lama) -- overlay HANYA warna solid semi-transparan supaya teks
          "TERRA" dan judul tetap kontras, tengah panel (tempat robot & inti
          ilustrasi) dibiarkan paling terang. */}
      <div className="relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url(/img/login-illustration.jpeg)" }}
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: "rgba(38, 32, 48, 0.72)" }}
        />

        <div className="relative flex items-center gap-2.5">
          {/* Shared element -- lihat vt-terra-logo di index.css: browser
              morph logo ini ke posisi logo di header halaman berikutnya
              (bukan potong instan) saat redirect setelah login berhasil. */}
          <span className="vt-terra-logo inline-flex">
            <Logo size={30} variant="always-dark" />
          </span>
          <span className="text-lg font-bold tracking-tight">TERRA FINANCE</span>
        </div>

        <div className="relative z-20 flex flex-col items-center">
          {/* Maskot animasi (user-provided GIF, "Robot Login") -- file GIF-nya
              SUDAH punya transparansi asli (dicek: Graphic Control Extension
              transparent-flag=1), jadi TIDAK dipakai mix-blend-mode lagi --
              itu justru melunturkan warnanya (screen = melightening semua
              piksel terhadap background terang di titik ini, bukan cuma yang
              hitam). Ditampilkan APA ADANYA (opaque, di atas segalanya) plus
              vignette gelap membulat di belakangnya supaya tetap kontras dari
              ilustrasi laptop/HP yang ramai di titik itu. */}
          <div className="relative flex items-center justify-center">
            <div
              className="absolute inset-0 -z-10 scale-[2.2] rounded-full opacity-90 blur-2xl"
              style={{ backgroundColor: "rgba(38, 32, 48, 0.85)" }}
            />
            <img
              src="/img/robot-login.gif"
              alt="Maskot robot TERRA FINANCE"
              className="relative w-72 max-w-full animate-[float_6s_ease-in-out_infinite]"
            />
          </div>
        </div>

        <div className="relative">
          <h2 className="mb-3 max-w-md text-3xl font-bold leading-tight">
            Kelola keuangan.
            <br />
            Pahami bisnis.
            <br />
            Ambil keputusan.
          </h2>
          <p className="max-w-sm text-sm text-white/50">
            Satu platform untuk laporan keuangan, jurnal, pajak, dan rasio seluruh portofolio klien Anda.
          </p>
        </div>
      </div>

      {/* Kanan -- login panel, MENGIKUTI tema situs (light/dark) sepenuhnya
          -- lihat brief "Premium Theme System" #14: login wajib punya varian
          terang & gelap, bukan cuma dark experience. */}
      <div className="relative flex flex-col items-center justify-center gap-6 bg-bg px-4 py-12 transition-colors duration-200">
        <div className="absolute right-4 top-4">
          <ThemeMenu />
        </div>

        <form
          onSubmit={handleSubmit}
          className="w-full max-w-sm rounded-[24px] border border-line bg-white/80 p-8 text-heading backdrop-blur-xl transition-colors duration-200 dark:border-white/10 dark:bg-[#243746]/90 dark:text-white"
        >
          <div className="mb-6 flex flex-col items-center gap-3 text-center lg:hidden">
            <Logo size={32} />
            <span className="text-base font-bold tracking-tight">TERRA FINANCE</span>
          </div>

          <div className="mb-4">
            <LoginRobotTrio mood={robotMood} />
          </div>

          <h1 className="mb-1 text-xl font-bold">Selamat Datang</h1>
          <p className="mb-6 text-sm text-ink/60 dark:text-white/50">Masuk ke TERRA FINANCE untuk mengelola keuangan bisnis Anda.</p>
          {loggedOutByIdle && (
            <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
              Anda keluar otomatis karena tidak ada aktivitas selama 15 menit. Silakan masuk kembali.
            </p>
          )}

          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink/50 dark:text-white/50">
            Email
          </label>
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 transition-all focus-within:border-cyan-500 focus-within:outline focus-within:outline-2 focus-within:outline-cyan-500 dark:border-white/15 dark:bg-white/5">
            <Mail size={16} className="shrink-0 text-ink/40 dark:text-white/40" />
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearErrorOnEdit();
              }}
              className="w-full bg-transparent text-sm text-heading outline-none placeholder:text-ink/30 dark:text-white dark:placeholder:text-white/30"
              placeholder="nama@perusahaan.com"
            />
          </div>

          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink/50 dark:text-white/50">
            Password
          </label>
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 transition-all focus-within:border-cyan-500 focus-within:outline focus-within:outline-2 focus-within:outline-cyan-500 dark:border-white/15 dark:bg-white/5">
            <Lock size={16} className="shrink-0 text-ink/40 dark:text-white/40" />
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearErrorOnEdit();
              }}
              className="w-full bg-transparent text-sm text-heading outline-none placeholder:text-ink/30 dark:text-white dark:placeholder:text-white/30"
              placeholder="••••••••"
            />
          </div>

          <div className="mb-5 flex items-center justify-between text-xs">
            <label className="flex cursor-pointer items-center gap-2 text-ink/60 dark:text-white/60">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-line bg-surface accent-cyan-500 dark:border-white/30 dark:bg-white/5"
              />
              Ingat saya
            </label>
            <button
              type="button"
              onClick={() => setShowForgotHint((v) => !v)}
              className="font-medium text-cyan-600 hover:text-cyan-700 dark:text-cyan-300/90 dark:hover:text-cyan-200"
            >
              Lupa Password?
            </button>
          </div>

          {showForgotHint && (
            <p className="mb-4 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-xs text-ink/60 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
              Hubungi admin/konsultan Anda untuk reset password.
            </p>
          )}

          {login.isError && (
            <p className="mb-4 flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-200">
              <AlertCircle size={15} className="shrink-0" />
              {(login.error as Error).message}
            </p>
          )}

          <button
            type="submit"
            disabled={login.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#25A970] px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#20945F] active:bg-[#1B7F51] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {login.isPending && <Loader2 size={15} className="animate-spin" />}
            {login.isPending ? "Memproses..." : "MASUK"}
          </button>
        </form>
        <p className="text-xs text-ink/30 dark:text-white/30">Powered by Terra Teknologi Digital</p>
      </div>
    </div>
  );
}
