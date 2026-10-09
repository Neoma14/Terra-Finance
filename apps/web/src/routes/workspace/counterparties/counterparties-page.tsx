import { Plus } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Badge, Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useCounterpartyBalances } from "../../../features/workspace/use-counterparties.js";
import { useReportScope } from "../../../features/workspace/report-scope.js";
import { ReportScopePicker } from "../report-scope/report-scope-picker.js";
import { ScopeBanner } from "../report-scope/scope-banner.js";
import type { CounterpartyType } from "../../../features/workspace/counterparty-types.js";
import { AddCounterpartyModal } from "./add-counterparty-modal.js";

/**
 * Hutang & Piutang (TASK-023 §6) -- saldo dari `GET /counterparties/balances`,
 * dihitung backend langsung dari journal_entry_lines (lihat counterparty-
 * service.ts), BUKAN dihitung ulang di frontend. Due date/termin TIDAK
 * ditampilkan -- skema tidak mendukungnya (dokumentasi, bukan tebakan).
 * Melunasi hutang/piutang = buat jurnal baru lewat menu Jurnal (pilih
 * counterparty di baris akun subledger yang sama), BUKAN form "Bayar" di
 * sini -- supaya tetap lewat Transaction -> Journal -> Ledger -> Reports.
 */
export function CounterpartiesPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [type, setType] = useState<CounterpartyType>("vendor");
  const [showAddModal, setShowAddModal] = useState(false);

  const [scope, setScope] = useReportScope(company.slug);
  const { data, isLoading, isError, error } = useCounterpartyBalances(company.slug, type, scope);
  const rows = data?.balances ?? [];
  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Hutang & Piutang</h1>
          <p className="text-sm text-ink/50">Saldo hutang usaha dan piutang usaha {company.name}, dari jurnal yang sudah diposting.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 rounded-lg bg-navy-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-navy-900"
        >
          <Plus size={15} /> Tambah {type === "vendor" ? "Vendor" : "Customer"}
        </button>
      </div>

      <ReportScopePicker companySlug={company.slug} scope={scope} onChange={setScope} />
      <ScopeBanner scope={data?.scope} />

      <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
        {(["vendor", "customer"] as CounterpartyType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              type === t ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"
            }`}
          >
            {t === "vendor" ? "Hutang (Vendor)" : "Piutang (Customer)"}
          </button>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="px-4 py-2.5">Kode</th>
                <th className="px-4 py-2.5">Nama</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-ink/40">
                    Memuat...
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-rose-600">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading &&
                !isError &&
                rows.map((r) => (
                  <tr key={r.counterpartyId} className="border-t border-line/60">
                    <td className="px-4 py-2 tabular-nums font-medium text-heading">{r.code}</td>
                    <td className="px-4 py-2">{r.name}</td>
                    <td className="px-4 py-2">
                      <Badge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "Aktif" : "Nonaktif"}</Badge>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatIDR(r.balance)}</td>
                  </tr>
                ))}
              {!isLoading && !isError && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-ink/40">
                    {type === "vendor" ? "Belum ada vendor." : "Belum ada customer."}
                  </td>
                </tr>
              )}
            </tbody>
            {!isLoading && !isError && rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-line bg-surface-2/60 font-semibold">
                  <td colSpan={3} className="px-4 py-2.5 text-ink/60">
                    Total
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-heading">{formatIDR(totalBalance)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {showAddModal && <AddCounterpartyModal companySlug={company.slug} type={type} onClose={() => setShowAddModal(false)} />}
    </div>
  );
}
