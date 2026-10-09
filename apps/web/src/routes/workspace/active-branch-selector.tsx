import { Building2, Check, ChevronsUpDown, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import { useClickOutside } from "../../lib/use-click-outside.js";
import { ACTIVE_BRANCH_CHANGED_EVENT, BRANCH_CONTEXT_INVALID_EVENT, setActiveBranch } from "../../lib/active-branch.js";
import { Badge } from "../../components/ui.js";

interface BranchContextResponse {
  multiBranchEnabled: boolean;
  scope: "ALL" | "LIMITED";
  context: { id: string; code: string; name: string; status: string } | null;
  contextSource: "header" | "preference" | "default" | "none";
  branches: Array<{ id: string; code: string; name: string; status: "ACTIVE" | "INACTIVE" | "CLOSED"; isHeadOffice: boolean; operational: boolean; isContext: boolean }>;
}

const STATUS_LABEL = { ACTIVE: "Aktif", INACTIVE: "Nonaktif", CLOSED: "Ditutup" } as const;

/** Tanda tangan akses (scope + cabang + statusnya) untuk mendeteksi perubahan akses saat sesi berjalan. */
function accessSignature(d: BranchContextResponse): string {
  return `${d.scope}|${d.branches.map((b) => `${b.id}:${b.status}`).sort().join(",")}`;
}

/**
 * Pemilih Cabang Aktif. SERVER adalah sumber kebenaran: yang ditampilkan adalah `context` hasil validasi server
 * (header `X-Branch-Context` dikirim dari pilihan tersimpan, tetapi divalidasi ulang tiap request). Bila akses dicabut
 * / cabang ditutup, server menolak, pilihan tersimpan dibuang, dan komponen ini menampilkan pemberitahuan.
 * Hanya tampil saat multi-cabang aktif pada perusahaan -- perusahaan biasa tidak berubah sama sekali.
 */
export function ActiveBranchSelector({ companySlug }: { companySlug: string }) {
  const qc = useQueryClient();
  const queryKey = ["workspace", "branch-context", companySlug];
  const { data } = useQuery({
    queryKey,
    queryFn: () => companyApi.get<BranchContextResponse>(`/${companySlug}/branch-context`),
    enabled: Boolean(companySlug),
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setOpen(false), open);
  const lastSignature = useRef<string | null>(null);

  // Deteksi perubahan akses/scope sejak terakhir dilihat.
  useEffect(() => {
    if (!data) return;
    const sig = accessSignature(data);
    if (lastSignature.current !== null && lastSignature.current !== sig) {
      setNotice(`Akses cabang Anda berubah (${data.scope === "ALL" ? "semua cabang" : `${data.branches.length} cabang`}). Cabang aktif: ${data.context?.name ?? "tidak ada"}.`);
    }
    lastSignature.current = sig;
  }, [data]);

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries();
  }, [qc]);

  useEffect(() => {
    function onInvalid(e: Event) {
      if ((e as CustomEvent<{ slug: string }>).detail?.slug !== companySlug) return;
      setNotice("Cabang kerja sebelumnya tidak lagi sah (akses dicabut atau cabang ditutup). Sistem beralih ke cabang yang diizinkan server.");
      refreshAll();
    }
    function onChanged(e: Event) {
      if ((e as CustomEvent<{ slug: string }>).detail?.slug === companySlug) void qc.invalidateQueries({ queryKey });
    }
    window.addEventListener(BRANCH_CONTEXT_INVALID_EVENT, onInvalid);
    window.addEventListener(ACTIVE_BRANCH_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(BRANCH_CONTEXT_INVALID_EVENT, onInvalid);
      window.removeEventListener(ACTIVE_BRANCH_CHANGED_EVENT, onChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySlug, refreshAll, qc]);

  if (!data || !data.multiBranchEnabled) return null;

  const operational = data.branches.filter((b) => b.operational);

  async function choose(branchId: string) {
    setOpen(false);
    if (branchId === data?.context?.id) return;
    setBusy(true);
    setError(null);
    try {
      // Buang pilihan lama dulu agar PUT tidak membawa header cabang yang mungkin sudah tidak sah.
      setActiveBranch(companySlug, null);
      await companyApi.put(`/${companySlug}/branch-context`, { branchId });
      setActiveBranch(companySlug, branchId);
      setNotice(null);
      refreshAll();
    } catch (err) {
      setError((err as Error).message);
      void qc.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative z-40 flex items-center gap-2" ref={containerRef}>
      <button
        type="button"
        data-testid="active-branch-button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="Cabang aktif: jurnal dan saldo awal yang Anda lihat dan buat mengikuti cabang ini"
        className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2 disabled:opacity-60"
      >
        <Building2 size={14} className="text-ink/40" />
        <span className="text-xs text-ink/50">Cabang aktif</span>
        <span className="max-w-[160px] truncate" data-testid="active-branch-name">
          {data.context ? data.context.name : "Tidak ada"}
        </span>
        <ChevronsUpDown size={14} className="text-ink/40" />
      </button>
      <Badge tone={data.scope === "ALL" ? "info" : "neutral"}>{data.scope === "ALL" ? "Akses semua cabang" : `Terbatas (${operational.length} aktif)`}</Badge>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-80 rounded-lg border border-line bg-surface p-1">
          {data.branches.length === 0 && <p className="px-2.5 py-2 text-sm text-ink/50">Anda belum memiliki akses ke cabang mana pun. Hubungi pemilik perusahaan.</p>}
          {data.branches.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={!b.operational}
              onClick={() => choose(b.id)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate">{b.name}</span>
                <span className="block text-xs text-ink/40">
                  {b.code}
                  {b.status !== "ACTIVE" ? ` · ${STATUS_LABEL[b.status]} (hanya baca)` : ""}
                </span>
              </span>
              {b.id === data.context?.id && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
          <div className="mt-1 border-t border-line px-2.5 py-2 text-xs text-ink/50">
            Jurnal dan saldo awal mengikuti cabang aktif. Laporan, dashboard, dan buku besar masih mencakup seluruh perusahaan sampai pelaporan per cabang tersedia.
            Server memeriksa ulang akses Anda pada setiap permintaan.
          </div>
        </div>
      )}

      {(notice || error) && (
        <div className={`absolute left-0 top-full mt-1.5 flex w-96 max-w-[90vw] items-start gap-2 rounded-lg border px-3 py-2 text-xs ${error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"}`} style={{ zIndex: 30 }} role="status">
          <span className="flex-1">{error ?? notice}</span>
          <button type="button" aria-label="Tutup pemberitahuan" onClick={() => (setNotice(null), setError(null))}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
