import { BookOpen, Landmark, NotebookText, Scale } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { JournalPage } from "../journal/journal-page.js";
import { LedgerPage } from "../ledger/ledger-page.js";
import { TrialBalancePage } from "../trial-balance/trial-balance-page.js";
import { CashBankView } from "./cash-bank-view.js";

type Tab = "jurnal" | "ledger" | "kas-bank" | "trial-balance";

/**
 * Buku / Laporan Buku (TASK-023 §5/§9) -- SATU komponen, dipakai utk DUA
 * nav key ("buku" & "laporan-buku") krn spesifikasinya tumpang-tindih
 * (Jurnal + Buku Besar + Kas/Bank, "Laporan Buku" tambah Trial Balance).
 * Membuat dua halaman custom terpisah utk isi yang hampir identik akan
 * berarti menduplikasi query accounting yang SAMA dua kali -- justru
 * yang dilarang instruksi §5/§9 ("jangan membuat query yang menghasilkan
 * angka berbeda dari ledger"). Tiap tab me-render ULANG komponen yang
 * SUDAH ADA (JournalPage/LedgerPage/TrialBalancePage) apa adanya -- tidak
 * ada logic akuntansi baru di file ini sama sekali.
 */
export function BooksHubPage({ includeTrialBalance }: { includeTrialBalance?: boolean }) {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [tab, setTab] = useState<Tab>("jurnal");

  const tabs: { key: Tab; label: string; icon: typeof BookOpen }[] = [
    { key: "jurnal", label: "Jurnal", icon: NotebookText },
    { key: "ledger", label: "Buku Besar", icon: BookOpen },
    { key: "kas-bank", label: "Kas & Bank", icon: Landmark },
    ...(includeTrialBalance ? [{ key: "trial-balance" as Tab, label: "Trial Balance", icon: Scale }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">{includeTrialBalance ? "Laporan Buku" : "Buku"}</h1>
        <p className="text-sm text-ink/50">Jurnal, buku besar, dan kas/bank {company.name}.</p>
      </div>

      <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "jurnal" && <JournalPage />}
      {tab === "ledger" && <LedgerPage />}
      {tab === "kas-bank" && <CashBankView companySlug={company.slug} />}
      {tab === "trial-balance" && includeTrialBalance && <TrialBalancePage />}
    </div>
  );
}
