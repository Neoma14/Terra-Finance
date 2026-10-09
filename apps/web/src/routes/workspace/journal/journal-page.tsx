import { List, PenLine, Undo2, UploadCloud } from "lucide-react";
import { useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useJournalDetail } from "../../../features/workspace/use-journal.js";
import { JournalDetailModal } from "./journal-detail-modal.js";
import { JournalFormPanel } from "./journal-form-panel.js";
import { JournalImportTab } from "./journal-import-tab.js";
import { JournalListTab } from "./journal-list-tab.js";
import { JournalReversalTab } from "./journal-reversal-tab.js";

type Tab = "list" | "manual" | "reversal" | "import";

const TABS: { key: Tab; label: string; icon: typeof List }[] = [
  { key: "list", label: "Daftar Jurnal", icon: List },
  { key: "manual", label: "Entry Manual", icon: PenLine },
  { key: "reversal", label: "Reversal Jurnal", icon: Undo2 },
  { key: "import", label: "Import Excel", icon: UploadCloud },
];

/**
 * Journal Module nyata di atas foundation workspace baru (TASK-DB-ARCH-014)
 * -- menggantikan placeholder nav "jurnal" dari TASK-DB-ARCH-013. Pola tab
 * SAMA dgn `journal-page.tsx` legacy (konsistensi UX, §9 instruksi), tapi
 * SELURUH data lewat `/api/company-db/:slug/...` (company-scoped) --
 * TIDAK ADA pemanggilan API legacy di sini.
 */
export function JournalPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [tab, setTab] = useState<Tab>("list");
  // Hasil pencarian global membuka jurnal lewat ?journalId=
  const [searchParams, setSearchParams] = useSearchParams();
  const [detailId, setDetailId] = useState<string | null>(searchParams.get("journalId"));
  const [reversalPrefill, setReversalPrefill] = useState<{ referenceNo: string; entryDate: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  function closeDetail() {
    setDetailId(null);
    if (searchParams.has("journalId")) setSearchParams({}, { replace: true });
  }

  const editingDetailQuery = useJournalDetail(company.slug, editingId ?? undefined);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Jurnal</h1>
        <p className="text-sm text-ink/50">Entry manual, import Excel, dan daftar jurnal {company.name}.</p>
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

      {tab === "list" && <JournalListTab companySlug={company.slug} onOpenDetail={setDetailId} />}

      {tab === "manual" &&
        (editingId && editingDetailQuery.data ? (
          <JournalFormPanel
            companySlug={company.slug}
            editingDetail={editingDetailQuery.data}
            onDone={() => {
              setEditingId(null);
              setTab("list");
            }}
          />
        ) : (
          <JournalFormPanel companySlug={company.slug} onDone={() => setTab("list")} />
        ))}

      {tab === "reversal" && <JournalReversalTab companySlug={company.slug} prefill={reversalPrefill} />}

      {tab === "import" && <JournalImportTab companySlug={company.slug} />}

      {detailId && (
        <JournalDetailModal
          companySlug={company.slug}
          journalId={detailId}
          onClose={closeDetail}
          onReverse={(j) => {
            setReversalPrefill({ referenceNo: j.referenceNo, entryDate: j.entryDate });
            closeDetail();
            setTab("reversal");
          }}
          onEdit={() => {
            setEditingId(detailId);
            closeDetail();
            setTab("manual");
          }}
        />
      )}
    </div>
  );
}
