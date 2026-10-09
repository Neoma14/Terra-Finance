import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

/**
 * Rate limit per kategori (UAT-010). Dulu satu bucket global 200/menit untuk
 * SEMUA request (termasuk file statis SPA + banyak GET paralel tiap pindah
 * halaman) sehingga navigasi cepat membuat halaman kosong. Sekarang:
 *  - non-API (file statis SPA) dan /api/health : tidak dibatasi
 *  - auth     : ketat (30/menit) -- pembatas gagal-login ada terpisah
 *  - mutation : sedang (120/menit); import/restore lebih ketat (30/menit)
 *  - read     : longgar (1200/menit)
 * Bucket dipisah per kategori sehingga lonjakan baca tidak menghabiskan
 * jatah mutasi, begitu pula sebaliknya.
 */
export type RateCategory = "exempt" | "auth" | "mutation" | "heavy" | "read";

export const RATE_LIMITS: Record<Exclude<RateCategory, "exempt">, number> = {
  auth: 30,
  heavy: 30,
  mutation: 120,
  read: 1200,
};

export function rateCategory(method: string, rawUrl: string): RateCategory {
  const path = rawUrl.split("?")[0] ?? "";
  if (!path.startsWith("/api")) return "exempt";
  if (path === "/api/health") return "exempt";
  if (path.startsWith("/api/auth/login")) return "auth";
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  if (path.startsWith("/api/auth/")) return "auth"; // logout/activity/avatar
  // journal-import, accounts-import, opening-balance-import, .../restore
  if (/(^|[/-])(import|restore)(\/|$)/.test(path)) return "heavy";
  return "mutation";
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const cat = (req: FastifyRequest) => rateCategory(req.method, req.raw.url ?? "");
  await app.register(rateLimit, {
    global: true,
    max: (req: FastifyRequest) => {
      const c = cat(req);
      return c === "exempt" ? 1_000_000 : RATE_LIMITS[c];
    },
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `${req.ip}|${cat(req)}`,
    allowList: (req: FastifyRequest) => cat(req) === "exempt",
    errorResponseBuilder: (_req, context) =>
      Object.assign(new Error(`Terlalu banyak permintaan. Coba lagi dalam ${Math.max(1, Math.ceil(context.ttl / 1000))} detik.`), {
        statusCode: 429,
        code: "RATE_LIMITED",
      }),
  });
}
