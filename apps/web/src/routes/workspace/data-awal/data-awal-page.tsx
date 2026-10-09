import { ArrowRight, Check } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useCompanyProfile } from "../../../features/workspace/use-company-profile.js";
import { useAccountList } from "../../../features/workspace/use-accounts.js";
import { usePeriodOptions } from "../../../features/workspace/use-journal.js";
import { useOpeningBalance } from "../../../features/workspace/use-opening-balance.js";
import { GeneratePeriodsModal } from "./generate-periods-modal.js";

interface ChecklistItem {
  label: string;
  description: string;
  status: string;
  done: boolean;
  navKey: string;
}

/**
 * Data Awal (TASK-023 §4) -- PUSAT SETUP, bukan accounting engine kedua.
 * Setiap baris cuma status ringkas + link ke modul yang SUDAH ADA (COA,
 * Periode, Opening Balance, Profil Perusahaan) -- tidak ada logic/
 * perhitungan baru di sini sama sekali, semua data dari hook yang sudah
 * dipakai halaman lain. Saldo awal TETAP lewat Opening Balance existing
 * (`/workspace/:slug/opening-balance`), tidak ada tabel saldo awal baru.
 */
export function DataAwalPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const navigate = useNavigate();
  const [showGeneratePeriods, setShowGeneratePeriods] = useState(false);
  const canManagePeriods = company.role === "OWNER" || company.role === "ADMIN";

  const profileQuery = useCompanyProfile(company.slug);
  const accountsQuery = useAccountList(company.slug, { pageSize: 1 });
  const periodsQuery = usePeriodOptions(company.slug);
  const openingBalanceQuery = useOpeningBalance(company.slug);

  const loading = profileQuery.isLoading || accountsQuery.isLoading || periodsQuery.isLoading || openingBalanceQuery.isLoading;

  const profile = profileQuery.data?.profile;
  const profileComplete = Boolean(profile?.address && profile?.phone && profile?.email);
  const accountCount = accountsQuery.data?.total ?? 0;
  const periodCount = periodsQuery.data?.periods.length ?? 0;
  const obStatus = openingBalanceQuery.data;

  const items: ChecklistItem[] = [
    {
      label: "Profil Perusahaan",
      description: "Nama, alamat, dan kontak perusahaan.",
      status: profileComplete ? "Lengkap" : "Belum lengkap",
      done: profileComplete,
      navKey: "perusahaan",
    },
    {
      label: "Chart of Accounts",
      description: "Daftar akun untuk pencatatan transaksi.",
      status: accountCount > 0 ? `${accountCount} akun` : "Belum ada akun",
      done: accountCount > 0,
      navKey: "accounts",
    },
    {
      label: "Periode Fiskal",
      description: "Periode akuntansi tempat jurnal dicatat.",
      status: periodCount > 0 ? `${periodCount} periode` : "Belum ada periode",
      done: periodCount > 0,
      navKey: "jurnal",
    },
    {
      label: "Saldo Awal",
      description: "Saldo pembuka sebelum transaksi berjalan dicatat.",
      status: !obStatus?.exists ? "Belum diisi" : obStatus.status === "POSTED" ? "Sudah diposting" : obStatus.status === "DRAFT" ? "Draft, belum diposting" : "Direversal",
      done: obStatus?.status === "POSTED",
      navKey: "opening-balance",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Data Awal</h1>
        <p className="text-sm text-ink/50">Pusat setup data awal {company.name} sebelum mulai mencatat transaksi.</p>
      </div>

      <Card>
        {loading ? (
          <p className="p-6 text-sm text-ink/40">Memuat...</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.navKey}
                  onClick={() => navigate(`/workspace/${company.slug}/${item.navKey}`)}
                  className="cursor-pointer border-t border-line/60 first:border-t-0 hover:bg-surface-2/60"
                >
                  <td className="w-8 px-4 py-3.5">
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full ${item.done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" : "bg-surface-2 text-ink/30"}`}
                    >
                      {item.done && <Check size={12} strokeWidth={3} />}
                    </span>
                  </td>
                  <td className="px-2 py-3.5">
                    <p className="font-medium text-heading">{item.label}</p>
                    <p className="text-xs text-ink/40">{item.description}</p>
                  </td>
                  <td className="px-4 py-3.5 text-right text-ink/60">{item.status}</td>
                  <td className="w-40 px-4 py-3.5 text-right">
                    {item.navKey === "jurnal" && canManagePeriods ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowGeneratePeriods(true);
                        }}
                        className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink/70 hover:bg-surface-2"
                      >
                        Buat Periode
                      </button>
                    ) : (
                      <ArrowRight size={14} className="ml-auto text-ink/30" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {showGeneratePeriods && <GeneratePeriodsModal companySlug={company.slug} onClose={() => setShowGeneratePeriods(false)} />}
    </div>
  );
}
