import { ChevronLeft, ChevronRight, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useParams } from "react-router-dom";
import { UserAvatar } from "../../components/avatar.js";
import { LicenseBanner } from "../../components/license-banner.js";
import { Badge } from "../../components/ui.js";
import { Logo } from "../../components/logo.js";
import { LogoutButton } from "../../components/logout-button.js";
import { ThemeMenu } from "../../theme/theme-menu.js";
import { useMe } from "../../features/auth/use-auth.js";
import { useAccessibleCompanies } from "../../features/workspace/use-workspace.js";
import { useInterBranchNav } from "../../features/workspace/use-inter-branch.js";
import { ActiveBranchSelector } from "./active-branch-selector.js";
import { CompanySwitcher } from "./company-switcher.js";
import { GlobalSearch } from "./global-search.js";
import { WORKSPACE_NAV } from "./nav-config.js";

const SIDEBAR_COLLAPSED_KEY = "terra.workspace.sidebarCollapsed";

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Shell workspace company-scoped BARU (TASK-DB-ARCH-013) -- paralel dgn
 * `app-shell.tsx` legacy (TIDAK mengubahnya), dipakai HANYA di bawah
 * route `/workspace/:companySlug/*`. Visual language (sidebar warna solid,
 * collapse, footer) disalin dari `app-shell.tsx` demi §35 Style_Guide
 * ("same sidebar, same topbar" di SELURUH aplikasi) -- bukan desain baru.
 *
 * Company context: `companySlug` dari URL dicocokkan ke daftar company
 * yang BENAR-BENAR bisa diakses user (`useAccessibleCompanies`, sumber
 * yang sama dgn backend `requireCompanyAccess`). Kalau tidak ketemu --
 * baik karena company tidak ada ATAU user tidak punya akses, DIPERLAKUKAN
 * SAMA (redirect ke selector) -- konsisten dgn prinsip anti-enumeration
 * 404-generik yang sudah diterapkan di backend (TASK-DB-ARCH-010 §17/§24).
 */
export function WorkspaceShell() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const { data: meData } = useMe();
  const { data: companiesData, isLoading, isError, error } = useAccessibleCompanies();
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  // Menu Antar Cabang tampil bila multi-cabang aktif + izin baca + akses cabang (UX saja; server tetap penentu).
  const interBranchNav = useInterBranchNav(companySlug ?? "");

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // localStorage tidak tersedia -- abaikan, cuma preferensi tampilan.
    }
  }, [collapsed]);

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-ink/50">Memuat...</div>;
  }

  // BEDAKAN "fetch gagal" (jaringan/server error) dari "company tidak ada
  // di daftar akses user" -- sebelumnya KEDUANYA diperlakukan sama (bounce
  // diam-diam ke /workspace, yang lalu menampilkan pesan "Anda belum
  // memiliki akses...") -- menyesatkan kalau penyebab sebenarnya cuma
  // request gagal sesaat, bukan memang tidak py akses.
  if (isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-rose-600">Gagal memuat daftar perusahaan. {(error as Error).message}</p>
        <p className="text-xs text-ink/40">Coba muat ulang halaman.</p>
        <Link to="/lisensi" className="text-sm font-medium text-accent underline">Periksa / perpanjang lisensi</Link>
      </div>
    );
  }

  const company = companiesData?.companies.find((c) => c.slug === companySlug);
  if (!company) {
    return <Navigate to="/workspace" replace />;
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <aside
        className={`sticky top-0 z-30 flex h-screen shrink-0 flex-col overflow-hidden border-r border-white/5 bg-[#262030] text-white transition-[width] duration-300 ease-in-out ${
          collapsed ? "w-[76px]" : "w-64"
        }`}
      >
        <div className="relative flex items-center gap-2 px-4 py-4">
          <Link to="/workspace" className="flex shrink-0 items-center gap-2">
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
          {WORKSPACE_NAV.map((group, groupIndex) => (
            <div key={groupIndex}>
              {group.group && !collapsed && (
                <p className="mb-1 mt-3 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-white/30">{group.group}</p>
              )}
              {group.items
                .filter((item) => item.requires !== "inter-branch" || interBranchNav.visible)
                .map((item) => {
                const to = item.key ? `/workspace/${companySlug}/${item.key}` : `/workspace/${companySlug}`;
                return (
                  <NavLink
                    key={item.key || "dashboard"}
                    to={to}
                    end={item.key === ""}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-medium transition-all ${
                        collapsed ? "justify-center" : ""
                      } ${isActive ? "bg-white/10 text-white" : "text-white/55 hover:bg-white/5 hover:text-white/90"}`
                    }
                  >
                    <span className={`overflow-hidden transition-all duration-200 ${collapsed ? "w-0 opacity-0" : "w-auto opacity-100"}`}>
                      {item.label}
                    </span>
                    {item.key === "antar-cabang" && interBranchNav.badge > 0 && !collapsed && (
                      <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white" data-testid="ib-nav-badge" title="Transaksi masuk menunggu keputusan Anda">
                        {interBranchNav.badge}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="relative flex flex-col gap-2 border-t border-white/10 px-3 py-3">
          <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center" : ""}`}>
            <UserAvatar name={meData?.user.fullName ?? ""} avatarUrl={meData?.user.avatarUrl} size={collapsed ? 32 : 36} />
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{meData?.user.fullName || "..."}</p>
                <p className="truncate text-xs text-white/40">{meData?.user.email}</p>
              </div>
            )}
          </div>

          <Link
            to="/lisensi"
            title="Lisensi"
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-white/55 hover:bg-white/5 hover:text-white/90 ${collapsed ? "justify-center" : ""}`}
          >
            <KeyRound size={15} />
            {!collapsed && <span>Lisensi</span>}
          </Link>

          <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
            <ThemeMenu variant="dark" placement="up" />
            {!collapsed && <LogoutButton variant="dark" fullName={meData?.user.fullName} />}
          </div>
          {collapsed && <LogoutButton variant="dark" fullName={meData?.user.fullName} collapsed />}
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <LicenseBanner />
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <CompanySwitcher current={company} />
            <Badge tone="accent">{company.role}</Badge>
            <ActiveBranchSelector companySlug={company.slug} />
          </div>
          <GlobalSearch companySlug={company.slug} />
        </header>
        <main className="relative z-10 p-4 md:p-6">
          <Outlet context={{ company }} />
        </main>
        <footer className="relative px-6 pb-4 text-center text-[11px] text-ink/30">Powered by Terra Teknologi Digital</footer>
      </div>
    </div>
  );
}
