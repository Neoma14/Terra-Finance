import { X } from "lucide-react";
import { formatIDR } from "../../../lib/format.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import { useAccountOptions, useDeleteDraftJournal, usePostJournal, useJournalDetail } from "../../../features/workspace/use-journal.js";
import { JournalStatusBadge } from "./journal-status-badge.js";

/**
 * Detail + actions (Post/Reverse/Delete/Edit) satu jurnal -- pola modal
 * sama dgn `add-account-modal.tsx` (overlay + panel, TIDAK didesain ulang,
 * §9 instruksi "jangan membuat desain berbeda-beda").
 */
export function JournalDetailModal({
  companySlug,
  journalId,
  onClose,
  onEdit,
  onReverse,
}: {
  companySlug: string;
  journalId: string;
  onClose: () => void;
  onEdit: () => void;
  /** Membuka proses Reversal Jurnal (tab terpisah) dengan referensi + tanggal terisi. */
  onReverse?: (journal: { referenceNo: string; entryDate: string }) => void;
}) {
  useEscapeToClose(onClose);
  const { data, isLoading, isError, error } = useJournalDetail(companySlug, journalId);
  const { data: accountsData } = useAccountOptions(companySlug);
  const accountById = new Map((accountsData?.accounts ?? []).map((a) => [a.id, a]));
  const postJournal = usePostJournal(companySlug);
  const deleteDraft = useDeleteDraftJournal(companySlug);

  const journal = data?.journal;
  const lines = data?.lines ?? [];
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);

  async function handlePost() {
    await postJournal.mutateAsync(journalId);
  }
  async function handleDelete() {
    if (!confirm("Hapus draft jurnal ini? Tindakan tidak dapat dibatalkan.")) return;
    await deleteDraft.mutateAsync(journalId);
    onClose();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Detail Jurnal</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          {isLoading && <p className="text-sm text-ink/50">Memuat...</p>}
          {isError && <p className="text-sm text-rose-600">Gagal memuat detail jurnal. {(error as Error).message}</p>}
          {journal && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-heading">{journal.reference_no ?? "(tanpa nomor)"}</p>
                  <p className="text-sm text-ink/50">
                    {journal.entry_date.slice(0, 10)} {journal.description && `- ${journal.description}`}
                  </p>
                </div>
                <JournalStatusBadge status={journal.status} />
              </div>

              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                    <tr>
                      <th className="px-3 py-2">Akun</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Kredit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const account = accountById.get(l.account_id);
                      return (
                        <tr key={l.id} className="border-t border-line/60">
                          <td className="px-3 py-1.5">{account ? `${account.code} - ${account.name}` : l.account_id}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{l.debit ? formatIDR(Number(l.debit)) : ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{l.credit ? formatIDR(Number(l.credit)) : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line bg-surface-2/60 font-semibold">
                      <td className="px-3 py-1.5">Total</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatIDR(totalDebit)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatIDR(totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {journal.reversal_of_journal_id && <p className="text-xs text-ink/50">Reversal dari jurnal lain.</p>}
              {journal.reversal_reason && <p className="text-xs text-ink/50">Alasan reversal: {journal.reversal_reason}</p>}

              {(postJournal.isError || deleteDraft.isError) && (
                <p className="text-sm text-rose-600">
                  {((postJournal.error || deleteDraft.error) as Error).message}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                {journal.status === "DRAFT" && (
                  <>
                    <button type="button" onClick={handlePost} disabled={postJournal.isPending} className="rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
                      {postJournal.isPending ? "Memposting..." : "Post Jurnal"}
                    </button>
                    <button type="button" onClick={onEdit} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2">
                      Edit
                    </button>
                    <button type="button" onClick={handleDelete} disabled={deleteDraft.isPending} className="rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-500/10">
                      {deleteDraft.isPending ? "Menghapus..." : "Hapus Draft"}
                    </button>
                  </>
                )}
                {journal.status === "POSTED" && onReverse && journal.reference_no && (
                  <button
                    type="button"
                    onClick={() => onReverse({ referenceNo: journal.reference_no!, entryDate: journal.entry_date.slice(0, 10) })}
                    className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2"
                  >
                    Reversal
                  </button>
                )}
              </div>

            </>
          )}
        </div>
      </div>
    </div>
  );
}
