import { Check, ChevronsUpDown } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useClickOutside } from "../../lib/use-click-outside.js";
import { useAccessibleCompanies } from "../../features/workspace/use-workspace.js";
import type { AccessibleCompany } from "../../features/workspace/types.js";

/** Dropdown ganti-perusahaan -- pola popover sama dgn `ThemeMenu`
 * (`useClickOutside`). List diambil dari query yang SAMA dgn Company
 * Selector (`useAccessibleCompanies`, sudah di-cache react-query) --
 * tidak ada request/daftar terpisah yang bisa beda isinya. */
export function CompanySwitcher({ current }: { current: AccessibleCompany }) {
  const { data } = useAccessibleCompanies();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setOpen(false), open);
  const navigate = useNavigate();

  return (
    <div className="relative z-40" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:bg-surface-2"
      >
        <span className="max-w-[200px] truncate">{current.name}</span>
        <ChevronsUpDown size={14} className="text-ink/40" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-64 rounded-lg border border-line bg-surface p-1">
          {(data?.companies ?? []).map((c) => (
            <button
              key={c.companyId}
              type="button"
              onClick={() => {
                setOpen(false);
                if (c.slug !== current.slug) navigate(`/workspace/${c.slug}`);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm text-ink hover:bg-surface-2"
            >
              <span className="truncate">{c.name}</span>
              {c.slug === current.slug && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/workspace");
            }}
            className="w-full rounded-md px-2.5 py-2 text-left text-sm text-ink/60 hover:bg-surface-2"
          >
            Lihat semua perusahaan
          </button>
        </div>
      )}
    </div>
  );
}
