import { List, Plus, UploadCloud } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useAccountDetail } from "../../../features/workspace/use-accounts.js";
import { AccountDetailModal } from "./account-detail-modal.js";
import { AccountFormPanel } from "./account-form-panel.js";
import { AccountImportTab } from "./account-import-tab.js";
import { AccountList } from "./account-list.js";

type Tab = "list" | "form" | "import";

const TABS: { key: Tab; label: string; icon: typeof List }[] = [
  { key: "list", label: "Daftar Akun", icon: List },
  { key: "form", label: "Tambah Akun", icon: Plus },
  { key: "import", label: "Import Excel", icon: UploadCloud },
];

/**
 * Chart of Accounts Module nyata di atas foundation workspace
 * (TASK-DB-ARCH-015) -- menggantikan placeholder nav "perusahaan"... Rute
 * ditempatkan di `/workspace/:companySlug/accounts` (lihat App.tsx),
 * nav leaf-nya SENGAJA TETAP dipetakan dari key existing (lihat
 * nav-config.ts) -- bukan menambah leaf baru di luar struktur yang sudah
 * disetujui TASK-DB-ARCH-013.
 */
export function AccountsPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [tab, setTab] = useState<Tab>("list");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingDetailQuery = useAccountDetail(company.slug, editingId ?? undefined);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Chart of Accounts</h1>
        <p className="text-sm text-ink/50">Daftar akun, tambah/edit akun, dan import Excel untuk {company.name}.</p>
      </div>

      <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key);
              setEditingId(null);
            }}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "list" && <AccountList companySlug={company.slug} onOpenDetail={setDetailId} />}

      {tab === "form" &&
        (editingId && editingDetailQuery.data ? (
          <AccountFormPanel
            companySlug={company.slug}
            editingAccount={editingDetailQuery.data.account}
            onDone={() => {
              setEditingId(null);
              setTab("list");
            }}
          />
        ) : (
          <AccountFormPanel companySlug={company.slug} onDone={() => setTab("list")} />
        ))}

      {tab === "import" && <AccountImportTab companySlug={company.slug} />}

      {detailId && (
        <AccountDetailModal
          companySlug={company.slug}
          accountId={detailId}
          canLock={company.role === "OWNER" || company.role === "ADMIN"}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            setEditingId(detailId);
            setDetailId(null);
            setTab("form");
          }}
        />
      )}
    </div>
  );
}
