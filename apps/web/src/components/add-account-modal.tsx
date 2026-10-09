import type { AccountType, StatementLineOption } from "@konsultan/shared";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { useCreateAccount, useStatementLineOptions } from "../features/accounts/use-accounts.js";
import { usePeriods } from "../features/statements/use-statements.js";
import { useEscapeToClose } from "../lib/use-escape-to-close.js";

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "Aset",
  liability: "Liabilitas",
  equity: "Ekuitas",
  revenue: "Pendapatan",
  expense: "Beban",
};

/** Saldo normal default per jenis akun -- tetap bisa ditimpa manual lewat
 * dropdown "Saldo Normal", tapi ini tebakan yang benar utk hampir semua
 * kasus supaya user tidak perlu mikir tiap kali. */
const DEFAULT_NORMAL_BALANCE: Record<AccountType, "debit" | "credit"> = {
  asset: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
  expense: "debit",
};

function statementTypeFor(accountType: AccountType): "balance_sheet" | "income_statement" {
  return accountType === "revenue" || accountType === "expense" ? "income_statement" : "balance_sheet";
}

/** Sama persis dgn AddAccountModal versi online. */
export function AddAccountModal({ companySlug, onClose }: { companySlug: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  const createAccount = useCreateAccount(companySlug);
  const { data: linesData } = useStatementLineOptions(companySlug);
  const { data: periodsData } = usePeriods(companySlug);
  const periods = periodsData?.periods ?? [];

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("asset");
  const [accountSubtype, setAccountSubtype] = useState("other");
  const [normalBalance, setNormalBalance] = useState<"debit" | "credit">("debit");
  const [statementLineId, setStatementLineId] = useState("");
  const [isCash, setIsCash] = useState(false);
  const [cashFlowActivity, setCashFlowActivity] = useState<"" | "operating" | "investing" | "financing">("");
  const [subledgerType, setSubledgerType] = useState<"" | "payable" | "receivable">("");
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingPeriodId, setOpeningPeriodId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const lineOptions = useMemo(() => {
    const wantedType = statementTypeFor(accountType);
    return (linesData?.lines ?? []).filter((l: StatementLineOption) => l.statementType === wantedType);
  }, [linesData, accountType]);

  function handleAccountTypeChange(next: AccountType) {
    setAccountType(next);
    setNormalBalance(DEFAULT_NORMAL_BALANCE[next]);
    setStatementLineId("");
    if (next !== "asset") setIsCash(false);
  }

  const canSubmit = code.trim().length > 0 && name.trim().length > 0 && accountSubtype.trim().length > 0;

  async function handleSubmit() {
    setError(null);
    const amount = Number(openingAmount);
    if (openingAmount && (!Number.isFinite(amount) || amount <= 0)) {
      setError("Saldo awal harus berupa angka lebih dari 0");
      return;
    }
    if (openingAmount && !openingPeriodId) {
      setError("Pilih periode untuk saldo awal");
      return;
    }
    try {
      await createAccount.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        accountType,
        accountSubtype: accountSubtype.trim(),
        normalBalance,
        cashFlowActivity: cashFlowActivity || undefined,
        isCash,
        subledgerType: subledgerType || null,
        statementLineId: statementLineId || undefined,
        openingBalance: openingAmount && openingPeriodId ? { amount, periodId: openingPeriodId } : undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Tambah Akun Baru</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Kode Akun</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} className="input-base w-full" placeholder="mis. 1160" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Jenis Akun</label>
              <select value={accountType} onChange={(e) => handleAccountTypeChange(e.target.value as AccountType)} className="input-base w-full">
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Nama Akun</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input-base w-full" placeholder="mis. Kas Kecil Cabang Bandung" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Saldo Normal</label>
              <select value={normalBalance} onChange={(e) => setNormalBalance(e.target.value as "debit" | "credit")} className="input-base w-full">
                <option value="debit">Debit</option>
                <option value="credit">Kredit</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Sub Tipe Akun</label>
              <input value={accountSubtype} onChange={(e) => setAccountSubtype(e.target.value)} className="input-base w-full" placeholder="mis. current_asset" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">
              Mapping ke Baris Laporan {statementTypeFor(accountType) === "balance_sheet" ? "(Neraca)" : "(Laba Rugi)"}
            </label>
            <select value={statementLineId} onChange={(e) => setStatementLineId(e.target.value)} className="input-base w-full">
              <option value="">Otomatis (baris tampungan umum)</option>
              {lineOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.lineLabel}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink/40">
              Kalau tidak dipilih, akun tetap ikut terhitung di Total Aset/Liabilitas/Ekuitas/Pendapatan/Beban lewat
              baris tampungan umum -- bisa disesuaikan lagi nanti.
            </p>
          </div>

          {accountType === "asset" && (
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-sm text-ink">
              <input type="checkbox" checked={isCash} onChange={(e) => setIsCash(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
              Akun ini termasuk Kas &amp; Setara Kas (dihitung sebagai saldo kas di Dashboard &amp; Arus Kas)
            </label>
          )}

          {(accountType === "asset" || accountType === "liability" || accountType === "equity") && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Aktivitas Arus Kas</label>
              <select value={cashFlowActivity} onChange={(e) => setCashFlowActivity(e.target.value as typeof cashFlowActivity)} className="input-base w-full">
                <option value="">Tidak relevan / tidak diikutkan</option>
                <option value="operating">Operasi</option>
                <option value="investing">Investasi</option>
                <option value="financing">Pendanaan</option>
              </select>
            </div>
          )}

          {(accountType === "asset" || accountType === "liability") && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Kartu Hutang/Piutang</label>
              <select value={subledgerType} onChange={(e) => setSubledgerType(e.target.value as typeof subledgerType)} className="input-base w-full">
                <option value="">Bukan akun hutang/piutang</option>
                <option value="receivable">Kartu Piutang</option>
                <option value="payable">Kartu Hutang</option>
              </select>
            </div>
          )}

          <div className="rounded-lg border border-line p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/50">Saldo Awal (opsional)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink/60">Jumlah (Rp)</label>
                <input
                  type="number"
                  min={0}
                  value={openingAmount}
                  onChange={(e) => setOpeningAmount(e.target.value)}
                  className="input-base w-full"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink/60">Periode</label>
                <select value={openingPeriodId} onChange={(e) => setOpeningPeriodId(e.target.value)} className="input-base w-full">
                  <option value="">Pilih periode</option>
                  {periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-2 text-xs text-ink/40">
              Diposting sebagai jurnal "Saldo Awal" berpasangan dengan akun ekuitas penyeimbang "Saldo Awal
              (Penyesuaian)" -- Neraca tetap balance & saldo ikut terbawa ke periode-periode setelahnya.
            </p>
          </div>

          {error && (
            <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-300">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            Batal
          </button>
          <button
            type="button"
            disabled={!canSubmit || createAccount.isPending}
            onClick={handleSubmit}
            className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {createAccount.isPending ? "Menyimpan..." : "Simpan Akun"}
          </button>
        </div>
      </div>
    </div>
  );
}
