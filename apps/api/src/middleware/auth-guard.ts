import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { expireStaleSession, resolveSession } from "../modules/auth/session-service.js";
import { recordAuthEvent } from "../modules/auth/auth-audit.js";
import { SESSION_COOKIE } from "../modules/auth/routes.js";

/** Mencoba resolve user dari cookie session di setiap request (tidak memaksa 401). */
export const attachAuthUser = fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const user = await resolveSession(token);
    if (user) {
      request.authUser = user;
      return;
    }
    // Token tidak valid: bila itu sesi yang kedaluwarsa, catat SESSION_EXPIRED (sekali).
    const expired = await expireStaleSession(token);
    if (expired) {
      await recordAuthEvent({
        event: "SESSION_EXPIRED",
        userId: expired.userId,
        identifier: expired.email,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        reason: expired.reason,
      });
    }
  });
});

/** preHandler untuk route yang wajib login. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authUser) {
    return reply.code(401).send({ error: "Belum login" });
  }
}

/** preHandler untuk route yang wajib login DAN role admin (mis. manajemen
 * user) -- staff yang mencoba akses langsung lewat URL/API tetap ditolak
 * di server, terlepas dari nav yang disembunyikan di frontend. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authUser) {
    return reply.code(401).send({ error: "Belum login" });
  }
  if (request.authUser.role !== "admin") {
    return reply.code(403).send({ error: "Hanya admin yang bisa mengakses ini" });
  }
}
