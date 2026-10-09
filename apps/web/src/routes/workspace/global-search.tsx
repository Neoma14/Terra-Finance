import { FileText, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import { formatIDR } from "../../lib/format.js";
import { WORKSPACE_NAV_LEAVES } from "./nav-config.js";

interface SearchJournal {
  id: string;
  referenceNo: string | null;
  description: string | null;
  entryDate: string;
  status: string;
  total: number;
}
interface SearchAccount {
  id: string;
  code: string;
  name: string;
}
interface SearchResult {
  journals: SearchJournal[];
  accounts: SearchAccount[];
}

/** Menu yang bisa dicari selain nama di sidebar (sinonim umum). */
const MENU_ALIASES: Record<string, string> = {
  jurnal: "journal entry transaksi",
  accounts: "akun coa chart of accounts",
  ledger: "buku besar",
  "trial-balance": "neraca saldo",
  reports: "neraca laba rugi balance sheet income statement cash flow arus kas ekuitas",
  buku: "kas bank",
  pengaturan: "settings backdate",
  "audit-log": "riwayat log",
};

/**
 * Pencarian global (Ctrl+K / tombol di header). Menu dicari di klien dari
 * daftar navigasi yang sama dengan sidebar; transaksi dan akun dicari lewat
 * `GET /search` yang dijaga auth -> akses perusahaan -> permission di server.
 */
export function GlobalSearch({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setTerm("");
      setDebounced("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 200);
    return () => clearTimeout(t);
  }, [term]);

  const { data, isFetching } = useQuery({
    queryKey: ["workspace", "search", companySlug, debounced],
    queryFn: () => companyApi.get<SearchResult>(`/${companySlug}/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });

  const menus = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return WORKSPACE_NAV_LEAVES.filter((m) => `${m.label} ${MENU_ALIASES[m.key] ?? ""}`.toLowerCase().includes(q)).slice(0, 6);
  }, [term]);

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  const hasAny = menus.length > 0 || (data?.journals.length ?? 0) > 0 || (data?.accounts.length ?? 0) > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Cari (Ctrl+K)"
        className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink/50 hover:text-ink"
      >
        <Search size={14} />
        <span className="hidden sm:inline">Cari menu, jurnal, akun...</span>
        <kbd className="hidden rounded border border-line px-1.5 text-[10px] sm:inline">Ctrl K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Search size={16} className="text-ink/40" />
              <input
                ref={inputRef}
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Cari menu, nomor jurnal, keterangan, tanggal, nominal, akun..."
                className="w-full bg-transparent text-sm text-heading outline-none placeholder:text-ink/40"
              />
              <button type="button" onClick={() => setOpen(false)} className="text-ink/40 hover:text-ink">
                <X size={16} />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-2 text-sm">
              {term.trim().length < 2 && menus.length === 0 && <p className="px-3 py-6 text-center text-ink/40">Ketik minimal 2 huruf. Contoh: ledger, JRN-0001, kas, 1500000.</p>}

              {menus.length > 0 && (
                <Section title="Menu">
                  {menus.map((m) => (
                    <Row key={m.key || "dashboard"} onClick={() => go(m.key ? `/workspace/${companySlug}/${m.key}` : `/workspace/${companySlug}`)}>
                      <FileText size={14} className="text-ink/40" /> {m.label}
                    </Row>
                  ))}
                </Section>
              )}

              {(data?.journals.length ?? 0) > 0 && (
                <Section title="Transaksi">
                  {data!.journals.map((j) => (
                    <Row key={j.id} onClick={() => go(`/workspace/${companySlug}/jurnal?journalId=${j.id}`)}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-heading">
                          {j.referenceNo ?? "(tanpa nomor)"} <span className="font-normal text-ink/40">· {String(j.entryDate).slice(0, 10)} · {j.status}</span>
                        </p>
                        <p className="truncate text-xs text-ink/50">{j.description || "-"}</p>
                      </div>
                      <span className="shrink-0 tabular-nums text-xs text-ink/60">{formatIDR(Number(j.total))}</span>
                    </Row>
                  ))}
                </Section>
              )}

              {(data?.accounts.length ?? 0) > 0 && (
                <Section title="Akun (buka Ledger)">
                  {data!.accounts.map((a) => (
                    <Row key={a.id} onClick={() => go(`/workspace/${companySlug}/ledger?accountId=${a.id}`)}>
                      <span className="font-medium text-heading">{a.code}</span> <span className="text-ink/70">{a.name}</span>
                    </Row>
                  ))}
                </Section>
              )}

              {debounced.length >= 2 && !isFetching && !hasAny && <p className="px-3 py-6 text-center text-ink/40">Tidak ada hasil untuk "{debounced}".</p>}
              {isFetching && <p className="px-3 py-2 text-xs text-ink/40">Mencari...</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink/40">{title}</p>
      {children}
    </div>
  );
}

function Row({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-2">
      {children}
    </button>
  );
}
