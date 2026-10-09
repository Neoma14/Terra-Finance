import { CheckCircle2, XCircle } from "lucide-react";
import { isBalancedExact } from "../../../lib/money.js";
import { todayLocal } from "../../../lib/date.js";
import { useState, type ReactNode } from "react";
import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import { useAccountList } from "../../../features/workspace/use-accounts.js";
import { usePeriodOptions } from "../../../features/workspace/use-journal.js";
import { useCreateOpeningBalance, useUpdateOpeningBalance } from "../../../features/workspace/use-opening-balance.js";
import type { OpeningBalanceSummary } from "../../../features/workspace/opening-balance-types.js";

interface FormLine {
  accountId: string;
  debit: string;
  credit: string;
}

function emptyLines(): FormLine[] {
  return [
    { accountId: "", debit: "", credit: "" },
    { accountId: "", debit: "", credit: "" },
  ];
}

/**
 * Input manual Opening Balance (TASK-DB-ARCH-016 §5-6) -- SATU komponen
 * utk create DAN edit (pola sama dgn `journal-form-panel.tsx`/
 * `account-form-panel.tsx`). Akun dipilih dari dropdown COA existing
 * (`useAccountList`) -- user TIDAK mengetik nama akun bebas (§5).
 */
export function OpeningBalanceForm({ companySlug, existing, onDone }: { companySlug: string; existing?: OpeningBalanceSummary; onDone: () => void }) {
  const isEditing = Boolean(existing?.exists);
  const { data: accountsData } = useAccountList(companySlug, { isActive: true, pageSize: 500 });
  const { data: periodsData } = usePeriodOptions(companySlug);
  const accounts = (accountsData?.accounts ?? []).filter((a) => !a.isLocked);
  const periods = periodsData?.periods ?? [];

  const create = useCreateOpeningBalance(companySlug);
  const update = useUpdateOpeningBalance(companySlug);
  const mutation = isEditing ? update : create;

  const [entryDate, setEntryDate] = useState(existing?.entryDate?.slice(0, 10) ?? todayLocal());
  const [periodId, setPeriodId] = useState(existing?.periodId ?? "");
  const [lines, setLines] = useState<FormLine[]>(
    existing?.lines.length ? existing.lines.map((l) => ({ accountId: l.accountId, debit: l.debit ? String(l.debit) : "", credit: l.credit ? String(l.credit) : "" })) : emptyLines(),
  );

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isBalanced = isBalancedExact(totalDebit, totalCredit);
  const filledAccountIds = lines.filter((l) => l.accountId).map((l) => l.accountId);
  const hasDuplicate = new Set(filledAccountIds).size !== filledAccountIds.length;
  const hasDebit = lines.some((l) => Number(l.debit) > 0);
  const hasCredit = lines.some((l) => Number(l.credit) > 0);
  const canSubmit = isBalanced && periodId && filledAccountIds.length >= 2 && !hasDuplicate && hasDebit && hasCredit && lines.filter((l) => l.accountId).every((l) => Number(l.debit) > 0 || Number(l.credit) > 0);

  function updateLine(i: number, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    const input = {
      entryDate,
      periodId,
      lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
    };
    if (isEditing) await update.mutateAsync(input);
    else await create.mutateAsync(input);
    onDone();
  }

  return (
    <Card className="p-6">
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Tanggal Saldo Awal">
          <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="input-base w-full" />
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
      </div>

      <div className="mb-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-3 py-2">Akun</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Kredit</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const isDuplicateRow = line.accountId && filledAccountIds.filter((id) => id === line.accountId).length > 1;
              return (
                <tr key={i} className={`border-t border-line/60 ${isDuplicateRow ? "bg-rose-50/50 dark:bg-rose-500/10" : ""}`}>
                  <td className="px-3 py-1.5">
                    <select value={line.accountId} onChange={(e) => updateLine(i, { accountId: e.target.value })} className="input-base w-full">
                      <option value="">Pilih akun</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} - {a.name}
                        </option>
                      ))}
                    </select>
                    {isDuplicateRow && <p className="mt-0.5 text-xs text-rose-600">Akun duplikat (§7: harus error, tidak digabung).</p>}
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

      <button type="button" onClick={() => setLines((prev) => [...prev, { accountId: "", debit: "", credit: "" }])} className="mb-4 text-sm font-medium text-accent hover:underline">
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

      <button type="button" disabled={!canSubmit || mutation.isPending} onClick={handleSubmit} className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
        {mutation.isPending ? "Menyimpan..." : isEditing ? "Simpan Perubahan" : "Simpan sbg Draft"}
      </button>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink/60">{label}</label>
      {children}
    </div>
  );
}
