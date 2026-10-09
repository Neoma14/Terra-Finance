import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Badge, Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useBranches, useMyAuthorization } from "../../../features/workspace/use-authorization.js";
import { useInterBranchList, useInterBranchSettings, useInterBranchSummary, useSetInterBranchExpiry } from "../../../features/workspace/use-inter-branch.js";
import { INTER_BRANCH_STATUS_LABEL, INTER_BRANCH_TYPE_LABEL, type InterBranchListFilters, type InterBranchStatus, type InterBranchType } from "../../../features/workspace/inter-branch-types.js";
import { InterBranchDetailModal } from "./inter-branch-detail-modal.js";
import { InterBranchFormModal } from "./inter-branch-form-modal.js";
import { InterBranchStatusBadges } from "./inter-branch-status-badge.js";

type Box = "in" | "out" | "all";
const PAGE_SIZE = 20;
const TABS: Array<{ key: Box; label: string }> = [
  { key: "in", label: "Masuk" },
  { key: "out", label: "Keluar" },
  { key: "all", label: "Semua" },
];

function ExpirySetting({ companySlug }: { companySlug: string }) {
  const settings = useInterBranchSettings(companySlug, true);
  const save = useSetInterBranchExpiry(companySlug);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!settings.data) return null;
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-heading">Masa berlaku pengajuan</p>
      <p className="mb-2 text-xs text-ink/50">Pengajuan yang tidak diputuskan cabang tujuan kedaluwarsa setelah jumlah hari ini (berlaku untuk pengajuan berikutnya).</p>
      <div className="flex items-center gap-2">
        <input className="input-base w-24" type="number" min={settings.data.minDays} max={settings.data.maxDays} placeholder={String(settings.data.expiryDays)} value={value} onChange={(e) => setValue(e.target.value)} data-testid="ib-expiry-input" />
        <span className="text-sm text-ink/60">hari (saat ini {settings.data.expiryDays})</span>
        <button
          type="button"
          disabled={save.isPending || value === ""}
          className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2 disabled:opacity-50"
          onClick={async () => {
            setError(null);
            try {
              await save.mutateAsync(Number(value));
              setValue("");
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          Simpan
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </Card>
  );
}

export function InterBranchPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const slug = company.slug;
  const authorization = useMyAuthorization(slug);
  const branches = useBranches(slug);
  const permissions = authorization.data?.permissions ?? [];
  const enabled = branches.data?.multiBranchEnabled === true && permissions.includes("interbranch.read");
  const canCreate = permissions.includes("interbranch.create");

  const [box, setBox] = useState<Box>("all");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<InterBranchStatus | "">("");
  const [type, setType] = useState<InterBranchType | "">("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const filters: InterBranchListFilters = { box, status, type, search: search || undefined, fromDate: fromDate || undefined, toDate: toDate || undefined, page, pageSize: PAGE_SIZE };
  const list = useInterBranchList(slug, filters, enabled);
  const summary = useInterBranchSummary(slug, enabled);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const reset = () => setPage(1);

  if (authorization.isLoading || branches.isLoading) return <p className="text-sm text-ink/50">Memuat...</p>;
  if (!enabled) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="vt-page-title text-xl font-bold text-heading">Antar Cabang</h1>
        <p className="text-sm text-ink/60" data-testid="ib-disabled">
          Transaksi antar cabang tidak tersedia: fitur multi-cabang belum diaktifkan untuk perusahaan ini, atau akun Anda belum memiliki izin untuk melihatnya.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Antar Cabang</h1>
          <p className="text-sm text-ink/50">Transfer kas dan pembebanan antar cabang {company.name}. Jurnal kedua cabang baru dibuat setelah cabang tujuan menyetujui.</p>
        </div>
        {canCreate && (
          <button type="button" onClick={() => setCreating(true)} data-testid="ib-new" className="flex items-center gap-1.5 rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900">
            <Plus size={14} /> Transaksi Baru
          </button>
        )}
      </div>

      <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            data-testid={`ib-tab-${key}`}
            onClick={() => {
              setBox(key);
              reset();
            }}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${box === key ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"}`}
          >
            {label}
            {key === "in" && (summary.data?.incomingWaiting ?? 0) > 0 && <Badge tone="warning">{summary.data!.incomingWaiting}</Badge>}
            {key === "out" && (summary.data?.outgoingWaiting ?? 0) > 0 && <Badge tone="neutral">{summary.data!.outgoingWaiting}</Badge>}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink/40" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                reset();
              }}
              placeholder="Cari nomor/keterangan..."
              className="input-base w-56 pl-8"
              data-testid="ib-search"
            />
          </div>
          <select value={status} onChange={(e) => { setStatus(e.target.value as InterBranchStatus | ""); reset(); }} className="input-base" data-testid="ib-filter-status">
            <option value="">Semua status</option>
            {(Object.keys(INTER_BRANCH_STATUS_LABEL) as InterBranchStatus[]).map((s) => (
              <option key={s} value={s}>
                {INTER_BRANCH_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => { setType(e.target.value as InterBranchType | ""); reset(); }} className="input-base">
            <option value="">Semua jenis</option>
            {(Object.keys(INTER_BRANCH_TYPE_LABEL) as InterBranchType[]).map((t) => (
              <option key={t} value={t}>
                {INTER_BRANCH_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); reset(); }} className="input-base" />
          <span className="text-ink/30">-</span>
          <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); reset(); }} className="input-base" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="ib-table">
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="px-4 py-2.5">Nomor</th>
                <th className="px-4 py-2.5">Asal → Tujuan</th>
                <th className="px-4 py-2.5">Tanggal</th>
                <th className="px-4 py-2.5">Jenis</th>
                <th className="px-4 py-2.5 text-right">Nominal</th>
                <th className="px-4 py-2.5">Dibuat oleh</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-ink/40">
                    Memuat...
                  </td>
                </tr>
              )}
              {list.isError && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-rose-600">
                    Gagal memuat daftar. {(list.error as Error).message}
                  </td>
                </tr>
              )}
              {!list.isError &&
                items.map((it) => (
                  <tr key={it.id} onClick={() => setDetailId(it.id)} className="cursor-pointer border-t border-line/60 hover:bg-surface-2/60" data-testid="ib-row">
                    <td className="px-4 py-2 font-medium text-heading">{it.transactionNo}</td>
                    <td className="px-4 py-2">
                      {it.fromBranch.name} → {it.toBranch.name}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{it.transactionDate}</td>
                    <td className="px-4 py-2">{INTER_BRANCH_TYPE_LABEL[it.type]}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatIDR(it.amount)}</td>
                    <td className="px-4 py-2">{it.proposedBy.name}</td>
                    <td className="px-4 py-2">
                      <InterBranchStatusBadges item={it} />
                    </td>
                  </tr>
                ))}
              {!list.isLoading && !list.isError && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-ink/40" data-testid="ib-empty">
                    {search || status || type || fromDate || toDate
                      ? "Tidak ada transaksi yang cocok dengan filter."
                      : box === "in"
                        ? "Tidak ada transaksi masuk."
                        : box === "out"
                          ? "Belum ada transaksi keluar."
                          : "Belum ada transaksi antar cabang."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-ink/50">
          <span>{total} transaksi</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-line p-1.5 hover:bg-surface-2 disabled:opacity-40" aria-label="Halaman sebelumnya">
              <ChevronLeft size={14} />
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-line p-1.5 hover:bg-surface-2 disabled:opacity-40" aria-label="Halaman berikutnya">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </Card>

      {company.role === "OWNER" && <ExpirySetting companySlug={slug} />}

      {creating && (
        <InterBranchFormModal
          companySlug={slug}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setDetailId(id);
          }}
        />
      )}
      {detailId && <InterBranchDetailModal companySlug={slug} id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
