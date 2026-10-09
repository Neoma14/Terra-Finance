import { CheckCircle2, PenLine, UploadCloud, XCircle } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Badge, Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import {
  useDeleteOpeningBalance,
  useOpeningBalance,
  usePostOpeningBalance,
  useReverseOpeningBalance,
} from "../../../features/workspace/use-opening-balance.js";
import { usePeriodOptions } from "../../../features/workspace/use-journal.js";
import { OpeningBalanceForm } from "./opening-balance-form.js";
import { OpeningBalanceImportTab } from "./opening-balance-import-tab.js";

type Tab = "manual" | "import";

const STATUS_TONE: Record<string, "neutral" | "success" | "danger"> = { DRAFT: "neutral", POSTED: "success", REVERSED: "danger" };

/**
 * Opening Balance / Saldo Awal (TASK-DB-ARCH-016) -- SATU entity per
 * company (bukan list, lihat opening-balance-service.ts §9), jadi
 * halaman ini TIDAK berbentuk "daftar" spt Journal/COA, melainkan satu
 * dashboard: header+summary+form/read-only, tergantung status yang
 * sedang aktif. Mengalir ke ledger/trial-balance/reports EXISTING TANPA
 * modifikasi apa pun di sana (§18, dibuktikan test backend).
 */
export function OpeningBalancePage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const { data, isLoading, isError, error } = useOpeningBalance(company.slug);
  const { data: periodsData } = usePeriodOptions(company.slug);
  const [tab, setTab] = useState<Tab>("manual");
  const [editing, setEditing] = useState(false);
  const [showReverseForm, setShowReverseForm] = useState(false);
  const [reversePeriodId, setReversePeriodId] = useState("");
  const [reverseReason, setReverseReason] = useState("");

  const deleteOB = useDeleteOpeningBalance(company.slug);
  const postOB = usePostOpeningBalance(company.slug);
  const reverseOB = useReverseOpeningBalance(company.slug);

  if (isLoading) {
    return <p className="text-sm text-ink/50">Memuat...</p>;
  }
  if (isError) {
    return <p className="text-sm text-rose-600">Gagal memuat Saldo Awal. {(error as Error).message}</p>;
  }
  if (!data) {
    return <p className="text-sm text-ink/50">Memuat...</p>;
  }

  const showForm = !data.exists || (data.status === "DRAFT" && editing);
  const canImport = !data.exists;

  async function handleReverse() {
    if (!reversePeriodId || !reverseReason.trim()) return;
    await reverseOB.mutateAsync({ targetPeriodId: reversePeriodId, reason: reverseReason.trim() });
    setShowReverseForm(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Opening Balance / Saldo Awal</h1>
        <p className="text-sm text-ink/50">
          {company.name} {data.periodLabel && `, Periode ${data.periodLabel}`} {data.entryDate && `, Tanggal ${data.entryDate.slice(0, 10)}`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <SummaryCard label="Total Debit" value={formatIDR(data.totalDebit)} />
        <SummaryCard label="Total Credit" value={formatIDR(data.totalCredit)} />
        <SummaryCard label="Difference" value={formatIDR(data.difference)} tone={data.isBalanced ? "neutral" : "negative"} />
        <Card className="flex flex-col gap-1 p-5">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">Status</span>
          {data.exists ? (
            <div className="flex items-center gap-2">
              <Badge tone={STATUS_TONE[data.status ?? "DRAFT"]}>{data.status}</Badge>
              <Badge tone={data.isBalanced ? "success" : "danger"}>{data.isBalanced ? "BALANCED" : "NOT BALANCED"}</Badge>
            </div>
          ) : (
            <Badge tone="neutral">Belum dibuat</Badge>
          )}
        </Card>
      </div>

      {!data.exists && (
        <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
          {([
            { key: "manual" as const, label: "Input Manual", icon: PenLine },
            { key: "import" as const, label: "Import Excel", icon: UploadCloud },
          ]).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === key ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      )}

      {data.exists && !editing && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
                <tr>
                  <th className="px-4 py-2.5">Kode</th>
                  <th className="px-4 py-2.5">Nama Akun</th>
                  <th className="px-4 py-2.5 text-right">Debit</th>
                  <th className="px-4 py-2.5 text-right">Kredit</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.accountId} className="border-t border-line/60">
                    <td className="px-4 py-2 tabular-nums">{l.accountCode}</td>
                    <td className="px-4 py-2">{l.accountName}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.debit ? formatIDR(l.debit) : ""}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.credit ? formatIDR(l.credit) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(deleteOB.isError || postOB.isError || reverseOB.isError) && (
            <p className="px-4 pb-2 text-sm text-rose-600">{((deleteOB.error || postOB.error || reverseOB.error) as Error).message}</p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line p-4">
            {data.status === "DRAFT" && (
              <>
                <button type="button" onClick={() => postOB.mutate()} disabled={postOB.isPending} className="flex items-center gap-1.5 rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
                  <CheckCircle2 size={14} /> {postOB.isPending ? "Memposting..." : "Post Saldo Awal"}
                </button>
                <button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2">
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => deleteOB.mutate()}
                  disabled={deleteOB.isPending}
                  className="flex items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-500/10"
                >
                  <XCircle size={14} /> {deleteOB.isPending ? "Menghapus..." : "Hapus Draft"}
                </button>
              </>
            )}
            {data.status === "POSTED" && !showReverseForm && (
              <button type="button" onClick={() => setShowReverseForm(true)} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2">
                Reversal
              </button>
            )}
            {data.status === "POSTED" && (
              <p className="text-xs text-ink/40">Sudah POSTED -- read-only. Gunakan Reversal utk mengoreksi (§21: lebih aman drpd edit langsung data yang sudah efektif).</p>
            )}
          </div>

          {showReverseForm && (
            <div className="flex flex-col gap-3 border-t border-line p-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink/60">Periode Tujuan Reversal</label>
                <select value={reversePeriodId} onChange={(e) => setReversePeriodId(e.target.value)} className="input-base w-full max-w-xs">
                  <option value="">Pilih periode</option>
                  {(periodsData?.periods ?? []).map((p) => (
                    <option key={p.id} value={p.id} disabled={p.status !== "OPEN"}>
                      {p.label} {p.status !== "OPEN" ? `(${p.status})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink/60">Alasan Reversal</label>
                <input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} className="input-base w-full max-w-md" placeholder="mis. Koreksi saldo awal" />
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={!reversePeriodId || !reverseReason.trim() || reverseOB.isPending} onClick={handleReverse} className="rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
                  {reverseOB.isPending ? "Memproses..." : "Konfirmasi Reversal"}
                </button>
                <button type="button" onClick={() => setShowReverseForm(false)} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2">
                  Batal
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {showForm && tab === "manual" && (
        <OpeningBalanceForm
          companySlug={company.slug}
          existing={editing ? data : undefined}
          onDone={() => setEditing(false)}
        />
      )}

      {canImport && tab === "import" && <OpeningBalanceImportTab companySlug={company.slug} onCommitted={() => setTab("manual")} />}
    </div>
  );
}

function SummaryCard({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "negative" }) {
  return (
    <Card className="p-5">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/50">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${tone === "negative" ? "text-rose-600" : "text-heading"}`}>{value}</p>
    </Card>
  );
}
