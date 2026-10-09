import "fastify";
import type { SessionUser } from "../modules/auth/session-service.js";
import type { CompanyRole, Permission } from "../db/system/rbac.js";
import type { ActiveDelegation } from "../db/system/authorization.js";

/** Diisi `requireCompanyAccess` (middleware/company-access-guard.ts,
 * TASK-DB-ARCH-010) -- SELALU hasil verifikasi company_access, TIDAK
 * PERNAH dari request body/params mentah (§21 Actor Context, §24
 * Privilege Escalation). */
export interface CompanyAccessContext {
  companyId: string;
  slug: string;
  role: CompanyRole;
  /** System DB: id identitas user (system_users) dan baris company_access -- dari verifikasi server. */
  systemUserId: string;
  accessId: string;
  /** Multi-Branch: cakupan cabang akses ini. LIMITED => allowedBranchIds berisi cabang aktifnya (bisa kosong = fail-closed). */
  branchScope: "ALL" | "LIMITED";
  allowedBranchIds: string[] | null;
  defaultBranchId: string | null;
  /** Phase 3: override aktif (GRANT/DENY) dan delegasi yang berlaku -- dibaca dari System DB tiap request, tanpa cache. */
  grants: ReadonlySet<Permission>;
  denies: ReadonlySet<Permission>;
  /** Delegasi (Revisi 5) yang berlaku untuk user ini; null bila tidak ada. */
  delegation: ActiveDelegation | null;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: SessionUser;
    companyAccess?: CompanyAccessContext;
  }
}
