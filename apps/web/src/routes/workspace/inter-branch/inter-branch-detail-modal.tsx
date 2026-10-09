import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatIDR } from "../../../lib/format.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import { useAccountOptions } from "../../../features/workspace/use-journal.js";
import {
  useApproveInterBranch,
  useCancelInterBranch,
  useDecideInterBranchReversal,
  useInterBranchDetail,
  useRejectInterBranch,
  useRequestInterBranchReversal,
} from "../../../features/workspace/use-inter-branch.js";
import { INTER_BRANCH_EVENT_LABEL, INTER_BRANCH_TYPE_LABEL, type InterBranchDetail } from "../../../features/workspace/inter-branch-types.js";
import { InterBranchStatusBadges, formatDateTime } from "./inter-branch-status-badge.js";

type Action = "approve" | "reject" | "cancel" | "reverse" | "reversal-reject" | "reversal-cancel";

const primary = "rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50";
const outline = "rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2 disabled:opacity-50";
const danger = "rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-500/10";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink/40">{label}</p>
      <div className="text-sm text-heading">{children}</div>
    </div>
  );
}

function Journals({ detail }: { detail: InterBranchDetail }) {
  if (detail.journals.length === 0) {
    return <p className="text-sm text-ink/50">Belum ada jurnal. Jurnal kedua cabang baru dibuat setelah cabang tujuan menyetujui.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {detail.journals.map((j) => (
        <div key={j.referenceNo} className="rounded-lg border border-line" data-testid="ib-journal">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-2 px-3 py-2 text-xs">
            <span className="font-semibold text-heading">{j.referenceNo}</span>
            <span className="text-ink/50">
              {j.leg === "ORIGINAL" ? "Jurnal asal" : "Jurnal pembalikan"} · sisi {j.side === "FROM" ? "pemberi" : "penerima"} · {j.status}
            </span>
          </div>
          {j.lines ? (
            <table className="w-full text-sm">
              <tbody>
                {j.lines.map((l, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="px-3 py-1.5">
                      {l.accountCode} - {l.accountName}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.debit > 0 ? formatIDR(l.debit) : ""}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.credit > 0 ? formatIDR(l.credit) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-3 py-2 text-xs text-ink/40">Isi jurnal ini milik cabang lain dan tidak ditampilkan.</p>
          )}
        </div>
      ))}
    </div>
  );
}

export function InterBranchDetailModal({ companySlug, id, onClose }: { companySlug: string; id: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  const { data, isLoading, isError, error } = useInterBranchDetail(companySlug, id);
  const accounts = useAccountOptions(companySlug);
  const approve = useApproveInterBranch(companySlug);
  const reject = useRejectInterBranch(companySlug);
  const cancel = useCancelInterBranch(companySlug);
  const requestReversal = useRequestInterBranchReversal(companySlug);
  const decideReversal = useDecideInterBranchReversal(companySlug);

  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [confirmedAccountId, setConfirmedAccountId] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  // Galat aksi muncul di bagian bawah modal yang dapat digulir: bawa ke area terlihat agar pengguna tahu aksinya gagal.
  useEffect(() => {
    if (message) messageRef.current?.scrollIntoView({ block: "nearest" });
  }, [message]);

  const busy = approve.isPending || reject.isPending || cancel.isPending || requestReversal.isPending || decideReversal.isPending;
  const caps = data?.capabilities;

  function open(next: Action) {
    setAction(next);
    setReason("");
    setMessage(null);
    if (next === "approve" && data) setConfirmedAccountId(data.toAccountConfirmed?.id ?? data.toAccountSuggested?.id ?? "");
  }

  async function run(fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setAction(null);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  const reasonOk = reason.trim().length >= 10;
  const toAccounts = (accounts.data?.accounts ?? []).filter(
    (a) => a.isActive && !a.isLocked && a.branchPolicy !== "INTER_BRANCH" && a.branchPolicy !== "SYSTEM_ONLY" && (data?.type !== "TRANSFER_KAS" || Boolean(a.isCash)),
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-line bg-surface" role="dialog" aria-label="Detail Transaksi Antar Cabang">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Detail Transaksi Antar Cabang</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink" aria-label="Tutup">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-6 py-5">
          {isLoading && <p className="text-sm text-ink/50">Memuat...</p>}
          {isError && <p className="text-sm text-rose-600">Transaksi tidak dapat dibuka. {(error as Error).message}</p>}

          {data && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-heading" data-testid="ib-detail-no">
                    {data.transactionNo}
                  </p>
                  <p className="text-sm text-ink/50">
                    {data.fromBranch.name} → {data.toBranch.name}
                  </p>
                </div>
                <InterBranchStatusBadges item={data} />
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Jenis">{INTER_BRANCH_TYPE_LABEL[data.type]}</Field>
                <Field label="Tanggal transaksi">{data.transactionDate}</Field>
                <Field label="Nominal">
                  <span className="font-semibold tabular-nums">{formatIDR(data.amount)}</span>
                </Field>
                <Field label="Dibuat oleh">
                  {data.proposedBy.name}
                  <span className="block text-xs text-ink/40">{formatDateTime(data.proposedAt)}</span>
                </Field>
                <Field label={data.status === "REJECTED" ? "Ditolak oleh" : "Diputuskan oleh"}>
                  {data.decidedBy ? (
                    <>
                      {data.decidedBy.name}
                      {data.selfApproved && <span className="ml-1 text-xs text-ink/40">(pengaju sendiri, OWNER)</span>}
                      {data.decidedAt && <span className="block text-xs text-ink/40">{formatDateTime(data.decidedAt)}</span>}
                    </>
                  ) : (
                    <span className="text-ink/40">-</span>
                  )}
                </Field>
                {data.expiresAt && <Field label="Batas keputusan">{formatDateTime(data.expiresAt)}</Field>}
                <div className="sm:col-span-3">
                  <Field label="Keterangan">
                    {data.description}
                    {data.referenceText && <span className="block text-xs text-ink/40">Bukti: {data.referenceText}</span>}
                  </Field>
                </div>
                {data.decisionReason && (
                  <div className="sm:col-span-3">
                    <Field label="Alasan keputusan">{data.decisionReason}</Field>
                  </div>
                )}
                {(data.fromAccount || data.toAccountSuggested) && (
                  <div className="grid gap-4 sm:col-span-3 sm:grid-cols-2">
                    {data.fromAccount && (
                      <Field label="Akun pemberi">
                        {data.fromAccount.code} - {data.fromAccount.name}
                      </Field>
                    )}
                    {(data.toAccountConfirmed ?? data.toAccountSuggested) && (
                      <Field label={data.toAccountConfirmed ? "Akun penerima (dikonfirmasi)" : "Akun penerima (usulan)"}>
                        {(data.toAccountConfirmed ?? data.toAccountSuggested)!.code} - {(data.toAccountConfirmed ?? data.toAccountSuggested)!.name}
                      </Field>
                    )}
                  </div>
                )}
              </div>

              {data.reversal && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-500/10" data-testid="ib-reversal-box">
                  <p className="font-semibold text-heading">Permintaan pembalikan menunggu</p>
                  <p className="text-ink/70">
                    Diminta {data.reversal.requestedBy.name} · {formatDateTime(data.reversal.requestedAt)} · berlaku sampai {formatDateTime(data.reversal.expiresAt)}
                  </p>
                  {data.reversal.reason && <p className="mt-1 text-ink/70">Alasan: {data.reversal.reason}</p>}
                </div>
              )}

              {caps?.selfApprovalBlocked && (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink/60" data-testid="ib-self-blocked">
                  Anda yang mengajukan transaksi ini. Persetujuan harus dilakukan pengguna lain yang berwenang di cabang tujuan.
                </p>
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold text-heading">Jurnal terkait</h3>
                <Journals detail={data} />
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold text-heading">Riwayat</h3>
                <ol className="flex flex-col gap-1.5 border-l border-line pl-4" data-testid="ib-history">
                  {data.history.map((h, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-medium text-heading">{INTER_BRANCH_EVENT_LABEL[h.action] ?? h.action}</span>
                      <span className="text-ink/50">
                        {" "}
                        · {h.actorLabel} · {formatDateTime(h.createdAt)}
                      </span>
                      {h.reason && <span className="block text-xs text-ink/50">Alasan: {h.reason}</span>}
                    </li>
                  ))}
                </ol>
              </section>

              {action === "approve" && (
                <div className="rounded-lg border border-line p-3" data-testid="ib-approve-panel">
                  <p className="mb-2 text-sm font-semibold text-heading">Setujui dan posting jurnal kedua cabang</p>
                  <label className="mb-1 block text-xs font-medium text-ink/60">Akun cabang Anda yang dikonfirmasi</label>
                  <select className="input-base w-full" value={confirmedAccountId} onChange={(e) => setConfirmedAccountId(e.target.value)} data-testid="ib-confirm-account">
                    {toAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs text-ink/50">
                    Setelah disetujui, jurnal {data.fromBranch.name} dan {data.toBranch.name} dibuat sekaligus. Bila salah satu gagal, tidak ada jurnal yang tersimpan.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" disabled={busy || !confirmedAccountId} className={primary} data-testid="ib-confirm-approve" onClick={() => run(() => approve.mutateAsync({ id, confirmedAccountId }))}>
                      {approve.isPending ? "Memposting..." : "Setujui & Posting"}
                    </button>
                    <button type="button" className={outline} onClick={() => setAction(null)}>
                      Batal
                    </button>
                  </div>
                </div>
              )}

              {(action === "reject" || action === "reverse" || action === "reversal-reject" || action === "cancel" || action === "reversal-cancel") && (
                <div className="rounded-lg border border-line p-3" data-testid="ib-reason-panel">
                  <label className="mb-1 block text-xs font-medium text-ink/60">
                    {action === "reject" || action === "reversal-reject" ? "Alasan penolakan (wajib, minimal 10 karakter)" : action === "reverse" ? "Alasan pembalikan (wajib, minimal 10 karakter)" : "Alasan (opsional)"}
                  </label>
                  <textarea className="input-base w-full" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ib-reason" />
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busy || ((action === "reject" || action === "reverse" || action === "reversal-reject") && !reasonOk)}
                      className={action === "reverse" ? primary : danger}
                      data-testid="ib-confirm-action"
                      onClick={() =>
                        run(() => {
                          if (action === "reject") return reject.mutateAsync({ id, reason: reason.trim() });
                          if (action === "cancel") return cancel.mutateAsync({ id, reason: reason.trim() });
                          if (action === "reverse") return requestReversal.mutateAsync({ id, reason: reason.trim() });
                          return decideReversal.mutateAsync({ id, approvalId: data.reversal!.approvalId, action: action === "reversal-reject" ? "reject" : "cancel", reason: reason.trim() });
                        })
                      }
                    >
                      {action === "reject" || action === "reversal-reject" ? "Tolak" : action === "reverse" ? "Minta Pembalikan" : "Batalkan"}
                    </button>
                    <button type="button" className={outline} onClick={() => setAction(null)}>
                      Kembali
                    </button>
                  </div>
                </div>
              )}

              {message && (
                <p ref={messageRef} className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10" role="alert" data-testid="ib-action-error">
                  {message}
                </p>
              )}
            </>
          )}
        </div>

        {data && caps && !action && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4" data-testid="ib-actions">
            {caps.canApprove && (
              <button type="button" className={primary} data-testid="ib-approve" onClick={() => open("approve")}>
                Setujui
              </button>
            )}
            {caps.canReject && (
              <button type="button" className={danger} data-testid="ib-reject" onClick={() => open("reject")}>
                Tolak
              </button>
            )}
            {caps.canCancel && (
              <button type="button" className={outline} data-testid="ib-cancel" onClick={() => open("cancel")}>
                Batalkan Pengajuan
              </button>
            )}
            {caps.canRequestReversal && (
              <button type="button" className={outline} data-testid="ib-reverse" onClick={() => open("reverse")}>
                Minta Pembalikan
              </button>
            )}
            {data.reversal && caps.canApproveReversal && (
              <button type="button" className={primary} data-testid="ib-reversal-approve" disabled={busy} onClick={() => run(() => decideReversal.mutateAsync({ id, approvalId: data.reversal!.approvalId, action: "approve" }))}>
                Setujui Pembalikan
              </button>
            )}
            {data.reversal && caps.canRejectReversal && (
              <button type="button" className={danger} onClick={() => open("reversal-reject")}>
                Tolak Pembalikan
              </button>
            )}
            {data.reversal && caps.canCancelReversal && (
              <button type="button" className={outline} onClick={() => open("reversal-cancel")}>
                Batalkan Permintaan Pembalikan
              </button>
            )}
            <button type="button" className={outline} onClick={onClose}>
              Tutup
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
