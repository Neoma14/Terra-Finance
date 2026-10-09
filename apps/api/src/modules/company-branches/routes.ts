import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import {
  BranchAccessDeniedError,
  resolveBranchAuthority,
  requireAccessibleBranch,
  replyBranchError,
  type BranchAuthority,
} from "../../middleware/branch-authority.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import {
  BRANCH_STATUSES,
  changeBranchStatus,
  createBranch,
  isMultiBranchEnabled,
  previewBranchClosure,
  requireBranch,
  setMultiBranchEnabled,
  softDeleteUnusedBranch,
  updateBranch,
  type BranchRow,
} from "../../db/company/branch-service.js";
import { BRANCH_POLICIES } from "../../db/company/account-branch-policy.js";
import {
  AccountPolicyChangeBlockedError,
  InterBranchAccountPlanInvalidError,
  createInterBranchAccountPair,
  previewInterBranchAccountPair,
  setAccountBranchPolicy,
} from "../../db/company/account-policy-service.js";
import { AccountInterBranchClassificationError, AccountNotFoundError } from "../../db/company/account-service.js";
import { systemDb } from "../../db/system/index.js";
import { findCompanyAccess } from "../../db/system/company-access.js";
import { canManageRole, type CompanyRole, type Permission } from "../../db/system/rbac.js";
import {
  AuthorizationBoundaryError,
  assertTargetInManageScope,
  delegatedBranchIds,
  getManageBranchInfoScope,
  getManageUsersScope,
  hasBasePermission,
} from "../../db/system/authorization.js";
import {
  BranchAccessAlreadyGrantedError,
  BranchAccessNotFoundError,
  countActiveAccessForBranch,
  grantBranchAccess,
  listBranchAccess,
  revokeBranchAccess,
  setBranchScope,
  setDefaultBranch,
  transferBranchAccess,
} from "../../db/system/user-branch-access.js";
import type { SystemActorContext } from "../../db/system/system-audit.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import type { SessionUser } from "../auth/session-service.js";

/**
 * Cabang, konteks kerja, akses user ke cabang, dan kebijakan akun
 * (Multi-Branch Phase 1-2). Semua otorisasi di server: requireAuth ->
 * requireCompanyAccess (termasuk akses cabang) -> requirePermission ->
 * aturan cabang. Akun LIMITED hanya boleh memanggil route yang terdaftar di
 * BRANCH_AWARE_ROUTES (middleware/branch-authority.ts) -- di sini hanya
 * pembacaan cabang dan konteks kerja.
 */

const createBranchSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(120),
  address: z.string().max(255).nullish(),
  phone: z.string().max(50).nullish(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  openedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
const updateBranchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  address: z.string().max(255).nullish(),
  phone: z.string().max(50).nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
const statusSchema = z.object({ to: z.enum(BRANCH_STATUSES), reason: z.string().max(500).nullish() });
const contextSchema = z.object({ branchId: z.string().min(1).nullable() });
const multiBranchSchema = z.object({ enabled: z.boolean() });
const grantSchema = z.object({ branchId: z.string().min(1) });
const revokeSchema = z.object({ reason: z.string().max(500).nullish() });
const transferSchema = z.object({ fromBranchId: z.string().min(1), toBranchId: z.string().min(1), reason: z.string().max(500).nullish() });
const scopeSchema = z.object({ scope: z.enum(["ALL", "LIMITED"]) });
const policySchema = z.object({
  policy: z.enum(BRANCH_POLICIES),
  counterpartBranchId: z.string().min(1).nullish(),
  reason: z.string().min(1).max(500),
});
const interBranchAccountSchema = z.object({
  branchAId: z.string().min(1),
  branchBId: z.string().min(1),
  accountTypeCode: z.enum(["LIABILITY", "ASSET"]),
  codeCounterpartB: z.string().max(30).optional(),
  codeCounterpartA: z.string().max(30).optional(),
});

function actorFromSession(user: SessionUser): ActorContext & SystemActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function serializeBranch(b: BranchRow, auth: BranchAuthority) {
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    status: b.status,
    isHeadOffice: b.isHeadOffice,
    address: b.address,
    phone: b.phone,
    sortOrder: b.sortOrder,
    openedAt: b.openedAt,
    closedAt: b.closedAt,
    closeReason: b.closeReason,
    reopenedAt: b.reopenedAt,
    operational: auth.operational.some((o) => o.id === b.id),
    isContext: auth.context?.id === b.id,
  };
}

async function failBranch(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (await replyBranchError(request, reply, err)) return reply;
  if (err instanceof AccountNotFoundError || err instanceof BranchAccessNotFoundError) {
    return reply.code(404).send({ error: toUserErrorMessage(err), code: (err as { code?: string }).code });
  }
  if (err instanceof BranchAccessAlreadyGrantedError || err instanceof AccountPolicyChangeBlockedError || err instanceof AccountInterBranchClassificationError) {
    return reply.code(409).send({ error: toUserErrorMessage(err), code: err.code });
  }
  if (err instanceof InterBranchAccountPlanInvalidError) {
    return reply.code(409).send({ error: toUserErrorMessage(err), code: err.code, plan: err.plan });
  }
  request.log.error(err);
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

/** Membuka company.db milik slug yang SUDAH diverifikasi requireCompanyAccess, menjalankan handler, menutupnya, dan memetakan error. */
async function withCompanyDb(request: FastifyRequest, reply: FastifyReply, fn: (db: Knex) => Promise<unknown>) {
  const db = openCompanyDbForSlug(request.companyAccess!.slug);
  try {
    return await fn(db);
  } catch (err) {
    return failBranch(request, reply, err);
  } finally {
    await db.destroy();
  }
}

function requireOwner(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.companyAccess!.role !== "OWNER") {
    reply.code(403).send({ error: "Hanya OWNER yang dapat melakukan tindakan ini." });
    return false;
  }
  return true;
}

function requirePerm(request: FastifyRequest, reply: FastifyReply, permission: Permission, message: string): boolean {
  if (!hasBasePermission(request.companyAccess!, permission)) {
    reply.code(403).send({ error: message });
    return false;
  }
  return true;
}

/**
 * Target = user yang aksesnya diubah: harus punya akses ke perusahaan INI, bukan diri sendiri, dan tidak melebihi wewenang aktor.
 * Aktor LIMITED hanya boleh bertindak lewat delegasi `manage_users` (Revisi 5): target harus ber-scope LIMITED dengan peran <= max_role;
 * cabang yang disentuh dibatasi ke cabang efektif delegasi oleh `requireDelegatedBranch`.
 */
async function resolveAccessTarget(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const access = request.companyAccess!;
  if (userId === access.systemUserId) {
    reply.code(403).send({ error: "Anda tidak dapat mengubah akses cabang Anda sendiri.", code: "SELF_MODIFICATION" });
    return null;
  }
  const target = await findCompanyAccess(systemDb, userId, access.companyId);
  if (!target) {
    reply.code(404).send({ error: "User tidak ditemukan pada perusahaan ini." });
    return null;
  }
  if (!canManageRole(access.role, target.role, null)) {
    reply.code(403).send({ error: "Anda tidak berwenang mengelola user dengan peran ini." });
    return null;
  }
  if (!gateDelegatedTarget(request, reply, target.role, target.branchScope === "ALL" ? "ALL" : "LIMITED")) return null;
  return target;
}

/** Aktor LIMITED wajib punya delegasi manage_users, dan target harus berada dalam batas delegasi (peran <= max_role, scope LIMITED). */
function gateDelegatedTarget(request: FastifyRequest, reply: FastifyReply, role: CompanyRole, scope: "ALL" | "LIMITED"): boolean {
  const access = request.companyAccess!;
  if (access.branchScope !== "LIMITED") return true;
  try {
    assertTargetInManageScope(access, { accessId: "", userId: "", companyId: access.companyId, role, branchScope: scope, branchIds: [] }, { requireAllTargetBranchesInside: false });
    return true;
  } catch (err) {
    if (err instanceof AuthorizationBoundaryError) {
      reply.code(403).send({ error: err.message, code: err.code });
      return false;
    }
    throw err;
  }
}

/** Cabang yang disentuh harus dalam cakupan efektif delegasi (aktor LIMITED); selain itu 404 seragam. */
function requireDelegatedBranch(request: FastifyRequest, branchId: string): void {
  const access = request.companyAccess!;
  if (access.branchScope === "ALL") return;
  if (!delegatedBranchIds(access, "manage_users").has(branchId)) throw new BranchAccessDeniedError("Cabang tidak ditemukan atau Anda tidak memiliki akses.");
}

export async function companyBranchesRoutes(app: FastifyInstance) {
  const P = "/api/company-db/:companySlug";
  const guard = (permission: Permission) => ({ preHandler: [requireAuth, requireCompanyAccess, requirePermission(permission)] });

  // ----------------------------------------------------------------- baca cabang & konteks
  app.get(`${P}/branches`, guard("branch.read"), async (request, reply) =>
    withCompanyDb(request, reply, async (db) => {
      const auth = await resolveBranchAuthority(request, db);
      return reply.send({ branches: auth.accessible.map((b) => serializeBranch(b, auth)), multiBranchEnabled: auth.multiBranchEnabled });
    }),
  );

  app.get<{ Params: { companySlug: string; id: string } }>(`${P}/branches/:id`, guard("branch.read"), async (request, reply) =>
    withCompanyDb(request, reply, async (db) => {
      const auth = await resolveBranchAuthority(request, db);
      return reply.send({ branch: serializeBranch(requireAccessibleBranch(auth, request.params.id), auth) });
    }),
  );

  app.get(`${P}/branch-context`, guard("branch.read"), async (request, reply) =>
    withCompanyDb(request, reply, async (db) => {
      const auth = await resolveBranchAuthority(request, db);
      const me = request.companyAccess!;
      const all = auth.scope === "ALL";
      const can = (p: Permission) => hasBasePermission(me, p);
      return reply.send({
        multiBranchEnabled: auth.multiBranchEnabled,
        scope: auth.scope,
        headOfficeBranchId: auth.headOffice.id,
        context: auth.context ? { id: auth.context.id, code: auth.context.code, name: auth.context.name, status: auth.context.status } : null,
        contextSource: auth.contextSource,
        branches: auth.accessible.map((b) => serializeBranch(b, auth)),
        capabilities: {
          manageBranches: all && can("branch.manage"),
          closeBranches: all && can("branch.close"),
          reopenBranches: all && can("branch.reopen"),
          // Phase 3: admin LIMITED mengelola akses cabang di dalam cakupan cabangnya sendiri.
          manageBranchAccess: can("user_branch.manage") && getManageUsersScope(me) !== null,
          manageBranchInfo: getManageBranchInfoScope(me) !== null,
          setAccountPolicy: all && can("account.policy"),
          manageDelegations: can("delegation.manage") && !me.delegation,
          manageUsers: all && can("users.manage"),
          // Phase 5A/5B: kenyamanan UI untuk pemilih cakupan laporan; penegakan sebenarnya di server (resolveReportScope).
          viewConsolidatedReports: can("report.consolidated"),
          allBranchesAccessible: auth.accessible.length === auth.branches.length,
        },
      });
    }),
  );

  // Mengganti konteks kerja = preferensi saja; BUKAN perubahan permission. Divalidasi server (harus cabang ACTIVE dalam akses).
  app.put(`${P}/branch-context`, guard("branch.read"), async (request, reply) => {
    const parsed = contextSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => {
      const auth = await resolveBranchAuthority(request, db);
      const access = request.companyAccess!;
      const wanted = parsed.data.branchId;
      if (wanted && !auth.operational.some((b) => b.id === wanted)) {
        requireAccessibleBranch(auth, wanted); // 404 bila di luar akses
        return reply.code(403).send({ error: "Cabang ini tidak aktif sehingga tidak dapat dipakai sebagai cabang kerja.", code: "BRANCH_CONTEXT_INVALID" });
      }
      await setDefaultBranch(systemDb, { companyId: access.companyId, accessId: access.accessId, targetUserId: access.systemUserId }, wanted, actorFromSession(request.authUser!));
      return reply.send({ success: true, branchId: wanted });
    });
  });

  // ----------------------------------------------------------------- kelola cabang
  app.put(`${P}/multi-branch`, guard("branch.manage"), async (request, reply) => {
    if (!requireOwner(request, reply)) return reply;
    const parsed = multiBranchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    return withCompanyDb(request, reply, async (db) => {
      await setMultiBranchEnabled(db, parsed.data.enabled, actorFromSession(request.authUser!));
      return reply.send({ success: true, multiBranchEnabled: await isMultiBranchEnabled(db) });
    });
  });

  app.post(`${P}/branches`, guard("branch.manage"), async (request, reply) => {
    const parsed = createBranchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => {
      const { id } = await createBranch(db, parsed.data, actorFromSession(request.authUser!));
      return reply.code(201).send({ success: true, id });
    });
  });

  app.patch<{ Params: { companySlug: string; id: string } }>(`${P}/branches/:id`, guard("branch.manage"), async (request, reply) => {
    const parsed = updateBranchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => {
      requireAccessibleBranch(await resolveBranchAuthority(request, db), request.params.id);
      // Aktor ALL: wewenang peran (branch.manage). Aktor LIMITED: hanya lewat delegasi manage_branch_info pada cabang itu,
      // dan hanya info dasar (nama/alamat/telepon) -- urutan tampilan cabang tetap wewenang scope ALL.
      const infoScope = getManageBranchInfoScope(request.companyAccess!);
      if (!infoScope) {
        return reply.code(403).send({ error: "Mengubah info cabang memerlukan delegasi manage_branch_info dari OWNER.", code: "DELEGATION_REQUIRED" });
      }
      if (!infoScope.all) {
        if (!infoScope.branchIds.has(request.params.id)) throw new BranchAccessDeniedError("Cabang tidak ditemukan atau Anda tidak memiliki akses.");
        if (parsed.data.sortOrder !== undefined) {
          return reply.code(403).send({ error: "Urutan cabang hanya dapat diubah oleh akun dengan akses semua cabang.", code: "DELEGATION_SCOPE_EXCEEDED" });
        }
      }
      await updateBranch(db, request.params.id, parsed.data, actorFromSession(request.authUser!));
      return reply.send({ success: true });
    });
  });

  app.get<{ Params: { companySlug: string; id: string } }>(`${P}/branches/:id/close-preview`, guard("branch.close"), async (request, reply) =>
    withCompanyDb(request, reply, async (db) => {
      requireAccessibleBranch(await resolveBranchAuthority(request, db), request.params.id);
      return reply.send(await previewBranchClosure(db, request.params.id));
    }),
  );

  // Izin ditentukan transisi: ->CLOSED = branch.close, CLOSED->ACTIVE = branch.reopen, selain itu branch.manage.
  app.post<{ Params: { companySlug: string; id: string } }>(`${P}/branches/:id/status`, guard("branch.read"), async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => {
      requireAccessibleBranch(await resolveBranchAuthority(request, db), request.params.id);
      const current = await requireBranch(db, request.params.id);
      const needed: Permission = parsed.data.to === "CLOSED" ? "branch.close" : current.status === "CLOSED" ? "branch.reopen" : "branch.manage";
      if (!requirePerm(request, reply, needed, "Anda tidak memiliki izin untuk mengubah status cabang ini.")) return reply;
      await changeBranchStatus(db, request.params.id, parsed.data, actorFromSession(request.authUser!));
      return reply.send({ success: true, status: parsed.data.to });
    });
  });

  // Soft delete: hanya OWNER, hanya cabang yang belum pernah dipakai. Tidak ada hard delete.
  app.delete<{ Params: { companySlug: string; id: string } }>(`${P}/branches/:id`, guard("branch.manage"), async (request, reply) => {
    if (!requireOwner(request, reply)) return reply;
    return withCompanyDb(request, reply, async (db) => {
      requireAccessibleBranch(await resolveBranchAuthority(request, db), request.params.id);
      const activeAccess = await countActiveAccessForBranch(systemDb, request.companyAccess!.companyId, request.params.id);
      await softDeleteUnusedBranch(db, request.params.id, activeAccess, actorFromSession(request.authUser!));
      return reply.send({ success: true });
    });
  });

  // ----------------------------------------------------------------- akses user ke cabang
  app.get<{ Params: { companySlug: string; userId: string } }>(`${P}/access/:userId/branches`, guard("user_branch.manage"), async (request, reply) =>
    withCompanyDb(request, reply, async () => {
      const access = request.companyAccess!;
      const target = await findCompanyAccess(systemDb, request.params.userId, access.companyId);
      if (!target) return reply.code(404).send({ error: "User tidak ditemukan pada perusahaan ini." });
      if (!gateDelegatedTarget(request, reply, target.role, target.branchScope === "ALL" ? "ALL" : "LIMITED")) return reply;
      // Aktor LIMITED hanya melihat bagian irisan dengan cakupannya (cabang lain milik user itu tidak tampak).
      const mine = access.branchScope === "ALL" ? null : delegatedBranchIds(access, "manage_users");
      const rows = await listBranchAccess(systemDb, target.id, { includeRevoked: true });
      return reply.send({
        userId: request.params.userId,
        scope: target.branchScope,
        branches: mine ? rows.filter((r) => mine.has(r.branchId)) : rows,
      });
    }),
  );

  app.post<{ Params: { companySlug: string; userId: string } }>(`${P}/access/:userId/branches`, guard("user_branch.manage"), async (request, reply) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    return withCompanyDb(request, reply, async (db) => {
      const target = await resolveAccessTarget(request, reply, request.params.userId);
      if (!target) return reply;
      const branch = requireAccessibleBranch(await resolveBranchAuthority(request, db), parsed.data.branchId);
      requireDelegatedBranch(request, branch.id);
      if (branch.status !== "ACTIVE") {
        return reply.code(409).send({ error: "Akses hanya dapat diberikan ke cabang yang aktif.", code: "BRANCH_NOT_OPERATIONAL" });
      }
      await grantBranchAccess(systemDb, { companyId: request.companyAccess!.companyId, accessId: target.id, targetUserId: request.params.userId }, branch.id, actorFromSession(request.authUser!));
      return reply.code(201).send({ success: true });
    });
  });

  app.delete<{ Params: { companySlug: string; userId: string; branchId: string } }>(
    `${P}/access/:userId/branches/:branchId`,
    guard("user_branch.manage"),
    async (request, reply) => {
      const parsed = revokeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
      return withCompanyDb(request, reply, async (db) => {
        const target = await resolveAccessTarget(request, reply, request.params.userId);
        if (!target) return reply;
        requireAccessibleBranch(await resolveBranchAuthority(request, db), request.params.branchId);
        requireDelegatedBranch(request, request.params.branchId);
        await revokeBranchAccess(
          systemDb,
          { companyId: request.companyAccess!.companyId, accessId: target.id, targetUserId: request.params.userId },
          request.params.branchId,
          actorFromSession(request.authUser!),
          parsed.data.reason ?? null,
        );
        return reply.send({ success: true });
      });
    },
  );

  app.post<{ Params: { companySlug: string; userId: string } }>(`${P}/access/:userId/branches/transfer`, guard("user_branch.manage"), async (request, reply) => {
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    return withCompanyDb(request, reply, async (db) => {
      const target = await resolveAccessTarget(request, reply, request.params.userId);
      if (!target) return reply;
      const auth = await resolveBranchAuthority(request, db);
      requireAccessibleBranch(auth, parsed.data.fromBranchId);
      const to = requireAccessibleBranch(auth, parsed.data.toBranchId);
      requireDelegatedBranch(request, parsed.data.fromBranchId);
      requireDelegatedBranch(request, to.id);
      if (to.status !== "ACTIVE") {
        return reply.code(409).send({ error: "Cabang tujuan harus aktif.", code: "BRANCH_NOT_OPERATIONAL" });
      }
      await transferBranchAccess(
        systemDb,
        { companyId: request.companyAccess!.companyId, accessId: target.id, targetUserId: request.params.userId },
        parsed.data.fromBranchId,
        parsed.data.toBranchId,
        actorFromSession(request.authUser!),
        parsed.data.reason ?? null,
      );
      return reply.send({ success: true });
    });
  });

  // Mengubah cakupan ALL <-> LIMITED: hanya OWNER. OWNER sendiri selalu ALL.
  app.put<{ Params: { companySlug: string; userId: string } }>(`${P}/access/:userId/branch-scope`, guard("user_branch.manage"), async (request, reply) => {
    if (!requireOwner(request, reply)) return reply;
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    return withCompanyDb(request, reply, async () => {
      const target = await resolveAccessTarget(request, reply, request.params.userId);
      if (!target) return reply;
      if (target.role === "OWNER" && parsed.data.scope === "LIMITED") {
        return reply.code(409).send({ error: "OWNER selalu memiliki akses ke semua cabang.", code: "OWNER_SCOPE_FIXED" });
      }
      await setBranchScope(systemDb, { companyId: request.companyAccess!.companyId, accessId: target.id, targetUserId: request.params.userId }, parsed.data.scope, actorFromSession(request.authUser!));
      return reply.send({ success: true, scope: parsed.data.scope });
    });
  });

  // ----------------------------------------------------------------- kebijakan akun (OWNER)
  app.put<{ Params: { companySlug: string; id: string } }>(`${P}/accounts/:id/branch-policy`, guard("account.policy"), async (request, reply) => {
    const parsed = policySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => {
      const impact = await setAccountBranchPolicy(db, request.params.id, parsed.data, actorFromSession(request.authUser!));
      return reply.send({ success: true, existingLinesAffected: impact });
    });
  });

  app.post(`${P}/accounts/inter-branch/preview`, guard("account.policy"), async (request, reply) => {
    const parsed = interBranchAccountSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => reply.send(await previewInterBranchAccountPair(db, parsed.data)));
  });

  app.post(`${P}/accounts/inter-branch`, guard("account.policy"), async (request, reply) => {
    const parsed = interBranchAccountSchema.extend({ confirm: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    return withCompanyDb(request, reply, async (db) => {
      const result = await createInterBranchAccountPair(db, parsed.data, actorFromSession(request.authUser!));
      return reply.code(201).send({ success: true, ...result });
    });
  });
}
