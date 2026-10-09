import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState } from "react";
import { Card } from "../../../components/ui.js";
import { useAccountList, useAccountTypes } from "../../../features/workspace/use-accounts.js";
import { AccountStatusBadge } from "./account-status-badge.js";

const PAGE_SIZE = 50;

export function AccountList({ companySlug, onOpenDetail }: { companySlug: string; onOpenDetail: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [accountTypeId, setAccountTypeId] = useState("");
  const [activeFilter, setActiveFilter] = useState<"" | "true" | "false">("");
  const [page, setPage] = useState(1);

  const { data: typesData } = useAccountTypes(companySlug);
  const accountTypeById = new Map((typesData?.accountTypes ?? []).map((t) => [t.id, t]));

  const { data, isLoading, isError, error } = useAccountList(companySlug, {
    search: search || undefined,
    accountTypeId: accountTypeId || undefined,
    isActive: activeFilter === "" ? undefined : activeFilter === "true",
    page,
    pageSize: PAGE_SIZE,
  });
  const accounts = data?.accounts ?? [];
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
            placeholder="Cari kode/nama akun..."
            className="input-base w-56 pl-8"
          />
        </div>
        <select
          value={accountTypeId}
          onChange={(e) => {
            setAccountTypeId(e.target.value);
            resetToFirstPage();
          }}
          className="input-base"
        >
          <option value="">Semua Tipe</option>
          {(typesData?.accountTypes ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.code}
            </option>
          ))}
        </select>
        <select
          value={activeFilter}
          onChange={(e) => {
            setActiveFilter(e.target.value as "" | "true" | "false");
            resetToFirstPage();
          }}
          className="input-base"
        >
          <option value="">Semua Status</option>
          <option value="true">Aktif</option>
          <option value="false">Nonaktif</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-4 py-2.5">Kode</th>
              <th className="px-4 py-2.5">Nama Akun</th>
              <th className="px-4 py-2.5">Tipe</th>
              <th className="px-4 py-2.5">Kas</th>
              <th className="px-4 py-2.5">Status</th>
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
              accounts.map((a) => (
                <tr key={a.id} onClick={() => onOpenDetail(a.id)} className="cursor-pointer border-t border-line/60 hover:bg-surface-2/60">
                  <td className="px-4 py-2 tabular-nums font-medium text-heading">{a.code}</td>
                  <td className="px-4 py-2">{a.name}</td>
                  <td className="px-4 py-2 text-ink/60">{accountTypeById.get(a.accountTypeId)?.code ?? "-"}</td>
                  <td className="px-4 py-2 text-ink/60">{a.isCash ? "Ya" : "-"}</td>
                  <td className="px-4 py-2">
                    <AccountStatusBadge isActive={a.isActive} isLocked={a.isLocked} />
                  </td>
                </tr>
              ))}
            {!isLoading && !isError && accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-ink/40">
                  Belum ada akun.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-ink/50">
        <span>{total} akun</span>
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
