import { AlertTriangle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatIDR } from "../../../lib/format.js";
import { todayLocal } from "../../../lib/date.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import { useAccountOptions, type JournalAccountOption } from "../../../features/workspace/use-journal.js";
import { useCreateInterBranch, useInterBranchOptions } from "../../../features/workspace/use-inter-branch.js";
import { INTER_BRANCH_TYPE_LABEL, type InterBranchType } from "../../../features/workspace/inter-branch-types.js";

/** "1.000.000" / "1000000,50" -> 1000000.5; NaN bila bukan angka. Titik = pemisah ribuan, koma = desimal (format Indonesia). */
export function parseRupiah(raw: string): number {
  const cleaned = raw.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

/** Akun yang boleh dipilih pengguna: aktif, tidak terkunci, bukan akun antar-cabang/sistem (akun antar-cabang dipilih otomatis oleh sistem). */
function selectable(account: JournalAccountOption, type: InterBranchType): boolean {
  if (!account.isActive || account.isLocked) return false;
  if (account.branchPolicy === "INTER_BRANCH" || account.branchPolicy === "SYSTEM_ONLY") return false;
  return type === "TRANSFER_KAS" ? Boolean(account.isCash) : true; // API mengirim 0/1 (SQLite), bukan boolean
}

const label = "mb-1 block text-xs font-medium text-ink/60";

export function InterBranchFormModal({ companySlug, onClose, onCreated }: { companySlug: string; onClose: () => void; onCreated: (id: string) => void }) {
  useEscapeToClose(onClose);
  const options = useInterBranchOptions(companySlug, true);
  const accountsQuery = useAccountOptions(companySlug);
  const create = useCreateInterBranch(companySlug);

  const [type, setType] = useState<InterBranchType>("TRANSFER_KAS");
  const [toBranchId, setToBranchId] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [amountText, setAmountText] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [description, setDescription] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  // Kunci idempotensi dibuat saat formulir dibuka: klik ganda / ulang setelah jaringan terputus tidak membuat transaksi ganda.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const accounts = useMemo(() => (accountsQuery.data?.accounts ?? []).filter((a) => selectable(a, type)), [accountsQuery.data, type]);
  const destinations = options.data?.destinations ?? [];
  const destination = destinations.find((d) => d.id === toBranchId);
  const amount = parseRupiah(amountText);
  const fromAccount = accounts.find((a) => a.id === fromAccountId);

  function validate(): string | null {
    if (!destination) return "Pilih cabang tujuan.";
    if (!destination.ready) return destination.reason ?? "Akun antarkantor untuk cabang tujuan ini belum siap.";
    if (!date) return "Tanggal transaksi wajib diisi.";
    if (!Number.isFinite(amount) || amount <= 0) return "Nominal harus lebih dari nol (maksimal dua desimal).";
    if (!fromAccountId) return "Pilih akun asal.";
    if (!toAccountId) return "Pilih usulan akun penerima.";
    if (description.trim().length < 3) return "Keterangan wajib diisi (minimal 3 karakter).";
    return null;
  }

  async function submit() {
    const problem = validate();
    if (problem) return setError(problem);
    setError(null);
    try {
      const res = await create.mutateAsync({ type, toBranchId, transactionDate: date, amount, fromAccountId, toAccountSuggestedId: toAccountId, description: description.trim(), referenceText: referenceText.trim() || null, idempotencyKey });
      onCreated(res.transaction.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-surface" role="dialog" aria-label="Transaksi Antar Cabang Baru">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Transaksi Antar Cabang Baru</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink" aria-label="Tutup">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-4 overflow-y-auto px-6 py-5 sm:grid-cols-2">
          {options.isLoading && <p className="text-sm text-ink/50 sm:col-span-2">Memuat pilihan...</p>}
          {options.isError && <p className="text-sm text-rose-600 sm:col-span-2">Tidak dapat membuka formulir. {(options.error as Error).message}</p>}

          {options.data && (
            <>
              <div>
                <label className={label}>Jenis transaksi</label>
                <select
                  className="input-base w-full"
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value as InterBranchType);
                    setFromAccountId("");
                    setToAccountId("");
                  }}
                  data-testid="ib-type"
                >
                  {(Object.keys(INTER_BRANCH_TYPE_LABEL) as InterBranchType[]).map((t) => (
                    <option key={t} value={t}>
                      {INTER_BRANCH_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ink/40">{type === "TRANSFER_KAS" ? "Perpindahan uang: kedua akun harus akun kas." : "Biaya/transaksi yang ditanggung atas nama cabang lain."}</p>
              </div>

              <div>
                <label className={label}>Cabang asal (pemberi)</label>
                <div className="input-base flex w-full items-center bg-surface-2 text-ink/70" data-testid="ib-from-branch">
                  {options.data.fromBranch.name}
                </div>
                <p className="mt-1 text-xs text-ink/40">Mengikuti cabang kerja aktif Anda.</p>
              </div>

              <div>
                <label className={label}>Cabang tujuan (penerima)</label>
                <select className="input-base w-full" value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} data-testid="ib-to-branch">
                  <option value="">Pilih cabang tujuan...</option>
                  {destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.ready ? "" : " (akun belum siap)"}
                    </option>
                  ))}
                </select>
                {destination && !destination.ready && (
                  <p className="mt-1 flex items-start gap-1 text-xs text-amber-600">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {destination.reason}
                  </p>
                )}
                {destinations.length === 0 && <p className="mt-1 text-xs text-ink/40">Belum ada cabang aktif lain sebagai tujuan.</p>}
              </div>

              <div>
                <label className={label}>Tanggal transaksi</label>
                <input type="date" className="input-base w-full" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} data-testid="ib-date" />
              </div>

              <div>
                <label className={label}>Nominal (Rp)</label>
                <input className="input-base w-full tabular-nums" inputMode="decimal" placeholder="1.000.000" value={amountText} onChange={(e) => setAmountText(e.target.value)} data-testid="ib-amount" />
                {Number.isFinite(amount) && amount > 0 && <p className="mt-1 text-xs text-ink/40">{formatIDR(amount)}</p>}
              </div>

              <div>
                <label className={label}>Nomor bukti (opsional)</label>
                <input className="input-base w-full" maxLength={100} value={referenceText} onChange={(e) => setReferenceText(e.target.value)} placeholder="Nomor bukti setoran / nota" />
              </div>

              <div>
                <label className={label}>Akun asal ({options.data.fromBranch.name})</label>
                <select className="input-base w-full" value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)} data-testid="ib-from-account">
                  <option value="">Pilih akun...</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} - {a.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={label}>Usulan akun penerima{destination ? ` (${destination.name})` : ""}</label>
                <select className="input-base w-full" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} data-testid="ib-to-account">
                  <option value="">Pilih akun...</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} - {a.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ink/40">Hanya usulan: cabang penerima mengonfirmasi akunnya saat menyetujui.</p>
              </div>

              <div className="sm:col-span-2">
                <label className={label}>Keterangan</label>
                <textarea className="input-base w-full" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="ib-description" />
              </div>

              {fromAccount && Number.isFinite(amount) && amount > 0 && (
                <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-xs text-ink/60 sm:col-span-2" data-testid="ib-preview">
                  <p className="mb-1 font-semibold text-heading">Jurnal sisi {options.data.fromBranch.name} setelah disetujui</p>
                  <p>Debit Antarkantor{destination ? `: ${destination.name}` : ""} (dipilih sistem): {formatIDR(amount)}</p>
                  <p>
                    Kredit {fromAccount.code} {fromAccount.name}: {formatIDR(amount)}
                  </p>
                  <p className="mt-1 text-ink/40">Belum ada jurnal sampai cabang tujuan menyetujui. Pengajuan kedaluwarsa bila tidak diputuskan.</p>
                </div>
              )}
            </>
          )}

          {error && (
            <p ref={errorRef} className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 sm:col-span-2" role="alert" data-testid="ib-error">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2">
            Batal
          </button>
          <button type="button" onClick={submit} disabled={create.isPending || !options.data} data-testid="ib-submit" className="rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
            {create.isPending ? "Mengajukan..." : "Ajukan ke Cabang Tujuan"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
