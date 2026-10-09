/**
 * Cabang aktif pada sisi klien = HANYA kenyamanan (mengingat pilihan per perusahaan). Server tetap sumber kebenaran:
 * header `X-Branch-Context` divalidasi TIAP request (akses cabang, status cabang); nilai yang tersimpan di sini
 * tidak pernah dipercaya. Bila server menolak (akses dicabut / cabang ditutup), nilai ini dibuang.
 */

export const BRANCH_CONTEXT_HEADER = "X-Branch-Context";
export const BRANCH_CONTEXT_INVALID_EVENT = "terra:branch-context-invalid";
export const ACTIVE_BRANCH_CHANGED_EVENT = "terra:active-branch-changed";

const key = (slug: string) => `terra.activeBranch.${slug}`;

export function getActiveBranch(slug: string): string | null {
  try {
    return sessionStorage.getItem(key(slug));
  } catch {
    return null;
  }
}

export function setActiveBranch(slug: string, branchId: string | null): void {
  try {
    if (branchId) sessionStorage.setItem(key(slug), branchId);
    else sessionStorage.removeItem(key(slug));
  } catch {
    /* penyimpanan tidak tersedia -- abaikan; server tetap memakai preferensi tersimpan di server */
  }
  window.dispatchEvent(new CustomEvent(ACTIVE_BRANCH_CHANGED_EVENT, { detail: { slug, branchId } }));
}

/** `/slug/...` (path company-api-client) -> slug; path kosong (daftar perusahaan) -> null. */
export function slugFromCompanyPath(path: string): string | null {
  const m = /^\/([^/?#]+)/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Header konteks cabang untuk satu path company-scoped; kosong bila tak ada pilihan tersimpan. */
export function branchHeaderFor(path: string): Record<string, string> {
  const slug = slugFromCompanyPath(path);
  const id = slug ? getActiveBranch(slug) : null;
  return id ? { [BRANCH_CONTEXT_HEADER]: id } : {};
}

export function notifyBranchContextInvalid(path: string): void {
  const slug = slugFromCompanyPath(path);
  if (!slug) return;
  setActiveBranch(slug, null);
  window.dispatchEvent(new CustomEvent(BRANCH_CONTEXT_INVALID_EVENT, { detail: { slug } }));
}
