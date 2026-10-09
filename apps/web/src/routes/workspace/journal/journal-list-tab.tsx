import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState } from "react";
import { Card } from "../../../components/ui.js";
import { useJournalList } from "../../../features/workspace/use-journal.js";
import { JournalStatusBadge } from "./journal-status-badge.js";

const PAGE_SIZE = 20;

export function JournalListTab({ companySlug, onOpenDetail }: { companySlug: string; onOpenDetail: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error } = useJournalList(companySlug, { search: search || undefined, fromDate: fromDate || undefined, toDate: toDate || undefined, status: status || undefined, page, pageSize: PAGE_SIZE });
  const journals = data?.journals ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function resetToFirstPage() {
    setPage(1);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink/40" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetToFirstPage();
            }}
            placeholder="Cari nomor/keterangan..."
            className="input-base w-56 pl-8"
          />
        </div>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => {
            setFromDate(e.target.value);
            resetToFirstPage();
          }}
          className="input-base"
        />
        <span className="text-ink/30">-</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => {
            setToDate(e.target.value);
            resetToFirstPage();
          }}
          className="input-base"
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            resetToFirstPage();
          }}
          className="input-base"
        >
          <option value="">Semua Status</option>
          <option value="DRAFT">Draft</option>
          <option value="POSTED">Posted</option>
          <option value="REVERSED">Reversed</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-2.5">Tanggal</th>
              <th className="px-4 py-2.5">Nomor Jurnal</th>
              <th className="px-4 py-2.5">Keterangan</th>
              <th className="px-4 py-2.5">Status</th>
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
                  Gagal memuat daftar jurnal. {(error as Error).message}
                </td>
              </tr>
            )}
            {!isLoading &&
              !isError &&
              journals.map((j) => (
                <tr key={j.id} onClick={() => onOpenDetail(j.id)} className="cursor-pointer border-t border-line/60 hover:bg-surface-2/60">
                  <td className="px-4 py-2 tabular-nums">{j.entryDate.slice(0, 10)}</td>
                  <td className="px-4 py-2 font-medium text-heading">{j.referenceNo ?? "-"}</td>
                  <td className="px-4 py-2">{j.description ?? "-"}</td>
                  <td className="px-4 py-2">
                    <JournalStatusBadge status={j.status} />
                  </td>
                </tr>
              ))}
            {!isLoading && !isError && journals.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-ink/40">
                  Belum ada transaksi.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-ink/50">
        <span>{total} jurnal</span>
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
  );
}
