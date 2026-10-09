import { Plus, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Badge, Card, CardHeader } from "../../../components/ui.js";
import type { AccessibleCompany, CompanyWorkspaceRole } from "../../../features/workspace/types.js";
import { useCompanyAccessList, useRevokeAccess, useUpdateAccessRole, useUpdateAccessStatus } from "../../../features/workspace/use-access.js";
import type { CompanyAccessUser } from "../../../features/workspace/access-types.js";
import { AddAccessModal } from "./add-access-modal.js";
import { capabilityLabel, permissionLabel, type AuthorizationUser, type DelegationView } from "../../../features/workspace/authorization-types.js";
import { useAuthorizationUsers, useBranches, useDelegations, useMyAuthorization, useRevokeDelegation } from "../../../features/workspace/use-authorization.js";
import { DelegationModal } from "./delegation-modal.js";
import { UserAuthorizationModal } from "./user-authorization-modal.js";

const ROLE_OPTIONS: CompanyWorkspaceRole[] = ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"];

function roleBadgeTone(role: CompanyWorkspaceRole): "accent" | "info" | "neutral" {
  if (role === "OWNER") return "accent";
  if (role === "ADMIN") return "info";
  return "neutral";
}

/** §7 instruksi: OWNER terakhir yang ACTIVE tidak boleh diturunkan/dicabut
 * -- backend yang menegakkan (409 kalau dilanggar), ini HANYA utk
 * menyembunyikan aksi yang pasti gagal supaya user tidak dapat error
 * tanpa alasan jelas. Bukan aturan authorization baru di frontend. */
function isSoleActiveOwner(user: CompanyAccessUser, allUsers: CompanyAccessUser[]): boolean {
  if (user.role !== "OWNER" || user.status !== "ACTIVE") return false;
  return allUsers.filter((u) => u.role === "OWNER" && u.status === "ACTIVE").length <= 1;
}

/**
 * Halaman Pengguna (TASK-022) -- nav key "pengguna" (nav-config.ts,
 * sudah ada sejak TASK-DB-ARCH-013), rute `/workspace/:companySlug/pengguna`
 * (pola routing workspace existing, BUKAN path baru "/users" -- konsisten
 * dgn seluruh nav leaf lain yang path-nya = key). 100% reuse API
 * `company-access` (TASK-DB-ARCH-011 Part A) -- tidak ada backend/
 * permission baru selain perluasan kecil lookup email di routes.ts
 * (lihat komentar `resolveTargetUser`, diperlukan krn requester company
 * OWNER/ADMIN umumnya bukan installation admin jadi tidak bisa pakai
 * `/api/users` utk cari id user lain).
 */
export function UsersPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  // Phase 3: wewenang saya + cabang. UI hanya menyembunyikan aksi yang pasti ditolak; server tetap penentu.
  const meQ = useMyAuthorization(company.slug);
  const branchesQ = useBranches(company.slug);
  const me = meQ.data;
  const multiBranch = branchesQ.data?.multiBranchEnabled === true;
  const canManageUsers = Boolean(me && me.scope === "ALL" && me.permissions.includes("users.manage"));
  // Admin LIMITED mengelola akses cabang HANYA lewat delegasi manage_users yang berlaku (irisan dengan akses & permission perannya).
  const canBranchAccess = Boolean(
    me && me.permissions.includes("user_branch.manage") && (me.scope === "ALL" || (me.delegation?.effectiveBranchIds.manage_users.length ?? 0) > 0),
  );
  const canDelegate = Boolean(me?.canDelegate);
  const canAuthorize = multiBranch && (canBranchAccess || canManageUsers || canDelegate);
  const authUsersQ = useAuthorizationUsers(company.slug, canAuthorize);
  const delegationsQ = useDelegations(company.slug, multiBranch && Boolean(me));
  const revokeDelegation = useRevokeDelegation(company.slug);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [showDelegation, setShowDelegation] = useState(false);
  const accessQ = useCompanyAccessList(company.slug, canManageUsers);
  const authById = new Map<string, AuthorizationUser>((authUsersQ.data?.users ?? []).map((u) => [u.userId, u]));
  // Admin yang dibatasi cabang tidak memakai daftar penuh perusahaan: pakai daftar yang sudah disaring server.
  const data = canManageUsers
    ? accessQ.data
    : { users: (authUsersQ.data?.users ?? []).map<CompanyAccessUser>((u) => ({ userId: u.userId, name: u.name, email: u.email, role: u.role, status: u.status })) };
  const isLoading = meQ.isLoading || (canManageUsers ? accessQ.isLoading : canAuthorize ? authUsersQ.isLoading : false);
  const isError = canManageUsers ? accessQ.isError : authUsersQ.isError;
  const error = canManageUsers ? accessQ.error : authUsersQ.error;
  const noPermission = Boolean(me) && !canManageUsers && !canAuthorize;
  const updateRole = useUpdateAccessRole(company.slug);
  const updateStatus = useUpdateAccessStatus(company.slug);
  const revoke = useRevokeAccess(company.slug);

  const [showAddModal, setShowAddModal] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const users = data?.users ?? [];

  function flashSuccess(message: string) {
    setRowError(null);
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 3000);
  }

  async function handleRoleChange(user: CompanyAccessUser, newRole: CompanyWorkspaceRole) {
    if (newRole === user.role) return;
    if (!confirm(`Ubah role "${user.name}" dari ${user.role} menjadi ${newRole}?`)) return;
    try {
      await updateRole.mutateAsync({ userId: user.userId, role: newRole });
      flashSuccess(`Role ${user.name} berhasil diubah menjadi ${newRole}.`);
    } catch (err) {
      setRowError((err as Error).message);
    }
  }

  async function handleToggleStatus(user: CompanyAccessUser) {
    const newStatus = user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    const verb = newStatus === "SUSPENDED" ? "menonaktifkan" : "mengaktifkan kembali";
    if (!confirm(`Yakin ingin ${verb} akses "${user.name}"?`)) return;
    try {
      await updateStatus.mutateAsync({ userId: user.userId, status: newStatus });
      flashSuccess(`Akses ${user.name} berhasil di-${newStatus === "SUSPENDED" ? "nonaktifkan" : "aktifkan"}.`);
    } catch (err) {
      setRowError((err as Error).message);
    }
  }

  async function handleRevoke(user: CompanyAccessUser) {
    if (!confirm("Cabut akses pengguna ini dari perusahaan?")) return;
    try {
      await revoke.mutateAsync(user.userId);
      flashSuccess(`Akses ${user.name} berhasil dicabut.`);
    } catch (err) {
      setRowError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Pengguna</h1>
          <p className="text-sm text-ink/50">Kelola pengguna dan akses mereka ke perusahaan ini.</p>
        </div>
        <div className="flex gap-2">
          {multiBranch && canDelegate && (
            <button
              type="button"
              onClick={() => setShowDelegation(true)}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-sm font-semibold text-heading hover:bg-surface-2"
            >
              Delegasikan Wewenang
            </button>
          )}
          {canManageUsers && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 rounded-lg bg-navy-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-navy-900"
            >
              <Plus size={15} /> Tambah Pengguna
            </button>
          )}
        </div>
      </div>

      {noPermission && (
        <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-ink/60">Anda tidak memiliki izin untuk mengelola pengguna pada perusahaan ini.</div>
      )}

      {successMessage && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
          ✓ {successMessage}
        </div>
      )}
      {rowError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-600 dark:border-rose-500/20 dark:bg-rose-500/10">
          {rowError}
        </div>
      )}

      <Card>
        <CardHeader title={`${users.length} Pengguna`} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
              <tr>
                <th className="px-4 py-2.5">Pengguna</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                {multiBranch && <th className="px-4 py-2.5">Akses Cabang</th>}
                {multiBranch && <th className="px-4 py-2.5">Wewenang Khusus</th>}
                <th className="px-4 py-2.5 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={multiBranch ? 6 : 4} className="px-4 py-6 text-center text-sm text-ink/40">
                    Memuat...
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={multiBranch ? 6 : 4} className="px-4 py-6 text-center text-sm text-rose-600">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading &&
                !isError &&
                users.map((u) => {
                  const locked = isSoleActiveOwner(u, users);
                  const busy = updateRole.isPending || updateStatus.isPending || revoke.isPending;
                  return (
                    <tr key={u.userId} className="border-t border-line/60">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-heading">{u.name}</p>
                        <p className="text-xs text-ink/40">{u.email ?? "Belum tersedia"}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          value={u.role}
                          disabled={locked || busy || !canManageUsers}
                          onChange={(e) => handleRoleChange(u, e.target.value as CompanyWorkspaceRole)}
                          className="input-base disabled:opacity-50"
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={u.status === "ACTIVE" ? "success" : "neutral"}>{u.status === "ACTIVE" ? "Aktif" : "Tidak Aktif"}</Badge>
                      </td>
                      {multiBranch && (
                        <td className="px-4 py-2.5">
                          <BranchCell user={authById.get(u.userId)} role={u.role} />
                        </td>
                      )}
                      {multiBranch && (
                        <td className="px-4 py-2.5">
                          <OverrideCell user={authById.get(u.userId)} />
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex justify-end gap-2">
                          {canAuthorize && (
                            <button
                              type="button"
                              onClick={() => setAuthUserId(u.userId)}
                              className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink/70 hover:bg-surface-2"
                            >
                              <SlidersHorizontal size={13} /> Atur Wewenang
                            </button>
                          )}
                          {canManageUsers && (
                            <>
                          <button
                            type="button"
                            disabled={locked || busy}
                            onClick={() => handleToggleStatus(u)}
                            title={locked ? "OWNER terakhir yang aktif tidak dapat dinonaktifkan" : undefined}
                            className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink/70 hover:bg-surface-2 disabled:opacity-40"
                          >
                            {u.status === "ACTIVE" ? "Nonaktifkan" : "Aktifkan"}
                          </button>
                          <button
                            type="button"
                            disabled={locked || busy}
                            onClick={() => handleRevoke(u)}
                            title={locked ? "OWNER terakhir yang aktif tidak dapat dicabut" : undefined}
                            className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-500/30 dark:hover:bg-rose-500/10"
                          >
                            Cabut Akses
                          </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              {!isLoading && !isError && users.length === 0 && (
                <tr>
                  <td colSpan={multiBranch ? 6 : 4} className="px-4 py-10 text-center text-sm text-ink/40">
                    Belum ada pengguna.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {multiBranch && me && (
        <DelegationList
          delegations={delegationsQ.data?.delegations ?? []}
          branchNames={new Map((branchesQ.data?.branches ?? []).map((b) => [b.id, b.name]))}
          busy={revokeDelegation.isPending}
          onRevoke={async (d) => {
            if (!confirm(`Cabut delegasi untuk ${d.grantee.name}? Berlaku pada permintaan berikutnya, tanpa perlu logout.`)) return;
            try {
              await revokeDelegation.mutateAsync(d.id);
              flashSuccess("Delegasi berhasil dicabut.");
            } catch (err) {
              setRowError((err as Error).message);
            }
          }}
        />
      )}

      {showAddModal && <AddAccessModal companySlug={company.slug} onClose={() => setShowAddModal(false)} />}
      {authUserId && me && (
        <UserAuthorizationModal
          companySlug={company.slug}
          userId={authUserId}
          branches={branchesQ.data?.branches ?? []}
          me={me}
          canManageBranchAccess={canBranchAccess}
          canManageOverrides={me.permissions.includes("users.manage")}
          onClose={() => setAuthUserId(null)}
        />
      )}
      {showDelegation && me && (
        <DelegationModal companySlug={company.slug} users={authUsersQ.data?.users ?? []} branches={branchesQ.data?.branches ?? []} onClose={() => setShowDelegation(false)} />
      )}
    </div>
  );
}

function BranchCell({ user, role }: { user: AuthorizationUser | undefined; role: CompanyWorkspaceRole }) {
  if (!user) return <span className="text-xs text-ink/40">-</span>;
  if (user.branchScope === "ALL") return <Badge tone="accent">Semua cabang</Badge>;
  if (user.branches.length === 0 && user.hiddenBranchCount === 0) {
    return <span className="text-xs text-amber-600">Belum ada cabang{role === "OWNER" ? "" : " (belum dapat bekerja)"}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {user.branches.map((b) => (
        <Badge key={b.id} tone="neutral">
          {b.name}
        </Badge>
      ))}
      {user.hiddenBranchCount > 0 && <Badge tone="neutral">+{user.hiddenBranchCount} lain</Badge>}
    </div>
  );
}

function OverrideCell({ user }: { user: AuthorizationUser | undefined }) {
  if (!user) return <span className="text-xs text-ink/40">-</span>;
  const delegated = user.delegation ? 1 : 0;
  if (user.overrides.length === 0 && delegated === 0) return <span className="text-xs text-ink/40">Mengikuti peran</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {user.overrides.map((o) => (
        <Badge key={o.permission} tone={o.effect === "GRANT" ? "success" : "danger"}>
          {o.effect === "GRANT" ? "+" : "-"} {permissionLabel(o.permission)}
        </Badge>
      ))}
      {user.delegation && <Badge tone="info">Delegasi: {user.delegation.capabilities.map(capabilityLabel).join(", ")}</Badge>}
    </div>
  );
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "sampai dicabut";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `s/d ${d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })}`;
}

function DelegationList({
  delegations,
  branchNames,
  busy,
  onRevoke,
}: {
  delegations: DelegationView[];
  branchNames: Map<string, string>;
  busy: boolean;
  onRevoke: (d: DelegationView) => void;
}) {
  return (
    <Card>
      <CardHeader title={`Delegasi Wewenang (${delegations.length})`} />
      {delegations.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink/40">Belum ada delegasi aktif.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {delegations.map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-heading">{d.capabilities.map(capabilityLabel).join(", ")}</p>
                <p className="text-xs text-ink/50">
                  {d.grantor.name} → {d.grantee.name} · cabang:{" "}
                  {[...d.branchIds.map((id) => branchNames.get(id) ?? id), ...(d.hiddenBranchCount ? [`+${d.hiddenBranchCount} lain`] : [])].join(", ")} · peran maks. {d.maxRole} ·{" "}
                  {formatExpiry(d.expiresAt)}
                </p>
                {d.reason && <p className="text-xs text-ink/40">Alasan: {d.reason}</p>}
              </div>
              {d.canRevoke && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRevoke(d)}
                  className="shrink-0 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-500/30 dark:hover:bg-rose-500/10"
                >
                  Cabut
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
