import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useCompanyAuditLog } from "../../../features/workspace/use-audit-log.js";

const PAGE_SIZE = 50;

function formatTimestamp(iso: string): string {
  return new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).toLocaleString("id-ID");
}

/**
 * Audit Log (TASK-023 §14) -- READ-ONLY, menampilkan `company_audit_log`
 * yang sudah ditulis terus-menerus oleh setiap aksi di seluruh app
 * (journal.create/post/reverse, account.update, company_profile.change,
 * dst -- lihat `appendCompanyAudit`). Tidak ada aksi apa pun di halaman
 * ini (tidak ada edit/hapus) -- `company_audit_log` sendiri append-only
 * dgn trigger DB (C0012), konsisten end-to-end.
 */
export function AuditLogPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error } = useCompanyAuditLog(company.slug, {
    page,
    pageSize: PAGE_SIZE,
    entityType: entityType || undefined,
  });
  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Audit Log</h1>
        <p className="text-sm text-ink/50">Riwayat aktivitas pada data {company.name}. Hanya dapat dilihat, tidak dapat diubah.</p>
      </div>

      <Card>
        <div className="flex items-center gap-2 border-b border-line p-4">
          <input
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              setPage(1);
            }}
            placeholder="Filter berdasarkan tipe entitas, mis. journal_entry, account..."
            className="input-base w-80"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="px-4 py-2.5">Waktu</th>
                <th className="px-4 py-2.5">Pengguna</th>
                <th className="px-4 py-2.5">Aksi</th>
                <th className="px-4 py-2.5">Entitas</th>
                <th className="px-4 py-2.5">Keterangan</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink/40">
                    Memuat...
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-rose-600">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading &&
                !isError &&
                entries.map((e) => (
                  <tr key={e.id} className="border-t border-line/60">
                    <td className="px-4 py-2 tabular-nums text-ink/60">{formatTimestamp(e.createdAt)}</td>
                    <td className="px-4 py-2">{e.actorLabel}</td>
                    <td className="px-4 py-2 font-medium text-heading">{e.action}</td>
                    <td className="px-4 py-2 text-ink/60">
                      {e.entityType ?? "-"}
                      {e.entityId && <span className="ml-1 text-xs text-ink/30">{e.entityId.slice(0, 8)}</span>}
                    </td>
                    <td className="px-4 py-2 text-ink/60">{e.reason ?? "-"}</td>
                  </tr>
                ))}
              {!isLoading && !isError && entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-ink/40">
                    Belum ada aktivitas tercatat.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-ink/50">
          <span>{total} entri</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-line p-1.5 hover:bg-surface-2 disabled:opacity-40">
              <ChevronLeft size={14} />
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-line p-1.5 hover:bg-surface-2 disabled:opacity-40">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
