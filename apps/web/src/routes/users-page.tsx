import { Plus, Users as UsersIcon, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge, Card, CardHeader } from "../components/ui.js";
import { UserAvatar } from "../components/avatar.js";
import { useMe } from "../features/auth/use-auth.js";
import { ApiError } from "../lib/api-client.js";
import { useEscapeToClose } from "../lib/use-escape-to-close.js";
import { useCreateUser, useSetUserActive, useUsers, type ManagedUser } from "../features/users/use-users.js";

/** Halaman ini hanya boleh dibuka user dengan role "admin" -- penegakan
 * SEBENARNYA ada di server (lihat requireAdmin di API), tapi kita cegah
 * juga di sini supaya staff yang buka URL ini lewat ketikan langsung
 * dapat pesan yang jelas, bukan halaman kosong/error API mentah. */
export function UsersPage() {
  const { data: me } = useMe();
  const isAdmin = me?.user.role === "admin";

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold text-heading">Pengguna</h1>
        <p className="text-sm text-ink/60">Hanya admin yang bisa mengelola daftar pengguna.</p>
      </div>
    );
  }

  return <UsersPageContent currentUserId={me?.user.id} />;
}

function UsersPageContent({ currentUserId }: { currentUserId?: string }) {
  const { data, isLoading } = useUsers();
  const setActive = useSetUserActive();
  const [showAddModal, setShowAddModal] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="vt-page-title text-xl font-bold text-heading">Pengguna</h1>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white hover:bg-accent-600"
        >
          <Plus size={15} /> Tambah User
        </button>
      </div>

      <Card>
        <CardHeader title="Daftar Pengguna" icon={<UsersIcon size={16} className="text-heading/60" />} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-navy-700 text-left text-white">
                <th className="px-5 py-2.5 font-semibold">Nama</th>
                <th className="px-5 py-2.5 font-semibold">Email</th>
                <th className="px-5 py-2.5 font-semibold">Role</th>
                <th className="px-5 py-2.5 font-semibold">Status</th>
                <th className="px-5 py-2.5 font-semibold text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-center text-ink/40">
                    Memuat...
                  </td>
                </tr>
              )}
              {data?.users.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === currentUserId} onToggleActive={setActive} />
              ))}
              {!isLoading && data?.users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-center text-ink/40">
                    Belum ada pengguna.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {showAddModal && <AddUserModal onClose={() => setShowAddModal(false)} />}
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  onToggleActive,
}: {
  user: ManagedUser;
  isSelf: boolean;
  onToggleActive: ReturnType<typeof useSetUserActive>;
}) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-5 py-3">
        <div className="flex items-center gap-2.5">
          <UserAvatar name={user.fullName} size={28} />
          <span className="font-medium text-heading">
            {user.fullName}
            {isSelf && <span className="ml-1.5 text-xs font-normal text-ink/40">(Anda)</span>}
          </span>
        </div>
      </td>
      <td className="px-5 py-3 text-ink/70">{user.email}</td>
      <td className="px-5 py-3">
        <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role === "admin" ? "Admin" : "Staff"}</Badge>
      </td>
      <td className="px-5 py-3">
        <Badge tone={user.isActive ? "success" : "danger"}>{user.isActive ? "Aktif" : "Nonaktif"}</Badge>
      </td>
      <td className="px-5 py-3 text-right">
        {!isSelf && (
          <button
            type="button"
            onClick={() => onToggleActive.mutate({ id: user.id, isActive: !user.isActive })}
            disabled={onToggleActive.isPending}
            className="text-xs font-semibold text-ink/60 underline hover:text-ink disabled:opacity-50"
          >
            {user.isActive ? "Nonaktifkan" : "Aktifkan"}
          </button>
        )}
      </td>
    </tr>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose);
  const createUser = useCreateUser();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "staff">("staff");
  const [error, setError] = useState<string | null>(null);

  const validationMessage = !fullName.trim()
    ? "Nama lengkap wajib diisi"
    : !email.trim()
      ? "Email wajib diisi"
      : password.length < 8
        ? `Password minimal 8 karakter (saat ini ${password.length})`
        : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createUser.mutateAsync({ fullName: fullName.trim(), email: email.trim(), password, role });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal menambah user");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-heading">Tambah User</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/50">Nama Lengkap</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="input-base w-full" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/50">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-base w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/50">
              Password (minimal 8 karakter)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-base w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/50">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "staff")} className="input-base w-full">
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
            <p className="mt-1 text-xs text-ink/40">
              Admin bisa mengelola pengguna lain; Staff tidak bisa membuka halaman ini.
            </p>
          </div>

          {error && (
            <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-300">
              {error}
            </p>
          )}
          {!error && validationMessage && (fullName || email || password) && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{validationMessage}</p>
          )}

          <button
            type="submit"
            disabled={!!validationMessage || createUser.isPending}
            className="mt-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {createUser.isPending ? "Menyimpan..." : "Tambah User"}
          </button>
        </form>
      </div>
    </div>
  );
}
