import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { masterDb, getDbFilePath } from "../../db/master/index.js";
import { recordAudit, listAuditLog } from "../audit/service.js";
import { listAnomalies, reviewAnomaly, recordAnomaly } from "../anomaly/service.js";
import { checkOutOfHoursActivity, repairModeCandidate } from "../anomaly/rules.js";
import { getLicenseStatus } from "../license/service.js";
import { verifyAdministratorToken, createAdministratorSessionCookie, requireAdministratorFactory, ADMINISTRATOR_COOKIE } from "./auth.js";

const loginSchema = z.object({
  licenseKey: z.string().min(1),
  token: z.string().min(1),
});

const repairModeSchema = z.object({
  table: z.string().min(1),
  id: z.string().min(1),
  patch: z.record(z.unknown()),
  reason: z.string().min(5, "Alasan mode perbaikan wajib diisi (minimal 5 karakter)"),
});

// Tabel yang boleh disentuh mode-perbaikan -- whitelist eksplisit supaya
// endpoint generik ini TIDAK bisa dipakai menulis ke tabel sembarang (mis.
// audit_log sendiri, yang harus tetap immutable walau lewat Administrator).
const REPAIR_ALLOWED_TABLES = new Set(["company_profile", "device_registry", "license"]);

export async function administratorRoutes(app: FastifyInstance) {
  const requireAdministrator = requireAdministratorFactory(env.SESSION_SECRET);

  app.post("/api/administrator/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });

    const license = await masterDb("license").first();
    // Kunci lisensi peka huruf besar/kecil (base64url) -- bandingkan apa
    // adanya. Sebelumnya input di-uppercase sehingga tidak pernah cocok.
    if (!license || String(license.license_key).trim() !== parsed.data.licenseKey.trim()) {
      return reply.code(401).send({ error: "License key tidak cocok dengan instalasi ini" });
    }
    if (!verifyAdministratorToken(parsed.data.licenseKey, parsed.data.token)) {
      return reply.code(401).send({ error: "Token Administrator salah" });
    }

    const cookieValue = createAdministratorSessionCookie(env.SESSION_SECRET);
    reply.setCookie(ADMINISTRATOR_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.COOKIE_SECURE,
      path: "/",
      maxAge: 60 * 60 * 4,
    });

    // Login Administrator SENDIRI wajib tercatat -- accountable, bukan silent.
    await recordAudit(masterDb, {
      actorType: "administrator",
      actorLabel: `Administrator (${license.client_name})`,
      action: "administrator.login",
    });

    const outOfHours = checkOutOfHoursActivity(new Date(), "Login Administrator");
    if (outOfHours) await recordAnomaly(masterDb, outOfHours);

    return reply.send({ ok: true });
  });

  app.post("/api/administrator/logout", { preHandler: requireAdministrator }, async (request, reply) => {
    reply.clearCookie(ADMINISTRATOR_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.get("/api/administrator/me", { preHandler: requireAdministrator }, async (_request, reply) => {
    const license = await getLicenseStatus(masterDb);
    return reply.send({ license });
  });

  app.get<{ Querystring: { actorType?: string; entityType?: string; from?: string; to?: string } }>(
    "/api/administrator/audit-log",
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const rows = await listAuditLog(masterDb, request.query);
      return reply.send({ rows });
    },
  );

  app.get("/api/administrator/error-log", { preHandler: requireAdministrator }, async (_request, reply) => {
    const rows = await masterDb("error_log")
      .select(
        "id",
        "level",
        "module",
        "message",
        "stack_trace as stackTrace",
        "app_version as appVersion",
        "created_at as createdAt",
      )
      .orderBy("created_at", "desc")
      .limit(200);
    return reply.send({ rows });
  });

  app.get("/api/administrator/devices", { preHandler: requireAdministrator }, async (_request, reply) => {
    const rows = await masterDb("device_registry")
      .select(
        "id",
        "device_name as deviceName",
        "fingerprint",
        "approved",
        "first_seen_at as firstSeenAt",
        "last_seen_at as lastSeenAt",
      )
      .orderBy("last_seen_at", "desc");
    return reply.send({ rows });
  });

  app.post<{ Params: { id: string } }>(
    "/api/administrator/devices/:id/approve",
    { preHandler: requireAdministrator },
    async (request, reply) => {
      await masterDb("device_registry").where({ id: request.params.id }).update({ approved: true });
      await recordAudit(masterDb, {
        actorType: "administrator",
        actorLabel: "Administrator",
        action: "device.approve",
        entityType: "device_registry",
        entityId: request.params.id,
      });
      return reply.send({ ok: true });
    },
  );

  app.get<{ Querystring: { onlyUnreviewed?: string } }>(
    "/api/administrator/anomalies",
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const rows = await listAnomalies(masterDb, request.query.onlyUnreviewed === "true");
      return reply.send({ rows });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/administrator/anomalies/:id/review",
    { preHandler: requireAdministrator },
    async (request, reply) => {
      await reviewAnomaly(masterDb, request.params.id, "Administrator");
      return reply.send({ ok: true });
    },
  );

  app.get("/api/administrator/diagnostics", { preHandler: requireAdministrator }, async (_request, reply) => {
    const dbFilePath = getDbFilePath();
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(dbFilePath).size;
    } catch {
      // file belum ada -- biarkan 0
    }

    const integrityRow = await masterDb.raw("PRAGMA integrity_check");
    const integrityOk = Array.isArray(integrityRow) && integrityRow[0]?.integrity_check === "ok";

    const [userCount, sessionCount, unreviewedAnomalyCount] = await Promise.all([
      masterDb("users").count("* as c").first(),
      masterDb("sessions").count("* as c").first(),
      masterDb("anomaly_flags").whereNull("reviewed_at").count("* as c").first(),
    ]);

    return reply.send({
      diagnostics: {
        appVersion: "0.1.0",
        dbFilePath,
        dbSizeBytes,
        integrityOk,
        userCount: Number((userCount as any)?.c ?? 0),
        sessionCount: Number((sessionCount as any)?.c ?? 0),
        unreviewedAnomalyCount: Number((unreviewedAnomalyCount as any)?.c ?? 0),
      },
    });
  });

  // Mode perbaikan data -- SATU-SATUNYA jalur mutasi langsung yang boleh
  // dipakai Administrator (semua endpoint lain di atas READ-ONLY). Wajib
  // alasan, wajib tabel whitelist, dan SELALU tercatat di audit_log DAN
  // anomaly_flags (lihat komentar repairModeCandidate) sebelum patch
  // benar-benar dijalankan.
  app.post("/api/administrator/repair", { preHandler: requireAdministrator }, async (request, reply) => {
    const parsed = repairModeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    const { table, id, patch, reason } = parsed.data;

    if (!REPAIR_ALLOWED_TABLES.has(table)) {
      return reply.code(400).send({ error: `Tabel "${table}" tidak diizinkan utk mode perbaikan` });
    }

    const before = await masterDb(table).where({ id }).first();
    if (!before) return reply.code(404).send({ error: "Baris tidak ditemukan" });

    await masterDb(table).where({ id }).update(patch);
    const after = await masterDb(table).where({ id }).first();

    await recordAudit(masterDb, {
      actorType: "administrator",
      actorLabel: "Administrator",
      action: "administrator.repair",
      entityType: table,
      entityId: id,
      before,
      after,
      reason,
      repairMode: true,
    });
    await recordAnomaly(masterDb, repairModeCandidate(reason), { type: table, id });

    return reply.send({ ok: true });
  });
}
