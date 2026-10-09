import { ArrowLeft, Building2, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LicenseBanner } from "../../components/license-banner.js";
import { Badge } from "../../components/ui.js";
import { Logo } from "../../components/logo.js";
import { UserAvatar } from "../../components/avatar.js";
import { LogoutButton } from "../../components/logout-button.js";
import { useMe } from "../../features/auth/use-auth.js";
import { useAccessibleCompanies, type CreatedCompany } from "../../features/workspace/use-workspace.js";
import { AddCompanyModal } from "./add-company-modal.js";

const ROLE_BADGE_TONE: Record<string, "accent" | "neutral"> = {
  OWNER: "accent",
  ADMIN: "accent",
};

/**
 * Company Selector (TASK-DB-ARCH-013) -- halaman MASUK ke workspace
 * company-scoped baru, `/workspace`. BEDA mendasar dari `/companies`
 * legacy (`companies-page.tsx`): daftar di sini HANYA company yang
 * `company_access`-nya ACTIVE milik user yang login (`GET
 * /api/company-db`, difilter server-side) -- bukan seluruh registry,
 * dan setiap card menunjukkan role user DI perusahaan itu (konsep yang
 * sengaja TIDAK ADA di legacy, lihat komentar companies-page.tsx).
 */
export function CompanySelectorPage() {
  const { data: meData } = useMe();
  const { data, isLoading, isError, error } = useAccessibleCompanies();
  const navigate = useNavigate();
  const companies = data?.companies ?? [];
  const [showAddModal, setShowAddModal] = useState(false);
  const [createdName, setCreatedName] = useState<string | null>(null);

  function handleCreated(company: CreatedCompany) {
    setShowAddModal(false);
    setCreatedName(company.name);
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 md:px-6">
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <span className="font-semibold tracking-tight text-heading">TERRA FINANCE</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <UserAvatar name={meData?.user.fullName ?? ""} avatarUrl={meData?.user.avatarUrl} size={28} />
            <span className="hidden text-sm font-medium text-ink/70 sm:inline">{meData?.user.fullName}</span>
          </div>
          <LogoutButton fullName={meData?.user.fullName} />
        </div>
      </header>

      <LicenseBanner />

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-10 md:px-6">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-ink/60 hover:text-ink"
        >
          <ArrowLeft size={15} /> Kembali
        </button>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="vt-page-title text-xl font-bold text-heading">Daftar Perusahaan</h1>
            <p className="text-sm text-ink/50">Kelola dan pilih perusahaan Anda. Hanya perusahaan yang Anda miliki aksesnya yang tampil.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setCreatedName(null);
              setShowAddModal(true);
            }}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-600"
          >
            <Plus size={16} /> Tambah Perusahaan
          </button>
        </div>

        {createdName && (
          <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
            ✓ Perusahaan "{createdName}" berhasil dibuat dan sudah muncul di daftar. Pilih perusahaan tersebut untuk membuka workspace-nya.
          </p>
        )}

        {isLoading && <p className="text-sm text-ink/40">Memuat...</p>}

        {isError && (
          <div className="rounded-xl border border-dashed border-rose-300 p-10 text-center">
            <p className="text-sm text-rose-600">Gagal memuat daftar perusahaan. {(error as Error).message}</p>
            <Link to="/lisensi" className="mt-2 inline-block text-sm font-medium text-accent underline">
              Periksa / perpanjang lisensi
            </Link>
          </div>
        )}

        {!isLoading && !isError && companies.length === 0 && (
          <div className="rounded-xl border border-dashed border-line p-10 text-center">
            <p className="text-sm text-ink/60">
              Anda belum memiliki akses ke perusahaan manapun. Hubungi Owner/Admin perusahaan Anda untuk diberikan akses.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {companies.map((c) => (
            <button
              key={c.companyId}
              type="button"
              onClick={() => navigate(`/workspace/${c.slug}`)}
              className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-5 text-left transition-all hover:-translate-y-0.5 hover:border-accent"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-heading">
                <Building2 size={22} />
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-heading">{c.name}</div>
                <div className="mt-2">
                  <Badge tone={ROLE_BADGE_TONE[c.role] ?? "neutral"}>{c.role}</Badge>
                </div>
              </div>
            </button>
          ))}
        </div>
      </main>

      {showAddModal && <AddCompanyModal onClose={() => setShowAddModal(false)} onCreated={handleCreated} />}
    </div>
  );
}
