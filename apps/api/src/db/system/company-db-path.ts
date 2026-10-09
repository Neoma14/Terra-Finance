import path from "node:path";

/**
 * Resolve & validasi path file `company.db` dari sebuah slug, untuk dipakai
 * mengisi `companies_registry.database_path` (STEP 7, TASK-DB-ARCH-002).
 *
 * INI BUKAN CompanyDbManager -- hanya helper path murni (resolve + validate),
 * tanpa open/close/switch connection. CompanyDbManager penuh adalah scope
 * task berikutnya (TASK-DB-ARCH-003), sengaja TIDAK dibuat di sini.
 *
 * Keamanan (Security_spec.md §"Path Security"):
 *   - slug HARUS cocok pola aman (huruf kecil, angka, dash, 1-64 char,
 *     tidak diawali/diakhiri dash) -- menolak nama perusahaan mentah apa
 *     adanya sebagai nama folder.
 *   - nama file SELALU di-hardcode "company.db" oleh fungsi ini sendiri --
 *     caller tidak bisa menyuntikkan nama file/ekstensi lain (termasuk
 *     executable), karena nama file tidak pernah berasal dari input.
 *   - path hasil WAJIB berada di bawah `dataRoot` setelah dinormalisasi --
 *     menolak traversal (`../`) maupun absolute path yang lolos pola slug
 *     tapi tetap mencoba keluar root lewat separator path.
 *
 * Batasan yang diketahui (dicatat, bukan diselesaikan di task ini):
 *   - tidak melakukan `fs.realpath` terhadap symlink, karena company.db
 *     belum tentu sudah ada di disk saat path ini pertama kali dihitung
 *     (baru dibuat belakangan oleh TASK-DB-ARCH-004). Pengecekan symlink
 *     post-creation adalah tanggung jawab CompanyDbManager saat benar-benar
 *     membuka file, bukan helper resolve-path ini.
 */

export class InvalidCompanySlugError extends Error {}

const SAFE_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function assertSafeCompanySlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new InvalidCompanySlugError("Slug perusahaan tidak boleh kosong.");
  }
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
    throw new InvalidCompanySlugError(`Slug perusahaan "${slug}" mengandung karakter yang tidak diizinkan.`);
  }
  if (!SAFE_SLUG_PATTERN.test(slug)) {
    throw new InvalidCompanySlugError(
      `Slug perusahaan "${slug}" tidak valid -- gunakan huruf kecil, angka, dan tanda hubung saja (maks 64 karakter, tidak diawali/diakhiri tanda hubung).`,
    );
  }
}

/**
 * Hitung path absolut `Data/<slug>/company.db` di bawah `dataRoot`, dan
 * pastikan hasilnya benar-benar berada di bawah `dataRoot` setelah
 * dinormalisasi (defense-in-depth, selain validasi pola slug di atas).
 */
export function resolveCompanyDatabasePath(dataRoot: string, slug: string): string {
  assertSafeCompanySlug(slug);

  const normalizedRoot = path.resolve(dataRoot);
  const resolved = path.resolve(normalizedRoot, slug, "company.db");

  const relative = path.relative(normalizedRoot, resolved);
  const escapesRoot = relative.startsWith("..") || path.isAbsolute(relative);
  if (escapesRoot) {
    throw new InvalidCompanySlugError(`Path hasil utk slug "${slug}" berada di luar data root yang diizinkan.`);
  }

  return resolved;
}
