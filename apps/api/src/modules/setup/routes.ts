import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { masterDb } from "../../db/master/index.js";
import { hashPassword } from "../auth/password.js";
import { activateLicense } from "../license/service.js";
import { recordAudit } from "../audit/service.js";

const setupSchema = z.object({
  companyName: z.string().min(1),
  industry: z.string().optional(),
  licenseKey: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8, "Password minimal 8 karakter"),
  adminFullName: z.string().min(1),
});

/**
 * Wizard setup awal (first-run) -- HANYA bisa dijalankan SEKALI, saat
 * `company_profile` & `users` masih kosong. Dijalankan dari halaman React
 * biasa saat frontend deteksi `GET /api/license/status` -> belum
 * activated ATAU `GET /api/setup/status` -> belum ada user sama sekali.
 */
export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async (_request, reply) => {
    const userCount = await masterDb("users").count("* as c").first();
    const profileCount = await masterDb("company_profile").count("* as c").first();
    const needsSetup = Number((userCount as any)?.c ?? 0) === 0 || Number((profileCount as any)?.c ?? 0) === 0;
    return reply.send({ needsSetup });
  });

  app.post("/api/setup/complete", async (request, reply) => {
    const existingUsers = await masterDb("users").count("* as c").first();
    const existingProfile = await masterDb("company_profile").count("* as c").first();
    if (Number((existingUsers as any)?.c ?? 0) > 0 || Number((existingProfile as any)?.c ?? 0) > 0) {
      return reply.code(409).send({ error: "Instalasi ini sudah pernah di-setup" });
    }

    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    const data = parsed.data;

    try {
      await activateLicense(masterDb, data.licenseKey);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const userId = crypto.randomUUID();
    await masterDb("company_profile").insert({
      id: crypto.randomUUID(),
      name: data.companyName,
      industry: data.industry ?? null,
    });
    await masterDb("users").insert({
      id: userId,
      email: data.adminEmail,
      password_hash: await hashPassword(data.adminPassword),
      full_name: data.adminFullName,
      role: "admin",
    });

    await recordAudit(masterDb, {
      actorType: "user",
      actorId: userId,
      actorLabel: data.adminFullName,
      action: "setup.complete",
      entityType: "company_profile",
    });

    return reply.send({ ok: true });
  });
}
