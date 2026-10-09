import { X } from "lucide-react";
import { useAccountDetail, useAccountList, useAccountTypes, useSetAccountLocked, useUpdateAccount } from "../../../features/workspace/use-accounts.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import { AccountStatusBadge } from "./account-status-badge.js";

/** Detail + Edit + Activate/Deactivate -- pola modal sama dgn
 * `journal-detail-modal.tsx` (TASK-DB-ARCH-014) & `add-account-modal.tsx`
 * legacy (overlay+panel, TIDAK didesain ulang). */
export function AccountDetailModal({ companySlug, accountId, onClose, onEdit, canLock = false }: { companySlug: string; accountId: string; onClose: () => void; onEdit: () => void; canLock?: boolean }) {
  useEscapeToClose(onClose);
  const { data, isLoading, isError, error } = useAccountDetail(companySlug, accountId);
  const { data: typesData } = useAccountTypes(companySlug);
  const { data: accountsData } = useAccountList(companySlug, { pageSize: 200 });
  const update = useUpdateAccount(companySlug);
  const setLocked = useSetAccountLocked(companySlug);

  const account = data?.account;
  const accountType = (typesData?.accountTypes ?? []).find((t) => t.id === account?.accountTypeId);
  const parent = (accountsData?.accounts ?? []).find((a) => a.id === account?.parentAccountId);

  async function handleToggleActive() {
    if (!account) return;
    await update.mutateAsync({ id: account.id, input: { isActive: !account.isActive } });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Detail Akun</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          {isLoading && <p className="text-sm text-ink/50">Memuat...</p>}
          {isError && <p className="text-sm text-rose-600">Gagal memuat detail akun. {(error as Error).message}</p>}
          {account && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-heading">
                    {account.code} - {account.name}
                  </p>
                  <p className="text-sm text-ink/50">{accountType ? `${accountType.code} - ${accountType.name}` : "-"}</p>
                </div>
                <AccountStatusBadge isActive={account.isActive} isLocked={account.isLocked} />
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <DetailRow label="Saldo Normal" value={account.normalBalance === "debit" ? "Debit" : "Credit"} />
                <DetailRow label="Akun Induk" value={parent ? `${parent.code} - ${parent.name}` : "-"} />
                <DetailRow label="Akun Kas" value={account.isCash ? "Ya" : "Tidak"} />
                <DetailRow label="Aktivitas Arus Kas" value={account.cashFlowActivity ?? "-"} />
                <DetailRow label="Kartu" value={account.subledgerType === "payable" ? "Hutang" : account.subledgerType === "receivable" ? "Piutang" : "-"} />
                <DetailRow label="Akun Sistem" value={account.isSystemAccount ? "Ya" : "Tidak"} />
              </dl>

              {(update.isError || setLocked.isError) && <p className="text-sm text-rose-600">{((update.error || setLocked.error) as Error).message}</p>}

              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <button type="button" onClick={onEdit} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2">
                  Edit
                </button>
                <button
                  type="button"
                  onClick={handleToggleActive}
                  disabled={update.isPending}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                    account.isActive ? "border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" : "border-emerald-300 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                  }`}
                >
                  {update.isPending ? "Memproses..." : account.isActive ? "Nonaktifkan" : "Aktifkan"}
                </button>
                {canLock && (
                  <button
                    type="button"
                    onClick={() => setLocked.mutate({ id: account.id, locked: !account.isLocked })}
                    disabled={setLocked.isPending}
                    className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2 disabled:opacity-50"
                  >
                    {setLocked.isPending ? "Memproses..." : account.isLocked ? "Unlock Akun" : "Lock Akun"}
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink/50">{label}</dt>
      <dd className="text-heading">{value}</dd>
    </div>
  );
}
