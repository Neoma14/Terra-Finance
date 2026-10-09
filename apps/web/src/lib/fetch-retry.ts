/** GET yang kena 429 (rate limit) dicoba ulang sekali setelah jeda singkat
 * (Retry-After, maks 5 detik) supaya navigasi cepat tidak membuat halaman
 * kosong. Mutasi TIDAK pernah dicoba ulang otomatis. */
export async function fetchWithRateLimitRetry(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  const method = (init?.method ?? "GET").toUpperCase();
  if (res.status !== 429 || method !== "GET") return res;
  const retryAfter = Number(res.headers.get("Retry-After"));
  const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000, 5000);
  await new Promise((r) => setTimeout(r, waitMs));
  return fetch(url, init);
}
