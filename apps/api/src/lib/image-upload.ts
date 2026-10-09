/**
 * Upload gambar (avatar user & logo perusahaan) -- UAT-009. Allowlist ketat
 * PNG/JPEG/WEBP; SVG/HTML/skrip/executable DITOLAK. Validasi berlapis:
 * ekstensi, MIME yang dikirim klien, DAN magic bytes -- ketiganya harus
 * sepakat pada tipe yang sama. Data URI yang disimpan dibentuk dari tipe
 * hasil deteksi magic bytes (bukan dari input klien).
 * Catatan: tidak ada re-encoding gambar (tidak ada pipeline gambar di app).
 */
const MAX_BYTES = 500 * 1024; // logo/avatar disimpan sbg data URI di kolom DB, jaga row tetap kecil.

type ImageKind = "png" | "jpeg" | "webp";
const MIME_BY_KIND: Record<ImageKind, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const EXT_KIND: Record<string, ImageKind> = { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" };

export class LogoUploadError extends Error {}

export function sniffImageKind(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

// Pertahanan berlapis terhadap polyglot: gambar sah tidak berisi markup/skrip.
const ACTIVE_CONTENT = /<\s*(script|svg|html|iframe|object|embed)\b|<\?php|javascript:/i;

export function toDataUri(buffer: Buffer, mimeType: string, filename?: string): string {
  const mime = (mimeType ?? "").toLowerCase().trim();
  const declared = (Object.entries(MIME_BY_KIND).find(([, m]) => m === mime)?.[0] ?? null) as ImageKind | null;
  if (!declared) {
    throw new LogoUploadError("Tipe file tidak didukung -- gunakan PNG, JPEG, atau WEBP.");
  }
  if (filename !== undefined) {
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    const extKind = filename.includes(".") ? EXT_KIND[ext] : undefined;
    if (!extKind) throw new LogoUploadError("Ekstensi file tidak didukung -- gunakan .png, .jpg, .jpeg, atau .webp.");
    if (extKind !== declared) throw new LogoUploadError("Ekstensi file tidak sesuai dengan tipe file.");
  }
  if (buffer.byteLength > MAX_BYTES) {
    throw new LogoUploadError(`Ukuran file maksimal ${MAX_BYTES / 1024}KB.`);
  }
  const sniffed = sniffImageKind(buffer);
  if (!sniffed || sniffed !== declared) {
    throw new LogoUploadError("Isi file bukan gambar PNG/JPEG/WEBP yang valid.");
  }
  if (ACTIVE_CONTENT.test(buffer.toString("latin1"))) {
    throw new LogoUploadError("File gambar mengandung konten aktif dan ditolak.");
  }
  return `data:${MIME_BY_KIND[sniffed]};base64,${buffer.toString("base64")}`;
}
