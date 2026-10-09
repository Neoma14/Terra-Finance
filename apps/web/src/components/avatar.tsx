import type { IndustryTemplate } from "@konsultan/shared";
import { Camera, X } from "lucide-react";
import { useRef } from "react";
import { INDUSTRY_ICONS } from "./ui.js";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Avatar bulat user -- foto kalau ada `avatarUrl`, kalau tidak fallback ke
 * inisial nama di atas warna solid (deterministik dari nama, konsisten
 * antar render). */
export function UserAvatar({ name, avatarUrl, size = 32, className = "" }: { name: string; avatarUrl?: string | null; size?: number; className?: string }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        width={size}
        height={size}
        className={`shrink-0 rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-cyan-500/15 font-semibold text-cyan-600 dark:bg-cyan-400/20 dark:text-cyan-300 ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </div>
  );
}

/** Logo bulat/kotak perusahaan -- gambar kalau ada `logoUrl`, kalau tidak
 * fallback ke ikon industri (pola yang sudah dipakai IndustryBadge). */
export function CompanyLogo({
  industryTemplate,
  logoUrl,
  size = 32,
  className = "",
}: {
  industryTemplate: IndustryTemplate;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  if (logoUrl) {
    // object-contain (BUKAN object-cover) supaya logo klien -- sering
    // bentuknya lambang/seal bundar dgn detail sampai ke tepi, bukan foto
    // persegi -- SELALU utuh terlihat, tidak pernah terpotong sebagian
    // demi mengisi penuh kotak persegi.
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-lg border border-line bg-white p-0.5 ${className}`}
        style={{ width: size, height: size }}
      >
        <img src={logoUrl} alt="Logo perusahaan" className="h-full w-full object-contain" />
      </div>
    );
  }
  const Icon = INDUSTRY_ICONS[industryTemplate];
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-lg bg-surface-2 text-heading ${className}`}
      style={{ width: size, height: size }}
    >
      <Icon size={size * 0.55} />
    </div>
  );
}

/** Varian avatar/logo yang bisa diklik untuk ganti gambar (upload) dan
 * dihapus -- dipakai di panel pengaturan profil/perusahaan. `onUpload`
 * menerima File mentah (validasi tipe/ukuran dilakukan di server). */
export function EditableImage({
  imageUrl,
  fallback,
  onUpload,
  onRemove,
  isUploading,
  size = 72,
  shape = "circle",
}: {
  imageUrl?: string | null;
  fallback: React.ReactNode;
  onUpload: (file: File) => void;
  onRemove?: () => void;
  isUploading?: boolean;
  size?: number;
  shape?: "circle" | "square";
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="group relative inline-block" style={{ width: size, height: size }}>
      <div
        className={`h-full w-full overflow-hidden border border-line bg-surface-2 ${shape === "circle" ? "rounded-full" : "rounded-xl"}`}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">{fallback}</div>
        )}
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        title="Ganti gambar"
        className={`absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-100 ${
          shape === "circle" ? "rounded-full" : "rounded-xl"
        }`}
      >
        <Camera size={size * 0.3} />
      </button>

      {imageUrl && onRemove && !isUploading && (
        <button
          type="button"
          onClick={onRemove}
          title="Hapus gambar"
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white opacity-0 transition-opacity hover:bg-rose-600 group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
