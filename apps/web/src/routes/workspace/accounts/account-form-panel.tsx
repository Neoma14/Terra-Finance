import { useState, type ReactNode } from "react";
import { Card } from "../../../components/ui.js";
import { useAccountList, useAccountTypes, useCreateAccount, useUpdateAccount } from "../../../features/workspace/use-accounts.js";
import type { AccountRow } from "../../../features/workspace/account-types.js";

const CASH_FLOW_OPTIONS = [
  { value: "", label: "-" },
  { value: "operating", label: "Operasi" },
  { value: "investing", label: "Investasi" },
  { value: "financing", label: "Pendanaan" },
];
const SUBLEDGER_OPTIONS = [
  { value: "", label: "-" },
  { value: "payable", label: "Hutang" },
  { value: "receivable", label: "Piutang" },
];

/**
 * Create + Edit akun, SATU komponen (§9 "jangan membuat desain berbeda-
 * beda", pola sama dgn `journal-form-panel.tsx` TASK-DB-ARCH-014).
 * Activate/Deactivate SENGAJA BUKAN di sini -- aksi tersendiri di
 * `account-detail-modal.tsx` (pola sama dgn Post/Reverse jurnal: aksi
 * status-lifecycle terpisah dari form edit atribut).
 */
export function AccountFormPanel({ companySlug, editingAccount, onDone }: { companySlug: string; editingAccount?: AccountRow; onDone: () => void }) {
  const { data: typesData } = useAccountTypes(companySlug);
  const { data: accountsData } = useAccountList(companySlug, { pageSize: 200 });
  const accountTypes = typesData?.accountTypes ?? [];
  const accounts = (accountsData?.accounts ?? []).filter((a) => a.id !== editingAccount?.id);

  const create = useCreateAccount(companySlug);
  const update = useUpdateAccount(companySlug);
  const mutation = editingAccount ? update : create;

  const [code, setCode] = useState(editingAccount?.code ?? "");
  const [name, setName] = useState(editingAccount?.name ?? "");
  const [accountTypeCode, setAccountTypeCode] = useState(() => accountTypes.find((t) => t.id === editingAccount?.accountTypeId)?.code ?? "");
  const [normalBalance, setNormalBalance] = useState<"debit" | "credit">(editingAccount?.normalBalance ?? "debit");
  const [parentAccountId, setParentAccountId] = useState(editingAccount?.parentAccountId ?? "");
  const [isCash, setIsCash] = useState(editingAccount?.isCash ?? false);
  const [cashFlowActivity, setCashFlowActivity] = useState(editingAccount?.cashFlowActivity ?? "");
  const [subledgerType, setSubledgerType] = useState(editingAccount?.subledgerType ?? "");

  const canSubmit = code.trim() && name.trim() && accountTypeCode;

  async function handleSubmit() {
    if (!canSubmit) return;
    if (editingAccount) {
      await update.mutateAsync({
        id: editingAccount.id,
        input: {
          name: name.trim(),
          normalBalance,
          parentAccountId: parentAccountId || null,
          cashFlowActivity: cashFlowActivity || null,
          isCash,
          subledgerType: subledgerType || null,
        },
      });
    } else {
      await create.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        accountTypeCode,
        normalBalance,
        parentAccountId: parentAccountId || null,
        cashFlowActivity: cashFlowActivity || null,
        isCash,
        subledgerType: subledgerType || null,
      });
      setCode("");
      setName("");
      setAccountTypeCode("");
      setNormalBalance("debit");
      setParentAccountId("");
      setIsCash(false);
      setCashFlowActivity("");
      setSubledgerType("");
    }
    onDone();
  }

  return (
    <Card className="max-w-2xl p-6">
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Kode Akun">
          <input value={code} onChange={(e) => setCode(e.target.value)} disabled={Boolean(editingAccount)} className="input-base w-full disabled:opacity-60" placeholder="mis. 1100" />
        </Field>
        <Field label="Nama Akun">
          <input value={name} onChange={(e) => setName(e.target.value)} className="input-base w-full" />
        </Field>
        <Field label="Tipe Akun">
          <select value={accountTypeCode} onChange={(e) => setAccountTypeCode(e.target.value)} disabled={Boolean(editingAccount)} className="input-base w-full disabled:opacity-60">
            <option value="">Pilih tipe</option>
            {accountTypes.map((t) => (
              <option key={t.id} value={t.code}>
                {t.code} - {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Saldo Normal">
          <select value={normalBalance} onChange={(e) => setNormalBalance(e.target.value as "debit" | "credit")} className="input-base w-full">
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
        </Field>
        <Field label="Akun Induk (opsional)">
          <select value={parentAccountId} onChange={(e) => setParentAccountId(e.target.value)} className="input-base w-full">
            <option value="">-</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} - {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Aktivitas Arus Kas (opsional)">
          <select value={cashFlowActivity} onChange={(e) => setCashFlowActivity(e.target.value)} className="input-base w-full">
            {CASH_FLOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kartu (opsional)">
          <select value={subledgerType} onChange={(e) => setSubledgerType(e.target.value)} className="input-base w-full">
            {SUBLEDGER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Akun Kas">
          <label className="flex items-center gap-2 pt-2">
            <input type="checkbox" checked={isCash} onChange={(e) => setIsCash(e.target.checked)} />
            <span className="text-sm text-ink/70">Akun ini merupakan kas/setara kas</span>
          </label>
        </Field>
      </div>

      {mutation.isError && <p className="mb-3 text-sm text-rose-600">{(mutation.error as Error).message}</p>}

      <div className="flex gap-2">
        <button type="button" disabled={!canSubmit || mutation.isPending} onClick={handleSubmit} className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
          {mutation.isPending ? "Menyimpan..." : editingAccount ? "Simpan Perubahan" : "Tambah Akun"}
        </button>
        {editingAccount && (
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
    <div>
      <label className="mb-1 block text-xs font-medium text-ink/60">{label}</label>
      {children}
    </div>
  );
}
