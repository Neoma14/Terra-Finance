import { CheckCircle2, XCircle } from "lucide-react";
import { isBalancedExact } from "../../../lib/money.js";
import { todayLocal } from "../../../lib/date.js";
import { useState, type ReactNode } from "react";
import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useAccountOptions, useCreateJournal, useJournalSettings, usePeriodOptions, useUpdateDraftJournal } from "../../../features/workspace/use-journal.js";
import { useCounterpartyList } from "../../../features/workspace/use-counterparties.js";
import type { JournalDetail } from "../../../features/workspace/journal-types.js";

interface FormLine {
  accountId: string;
  debit: string;
  credit: string;
  counterpartyId: string;
}

function emptyLines(): FormLine[] {
  return [
    { accountId: "", debit: "", credit: "", counterpartyId: "" },
    { accountId: "", debit: "", credit: "", counterpartyId: "" },
  ];
}

function linesFromDetail(detail: JournalDetail): FormLine[] {
  return detail.lines.map((l) => ({
    accountId: l.account_id,
    debit: l.debit ? String(l.debit) : "",
    credit: l.credit ? String(l.credit) : "",
    counterpartyId: l.counterparty_id ?? "",
  }));
}

/**
 * Create + Edit DRAFT jurnal, SATU komponen (TASK-DB-ARCH-014 §9: "jangan
 * membuat desain berbeda-beda" -- form yang sama, bukan dua form terpisah
 * yang bisa diam-diam tidak sinkron). Edit mengirim PUT yang di backend
 * adalah delete-draft-lama + create-draft-baru ATOMIC (lihat
 * modules/company-journal/routes.ts) -- dari sisi form, cukup kirim data
 * baru, server yang urus penggantian draft-nya.
 */
export function JournalFormPanel({
  companySlug,
  editingDetail,
  onDone,
}: {
  companySlug: string;
  editingDetail?: JournalDetail;
  onDone: () => void;
}) {
  const { data: accountsData } = useAccountOptions(companySlug);
  const { data: periodsData } = usePeriodOptions(companySlug);
  const { data: vendorsData } = useCounterpartyList(companySlug, "vendor");
  const { data: customersData } = useCounterpartyList(companySlug, "customer");
  const { data: journalSettings } = useJournalSettings(companySlug);
  // Akun nonaktif / terkunci tidak ditawarkan (server tetap menolak bila dipaksa lewat API).
  const accounts = (accountsData?.accounts ?? []).filter((a) => a.isActive && !a.isLocked);
  const periods = periodsData?.periods ?? [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const create = useCreateJournal(companySlug);
  const update = useUpdateDraftJournal(companySlug);
  const mutation = editingDetail ? update : create;

  const [entryDate, setEntryDate] = useState(editingDetail?.journal.entry_date.slice(0, 10) ?? todayLocal());
  const [periodId, setPeriodId] = useState(editingDetail?.journal.period_id ?? "");
  const [referenceNo, setReferenceNo] = useState(editingDetail?.journal.reference_no ?? "");
  const [description, setDescription] = useState(editingDetail?.journal.description ?? "");
  const [lines, setLines] = useState<FormLine[]>(editingDetail ? linesFromDetail(editingDetail) : emptyLines());

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isBalanced = isBalancedExact(totalDebit, totalCredit);
  const canSubmit = isBalanced && periodId && referenceNo.trim() && lines.filter((l) => l.accountId).length >= 2 && lines.filter((l) => l.accountId).every((l) => Number(l.debit) > 0 || Number(l.credit) > 0);

  function updateLine(i: number, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    const input = {
      referenceNo: referenceNo.trim(),
      description: description || undefined,
      periodId,
      entryDate,
      lines: lines
        .filter((l) => l.accountId)
        .map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, counterpartyId: l.counterpartyId || null })),
    };

    if (editingDetail) {
      await update.mutateAsync({ id: editingDetail.journal.id, input });
    } else {
      await create.mutateAsync(input);
      setEntryDate(todayLocal());
      setPeriodId("");
      setReferenceNo("");
      setDescription("");
      setLines(emptyLines());
    }
    onDone();
  }

  return (
    <Card className="p-6">
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Field label="Tanggal">
          <input
            type="date"
            value={entryDate}
            max={todayLocal()}
            min={journalSettings?.earliestAllowedDate ?? undefined}
            onChange={(e) => setEntryDate(e.target.value)}
            className="input-base w-full"
          />
          <p className="mt-1 text-[11px] text-ink/40">
            {journalSettings?.maxBackdateDays != null
              ? `Maks. ${journalSettings.maxBackdateDays} hari ke belakang (sejak ${journalSettings.earliestAllowedDate}); tidak boleh melewati hari ini.`
              : "Tidak boleh melewati hari ini."}
          </p>
        </Field>
        <Field label="Periode">
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="input-base w-full">
            <option value="">Pilih periode</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id} disabled={p.status !== "OPEN"}>
                {p.label} {p.status !== "OPEN" ? `(${p.status})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nomor Jurnal">
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="mis. JRN-0001" className="input-base w-full" />
        </Field>
        <Field label="Keterangan">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input-base w-full" />
        </Field>
      </div>

      <div className="mb-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-3 py-2">Akun</th>
              <th className="px-3 py-2">Vendor/Customer</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Kredit</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const subledgerType = accountById.get(line.accountId)?.subledgerType ?? null;
              const counterpartyOptions = subledgerType === "payable" ? vendorsData?.counterparties : subledgerType === "receivable" ? customersData?.counterparties : undefined;
              return (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-3 py-1.5">
                    <select
                      value={line.accountId}
                      onChange={(e) => updateLine(i, { accountId: e.target.value, counterpartyId: "" })}
                      className="input-base w-full"
                    >
                      <option value="">Pilih akun</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} - {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-1.5">
                    {counterpartyOptions ? (
                      <select value={line.counterpartyId} onChange={(e) => updateLine(i, { counterpartyId: e.target.value })} className="input-base w-full">
                        <option value="">- (opsional)</option>
                        {counterpartyOptions.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} - {c.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-ink/30">-</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <input type="number" value={line.debit} onChange={(e) => updateLine(i, { debit: e.target.value, credit: "" })} className="input-base w-28 text-right" />
                  </td>
                  <td className="px-3 py-1.5">
                    <input type="number" value={line.credit} onChange={(e) => updateLine(i, { credit: e.target.value, debit: "" })} className="input-base w-28 text-right" />
                  </td>
                  <td className="px-3 py-1.5">
                    {lines.length > 2 && (
                      <button onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))} className="text-ink/30 hover:text-rose-500">
                        <XCircle size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button type="button" onClick={() => setLines((prev) => [...prev, { accountId: "", debit: "", credit: "", counterpartyId: "" }])} className="mb-4 text-sm font-medium text-accent hover:underline">
        + Tambah Baris
      </button>

      <div
        className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
          isBalanced ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"
        }`}
      >
        {isBalanced ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        Total Debit {formatIDR(totalDebit)}, Total Kredit {formatIDR(totalCredit)} {isBalanced ? "(balance)" : "(belum balance)"}
      </div>

      {mutation.isError && <p className="mb-3 text-sm text-rose-600">{(mutation.error as Error).message}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canSubmit || mutation.isPending}
          onClick={handleSubmit}
          className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
        >
          {mutation.isPending ? "Menyimpan..." : editingDetail ? "Simpan Perubahan" : "Simpan sbg Draft"}
        </button>
        {editingDetail && (
          <button type="button" onClick={onDone} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-heading hover:bg-surface-2">
            Batal
          </button>
        )}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex-1">
      <label className="mb-1 block text-xs font-medium text-ink/60">{label}</label>
      {children}
    </div>
  );
}
