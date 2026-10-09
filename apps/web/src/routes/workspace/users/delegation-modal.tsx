import { X } from "lucide-react";
import { useState } from "react";
import {
  DELEGATION_CAPABILITY_OPTIONS,
  type AuthorizationUser,
  type BranchSummary,
  type DelegationCapability,
  type DelegationMaxRole,
} from "../../../features/workspace/authorization-types.js";
import { useCreateDelegation } from "../../../features/workspace/use-authorization.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";

const MAX_ROLE_BY_RECIPIENT: Record<string, DelegationMaxRole[]> = {
  ADMIN: ["VIEWER", "STAFF", "ACCOUNTANT"],
  ACCOUNTANT: ["VIEWER", "STAFF"],
};
const MAX_ROLE_LABEL: Record<DelegationMaxRole, string> = { VIEWER: "VIEWER", STAFF: "STAFF", ACCOUNTANT: "ACCOUNTANT" };

/**
 * Delegasikan Wewenang (model Revisi 5): OWNER memberi seorang ADMIN/ACCOUNTANT kapabilitas TETAP atas cabang tertentu,
 * dengan peran maksimum user yang boleh dikelola dan masa berlaku. Delegasi tidak mengubah peran, tidak memberi akses
 * cabang, dan tidak pernah mencakup "semua cabang". Semua batas ditegakkan server; form ini hanya membantu mengisi.
 */
export function DelegationModal({
  companySlug,
  users,
  branches,
  onClose,
}: {
  companySlug: string;
  users: AuthorizationUser[];
  branches: BranchSummary[];
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const create = useCreateDelegation(companySlug);
  const candidates = users.filter((u) => !u.self && (u.role === "ADMIN" || u.role === "ACCOUNTANT") && u.status === "ACTIVE" && !u.delegation);

  const [userId, setUserId] = useState("");
  const [capabilities, setCapabilities] = useState<DelegationCapability[]>(["manage_users"]);
  const [maxRole, setMaxRole] = useState<DelegationMaxRole>("STAFF");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recipient = candidates.find((u) => u.userId === userId);
  const allowedMaxRoles = recipient ? MAX_ROLE_BY_RECIPIENT[recipient.role] ?? [] : [];
  const effectiveMaxRole = allowedMaxRoles.includes(maxRole) ? maxRole : allowedMaxRoles[allowedMaxRoles.length - 1];
  const canSubmit = userId !== "" && capabilities.length > 0 && branchIds.length > 0 && Boolean(effectiveMaxRole) && !create.isPending;

  function toggleCap(c: DelegationCapability) {
    setCapabilities((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  }
  function toggleBranch(id: string) {
    setBranchIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function submit() {
    if (!canSubmit || !effectiveMaxRole) return;
    setError(null);
    try {
      await create.mutateAsync({
        granteeUserId: userId,
        capabilities,
        maxRole: effectiveMaxRole,
        branchIds,
        // akhir hari yang dipilih (zona waktu perangkat)
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        reason: reason.trim() || null,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Delegasikan Wewenang</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink" aria-label="Tutup">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          <p className="text-xs text-ink/50">
            Delegasi memberi admin cabang kewenangan terbatas atas cabang tertentu. Peran penerima tidak berubah, ia tidak mendapat akses cabang baru,
            dan ia tidak dapat mendelegasikannya lagi. Hak efektif = delegasi ∩ akses cabang penerima saat ini ∩ permission perannya.
          </p>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Penerima (ADMIN / ACCOUNTANT)</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className="input-base w-full">
              <option value="">Pilih pengguna...</option>
              {candidates.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
            {candidates.length === 0 && <p className="mt-1 text-xs text-ink/40">Tidak ada ADMIN/ACCOUNTANT aktif tanpa delegasi.</p>}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Kapabilitas</label>
            <div className="flex flex-col gap-1.5">
              {DELEGATION_CAPABILITY_OPTIONS.map((c) => (
                <label key={c.value} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2">
                  <input type="checkbox" className="mt-1" checked={capabilities.includes(c.value)} onChange={() => toggleCap(c.value)} />
                  <span className="flex-1">
                    <span className="text-heading">{c.label}</span>
                    {!c.active && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">disiapkan</span>}
                    <span className="block text-xs text-ink/50">{c.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Peran maksimum user yang boleh dikelola</label>
            <select value={effectiveMaxRole ?? ""} onChange={(e) => setMaxRole(e.target.value as DelegationMaxRole)} disabled={!recipient} className="input-base w-full disabled:opacity-50">
              {!recipient && <option value="">Pilih penerima dahulu</option>}
              {allowedMaxRoles.map((r) => (
                <option key={r} value={r}>
                  {MAX_ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink/40">Selalu di bawah peran penerima; tidak pernah ADMIN atau OWNER.</p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Cabang Cakupan</label>
            <div className="flex flex-col gap-1.5">
              {branches.map((b) => (
                <label key={b.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2">
                  <input type="checkbox" checked={branchIds.includes(b.id)} onChange={() => toggleBranch(b.id)} />
                  <span className="flex-1 text-heading">{b.name}</span>
                  <span className="text-xs text-ink/40">{b.code}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink/40">Delegasi tidak pernah mencakup semua cabang; pilih cabang secara eksplisit.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Masa berlaku s/d (opsional)</label>
              <input type="date" min={today} value={expires} onChange={(e) => setExpires(e.target.value)} className="input-base w-full" />
              <p className="mt-1 text-xs text-ink/40">Maksimal 366 hari. Kosong = sampai dicabut.</p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Alasan (opsional)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="input-base w-full" placeholder="mis. cuti manajer" />
            </div>
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>

        <div className="flex gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {create.isPending ? "Menyimpan..." : "Simpan Delegasi"}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            Batal
          </button>
        </div>
      </div>
    </div>
  );
}
