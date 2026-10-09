import { BarChart3, Building2, ChevronLeft, ChevronRight, KeyRound, LayoutGrid, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { EditableImage, UserAvatar } from "../components/avatar.js";
import { LicenseBanner } from "../components/license-banner.js";
import { Logo } from "../components/logo.js";
import { LogoutButton } from "../components/logout-button.js";
import { useDeleteAvatar, useMe, useUploadAvatar } from "../features/auth/use-auth.js";
import { ThemeMenu } from "../theme/theme-menu.js";

// "Beranda", "Perusahaan" & "Pengaturan" selalu ada; "Pengguna" cuma utk
// role admin (lihat requireAdmin di API -- tersembunyi di sini demi UX,
// tapi enforcement SEBENARNYA ada di server).
//
// TASK-020: "Perusahaan" SEKARANG mengarah ke `/workspace` (arsitektur
// company-db BARU, company_access per-role), BUKAN `/companies` lama lagi
// -- audit keamanan menemukan rute API `/companies` & `/c/:slug/*` lama
// TIDAK PUNYA pengecekan akses per-perusahaan sama sekali (lihat komentar
// panjang di db/system/legacy-company-migration.ts & middleware/
// company-access-guard.ts dipasang ulang di rute lama sbg mitigasi), DAN
// `/workspace` ternyata SELAMA INI tidak tertaut dari nav mana pun (hanya
// reachable lewat URL manual) walau arsitekturnya SUDAH py kontrol akses
// yang benar -- diperbaiki di sini supaya jalur yang aman yg benar2 dipakai.
const baseNavItems = [
  { to: "/", label: "Beranda", icon: LayoutGrid },
  { to: "/workspace", label: "Perusahaan", icon: Building2 },
  { to: "/benchmark", label: "Benchmarking", icon: BarChart3 },
];
const adminNavItems = [{ to: "/users", label: "Pengguna", icon: Users }];
const licenseNavItem = { to: "/lisensi", label: "Lisensi", icon: KeyRound };
const settingsNavItem = { to: "/settings", label: "Pengaturan", icon: Settings };

const SIDEBAR_COLLAPSED_KEY = "terra.sidebarCollapsed";

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell() {
  const { data } = useMe();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  const fullName = data?.user.fullName ?? "";
  const avatarUrl = data?.user.avatarUrl ?? null;
  const navItems = [
    ...baseNavItems,
    ...(data?.user.role === "admin" ? adminNavItems : []),
    licenseNavItem,
    settingsNavItem,
  ];

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // localStorage tidak tersedia (mis. private mode) -- abaikan, cuma preferensi tampilan.
    }
  }, [collapsed]);

  return (
    <div className="flex min-h-screen bg-bg">
      <aside
        className={`sticky top-0 z-30 flex h-screen shrink-0 flex-col overflow-hidden border-r border-white/5 bg-[#262030] text-white transition-[width] duration-300 ease-in-out ${
          collapsed ? "w-[76px]" : "w-64"
        }`}
      >
        <div className="relative flex items-center gap-2 px-4 py-4">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <Logo size={26} variant="always-dark" />
          </Link>
          <span
            className={`overflow-hidden whitespace-nowrap font-semibold tracking-tight transition-all duration-200 ${
              collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
            }`}
          >
            TERRA FINANCE
          </span>

          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Perluas menu" : "Ciutkan menu"}
            className="absolute -right-3 top-5 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-[#243746] text-white/70 hover:bg-navy-900 hover:text-cyan-300"
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </button>
        </div>

        <nav className="relative flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2 scrollbar-thin">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-medium transition-all ${
                  collapsed ? "justify-center" : ""
                } ${isActive ? "bg-white/10 text-white" : "text-white/55 hover:bg-white/5 hover:text-white/90"}`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={16} strokeWidth={2} className={`shrink-0 ${isActive ? "text-cyan-300" : ""}`} />
                  <span className={`overflow-hidden transition-all duration-200 ${collapsed ? "w-0 opacity-0" : "w-auto opacity-100"}`}>
                    {label}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="relative flex flex-col gap-2 border-t border-white/10 px-3 py-3">
          <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center" : ""}`}>
            <EditableImage
              imageUrl={avatarUrl}
              fallback={<UserAvatar name={fullName} size={collapsed ? 32 : 36} />}
              onUpload={(file) => uploadAvatar.mutate(file)}
              onRemove={avatarUrl ? () => deleteAvatar.mutate() : undefined}
              isUploading={uploadAvatar.isPending}
              size={collapsed ? 32 : 36}
            />
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{fullName || "..."}</p>
                <p className="truncate text-xs text-white/40">{data?.user.email}</p>
              </div>
            )}
          </div>

          <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
            <ThemeMenu variant="dark" placement="up" />
            {!collapsed && <LogoutButton variant="dark" fullName={data?.user.fullName} />}
          </div>
          {collapsed && <LogoutButton variant="dark" fullName={data?.user.fullName} collapsed />}
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <LicenseBanner />
        <main className="relative z-10 p-4 md:p-6">
          <Outlet />
        </main>
        <footer className="relative z-10 px-6 pb-4 text-center text-[11px] text-ink/30">Powered by Terra Teknologi Digital</footer>
      </div>
    </div>
  );
}
