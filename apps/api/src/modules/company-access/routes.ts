import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { masterDb } from "../../db/master/index.js";
import { systemDb } from "../../db/system/index.js";
import { appendSystemAudit, type SystemActorContext } from "../../db/system/system-audit.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import {
  findCompanyAccess,
  listCompanyAccessForCompany,
  grantCompanyAccess,
  updateCompanyAccessRole,
  updateCompanyAccessStatus,
  deleteCompanyAccess,
  countActiveOwners,
} from "../../db/system/company-access.js";
import { canManageRole, isValidCompanyRole, type CompanyRole } from "../../db/system/rbac.js";
import type { SessionUser } from "../auth/session-service.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { isMultiBranchEnabled } from "../../db/company/branch-service.js";

/**
 * Company Access Management (TASK-DB-ARCH-011 Part A) -- CRUD relasi
 * `system_users` <-> `companies_registry` (`company_access`, skema `S0010`,
 * TIDAK diubah). Semua endpoint di belakang
 * `requireAuth -> requireCompanyAccess -> requirePermission("users.manage")`
 * (§10) -- role requester SELALU dari `request.companyAccess.role` (hasil
 * verifikasi DB), TIDAK PERNAH dari body (§17 Self-Permission).
 *
 * `:userId` di URL = legacy `masterDb.users.id` (SAMA PERSIS dgn
 * `system_users.id`, mapping deterministik ADR-003) -- client-facing id
 * yang paling masuk akal, bukan `system_users.id` yang murni internal.
 */

const roleSchema = z.string().refine(isValidCompanyRole, { message: "Role tidak valid" });

/** TASK-022 -- `userId` boleh diisi id ATAU email (lihat resolveTargetUser).
 * Kontrak field TIDAK berubah (nama tetap `userId`, test existing tidak
 * disentuh) -- hanya cara me-resolve-nya yang diperluas, krn requester
 * company OWNER/ADMIN pada umumnya BUKAN installation admin (`/api/users`
 * di-gate `requireAdmin`, beda konsep dari company-level OWNER/ADMIN),
 * jadi tidak punya cara lain mencari id user lain selain tahu emailnya. */
const grantSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
});

async function resolveTargetUser(identifier: string) {
  return masterDb("users").where({ id: identifier }).orWhere({ email: identifier }).first();
}

const roleChangeSchema = z.object({
  role: roleSchema,
});

function actorFromSession(user: SessionUser): SystemActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendAccessManagementError(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: message });
}

const FORBIDDEN_ROLE_MESSAGE = "Anda tidak berwenang mengelola peran ini. Peran OWNER hanya dapat dikelola oleh OWNER, dan peran tidak boleh melebihi peran Anda sendiri.";
function actorRole(request: { companyAccess?: { role: CompanyRole } }): CompanyRole {
  return request.companyAccess!.role;
}

/** §16 Owner Protection -- true kalau target access row INI adalah
 * satu-satunya OWNER ACTIVE company tsb (jadi tidak boleh diturunkan
 * role/suspend/revoke). */
async function isLastActiveOwner(companyId: string, access: { role: CompanyRole; status: string }): Promise<boolean> {
  if (access.role !== "OWNER" || access.status !== "ACTIVE") return false;
  const activeOwners = await countActiveOwners(systemDb, companyId);
  return activeOwners <= 1;
}

export async function companyAccessRoutes(app: FastifyInstance) {
  app.get(
    "/api/company-db/:companySlug/access",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("users.manage")] },
    async (request, reply) => {
      const companyId = request.companyAccess!.companyId;
      const rows = await listCompanyAccessForCompany(systemDb, companyId);

      // Nama/email SELALU dari masterDb.users (canonical, ADR-003) --
      // system_users hanya projection, bisa saja field-nya belum
      // ter-sinkron kalau user belum login lagi sejak terakhir berubah.
      const userIds = rows.map((r) => r.systemUserId);
      const legacyUsers = userIds.length ? await masterDb("users").whereIn("id", userIds).select("id", "email", "full_name as fullName") : [];
      const legacyById = new Map(legacyUsers.map((u: any) => [u.id, u]));

      const users = rows.map((r) => {
        const legacy = legacyById.get(r.systemUserId);
        return {
          userId: r.systemUserId,
          name: legacy?.fullName ?? "(user tidak ditemukan)",
          email: legacy?.email ?? null,
          role: r.role,
          status: r.status,
        };
      });

      return reply.send({ users });
    },
  );

  app.post(
    "/api/company-db/:companySlug/access",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("users.manage")] },
    async (request, reply) => {
      const parsed = grantSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const { userId, role } = parsed.data;
      const companyId = request.companyAccess!.companyId;
      if (!canManageRole(actorRole(request), null, role as CompanyRole)) return sendAccessManagementError(reply, 403, FORBIDDEN_ROLE_MESSAGE);

      const targetLegacyUser = await resolveTargetUser(userId);
      if (!targetLegacyUser) {
        return sendAccessManagementError(reply, 404, "User tidak ditemukan. Pastikan email/ID sudah benar dan user tersebut sudah terdaftar di instalasi ini.");
      }

      const existing = await findCompanyAccess(systemDb, targetLegacyUser.id, companyId);
      if (existing) {
        return sendAccessManagementError(reply, 409, "User ini sudah memiliki akses ke perusahaan ini.");
      }

      const targetSystemUserId = await ensureSystemIdentity(systemDb, {
        id: targetLegacyUser.id,
        email: targetLegacyUser.email,
        fullName: targetLegacyUser.full_name,
        role: targetLegacyUser.role,
        avatarUrl: targetLegacyUser.avatar_url ?? null,
      });

      // Multi-Branch: saat multi-cabang aktif, user baru (selain OWNER) dimulai LIMITED tanpa cabang
      // (tidak melihat apa pun sampai OWNER/ADMIN memberi akses cabang) -- bukan ALL secara default.
      let newUserScope: "ALL" | "LIMITED" = "ALL";
      if (role !== "OWNER") {
        const companyDb = openCompanyDbForSlug(request.companyAccess!.slug);
        try {
          if (await isMultiBranchEnabled(companyDb)) newUserScope = "LIMITED";
        } finally {
          await companyDb.destroy();
        }
      }

      const accessId = crypto.randomUUID();
      try {
        await systemDb.transaction(async (trx) => {
          await grantCompanyAccess(trx, { id: accessId, systemUserId: targetSystemUserId, companyId, role: role as CompanyRole, branchScope: newUserScope });
          await appendSystemAudit(trx, {
            actor: actorFromSession(request.authUser!),
            action: "company.access.granted",
            entityType: "company_access",
            entityId: accessId,
            companyId,
            after: { targetUserId: targetSystemUserId, newRole: role, newStatus: "ACTIVE" },
          });
        });
      } catch (err) {
        request.log.error(err);
        // Race yang lolos pre-check (unique constraint S0010) -- tetap
        // dipetakan ke 409 yang sama, bukan 500 generik.
        return sendAccessManagementError(reply, 409, "User ini sudah memiliki akses ke perusahaan ini.");
      }

      return reply.code(201).send({ success: true, accessId, userId: targetLegacyUser.id, role, status: "ACTIVE" });
    },
  );

  app.patch<{ Params: { companySlug: string; userId: string } }>(
    "/api/company-db/:companySlug/access/:userId",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("users.manage")] },
    async (request, reply) => {
      const parsed = roleChangeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const newRole = parsed.data.role as CompanyRole;
      const companyId = request.companyAccess!.companyId;

      const access = await findCompanyAccess(systemDb, request.params.userId, companyId);
      if (!access) return sendAccessManagementError(reply, 404, "Access tidak ditemukan.");
      if (!canManageRole(actorRole(request), access.role as CompanyRole, newRole)) return sendAccessManagementError(reply, 403, FORBIDDEN_ROLE_MESSAGE);

      if (newRole !== "OWNER" && (await isLastActiveOwner(companyId, access))) {
        return sendAccessManagementError(
          reply,
          409,
          "Tidak dapat mengubah role OWNER terakhir yang aktif. Tunjuk OWNER lain terlebih dahulu.",
        );
      }

      const oldRole = access.role;
      await systemDb.transaction(async (trx) => {
        await updateCompanyAccessRole(trx, access.id, newRole);
        await appendSystemAudit(trx, {
          actor: actorFromSession(request.authUser!),
          action: "company.access.role_changed",
          entityType: "company_access",
          entityId: access.id,
          companyId,
          before: { oldRole },
          after: { newRole, targetUserId: request.params.userId },
        });
      });

      return reply.send({ success: true, userId: request.params.userId, role: newRole });
    },
  );

  app.delete<{ Params: { companySlug: string; userId: string } }>(
    "/api/company-db/:companySlug/access/:userId",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("users.manage")] },
    async (request, reply) => {
      const companyId = request.companyAccess!.companyId;
      const access = await findCompanyAccess(systemDb, request.params.userId, companyId);
      if (!access) return sendAccessManagementError(reply, 404, "Access tidak ditemukan.");
      if (!canManageRole(actorRole(request), access.role as CompanyRole, null)) return sendAccessManagementError(reply, 403, FORBIDDEN_ROLE_MESSAGE);

      if (await isLastActiveOwner(companyId, access)) {
        return sendAccessManagementError(
          reply,
          409,
          "Tidak dapat mencabut OWNER terakhir yang aktif. Tunjuk OWNER lain terlebih dahulu.",
        );
      }

      await systemDb.transaction(async (trx) => {
        await deleteCompanyAccess(trx, access.id);
        await appendSystemAudit(trx, {
          actor: actorFromSession(request.authUser!),
          action: "company.access.revoked",
          entityType: "company_access",
          entityId: access.id,
          companyId,
          before: { oldRole: access.role, oldStatus: access.status },
          after: { targetUserId: request.params.userId },
        });
      });

      return reply.send({ success: true });
    },
  );

  // §13/§14 Suspend/Activate -- status transition murni, endpoint
  // terpisah dari PATCH role (satu concern per endpoint, lebih jelas
  // di audit action-nya: "suspended"/"activated", bukan "role_changed").
  app.patch<{ Params: { companySlug: string; userId: string } }>(
    "/api/company-db/:companySlug/access/:userId/status",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("users.manage")] },
    async (request, reply) => {
      const statusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) });
      const parsed = statusSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const newStatus = parsed.data.status;
      const companyId = request.companyAccess!.companyId;

      const access = await findCompanyAccess(systemDb, request.params.userId, companyId);
      if (!access) return sendAccessManagementError(reply, 404, "Access tidak ditemukan.");
      if (!canManageRole(actorRole(request), access.role as CompanyRole, null)) return sendAccessManagementError(reply, 403, FORBIDDEN_ROLE_MESSAGE);

      if (newStatus === "SUSPENDED" && (await isLastActiveOwner(companyId, access))) {
        return sendAccessManagementError(
          reply,
          409,
          "Tidak dapat menonaktifkan OWNER terakhir yang aktif. Tunjuk OWNER lain terlebih dahulu.",
        );
      }

      const oldStatus = access.status;
      await systemDb.transaction(async (trx) => {
        await updateCompanyAccessStatus(trx, access.id, newStatus);
        await appendSystemAudit(trx, {
          actor: actorFromSession(request.authUser!),
          action: newStatus === "SUSPENDED" ? "company.access.suspended" : "company.access.activated",
          entityType: "company_access",
          entityId: access.id,
          companyId,
          before: { oldStatus },
          after: { newStatus, targetUserId: request.params.userId },
        });
      });

      return reply.send({ success: true, userId: request.params.userId, status: newStatus });
    },
  );
}
