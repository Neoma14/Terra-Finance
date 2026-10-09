import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { masterDb } from "../../db/master/index.js";
import { requireAdmin } from "../../middleware/auth-guard.js";
import { recordAudit } from "../audit/service.js";
import { hashPassword } from "../auth/password.js";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password minimal 8 karakter"),
  fullName: z.string().min(1),
  role: z.enum(["admin", "staff"]),
});

const setActiveSchema = z.object({
  isActive: z.boolean(),
});

/**
 * Manajemen user KLIEN (bukan Administrator TTD) -- hanya bisa diakses
 * oleh user dengan role "admin" di instalasi ini (lihat requireAdmin).
 * User dinonaktifkan (is_active=false), TIDAK PERNAH dihapus permanen --
 * konsisten dgn filosofi audit trail: riwayat siapa pernah jadi user di
 * instalasi ini tetap terlihat, bukan hilang begitu saja.
 */
export async function usersRoutes(app: FastifyInstance) {
  app.get("/api/users", { preHandler: requireAdmin }, async (_request, reply) => {
    const users = await masterDb("users")
      .select("id", "email", "full_name as fullName", "role", "is_active as isActive", "created_at as createdAt")
      .orderBy("created_at", "asc");
    return reply.send({ users });
  });

  app.post("/api/users", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    const data = parsed.data;

    const existing = await masterDb("users").where({ email: data.email }).first();
    if (existing) return reply.code(409).send({ error: "Email sudah terdaftar" });

    const userId = crypto.randomUUID();
    await masterDb("users").insert({
      id: userId,
      email: data.email,
      password_hash: await hashPassword(data.password),
      full_name: data.fullName,
      role: data.role,
    });

    await recordAudit(masterDb, {
      actorType: "user",
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.fullName,
      action: "user.create",
      entityType: "users",
      entityId: userId,
      after: { email: data.email, fullName: data.fullName, role: data.role },
    });

    return reply.code(201).send({ ok: true, userId });
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id/active", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = setActiveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });

    const { id } = request.params;
    if (id === request.authUser!.id && !parsed.data.isActive) {
      return reply.code(400).send({ error: "Tidak bisa menonaktifkan akun sendiri" });
    }

    const target = await masterDb("users").where({ id }).first();
    if (!target) return reply.code(404).send({ error: "User tidak ditemukan" });

    await masterDb("users")
      .where({ id })
      .update({ is_active: parsed.data.isActive, updated_at: new Date().toISOString() });

    await recordAudit(masterDb, {
      actorType: "user",
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.fullName,
      action: parsed.data.isActive ? "user.activate" : "user.deactivate",
      entityType: "users",
      entityId: id,
      before: { isActive: !!target.is_active },
      after: { isActive: parsed.data.isActive },
    });

    return reply.send({ ok: true });
  });
}
