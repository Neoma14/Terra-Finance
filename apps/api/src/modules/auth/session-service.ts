import crypto from "node:crypto";
import { masterDb } from "../../db/master/index.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 hari (batas mutlak)
/** Tanpa aktivitas pengguna selama ini, sesi tidak dapat dipakai lagi. */
export const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 15;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  avatarUrl: string | null;
}

/** Token mentah dikirim ke client lewat cookie; hanya hash-nya disimpan di DB. */
export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await masterDb("sessions").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: hashToken(token),
    // Disimpan sbg string ISO 8601 eksplisit (BUKAN Date object mentah,
    // dan BUKAN dibandingkan ke `CURRENT_TIMESTAMP` SQLite) -- format
    // TEXT bawaan SQLite utk `CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS",
    // spasi, tanpa "T"/"Z") beda dari format Date.toISOString(), jadi
    // perbandingan string keduanya TIDAK bisa diandalkan urutannya.
    // Menyamakan KEDUA sisi ke ISO string (di sini & resolveSession di
    // bawah) menghindari itu sepenuhnya.
    expires_at: expiresAt.toISOString(),
    last_activity_at: new Date().toISOString(),
    user_agent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const row = await masterDb("sessions as s")
    .join("users as u", "u.id", "s.user_id")
    .where("s.token_hash", hashToken(token))
    .andWhere("s.expires_at", ">", new Date().toISOString())
    // Idle timeout ditegakkan di server: request apa pun (termasuk polling
    // latar belakang) TIDAK memperpanjang sesi -- hanya touchSession().
    .andWhere("s.last_activity_at", ">", new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS).toISOString())
    .andWhere("u.is_active", true)
    .select("u.id", "u.email", "u.full_name as fullName", "u.role", "u.avatar_url as avatarUrl")
    .first();

  return row ?? null;
}

/** Bila token menunjuk sesi yang sudah lewat batas (idle 15 menit / umur 7
 * hari), hapus barisnya dan kembalikan penyebabnya -- supaya SESSION_EXPIRED
 * dicatat tepat SEKALI. Null bila sesi tidak ada atau masih valid. */
export async function expireStaleSession(
  token: string,
): Promise<{ userId: string; email: string; reason: "IDLE_TIMEOUT" | "SESSION_LIFETIME" } | null> {
  const row = await masterDb("sessions as s")
    .join("users as u", "u.id", "s.user_id")
    .where("s.token_hash", hashToken(token))
    .select("s.id", "s.expires_at", "s.last_activity_at", "u.id as userId", "u.email")
    .first();
  if (!row) return null;
  const now = Date.now();
  let reason: "IDLE_TIMEOUT" | "SESSION_LIFETIME" | null = null;
  if (row.expires_at <= new Date(now).toISOString()) reason = "SESSION_LIFETIME";
  else if (row.last_activity_at <= new Date(now - SESSION_IDLE_TIMEOUT_MS).toISOString()) reason = "IDLE_TIMEOUT";
  if (!reason) return null;
  const deleted = await masterDb("sessions").where({ id: row.id }).delete();
  return deleted > 0 ? { userId: row.userId, email: row.email, reason } : null;
}

export async function revokeSession(token: string): Promise<void> {
  await masterDb("sessions").where({ token_hash: hashToken(token) }).delete();
}

/** Catat aktivitas pengguna (hanya dipanggil dari ping aktivitas yang
 * dikirim klien setelah interaksi nyata). Sesi yang sudah idle melewati
 * batas TIDAK dihidupkan kembali. Mengembalikan false bila sesi tidak
 * (lagi) valid. */
export async function touchSession(token: string): Promise<boolean> {
  const now = new Date();
  const updated = await masterDb("sessions")
    .where({ token_hash: hashToken(token) })
    .andWhere("expires_at", ">", now.toISOString())
    .andWhere("last_activity_at", ">", new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS).toISOString())
    .update({ last_activity_at: now.toISOString() });
  return updated > 0;
}
