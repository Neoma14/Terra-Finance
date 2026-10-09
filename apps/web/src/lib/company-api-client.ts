/**
 * API client terpisah KHUSUS utk arsitektur company-scoped baru
 * (`/api/company-db/:slug/...`, ADR-001 Option B) -- TASK-DB-ARCH-013.
 *
 * SENGAJA tidak reuse/extend `api-client.ts` (client legacy utk
 * `/api/companies`, `/api/c/:slug`, dst -- single shared DB lama) walau
 * bentuk fetch wrapper-nya mirip. Pemisahan ini disengaja (instruksi
 * TASK-013 eksplisit: "jangan mencampur API client legacy dgn yang baru")
 * supaya kedua permukaan API bisa berevolusi independen -- legacy
 * akhirnya akan di-deprecate/migrasi scr bertahap, API baru tidak boleh
 * diam-diam bergantung padanya.
 */

import { fetchWithRateLimitRetry } from "./fetch-retry.js";
import { branchHeaderFor, notifyBranchContextInvalid } from "./active-branch.js";

export class CompanyApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Kode galat stabil dari server (mis. SELF_APPROVAL_NOT_ALLOWED) -- untuk pesan UI yang tepat. */
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Respons 403 `BRANCH_CONTEXT_INVALID` = cabang kerja yang dikirim tidak lagi sah (akses dicabut / cabang ditutup).
 * Pilihan tersimpan dibuang dan selector diberi tahu. Permintaan BACA (GET) diulang sekali tanpa header agar server
 * memakai konteks default; permintaan TULIS tidak pernah diulang diam-diam (agar tidak menulis ke cabang yang tak dimaksud).
 */
async function request<T>(path: string, options?: RequestInit, retried = false): Promise<T> {
  // Content-Type JSON hanya dikirim bila ada body. Server (Fastify) menolak
  // permintaan ber-header JSON tanpa isi dengan 400 "Body cannot be empty" --
  // dulu ini membuat aksi POST tanpa body (Post Jurnal, Post Saldo Awal,
  // Lock/Unlock akun) gagal dari UI.
  const hasBody = options?.body !== undefined && options?.body !== null;
  const res = await fetchWithRateLimitRetry(`/api/company-db${path}`, {
    credentials: "include",
    ...options,
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...branchHeaderFor(path), ...(options?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && body.code === "BRANCH_CONTEXT_INVALID") {
      notifyBranchContextInvalid(path);
      if (!retried && (options?.method ?? "GET") === "GET") return request<T>(path, options, true);
    }
    throw new CompanyApiError(res.status, body.error ?? `Request gagal (${res.status})`, typeof body.code === "string" ? body.code : undefined);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Upload file (multipart) -- dipakai Journal Import (TASK-DB-ARCH-014
 * §2-5, "TERRA Import Standard"). Pola sama dgn `api-client.ts` legacy
 * (`uploadFile`), TIDAK reuse implementasinya -- lihat komentar header file. */
async function uploadFile<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`/api/company-db${path}`, { method: "POST", credentials: "include", headers: branchHeaderFor(path), body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new CompanyApiError(res.status, body.error ?? `Upload gagal (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function downloadFile(path: string, fallbackFileName: string): Promise<void> {
  const res = await fetch(`/api/company-db${path}`, { credentials: "include", headers: branchHeaderFor(path) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new CompanyApiError(res.status, body.error ?? `Download gagal (${res.status})`);
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const fileName = match?.[1] ?? fallbackFileName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const companyApi = {
  /** `path` kosong ("") -> `GET /api/company-db` (list company yang
   * diizinkan). `path` berawalan "/:slug/..." -> endpoint company-scoped. */
  get: <T>(path = "") => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: uploadFile,
  download: downloadFile,
};
