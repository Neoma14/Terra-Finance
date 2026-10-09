import type { FastifyReply, FastifyRequest } from "fastify";
import { systemDb } from "../db/system/index.js";
import { findCompanyRegistryBySlug } from "../db/system/companies-registry.js";
import { ensureSystemIdentity } from "../db/system/identity-bridge.js";
import { findCompanyAccess } from "../db/system/company-access.js";
import { listActiveBranchIds } from "../db/system/user-branch-access.js";
import { enforceLimitedScopeRoute } from "./branch-authority.js";
import { type CompanyRole, type Permission } from "../db/system/rbac.js";
import { hasBasePermission, loadActiveOverrides, resolveActiveDelegation } from "../db/system/authorization.js";

/**
 * Authorization middleware reusable (TASK-DB-ARCH-010 §19) -- menegakkan
 * alur §14:
 *
 *   requireAuth -> requireCompanyAccess(companySlug) -> requirePermission(perm) -> handler
 *
 * Company access DIPERIKSA SEBELUM Company DB dibuka (§14 "sangat
 * penting") -- fungsi ini TIDAK membuka company.db sama sekali, hanya
 * memverifikasi lewat System DB (`companies_registry`+`company_access`).
 * Pembukaan company.db yang sesungguhnya tetap lewat
 * `company-resolver.ts` (TIDAK diubah) di route handler, SETELAH guard
 * ini lolos.
 *
 * §24 Company Enumeration: respons DENY identik baik company tidak
 * ditemukan maupun company ada tapi user tidak punya akses -- client
 * tidak bisa membedakan dua kondisi itu dari response.
 */

function sendAccessDenied(reply: FastifyReply) {
  return reply.code(404).send({ error: "Perusahaan tidak ditemukan atau Anda tidak memiliki akses." });
}

export async function requireCompanyAccess(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authUser) {
    return reply.code(401).send({ error: "Belum login" });
  }

  const { companySlug } = request.params as { companySlug?: string };
  if (!companySlug) {
    return reply.code(400).send({ error: "companySlug wajib diisi pada URL" });
  }

  const registryRow = await findCompanyRegistryBySlug(systemDb, companySlug);
  if (!registryRow || registryRow.status !== "active") {
    return sendAccessDenied(reply);
  }

  // Identity bridge dipanggil LAZY, hanya saat company access benar-benar
  // dicek -- bukan di login flow (Identity_Architecture_Proposal.md Option A).
  const systemUserId = await ensureSystemIdentity(systemDb, request.authUser);

  const access = await findCompanyAccess(systemDb, systemUserId, registryRow.id);
  if (!access || access.status !== "ACTIVE") {
    return sendAccessDenied(reply);
  }

  // Multi-Branch: cakupan cabang dibaca dari System DB TIAP request (tanpa cache) -- pencabutan akses
  // cabang berlaku pada request berikutnya. Nilai tak dikenal diperlakukan LIMITED (fail-closed).
  const branchScope: "ALL" | "LIMITED" = access.branchScope === "ALL" ? "ALL" : "LIMITED";
  // Phase 3: override & delegasi juga dibaca TIAP request (pencabutan berlaku seketika, tanpa logout).
  const role = access.role as CompanyRole;
  const overrides = role === "OWNER" ? { grants: new Set<Permission>(), denies: new Set<Permission>() } : await loadActiveOverrides(systemDb, access.id);
  const delegation = await resolveActiveDelegation(systemDb, registryRow.id, { accessId: access.id, role });
  request.companyAccess = {
    companyId: registryRow.id,
    slug: companySlug,
    role,
    systemUserId,
    accessId: access.id,
    branchScope,
    allowedBranchIds: branchScope === "LIMITED" ? await listActiveBranchIds(systemDb, access.id) : null,
    defaultBranchId: access.defaultBranchId ?? null,
    grants: overrides.grants,
    denies: overrides.denies,
    delegation,
  };

  // Akun LIMITED hanya boleh memanggil route yang sudah sadar-cabang (deny by default).
  return enforceLimitedScopeRoute(request, reply);
}

/** WAJIB dipasang SETELAH `requireCompanyAccess` di preHandler array --
 * membaca `request.companyAccess.role` yang SUDAH diverifikasi lewat DB,
 * tidak pernah dari request body/params (§21/§24 Privilege Escalation). */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.companyAccess) {
      // Tidak seharusnya tercapai kalau preHandler dipasang berurutan
      // dgn benar -- dijaga sbg fail-safe (deny by default), bukan 500.
      return reply.code(404).send({ error: "Perusahaan tidak ditemukan atau Anda tidak memiliki akses." });
    }
    // Role + GRANT - DENY (hasBasePermission memanggil hasPermission(role, ...) apa adanya).
    if (!hasBasePermission(request.companyAccess, permission)) {
      return reply.code(403).send({ error: "Anda tidak memiliki izin untuk melakukan aksi ini." });
    }
  };
}
