import { X } from "lucide-react";
import { useState } from "react";
import { useGrantAccess } from "../../../features/workspace/use-access.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import type { CompanyWorkspaceRole } from "../../../features/workspace/types.js";

const ROLE_OPTIONS: CompanyWorkspaceRole[] = ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"];

/**
 * TASK-022 -- Tambah Pengguna. Reuse `POST /api/company-db/:slug/access`
 * (TASK-DB-ARCH-011) apa adanya, TIDAK ADA endpoint baru. Field "Email /
 * User" dikirim sebagai `userId` ke backend -- backend yang menerima id
 * ATAU email (lihat komentar `resolveTargetUser` di routes.ts), bukan
 * logic resolusi di frontend, krn sumber kebenaran tetap satu tempat.
 */
export function AddAccessModal({ companySlug, onClose }: { companySlug: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  const grant = useGrantAccess(companySlug);
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<CompanyWorkspaceRole>("STAFF");

  const canSubmit = identifier.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    await grant.mutateAsync({ userId: identifier.trim(), role });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Tambah Pengguna</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Email / User</label>
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="input-base w-full"
              placeholder="email@contoh.com"
              autoFocus
            />
            <p className="mt-1 text-xs text-ink/40">User harus sudah terdaftar di instalasi TERRA FINANCE ini.</p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as CompanyWorkspaceRole)} className="input-base w-full">
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          {grant.isError && <p className="text-sm text-rose-600">{(grant.error as Error).message}</p>}
        </div>

        <div className="flex gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            disabled={!canSubmit || grant.isPending}
            onClick={handleSubmit}
            className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {grant.isPending ? "Menambahkan..." : "Tambah Pengguna"}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            Batal
          </button>
        </div>
      </div>
    </div>
  );
}
