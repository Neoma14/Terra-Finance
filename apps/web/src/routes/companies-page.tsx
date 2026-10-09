import { INDUSTRY_TEMPLATE_LABELS, type IndustryTemplate } from "@konsultan/shared";
import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CompanyLogo } from "../components/avatar.js";
import { INDUSTRY_ICONS, IndustryBadge } from "../components/ui.js";
import { useCompanies, useCreateCompany } from "../features/companies/use-companies.js";

const INDUSTRY_OPTIONS = Object.keys(INDUSTRY_TEMPLATE_LABELS) as IndustryTemplate[];

/** Perusahaan KLIEN yang dikelola lewat instalasi ini -- beda dari "Profil
 * Saya" di Pengaturan (identitas firm konsultan sendiri). Field & logika
 * form ini SENGAJA disamakan persis dgn companies-home-page.tsx versi
 * online (slugify sama, fiscalYearStartMonth/currency di-hardcode 1/"IDR"
 * krn online juga tidak expose itu sbg input) -- BEDA: semua user (admin &
 * staff) di instalasi ini bisa lihat & kelola semua perusahaan, jadi tidak
 * ada badge "roleInCompany" spt versi online (tidak ada per-user access). */
export function CompaniesPage() {
  const { data, isLoading } = useCompanies();
  const createCompany = useCreateCompany();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [industryTemplate, setIndustryTemplate] = useState<IndustryTemplate>("general");

  function slugify(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const result = await createCompany.mutateAsync({
      name,
      slug: slugify(name),
      industry: industry || undefined,
      industryTemplate,
      fiscalYearStartMonth: 1,
      currency: "IDR",
    });
    setName("");
    setIndustry("");
    setIndustryTemplate("general");
    setShowForm(false);
    navigate(`/c/${result.company.slug}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Perusahaan</h1>
          <p className="text-sm text-ink/50">Daftar perusahaan klien yang Anda kelola.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-600"
        >
          <Plus size={16} />
          Tambah Perusahaan
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-line bg-surface p-6">
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink/80">Nama Perusahaan</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
                placeholder="mis. PT ABDI WARDHANA"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink/80">Industri (opsional)</label>
              <input
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
                placeholder="mis. Manufaktur, Ritel"
              />
            </div>
          </div>

          <label className="mb-2 block text-sm font-medium text-ink/80">Template Laporan Keuangan</label>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {INDUSTRY_OPTIONS.map((key) => {
              const Icon = INDUSTRY_ICONS[key];
              const active = industryTemplate === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIndustryTemplate(key)}
                  className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-colors ${
                    active ? "border-accent bg-accent-50" : "border-line hover:bg-surface-2"
                  }`}
                >
                  <Icon size={22} className={active ? "text-accent-600" : "text-heading/60"} />
                  <span className={`text-xs font-medium leading-tight ${active ? "text-accent-600" : "text-ink/70"}`}>
                    {INDUSTRY_TEMPLATE_LABELS[key]}
                  </span>
                </button>
              );
            })}
          </div>

          {createCompany.isError && (
            <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
              {(createCompany.error as Error).message}
            </p>
          )}
          <button
            type="submit"
            disabled={createCompany.isPending}
            className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {createCompany.isPending ? "Membuat..." : "Buat Perusahaan"}
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-ink/40">Memuat...</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.companies.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => navigate(`/c/${c.slug}`)}
            className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-5 text-left transition-all hover:-translate-y-0.5 hover:border-accent"
          >
            <CompanyLogo industryTemplate={c.industryTemplate} logoUrl={c.logoUrl} size={44} />
            <div className="min-w-0">
              <div className="truncate font-semibold text-heading">{c.name}</div>
              <div className="truncate text-sm text-ink/60">{c.industry ?? "-"}</div>
              <div className="mt-2">
                <IndustryBadge template={c.industryTemplate} />
              </div>
            </div>
          </button>
        ))}
      </div>

      {!isLoading && data?.companies.length === 0 && (
        <div className="rounded-xl border border-dashed border-line p-10 text-center">
          <p className="text-sm text-ink/60">Belum ada perusahaan. Tambahkan klien pertama Anda.</p>
        </div>
      )}
    </div>
  );
}
