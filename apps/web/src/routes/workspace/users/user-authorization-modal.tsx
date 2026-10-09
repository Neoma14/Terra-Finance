import { X } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../../components/ui.js";
import {
  OVERRIDABLE_PERMISSION_OPTIONS,
  capabilityLabel,
  type AuthorizationUser,
  type BranchSummary,
  type MyAuthorization,
  type OverridablePermission,
} from "../../../features/workspace/authorization-types.js";
import {
  useAuthorizationUsers,
  useGrantBranchAccess,
  useRevokeBranchAccess,
  useRevokePermissionOverride,
  useSetPermissionOverride,
} from "../../../features/workspace/use-authorization.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";

type OverrideChoice = "DEFAULT" | "GRANT" | "DENY";

function formatDate(iso: string | null): string {
  if (!iso) return "tanpa batas waktu";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Atur wewenang satu pengguna: akses cabang (centang), wewenang khusus (override GRANT/DENY),
 * dan delegasi yang diterimanya. UI hanya menampilkan apa yang boleh dicoba; batas wewenang,
 * cakupan cabang, dan pencegahan eskalasi ditegakkan SERVER (db/system/authorization.ts).
 */
export function UserAuthorizationModal({
  companySlug,
  userId,
  branches,
  me,
  canManageBranchAccess,
  canManageOverrides,
  onClose,
}: {
  companySlug: string;
  userId: string;
  branches: BranchSummary[];
  me: MyAuthorization;
  canManageBranchAccess: boolean;
  canManageOverrides: boolean;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const list = useAuthorizationUsers(companySlug, true);
  const grantBranch = useGrantBranchAccess(companySlug);
  const revokeBranch = useRevokeBranchAccess(companySlug);
  const setOverride = useSetPermissionOverride(companySlug);
  const revokeOverride = useRevokePermissionOverride(companySlug);
  const [error, setError] = useState<string | null>(null);

  const user: AuthorizationUser | undefined = list.data?.users.find((u) => u.userId === userId);
  const busy = grantBranch.isPending || revokeBranch.isPending || setOverride.isPending || revokeOverride.isPending;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function toggleBranch(u: AuthorizationUser, branch: BranchSummary, checked: boolean) {
    if (checked) return run(() => grantBranch.mutateAsync({ userId: u.userId, branchId: branch.id }));
    if (!confirm(`Cabut akses ${u.name} ke ${branch.name}? Berlaku pada permintaan berikutnya, tanpa perlu logout.`)) return;
    return run(() => revokeBranch.mutateAsync({ userId: u.userId, branchId: branch.id }));
  }

  function changeOverride(u: AuthorizationUser, permission: OverridablePermission, choice: OverrideChoice) {
    if (choice === "DEFAULT") return run(() => revokeOverride.mutateAsync({ userId: u.userId, permission }));
    return run(() => setOverride.mutateAsync({ userId: u.userId, permission, effect: choice }));
  }

  // Aktor LIMITED hanya melihat/menyentuh cabang efektif delegasi manage_users-nya; aktor ALL melihat semua cabang.
  const manageable = me.scope === "ALL" ? branches : branches.filter((b) => me.delegation?.effectiveBranchIds.manage_users.includes(b.id));
  const hasAllAccess = user?.branchScope === "ALL";
  const branchLocked = !user || user.self || hasAllAccess || user.role === "OWNER" || !canManageBranchAccess;
  const overrideLocked = !user || user.self || user.role === "OWNER" || !canManageOverrides;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-heading">Atur Wewenang</h2>
            {user && (
              <p className="text-xs text-ink/50">
                {user.name} · <Badge tone={user.role === "OWNER" ? "accent" : "neutral"}>{user.role}</Badge>
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink" aria-label="Tutup">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto px-6 py-5">
          {list.isLoading && <p className="text-sm text-ink/40">Memuat...</p>}
          {!list.isLoading && !user && <p className="text-sm text-rose-600">Pengguna tidak ditemukan atau berada di luar cakupan Anda.</p>}
          {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/20 dark:bg-rose-500/10">{error}</p>}

          {user && (
            <>
              <section>
                <h3 className="mb-1 text-sm font-semibold text-heading">Akses Cabang</h3>
                <p className="mb-2 text-xs text-ink/50">
                  Cabang yang boleh dikerjakan pengguna ini. Peran tetap satu untuk seluruh perusahaan; cabang hanya menentukan cakupan data.
                </p>
                {hasAllAccess && <p className="mb-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink/60">Pengguna ini memiliki akses ke semua cabang.</p>}
                {user.self && <p className="mb-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink/60">Anda tidak dapat mengubah wewenang Anda sendiri.</p>}
                <div className="flex flex-col gap-1.5">
                  {manageable.map((b) => {
                    const checked = hasAllAccess || user.branches.some((x) => x.id === b.id);
                    const cannotGrant = !checked && b.status !== "ACTIVE";
                    return (
                      <label key={b.id} className={`flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-sm ${branchLocked || cannotGrant ? "opacity-60" : "cursor-pointer hover:bg-surface-2"}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={branchLocked || busy || cannotGrant || hasAllAccess}
                          onChange={(e) => toggleBranch(user, b, e.target.checked)}
                        />
                        <span className="flex-1 text-heading">{b.name}</span>
                        <span className="text-xs text-ink/40">{b.code}</span>
                        {b.status !== "ACTIVE" && <Badge tone="warning">{b.status === "CLOSED" ? "Ditutup" : "Nonaktif"}</Badge>}
                      </label>
                    );
                  })}
                  {manageable.length === 0 && <p className="text-xs text-ink/40">Belum ada cabang dalam cakupan delegasi Anda.</p>}
                </div>
                {user.hiddenBranchCount > 0 && (
                  <p className="mt-1.5 text-xs text-ink/40">Pengguna ini juga memiliki akses ke {user.hiddenBranchCount} cabang lain di luar cakupan Anda.</p>
                )}
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold text-heading">Wewenang Khusus</h3>
                <p className="mb-2 text-xs text-ink/50">
                  Menambah atau membatasi wewenang operasional di luar peran. Hanya wewenang yang Anda miliki yang dapat diberikan; wewenang administrasi hanya mengikuti peran.
                </p>
                {user.role === "OWNER" && <p className="mb-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink/60">OWNER selalu memiliki wewenang penuh.</p>}
                <div className="flex flex-col gap-1.5">
                  {OVERRIDABLE_PERMISSION_OPTIONS.map((opt) => {
                    const current = user.overrides.find((o) => o.permission === opt.value);
                    const choice: OverrideChoice = current ? current.effect : "DEFAULT";
                    const roleHas = user.roleDefaults.includes(opt.value);
                    return (
                      <div key={opt.value} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-heading">{opt.label}</p>
                          <p className="text-xs text-ink/40">Bawaan peran {user.role}: {roleHas ? "diizinkan" : "tidak diizinkan"}</p>
                        </div>
                        <select
                          value={choice}
                          disabled={overrideLocked || busy}
                          onChange={(e) => changeOverride(user, opt.value, e.target.value as OverrideChoice)}
                          className="input-base disabled:opacity-50"
                          aria-label={`Wewenang ${opt.label}`}
                        >
                          <option value="DEFAULT">Ikuti peran</option>
                          <option value="GRANT">Izinkan</option>
                          <option value="DENY">Batasi</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
                {me.role !== "OWNER" && <p className="mt-1.5 text-xs text-ink/40">Server menolak pemberian wewenang yang tidak Anda miliki.</p>}
              </section>

              <section>
                <h3 className="mb-1 text-sm font-semibold text-heading">Delegasi yang Diterima</h3>
                {!user.delegation ? (
                  <p className="text-xs text-ink/40">Tidak ada delegasi aktif. Delegasi dikelola OWNER dari tombol "Delegasikan Wewenang".</p>
                ) : (
                  <div className="rounded-lg border border-line px-3 py-2 text-sm">
                    <p className="text-heading">{user.delegation.capabilities.map(capabilityLabel).join(", ")}</p>
                    <p className="text-xs text-ink/50">
                      Dari {user.delegation.grantor.name} · peran maks. {user.delegation.maxRole} · {user.delegation.branchIds.length + user.delegation.hiddenBranchCount} cabang · berlaku hingga {formatDate(user.delegation.expiresAt)}
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-line px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
