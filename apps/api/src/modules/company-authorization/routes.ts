import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { masterDb } from "../../db/master/index.js";
import { systemDb } from "../../db/system/index.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { listBranches } from "../../db/company/branch-service.js";
import { findCompanyAccess, listCompanyAccessForCompany, type CompanyAccessRow } from "../../db/system/company-access.js";
import { listActiveBranchIds } from "../../db/system/user-branch-access.js";
import {
  DELEGATION_CAPABILITIES,
  DELEGATION_MAX_ROLES,
  OVERRIDABLE_PERMISSIONS,
  PERMISSIONS,
  PREPARED_PERMISSIONS,
  ROLE_RANK,
  hasPermission,
  type CompanyRole,
  type Permission,
} from "../../db/system/rbac.js";
import {
  AuthorizationBoundaryError,
  AuthorizationConflictError,
  AuthorizationNotFoundError,
  auditBoundaryDenied,
  canRevokeDelegation,
  createDelegation,
  delegatedBranchIds,
  getManageUsersScope,
  hasBasePermission,
  listBasePermissions,
  listDelegations,
  listOverrides,
  revokeDelegation,
  revokePermissionOverride,
  setPermissionOverride,
  type AuthzActor,
  type AuthzTarget,
  type DelegationRow,
} from "../../db/system/authorization.js";
import type { SystemActorContext } from "../../db/system/system-audit.js";
import type { SessionUser } from "../auth/session-service.js";

/**
 * Otorisasi & delegasi multi-cabang (Phase 3, delegasi model Revisi 5). Seluruh keputusan di server:
 * requireAuth -> requireCompanyAccess (akses perusahaan + cabang + override + delegasi, dibaca tiap
 * request) -> permission -> batas wewenang (db/system/authorization.ts, pintu tunggal).
 * Akun LIMITED hanya mengelola user lewat delegasi `manage_users` yang berlaku (irisan akses cabang).
 */

const overrideBodySchema = z.object({ effect: z.enum(["GRANT", "DENY"]), reason: z.string().max(500).nullish() });
const revokeBodySchema = z.object({ reason: z.string().max(500).nullish() });
const delegationBodySchema = z.object({
  granteeUserId: z.string().min(1),
  capabilities: z.array(z.string().min(1).max(40)).max(10),
  maxRole: z.string().min(1).max(20),
  scopeAll: z.boolean().optional(),
  branchIds: z.array(z.string().min(1)).max(200).optional(),
  expiresAt: z.string().max(40).nullish(),
  reason: z.string().max(500).nullish(),
});

function actorAudit(user: SessionUser): SystemActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

/** Konteks akses yang SUDAH diverifikasi server -> bentuk aktor untuk aturan batas. */
function authzActor(request: FastifyRequest): AuthzActor {
  return request.companyAccess!;
}

function requireAny(permissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const a = request.companyAccess;
    if (!a) return reply.code(404).send({ error: "Perusahaan tidak ditemukan atau Anda tidak memiliki akses." });
    if (!permissions.some((p) => hasBasePermission(a, p))) {
      return reply.code(403).send({ error: "Anda tidak memiliki izin untuk melakukan aksi ini." });
    }
  };
}

async function failAuthz(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  ctx: { operation: string; targetUserId?: string | null; permission?: string; capabilities?: string[]; branchIds?: string[] },
) {
  if (err instanceof AuthorizationBoundaryError) {
    void auditBoundaryDenied(systemDb, actorAudit(request.authUser!), request.companyAccess!.companyId, ctx.targetUserId ?? null, {
      code: err.code,
      operation: ctx.operation,
      permission: ctx.permission,
      capabilities: ctx.capabilities,
      branchIds: ctx.branchIds,
    });
    return reply.code(403).send({ error: err.message, code: err.code });
  }
  if (err instanceof AuthorizationNotFoundError) return reply.code(404).send({ error: err.message, code: err.code });
  if (err instanceof AuthorizationConflictError) return reply.code(409).send({ error: err.message, code: err.code });
  request.log.error(err);
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

async function loadTarget(request: FastifyRequest, userId: string): Promise<{ row: CompanyAccessRow; target: AuthzTarget } | null> {
  const a = request.companyAccess!;
  const row = await findCompanyAccess(systemDb, userId, a.companyId);
  if (!row) return null;
  const branchScope = row.branchScope === "ALL" ? "ALL" : "LIMITED";
  const branchIds = branchScope === "LIMITED" ? await listActiveBranchIds(systemDb, row.id) : [];
  return { row, target: { accessId: row.id, userId, companyId: a.companyId, role: row.role as CompanyRole, branchScope, branchIds } };
}

/**
 * Apakah target terlihat/dikelola aktor: ALL = semua; LIMITED = hanya bila punya delegasi manage_users, dan targetnya
 * user LIMITED berperan <= max_role yang beririsan dengan cakupan efektif (atau belum punya cabang), atau dirinya sendiri.
 */
function isVisibleToActor(actor: AuthzActor, t: AuthzTarget): boolean {
  if (actor.accessId === t.accessId) return true;
  if (actor.branchScope === "ALL") return true;
  const scope = getManageUsersScope(actor);
  if (!scope) return false;
  if (t.branchScope !== "LIMITED") return false;
  if (t.role === "OWNER" || ROLE_RANK[t.role] > ROLE_RANK[scope.maxRole]) return false;
  return t.branchIds.length === 0 || t.branchIds.some((b) => scope.branchIds.has(b));
}

function serializeDelegation(d: DelegationRow, actor: AuthzActor, names: Map<string, { userId: string; name: string }>) {
  const who = (accessId: string) => names.get(accessId) ?? { userId: "", name: "(tidak diketahui)" };
  const visible = actor.role === "OWNER" || actor.branchScope === "ALL" ? d.branchIds : d.branchIds.filter((b) => (actor.allowedBranchIds ?? []).includes(b));
  return {
    id: d.id,
    capabilities: d.capabilities,
    maxRole: d.maxRole,
    branchIds: visible,
    // Cabang di luar akses pembaca tidak ditampilkan (tidak membocorkan struktur cabang lain).
    hiddenBranchCount: d.branchIds.length - visible.length,
    expiresAt: d.expiresAt,
    status: d.status,
    live: d.live,
    reason: d.reason,
    createdAt: d.createdAt,
    grantor: who(d.grantorAccessId),
    grantee: who(d.granteeAccessId),
    direction: d.grantorAccessId === actor.accessId ? "granted" : d.granteeAccessId === actor.accessId ? "received" : "managed",
    canRevoke: canRevokeDelegation(actor, d),
  };
}

async function namesByAccessId(companyId: string): Promise<Map<string, { userId: string; name: string }>> {
  const rows = await listCompanyAccessForCompany(systemDb, companyId);
  const users = rows.length ? await masterDb("users").whereIn("id", rows.map((r) => r.systemUserId)).select("id", "full_name as fullName", "email") : [];
  const byId = new Map<string, { fullName: string }>(users.map((u: { id: string; fullName: string }) => [u.id, u]));
  return new Map(rows.map((r) => [r.id, { userId: r.systemUserId, name: byId.get(r.systemUserId)?.fullName ?? "(user tidak ditemukan)" }]));
}

export async function companyAuthorizationRoutes(app: FastifyInstance) {
  const P = "/api/company-db/:companySlug";
  const base = [requireAuth, requireCompanyAccess];

  // ---------------------------------------------------------------- wewenang saya
  app.get(`${P}/authorization/me`, { preHandler: base }, async (request, reply) => {
    const a = authzActor(request);
    const names = await namesByAccessId(a.companyId);
    const received = await listDelegations(systemDb, a.companyId, { granteeAccessId: a.accessId });
    const d = a.delegation;
    return reply.send({
      role: a.role,
      scope: a.branchScope,
      permissions: listBasePermissions(a, PERMISSIONS),
      grants: [...a.grants],
      denies: [...a.denies],
      // Permission yang sudah didefinisikan tetapi BELUM mengendalikan fitur bisnis (Phase 5/6) -- "prepared".
      preparedPermissions: PREPARED_PERMISSIONS,
      delegation: d
        ? {
            id: d.id,
            capabilities: [...d.capabilities],
            maxRole: d.maxRole,
            expiresAt: d.expiresAt,
            // Cabang yang benar-benar berlaku per kapabilitas = delegasi x akses cabang saat ini x permission peran.
            effectiveBranchIds: Object.fromEntries(DELEGATION_CAPABILITIES.map((c) => [c, [...delegatedBranchIds(a, c)]])),
          }
        : null,
      delegationsReceived: received.map((x) => serializeDelegation(x, a, names)),
      canDelegate: hasBasePermission(a, "delegation.manage") && !d,
    });
  });

  // ---------------------------------------------------------------- daftar user + wewenangnya
  async function buildUserViews(request: FastifyRequest, onlyUserId?: string) {
    const a = authzActor(request);
    const db = openCompanyDbForSlug(request.companyAccess!.slug);
    try {
      const branchList = await listBranches(db);
      const branchById = new Map(branchList.map((b) => [b.id, b]));
      const rows = await listCompanyAccessForCompany(systemDb, a.companyId);
      const names = new Map<string, { fullName: string; email: string | null }>();
      const legacy = rows.length ? await masterDb("users").whereIn("id", rows.map((r) => r.systemUserId)).select("id", "full_name as fullName", "email") : [];
      for (const u of legacy as Array<{ id: string; fullName: string; email: string | null }>) names.set(u.id, u);
      const scope = a.branchScope === "ALL" ? null : getManageUsersScope(a);
      const out: unknown[] = [];
      for (const row of rows) {
        if (onlyUserId && row.systemUserId !== onlyUserId) continue;
        const rowScope = row.branchScope === "ALL" ? "ALL" : "LIMITED";
        const branchIds = rowScope === "LIMITED" ? await listActiveBranchIds(systemDb, row.id) : [];
        const target: AuthzTarget = { accessId: row.id, userId: row.systemUserId, companyId: a.companyId, role: row.role as CompanyRole, branchScope: rowScope, branchIds };
        if (!isVisibleToActor(a, target)) continue;
        // Aktor LIMITED hanya melihat irisan cabang user dengan cakupan efektif delegasinya.
        const shown = scope && row.id !== a.accessId ? branchIds.filter((b) => scope.branchIds.has(b)) : branchIds;
        const overrides = await listOverrides(systemDb, row.id);
        const received = await listDelegations(systemDb, a.companyId, { granteeAccessId: row.id });
        const nm = new Map<string, { userId: string; name: string }>();
        out.push({
          userId: row.systemUserId,
          name: names.get(row.systemUserId)?.fullName ?? "(user tidak ditemukan)",
          email: names.get(row.systemUserId)?.email ?? null,
          role: row.role,
          status: row.status,
          branchScope: rowScope,
          self: row.id === a.accessId,
          branches: shown.filter((b) => branchById.has(b)).map((b) => ({ id: b, code: branchById.get(b)!.code, name: branchById.get(b)!.name, status: branchById.get(b)!.status })),
          hiddenBranchCount: branchIds.length - shown.length,
          // Default role untuk permission yang dapat di-override: UI menampilkan "ikuti role" tanpa menghitung RBAC sendiri.
          roleDefaults: OVERRIDABLE_PERMISSIONS.filter((p) => hasPermission(row.role as CompanyRole, p)),
          overrides: overrides.map((o) => ({ permission: o.permission, effect: o.effect, reason: o.reason, createdAt: o.createdAt })),
          delegation: received[0] ? serializeDelegation(received[0], a, nm) : null,
        });
      }
      return out;
    } finally {
      await db.destroy();
    }
  }

  /** Aktor LIMITED tanpa delegasi manage_users tidak punya jalur pengelolaan sama sekali. */
  function denyLimitedWithoutDelegation(request: FastifyRequest, reply: FastifyReply): boolean {
    const a = authzActor(request);
    if (a.branchScope === "LIMITED" && !getManageUsersScope(a)) {
      reply.code(403).send({ error: "Akun Anda dibatasi per cabang; mengelola user memerlukan delegasi aktif dari OWNER.", code: "DELEGATION_REQUIRED" });
      return true;
    }
    return false;
  }

  const manageGuard = requireAny(["users.manage", "user_branch.manage", "delegation.manage"]);

  app.get(`${P}/authorization/users`, { preHandler: [...base, manageGuard] }, async (request, reply) => {
    if (denyLimitedWithoutDelegation(request, reply)) return reply;
    return reply.send({ users: await buildUserViews(request) });
  });

  app.get<{ Params: { companySlug: string; userId: string } }>(`${P}/authorization/users/:userId`, { preHandler: [...base, manageGuard] }, async (request, reply) => {
    if (denyLimitedWithoutDelegation(request, reply)) return reply;
    const [view] = await buildUserViews(request, request.params.userId);
    if (!view) return reply.code(404).send({ error: "User tidak ditemukan pada perusahaan ini." });
    return reply.send({ user: view });
  });

  // ---------------------------------------------------------------- override permission
  app.put<{ Params: { companySlug: string; userId: string; permission: string } }>(
    `${P}/access/:userId/permission-overrides/:permission`,
    { preHandler: [...base, requirePermission("users.manage")] },
    async (request, reply) => {
      const parsed = overrideBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const loaded = await loadTarget(request, request.params.userId);
      if (!loaded) return reply.code(404).send({ error: "User tidak ditemukan pada perusahaan ini." });
      const ctx = { operation: "override.set", targetUserId: request.params.userId, permission: request.params.permission };
      try {
        const result = await setPermissionOverride(systemDb, authzActor(request), actorAudit(request.authUser!), loaded.target, request.params.permission, parsed.data.effect, parsed.data.reason ?? null);
        return reply.code(result.replaced ? 200 : 201).send({ success: true, id: result.id });
      } catch (err) {
        return failAuthz(request, reply, err, ctx);
      }
    },
  );

  app.delete<{ Params: { companySlug: string; userId: string; permission: string } }>(
    `${P}/access/:userId/permission-overrides/:permission`,
    { preHandler: [...base, requirePermission("users.manage")] },
    async (request, reply) => {
      const parsed = revokeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
      const loaded = await loadTarget(request, request.params.userId);
      if (!loaded) return reply.code(404).send({ error: "User tidak ditemukan pada perusahaan ini." });
      try {
        await revokePermissionOverride(systemDb, authzActor(request), actorAudit(request.authUser!), loaded.target, request.params.permission, parsed.data.reason ?? null);
        return reply.send({ success: true });
      } catch (err) {
        return failAuthz(request, reply, err, { operation: "override.revoke", targetUserId: request.params.userId, permission: request.params.permission });
      }
    },
  );

  // ---------------------------------------------------------------- delegasi (Revisi 5)
  app.get(`${P}/delegations`, { preHandler: base }, async (request, reply) => {
    const a = authzActor(request);
    const names = await namesByAccessId(a.companyId);
    const rows = await listDelegations(systemDb, a.companyId);
    // OWNER melihat seluruhnya; lainnya hanya yang melibatkan dirinya.
    const visible = rows.filter((d) => a.role === "OWNER" || d.grantorAccessId === a.accessId || d.granteeAccessId === a.accessId);
    return reply.send({
      delegations: visible.map((d) => serializeDelegation(d, a, names)),
      capabilities: DELEGATION_CAPABILITIES,
      maxRoles: DELEGATION_MAX_ROLES,
    });
  });

  app.post(`${P}/delegations`, { preHandler: [...base, requirePermission("delegation.manage")] }, async (request, reply) => {
    const parsed = delegationBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    const input = parsed.data;
    const loaded = await loadTarget(request, input.granteeUserId);
    if (!loaded) return reply.code(404).send({ error: "User tidak ditemukan pada perusahaan ini." });
    if (loaded.row.status !== "ACTIVE") return reply.code(409).send({ error: "User tidak aktif; delegasi hanya dapat diberikan kepada user aktif.", code: "GRANTEE_NOT_ACTIVE" });
    const db = openCompanyDbForSlug(request.companyAccess!.slug);
    try {
      const branchIds = new Set((await listBranches(db)).map((b) => b.id));
      const { id } = await createDelegation(
        systemDb,
        authzActor(request),
        actorAudit(request.authUser!),
        loaded.target,
        { capabilities: input.capabilities, maxRole: input.maxRole, scopeAll: input.scopeAll ?? false, branchIds: input.branchIds ?? [], expiresAt: input.expiresAt ?? null, reason: input.reason ?? null },
        branchIds,
      );
      return reply.code(201).send({ success: true, id });
    } catch (err) {
      return failAuthz(request, reply, err, {
        operation: "delegation.create",
        targetUserId: input.granteeUserId,
        capabilities: input.capabilities,
        branchIds: input.branchIds ?? [],
      });
    } finally {
      await db.destroy();
    }
  });

  app.delete<{ Params: { companySlug: string; id: string } }>(`${P}/delegations/:id`, { preHandler: base }, async (request, reply) => {
    const parsed = revokeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    try {
      await revokeDelegation(systemDb, authzActor(request), actorAudit(request.authUser!), request.params.id, parsed.data.reason ?? null);
      return reply.send({ success: true });
    } catch (err) {
      return failAuthz(request, reply, err, { operation: "delegation.revoke" });
    }
  });
}
