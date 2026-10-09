import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAdmin } from "../../middleware/auth-guard.js";
import { recordAudit } from "../audit/service.js";
import { getLicenseStatus, inspectLicense, replaceLicense } from "./service.js";

const replaceSchema = z.object({ licenseKey: z.string().min(1) });

export async function licenseRoutes(app: FastifyInstance) {
  // Publik (tanpa auth) -- dipanggil frontend SEBELUM ada user login sama
  // sekali, utk tahu apakah instalasi ini perlu diarahkan ke wizard setup.
  app.get("/api/license/status", async (_request, reply) => {
    const status = await getLicenseStatus(masterDb);
    return reply.send({ license: status });
  });

  // Periksa kunci TANPA menyimpan (UI Perpanjang menampilkan isinya dulu).
  app.post("/api/license/inspect", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = replaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    return reply.send({ inspection: await inspectLicense(masterDb, parsed.data.licenseKey) });
  });

  // Penggantian lisensi oleh admin instalasi. Kunci tetap diverifikasi
  // tanda tangannya di server -- kunci palsu/diubah ditolak.
  app.post("/api/license/replace", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = replaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    try {
      const payload = await replaceLicense(masterDb, parsed.data.licenseKey);
      await recordAudit(masterDb, {
        actorType: "user",
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.fullName,
        action: "license.replace",
        entityType: "license",
        after: { licenseId: payload.lid, clientName: payload.client, expiry: payload.expiry, devices: payload.devices },
      });
      return reply.send({ ok: true, clientName: payload.client, expiry: payload.expiry, license: await getLicenseStatus(masterDb) });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
