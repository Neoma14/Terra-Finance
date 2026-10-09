import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { companyApi } from "../../../lib/company-api-client.js";

interface BranchContextForScope {
  multiBranchEnabled: boolean;
  scope: "ALL" | "LIMITED";
  context: { id: string; name: string } | null;
  branches: Array<{ id: string; code: string; name: string; status: "ACTIVE" | "INACTIVE" | "CLOSED" }>;
  capabilities?: { viewConsolidatedReports?: boolean; allBranchesAccessible?: boolean };
}

type Mode = "default" | "single" | "selected" | "comparison" | "all";
const STATUS_SUFFIX = { ACTIVE: "", INACTIVE: " (nonaktif)", CLOSED: " (ditutup)" } as const;

function parse(scope: string): { mode: Mode; ids: string[] } {
  if (scope === "all") return { mode: "all", ids: [] };
  const m = /^(branch|selected|branches):(.+)$/.exec(scope);
  if (!m) return { mode: "default", ids: [] };
  const ids = m[2].split(",");
  return { mode: m[1] === "branch" ? "single" : m[1] === "selected" ? "selected" : "comparison", ids };
}

/**
 * Pemilih cakupan laporan (Phase 5). KENYAMANAN, bukan penegakan: opsi yang tidak diizinkan disembunyikan, tetapi server
 * memvalidasi ulang tiap request (akses cabang + report.consolidated) dan menjawab dengan cakupan yang benar-benar dipakai.
 * Tidak tampil untuk perusahaan tanpa multi-cabang (tampilan lama tidak berubah sama sekali).
 */
export function ReportScopePicker({
  companySlug,
  scope,
  onChange,
  allowComparison = false,
}: {
  companySlug: string;
  scope: string;
  onChange: (scope: string) => void;
  allowComparison?: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["workspace", "branch-context", companySlug],
    queryFn: () => companyApi.get<BranchContextForScope>(`/${companySlug}/branch-context`),
    enabled: Boolean(companySlug),
    staleTime: 30_000,
  });
  const applied = parse(scope);
  const [mode, setMode] = useState<Mode>(applied.mode);
  const [singleId, setSingleId] = useState(applied.mode === "single" ? (applied.ids[0] ?? "") : "");
  const [checked, setChecked] = useState<string[]>(applied.mode === "selected" || applied.mode === "comparison" ? applied.ids : []);

  useEffect(() => {
    const next = parse(scope);
    setMode(next.mode);
    if (next.mode === "single") setSingleId(next.ids[0] ?? "");
    if (next.mode === "selected" || next.mode === "comparison") setChecked(next.ids);
  }, [scope]);

  if (!data || !data.multiBranchEnabled) return null;
  const branches = data.branches;
  const canConsolidate = Boolean(data.capabilities?.viewConsolidatedReports) && branches.length >= 2;
  const canAll = canConsolidate && Boolean(data.capabilities?.allBranchesAccessible);

  function pickMode(next: Mode) {
    setMode(next);
    if (next === "default") onChange("");
    else if (next === "all") onChange("all");
    else if (next === "single") {
      const id = singleId || data?.context?.id || branches[0]?.id || "";
      setSingleId(id);
      if (id) onChange(`branch:${id}`);
    }
  }
  function toggle(id: string) {
    setChecked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }
  const multiReady = checked.length >= 2;

  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" data-testid="report-scope-picker">
      <legend className="px-1 text-xs font-medium text-ink/60">Cakupan cabang</legend>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink/60">
          Tampilkan data untuk
          <select className="input-base w-80" value={mode} onChange={(e) => pickMode(e.target.value as Mode)} data-testid="scope-mode">
            <option value="default">Cabang kerja aktif{data.context ? `: ${data.context.name}` : ""}</option>
            <option value="single">Satu cabang tertentu</option>
            {canConsolidate && <option value="selected">Gabungan cabang terpilih</option>}
            {canConsolidate && allowComparison && <option value="comparison">Komparasi per cabang</option>}
            {canAll && <option value="all">Gabungan seluruh cabang</option>}
          </select>
        </label>

        {mode === "single" && (
          <label className="flex flex-col gap-1 text-xs font-medium text-ink/60">
            Cabang
            <select
              className="input-base w-80"
              value={singleId}
              onChange={(e) => {
                setSingleId(e.target.value);
                if (e.target.value) onChange(`branch:${e.target.value}`);
              }}
              data-testid="scope-single"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {STATUS_SUFFIX[b.status]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {(mode === "selected" || mode === "comparison") && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-label="Pilih minimal dua cabang">
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 text-sm text-heading">
                <input type="checkbox" checked={checked.includes(b.id)} onChange={() => toggle(b.id)} data-testid={`scope-branch-${b.code}`} />
                {b.name}
                {STATUS_SUFFIX[b.status]}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!multiReady}
              onClick={() => onChange(`${mode === "selected" ? "selected" : "branches"}:${checked.join(",")}`)}
              className="rounded-lg bg-navy-700 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
              data-testid="scope-apply"
            >
              Terapkan
            </button>
            {!multiReady && <span className="text-xs text-ink/60">Pilih minimal dua cabang.</span>}
          </div>
        </div>
      )}
    </fieldset>
  );
}
