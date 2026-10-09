import { useEffect, useState } from "react";
import { Card } from "../../../components/ui.js";
import { useJournalList, useReverseByReference } from "../../../features/workspace/use-journal.js";
import { JournalStatusBadge } from "./journal-status-badge.js";

/**
 * Proses Reversal Jurnal (terpisah dari Daftar/Buat). Pengguna wajib mengisi
 * Referensi Transaksi, Tanggal Transaksi, dan Alasan. Tanggal reversal SAMA
 * dengan tanggal jurnal asli -- server menolak tanggal yang tidak cocok dan
 * tidak pernah memakai tanggal hari ini. Jurnal asli tidak dihapus/diubah
 * isinya; hanya statusnya menjadi REVERSED dan dibuat jurnal pembalik baru.
 */
export function JournalReversalTab({ companySlug, prefill }: { companySlug: string; prefill?: { referenceNo: string; entryDate: string } | null }) {
  const [referenceNo, setReferenceNo] = useState(prefill?.referenceNo ?? "");
  const [entryDate, setEntryDate] = useState(prefill?.entryDate ?? "");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<{ reversalReferenceNo: string; reversalDate: string } | null>(null);

  useEffect(() => {
    if (prefill) {
      setReferenceNo(prefill.referenceNo);
      setEntryDate(prefill.entryDate);
      setDone(null);
    }
  }, [prefill]);

  const ref = referenceNo.trim();
  const lookup = useJournalList(companySlug, { search: ref || undefined, pageSize: 10 });
  const match = ref ? lookup.data?.journals.find((j) => j.referenceNo === ref) : undefined;
  const reverse = useReverseByReference(companySlug);

  const matchDate = match ? String(match.entryDate).slice(0, 10) : null;
  const dateMismatch = Boolean(match && entryDate && matchDate !== entryDate);
  const canSubmit = Boolean(ref && entryDate && reason.trim() && match?.status === "POSTED" && !dateMismatch);

  async function handleSubmit() {
    if (!canSubmit) return;
    if (!confirm(`Reversal jurnal ${ref} bertanggal ${entryDate}? Jurnal asli tetap tersimpan dan berstatus REVERSED.`)) return;
    const res = await reverse.mutateAsync({ referenceNo: ref, entryDate, reason: reason.trim() });
    setDone({ reversalReferenceNo: res.reversalReferenceNo, reversalDate: res.reversalDate });
    setReason("");
  }

  return (
    <Card className="max-w-2xl p-6">
      <h2 className="mb-1 text-base font-bold text-heading">Reversal Jurnal</h2>
      <p className="mb-4 text-sm text-ink/50">
        Membalik debit/kredit jurnal yang sudah diposting. Tanggal reversal otomatis sama dengan tanggal transaksi asli.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-ink/60">Referensi Transaksi</label>
          <input value={referenceNo} onChange={(e) => { setReferenceNo(e.target.value); setDone(null); }} placeholder="mis. JRN-0001" className="input-base w-full" />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-ink/60">Tanggal Transaksi</label>
          <input type="date" value={entryDate} onChange={(e) => { setEntryDate(e.target.value); setDone(null); }} className="input-base w-full" />
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-1.5 block text-xs font-medium text-ink/60">Alasan Reversal</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. Koreksi kesalahan input" className="input-base w-full" />
      </div>

      {ref && lookup.data && !match && <p className="mt-3 text-sm text-rose-600">Jurnal dengan referensi "{ref}" tidak ditemukan.</p>}
      {match && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
          <JournalStatusBadge status={match.status} />
          <span className="text-heading">{match.referenceNo}</span>
          <span className="text-ink/50">tanggal {matchDate}</span>
          <span className="text-ink/60">{match.description || ""}</span>
        </div>
      )}
      {match && match.status !== "POSTED" && <p className="mt-2 text-sm text-rose-600">Hanya jurnal berstatus POSTED yang dapat direversal (status sekarang: {match.status}).</p>}
      {dateMismatch && <p className="mt-2 text-sm text-rose-600">Tanggal tidak cocok. Tanggal jurnal {ref} adalah {matchDate}.</p>}

      {reverse.isError && <p className="mt-3 text-sm text-rose-600">{(reverse.error as Error).message}</p>}
      {done && (
        <p className="mt-3 text-sm text-emerald-600">
          ✓ Reversal berhasil: {done.reversalReferenceNo} (tanggal {done.reversalDate}). Jurnal asli berstatus REVERSED.
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmit || reverse.isPending}
        onClick={handleSubmit}
        className="mt-5 rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
      >
        {reverse.isPending ? "Memproses..." : "Proses Reversal"}
      </button>
    </Card>
  );
}
