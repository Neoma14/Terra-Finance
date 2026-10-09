import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const ADMINISTRATOR_COOKIE = "administrator_session";
// Sengaja PENDEK (4 jam) -- ini sesi kunjungan maintenance, bukan sesi
// harian seperti user klien biasa (7 hari). Kalau TTD butuh lebih lama,
// login ulang -- gesekan kecil ini disengaja supaya token Administrator
// tidak "menumpuk" valid tanpa disadari.
const SESSION_TTL_MS = 1000 * 60 * 60 * 4;

/** Token akses Administrator = tanda tangan Ed25519 vendor atas license_key
 * (dibuat vendor dengan perintah admin-token di tool penerbit lisensi).
 * Client hanya memverifikasi dengan public key -- tidak ada secret bersama
 * yang bisa dipakai membuat token baru. */
export { verifyAdministratorToken } from "../license/service.js";

/** Sesi Administrator STATELESS (cookie ber-signature, bukan baris di DB)
 * -- cukup utk aplikasi desktop single-instance ini, dan sengaja terpisah
 * total dari tabel `sessions` milik user klien (Administrator BUKAN
 * bagian dari hierarki role klien, lihat context di plan). */
export function createAdministratorSessionCookie(sessionSecret: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `administrator:${expiresAt}`;
  const sig = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
  return `${payload}:${sig}`;
}

function verifyAdministratorSessionCookie(cookieValue: string, sessionSecret: string): boolean {
  const parts = cookieValue.split(":");
  if (parts.length !== 3) return false;
  const [prefix, expiresAtStr, sig] = parts;
  if (prefix !== "administrator") return false;
  const payload = `${prefix}:${expiresAtStr}`;
  const expectedSig = crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Date.now() < Number(expiresAtStr);
}

export function requireAdministratorFactory(sessionSecret: string) {
  return async function requireAdministrator(request: FastifyRequest, reply: FastifyReply) {
    const cookieValue = request.cookies[ADMINISTRATOR_COOKIE];
    if (!cookieValue || !verifyAdministratorSessionCookie(cookieValue, sessionSecret)) {
      return reply.code(401).send({ error: "Sesi Administrator tidak valid atau sudah kadaluarsa, login ulang" });
    }
  };
}
