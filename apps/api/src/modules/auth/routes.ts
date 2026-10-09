import crypto from "node:crypto";
import { loginSchema } from "@konsultan/shared";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { masterDb } from "../../db/master/index.js";
import { LogoUploadError, toDataUri } from "../../lib/image-upload.js";
import { requireAdmin, requireAuth } from "../../middleware/auth-guard.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createSession, revokeSession, touchSession } from "./session-service.js";
import { loginThrottle } from "./login-throttle.js";
import { recordAuthEvent } from "./auth-audit.js";

const SESSION_COOKIE = "konsultan_session";

let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  return dummyHash;
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const ip = request.ip;
    const userAgent = request.headers["user-agent"];
    const rawEmail = (request.body as { email?: unknown } | null | undefined)?.email;

    // Cek pembatas SEBELUM memverifikasi apa pun (UAT-006): selama diblokir,
    // password benar pun ditolak -- tidak menjadi oracle tebakan.
    const gate = loginThrottle.check(ip, rawEmail);
    if (gate.blocked) {
      await recordAuthEvent({ event: "LOGIN_FAILED", identifier: rawEmail, ip, userAgent, reason: "THROTTLED" });
      return reply
        .code(429)
        .header("Retry-After", String(gate.retryAfterSeconds))
        .send({ error: "Terlalu banyak percobaan login. Coba lagi beberapa menit lagi.", code: "LOGIN_THROTTLED" });
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      loginThrottle.recordFailure(ip, rawEmail);
      await recordAuthEvent({ event: "LOGIN_FAILED", identifier: rawEmail, ip, userAgent, reason: "INVALID_INPUT" });
      return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    }

    const user = await masterDb("users").where({ email: parsed.data.email, is_active: true }).first();
    // Akun tidak ada -> tetap verifikasi ke hash tiruan supaya waktu respons
    // tidak membedakan "akun tidak ada" dari "password salah".
    const passwordOk = await verifyPassword(user ? user.password_hash : await getDummyHash(), parsed.data.password).catch(() => false);
    if (!user || !passwordOk) {
      loginThrottle.recordFailure(ip, parsed.data.email);
      await recordAuthEvent({
        event: "LOGIN_FAILED",
        userId: user?.id ?? null, // internal saja; response tetap generik
        identifier: parsed.data.email,
        ip,
        userAgent,
        reason: "INVALID_CREDENTIALS",
      });
      return reply.code(401).send({ error: "Email atau password salah" });
    }

    loginThrottle.recordSuccess(ip, parsed.data.email);
    const { token, expiresAt } = await createSession(user.id, { userAgent, ip });
    await recordAuthEvent({ event: "LOGIN_SUCCESS", userId: user.id, identifier: user.email, ip, userAgent, reason: "OK" });

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });

    return reply.send({
      user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, avatarUrl: user.avatar_url ?? null },
    });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      if (request.authUser) {
        await recordAuthEvent({
          event: "LOGOUT",
          userId: request.authUser.id,
          identifier: request.authUser.email,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          reason: "USER_LOGOUT",
        });
      }
      await revokeSession(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  // Riwayat audit autentikasi -- hanya baca, hanya admin sistem. Tabelnya
  // append-only di level database (trigger), tidak ada endpoint tulis.
  app.get("/api/auth/audit", { preHandler: requireAdmin }, async (request, reply) => {
    const limit = Math.min(Math.max(Number((request.query as { limit?: string }).limit) || 100, 1), 500);
    const rows = await masterDb("audit_log")
      .where("action", "like", "auth.%")
      .orderBy("created_at", "desc")
      .limit(limit)
      .select("id", "actor_id as userId", "actor_label as identifier", "action", "after_json as detail", "created_at as createdAt");
    return reply.send({ events: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
  });

  // Ping aktivitas pengguna (klien memanggilnya setelah interaksi nyata,
  // bukan dari polling). Sesi idle > 15 menit sudah ditolak requireAuth.
  app.post("/api/auth/activity", { preHandler: requireAuth }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const ok = token ? await touchSession(token) : false;
    if (!ok) return reply.code(401).send({ error: "Sesi berakhir" });
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.authUser) return reply.code(401).send({ error: "Belum login" });
    return reply.send({ user: request.authUser });
  });

  app.post("/api/auth/me/avatar", { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "File tidak ditemukan" });

    const buffer = await file.toBuffer();
    try {
      const dataUri = toDataUri(buffer, file.mimetype, file.filename);
      await masterDb("users").where({ id: request.authUser!.id }).update({ avatar_url: dataUri });
      return reply.send({ avatarUrl: dataUri });
    } catch (err) {
      if (err instanceof LogoUploadError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete("/api/auth/me/avatar", { preHandler: requireAuth }, async (request, reply) => {
    await masterDb("users").where({ id: request.authUser!.id }).update({ avatar_url: null });
    return reply.send({ ok: true });
  });
}

export { SESSION_COOKIE };
