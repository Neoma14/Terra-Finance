import type { FastifyInstance } from "fastify";

/**
 * Kebijakan CORS/Origin (UAT-008). Tidak ada refleksi origin sembarang dan
 * tidak ada wildcard. Request same-origin (Electron/SPA produksi) tidak butuh
 * CORS sama sekali; allowlist hanya untuk dev (Vite) dan origin eksplisit
 * dari CORS_ALLOWED_ORIGINS.
 */
export function parseOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.origin; // ternormalisasi: skema+host+port, huruf kecil, tanpa path
  } catch {
    return null;
  }
}

export function buildAllowedOrigins(opts: { nodeEnv: string; port: number; extra?: string }): Set<string> {
  const allowed = new Set<string>();
  const ports = [opts.port];
  if (opts.nodeEnv !== "production") ports.push(5173);
  for (const p of ports) {
    allowed.add(`http://localhost:${p}`);
    allowed.add(`http://127.0.0.1:${p}`);
  }
  for (const item of (opts.extra ?? "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed || trimmed === "*") continue; // wildcard tidak pernah diterima
    const o = parseOrigin(trimmed);
    if (o) allowed.add(o);
  }
  return allowed;
}

/** Opsi untuk @fastify/cors: header CORS hanya untuk origin di allowlist. */
export function corsOriginCallback(allowed: Set<string>) {
  return (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
    if (!origin) return cb(null, false); // same-origin / non-browser: tidak perlu header CORS
    const o = parseOrigin(origin);
    cb(null, o !== null && allowed.has(o));
  };
}

/** Tolak request /api dari browser yang membawa Origin asing (bukan same-host,
 * bukan allowlist) -- mencegah request lintas-situs ber-kredensial. */
export function registerOriginGuard(app: FastifyInstance, allowed: Set<string>): void {
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (!(request.raw.url ?? "").startsWith("/api")) return;
    const o = parseOrigin(origin);
    if (o !== null) {
      if (allowed.has(o)) return;
      const host = request.headers.host?.toLowerCase();
      if (host && new URL(o).host === host) return; // same-origin
    }
    return reply.code(403).send({ error: "Origin tidak diizinkan.", code: "ORIGIN_NOT_ALLOWED" });
  });
}
