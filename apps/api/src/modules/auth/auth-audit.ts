import crypto from "node:crypto";
import { masterDb } from "../../db/master/index.js";

/**
 * Audit event autentikasi (UAT-007) ke `audit_log` master DB -- tabel itu
 * append-only lewat TRIGGER database (UPDATE/DELETE di-ABORT), jadi tidak
 * ada role (termasuk Admin) yang bisa mengubah/menghapus lewat aplikasi.
 * TIDAK PERNAH menyimpan password, token, atau secret apa pun.
 */
export type AuthAuditEvent = "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGOUT" | "SESSION_EXPIRED";
export type AuthAuditReason =
  | "OK"
  | "INVALID_CREDENTIALS"
  | "THROTTLED"
  | "INVALID_INPUT"
  | "USER_LOGOUT"
  | "IDLE_TIMEOUT"
  | "SESSION_LIFETIME";

const ACTION: Record<AuthAuditEvent, string> = {
  LOGIN_SUCCESS: "auth.login_success",
  LOGIN_FAILED: "auth.login_failed",
  LOGOUT: "auth.logout",
  SESSION_EXPIRED: "auth.session_expired",
};

/** Identifier aman utk disimpan: dipotong, tanpa karakter kontrol. */
export function safeIdentifier(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return s || "(kosong)";
}

export async function recordAuthEvent(input: {
  event: AuthAuditEvent;
  userId?: string | null;
  identifier?: unknown;
  ip?: string;
  userAgent?: string;
  reason: AuthAuditReason;
}): Promise<void> {
  try {
    await masterDb("audit_log").insert({
      id: crypto.randomUUID(),
      actor_type: "user",
      actor_id: input.userId ?? null,
      actor_label: safeIdentifier(input.identifier),
      action: ACTION[input.event],
      entity_type: "auth",
      entity_id: input.userId ?? null,
      before_json: null,
      after_json: JSON.stringify({
        event: input.event,
        success: input.event !== "LOGIN_FAILED",
        reason: input.reason,
        ip: input.ip ?? null,
        userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null,
      }),
      reason: input.reason,
      repair_mode: false,
    });
  } catch {
    // Kegagalan menulis audit tidak boleh menggagalkan login/logout.
  }
}
