import { fetchWithRateLimitRetry } from "./fetch-retry.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Content-Type JSON hanya dikirim bila ada body. Server (Fastify) menolak
  // permintaan ber-header JSON tanpa isi dengan 400 "Body cannot be empty" --
  // dulu ini membuat aksi POST tanpa body (Post Jurnal, Post Saldo Awal,
  // Lock/Unlock akun) gagal dari UI.
  const hasBody = options?.body !== undefined && options?.body !== null;
  const res = await fetchWithRateLimitRetry(`/api${path}`, {
    credentials: "include",
    ...options,
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...(options?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request gagal (${res.status})`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function uploadFile<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append("file", file);

  // Sengaja tidak set Content-Type -- browser yang mengisi boundary
  // multipart yang benar otomatis kalau header ini dibiarkan kosong.
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "include", body: formData });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Upload gagal (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** Sama seperti uploadFile, tapi bisa bawa field teks tambahan (mis.
 * password konfirmasi) dalam SATU multipart form -- dipakai fitur Restore
 * yang butuh file backup + password sekaligus. */
async function uploadFileWithFields<T>(path: string, file: File, fields: Record<string, string>): Promise<T> {
  const formData = new FormData();
  formData.append("file", file);
  for (const [key, value] of Object.entries(fields)) formData.append(key, value);

  const res = await fetch(`/api${path}`, { method: "POST", credentials: "include", body: formData });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Upload gagal (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function downloadFile(path: string, fallbackFileName: string): Promise<void> {
  const res = await fetch(`/api${path}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Download gagal (${res.status})`);
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

/** POST yang responsnya BISA berupa file (kalau server mengirim
 * Content-Disposition attachment) ATAU JSON biasa -- dipakai endpoint
 * "danger zone" (reset/hapus perusahaan) yang backup-nya opsional: kalau
 * user minta backup, response-nya file .json untuk diunduh; kalau tidak,
 * cuma `{ok:true}`. */
async function postExpectingOptionalFile(path: string, body: unknown, fallbackFileName: string): Promise<{ downloaded: boolean }> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new ApiError(res.status, errBody.error ?? `Request gagal (${res.status})`);
  }

  const disposition = res.headers.get("Content-Disposition") ?? "";
  if (!disposition) {
    await res.json().catch(() => ({}));
    return { downloaded: false };
  }

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
  return { downloaded: true };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: uploadFile,
  uploadWithFields: uploadFileWithFields,
  download: downloadFile,
  postExpectingOptionalFile,
};
