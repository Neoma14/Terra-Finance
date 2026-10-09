import { User } from "lucide-react";
import { EditableImage, UserAvatar } from "../components/avatar.js";
import { Card, CardHeader } from "../components/ui.js";
import { useDeleteAvatar, useMe, useUploadAvatar } from "../features/auth/use-auth.js";

/**
 * Fondasi minimal -- cuma profil user, karena fitur Kasir/Backoffice
 * sesungguhnya (yang akan punya pengaturan sendiri) belum dibangun di
 * atas fondasi ini (lihat plan). Tidak ada "reset/hapus perusahaan" di
 * sini seperti versi online -- satu instalasi = satu klien, tidak ada
 * konsep menghapus company dari dalam aplikasi (uninstall aplikasinya).
 */
export function SettingsPage() {
  const { data: me } = useMe();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Pengaturan</h1>
      </div>

      <Card>
        <CardHeader title="Profil Saya" icon={<User size={16} className="text-heading/60" />} />
        <div className="flex items-center gap-4 p-5">
          <EditableImage
            imageUrl={me?.user.avatarUrl}
            fallback={<UserAvatar name={me?.user.fullName ?? ""} size={72} />}
            onUpload={(file) => uploadAvatar.mutate(file)}
            onRemove={me?.user.avatarUrl ? () => deleteAvatar.mutate() : undefined}
            isUploading={uploadAvatar.isPending}
            size={72}
          />
          <div>
            <p className="font-semibold text-heading">{me?.user.fullName}</p>
            <p className="text-sm text-ink/50">{me?.user.email}</p>
            <p className="mt-1 text-xs text-ink/40">Klik foto untuk mengganti atau menghapus.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
