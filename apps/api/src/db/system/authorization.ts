import crypto from "node:crypto";
import type { Knex } from "knex";
import {
  ACTIVE_DELEGATION_CAPABILITIES,
  DELEGATION_CAPABILITIES,
  DELEGATION_ELIGIBLE_ROLES,
  ROLE_RANK,
  canManageRole,
  hasPermission,
  isDelegationCapability,
  isDelegationMaxRole,
  isOverridablePermission,
  isReadOnlyOverridable,
  type CompanyRole,
  type DelegationCapability,
  type DelegationMaxRole,
  type Permission,
} from "./rbac.js";
import { appendSystemAudit, type SystemActorContext } from "./system-audit.js";

/**
 * Otorisasi efektif Multi-Branch (Phase 3, model delegasi Revisi 5).
 *
 *   Permission efektif   = (permission ROLE  UNION  GRANT aktif)  MINUS  DENY aktif
 *   Wewenang atas cabang = akses cabang user SAAT INI  DAN  permission efektif        (canActOnBranch)
 *   Delegasi (Revisi 5)  = kapabilitas TETAP (manage_users, manage_branch_info, view_branch_reports,
 *                          inter_branch) + daftar cabang + max_role + masa berlaku
 *                          Hak efektif = irisan(delegasi, akses cabang penerima SAAT INI,
 *                                               permission efektif penerima SAAT INI)
 *
 * Tidak ada cache: semuanya dibaca dari System DB pada TIAP request sehingga pencabutan (akses cabang,
 * override, delegasi) berlaku pada request berikutnya walau sesi masih hidup.
 *
 * Prinsip tunggal (Revisi 5 O.1): aktor hanya dapat memberi/mengubah/mencabut sesuatu yang (a) ia miliki
 * sendiri dan (b) ada di dalam cakupan cabang / delegasinya. Pintu aturannya hanya dua fungsi di file ini:
 * `assertOverrideBoundary` dan `assertDelegationBoundary` (+ `getManageUsersScope` untuk pengelolaan akses).
 * OWNER tetap melalui validasi dasar (perusahaan, target, cabang valid); tidak ada bypass global.
 */

export const AUTHZ_AUDIT_ACTIONS = {
  OVERRIDE_CREATED: "permission_override.created",
  OVERRIDE_REVOKED: "permission_override.revoked",
  DELEGATION_CREATED: "delegation.created",
  DELEGATION_REVOKED: "delegation.revoked",
  DELEGATION_EXPIRED: "delegation.expired",
  BOUNDARY_DENIED: "security.authorization_boundary_denied",
} as const;

export type BoundaryCode =
  | "SELF_MODIFICATION"
  | "OWNER_PROTECTED"
  | "ROLE_RANK_EXCEEDED"
  | "ROLE_EXCEEDS_DELEGATION"
  | "ROLE_NOT_ELIGIBLE"
  | "PERMISSION_NOT_OVERRIDABLE"
  | "PERMISSION_NOT_HELD"
  | "DELEGATION_REQUIRED"
  | "DELEGATION_DEPTH_EXCEEDED"
  | "CAPABILITY_INVALID"
  | "CAPABILITY_NOT_APPLICABLE"
  | "MAX_ROLE_INVALID"
  | "SCOPE_ALL_NOT_ALLOWED"
  | "SCOPE_EMPTY"
  | "BRANCH_OUT_OF_SCOPE"
  | "TARGET_OUT_OF_SCOPE"
  | "READ_ONLY_ROLE"
  | "INVALID_EXPIRY";

export class AuthorizationBoundaryError extends Error {
  constructor(
    public readonly code: BoundaryCode,
    message: string,
  ) {
    super(message);
  }
}
export class AuthorizationNotFoundError extends Error {
  readonly code = "AUTHORIZATION_NOT_FOUND" as const;
}
export class AuthorizationConflictError extends Error {
  readonly code = "AUTHORIZATION_ALREADY_EXISTS" as const;
}

// ---------------------------------------------------------------------------------------------
// Bentuk data
// ---------------------------------------------------------------------------------------------

/** Delegasi yang BERLAKU untuk seorang penerima saat ini (sudah divalidasi terhadap pemberi & peran). */
export interface ActiveDelegation {
  id: string;
  grantorAccessId: string;
  capabilities: ReadonlySet<DelegationCapability>;
  /** Cabang cakupan delegasi (sebelum diiris dengan akses cabang penerima). */
  branchIds: ReadonlySet<string>;
  maxRole: DelegationMaxRole;
  expiresAt: string | null;
}

export interface EffectiveAuthorizationInputs {
  role: CompanyRole;
  grants: ReadonlySet<Permission>;
  denies: ReadonlySet<Permission>;
  delegation: ActiveDelegation | null;
}

/** Subset konteks akses yang dibutuhkan fungsi di sini (diisi requireCompanyAccess). */
export interface AuthzActor extends EffectiveAuthorizationInputs {
  accessId: string;
  systemUserId: string;
  companyId: string;
  branchScope: "ALL" | "LIMITED";
  allowedBranchIds: string[] | null;
}

export interface AuthzTarget {
  accessId: string;
  userId: string;
  companyId: string;
  role: CompanyRole;
  branchScope: "ALL" | "LIMITED";
  /** Cabang aktif target (relevan bila LIMITED). */
  branchIds: string[];
}

export interface PermissionOverrideRow {
  id: string;
  accessId: string;
  permission: Permission;
  effect: "GRANT" | "DENY";
  status: "ACTIVE" | "REVOKED";
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface DelegationRow {
  id: string;
  companyId: string;
  grantorAccessId: string;
  granteeAccessId: string;
  capabilities: DelegationCapability[];
  branchIds: string[];
  maxRole: DelegationMaxRole;
  expiresAt: string | null;
  status: "ACTIVE" | "REVOKED";
  reason: string | null;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  /** true bila ACTIVE dan belum lewat masa berlaku (kondisi pemberi/penerima dievaluasi terpisah saat resolusi). */
  live: boolean;
}

// ---------------------------------------------------------------------------------------------
// Evaluasi permission (murni)
// ---------------------------------------------------------------------------------------------

/**
 * Permission efektif (role + GRANT - DENY). OWNER selalu penuh (override diabaikan: DENY pada OWNER ditolak
 * database, dan GRANT tak berarti). `hasPermission` dipanggil apa adanya agar tes yang menimpanya tetap berlaku.
 * Delegasi TIDAK menambah permission: delegasi hanya memberi kewenangan administratif atas cabang (di bawah).
 */
export function hasBasePermission(a: Pick<EffectiveAuthorizationInputs, "role" | "grants" | "denies">, permission: Permission): boolean {
  if (a.role === "OWNER") return hasPermission("OWNER", permission);
  const byRole = hasPermission(a.role, permission);
  const byGrant = isOverridablePermission(permission) && a.grants.has(permission);
  return (byRole || byGrant) && !a.denies.has(permission);
}

function isBranchAccessible(a: Pick<AuthzActor, "branchScope" | "allowedBranchIds">, branchId: string): boolean {
  return a.branchScope === "ALL" || (a.allowedBranchIds ?? []).includes(branchId);
}

/**
 * Wewenang melakukan `permission` PADA cabang tertentu = akses cabang user SAAT INI DAN permission efektif.
 * Inilah pemeriksaan untuk fitur per-cabang (Phase 6): permission tanpa akses cabang tidak cukup,
 * akses cabang tanpa permission juga tidak.
 */
export function canActOnBranch(a: EffectiveAuthorizationInputs & Pick<AuthzActor, "branchScope" | "allowedBranchIds">, permission: Permission, branchId: string | null): boolean {
  if (!branchId) return false;
  if (!isBranchAccessible(a, branchId)) return false;
  return hasBasePermission(a, permission);
}

/** Kapabilitas delegasi hanya berefek bila penerima juga memegang permission peran yang relevan (irisan, Z.4). */
export function isCapabilityApplicable(a: Pick<EffectiveAuthorizationInputs, "role" | "grants" | "denies">, cap: DelegationCapability): boolean {
  const required = ACTIVE_DELEGATION_CAPABILITIES[cap];
  return required ? hasBasePermission(a, required) : true;
}

/**
 * Cabang yang BENAR-BENAR dapat dikelola lewat delegasi untuk satu kapabilitas =
 * cabang delegasi  IRISAN  akses cabang penerima saat ini (kosong bila kapabilitas tak dimiliki / tak berlaku).
 */
export function delegatedBranchIds(a: AuthzActor, cap: DelegationCapability): Set<string> {
  const d = a.delegation;
  if (!d || !d.capabilities.has(cap) || !isCapabilityApplicable(a, cap)) return new Set();
  return new Set([...d.branchIds].filter((b) => isBranchAccessible(a, b)));
}

export interface ManageScope {
  /** true = aktor ber-scope ALL (wewenang peran sendiri, tanpa delegasi). */
  all: boolean;
  /** Bila !all: cabang efektif delegasi manage_users. */
  branchIds: ReadonlySet<string>;
  /** Bila !all: peran tertinggi user yang boleh dikelola. */
  maxRole: CompanyRole;
}

/**
 * Cakupan pengelolaan user (akses cabang & override) milik aktor:
 *  - scope ALL (OWNER / ADMIN lama): wewenang peran, tanpa delegasi;
 *  - LIMITED: HANYA lewat delegasi manage_users aktif (irisan akses & permission peran); tanpa itu -> null.
 */
export function getManageUsersScope(a: AuthzActor): ManageScope | null {
  if (a.branchScope === "ALL") return { all: true, branchIds: new Set(), maxRole: "OWNER" };
  const ids = delegatedBranchIds(a, "manage_users");
  if (!a.delegation || ids.size === 0) return null;
  return { all: false, branchIds: ids, maxRole: a.delegation.maxRole };
}

/** Cakupan perubahan info cabang (nama/alamat/telepon): ALL = permission peran; LIMITED = delegasi manage_branch_info. */
export function getManageBranchInfoScope(a: AuthzActor): { all: boolean; branchIds: ReadonlySet<string> } | null {
  if (a.branchScope === "ALL") return hasBasePermission(a, "branch.manage") ? { all: true, branchIds: new Set() } : null;
  const ids = delegatedBranchIds(a, "manage_branch_info");
  return ids.size > 0 ? { all: false, branchIds: ids } : null;
}

/** Daftar permission efektif (untuk UI / endpoint /authorization/me). */
export function listBasePermissions(a: Pick<EffectiveAuthorizationInputs, "role" | "grants" | "denies">, all: readonly Permission[]): Permission[] {
  return all.filter((p) => hasBasePermission(a, p));
}

// ---------------------------------------------------------------------------------------------
// Pembacaan dari System DB
// ---------------------------------------------------------------------------------------------

const OVERRIDE_COLUMNS = [
  "id",
  "access_id as accessId",
  "permission",
  "effect",
  "status",
  "reason",
  "created_by as createdBy",
  "created_at as createdAt",
  "revoked_by as revokedBy",
  "revoked_at as revokedAt",
  "revoke_reason as revokeReason",
];

export async function loadActiveOverrides(db: Knex, accessId: string): Promise<{ grants: Set<Permission>; denies: Set<Permission> }> {
  const rows = await db("access_permission_overrides").where({ access_id: accessId, status: "ACTIVE" }).select("permission", "effect");
  const grants = new Set<Permission>();
  const denies = new Set<Permission>();
  for (const r of rows as Array<{ permission: Permission; effect: string }>) {
    if (!isOverridablePermission(r.permission)) continue; // fail-closed: nilai asing diabaikan
    (r.effect === "GRANT" ? grants : denies).add(r.permission);
  }
  return { grants, denies };
}

export async function listOverrides(db: Knex, accessId: string, opts: { includeRevoked?: boolean } = {}): Promise<PermissionOverrideRow[]> {
  let q = db("access_permission_overrides").select(OVERRIDE_COLUMNS).where({ access_id: accessId }).orderBy("created_at", "asc");
  if (!opts.includeRevoked) q = q.where({ status: "ACTIVE" });
  return q;
}

interface RawDelegation {
  id: string;
  companyId: string;
  grantorAccessId: string;
  granteeAccessId: string;
  canManageUsers: number;
  canManageBranchInfo: number;
  canViewBranchReports: number;
  canInterBranch: number;
  maxRole: DelegationMaxRole;
  expiresAt: string | null;
  status: "ACTIVE" | "REVOKED";
  reason: string | null;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

const DELEGATION_COLUMNS = [
  "id",
  "company_id as companyId",
  "grantor_access_id as grantorAccessId",
  "grantee_access_id as granteeAccessId",
  "can_manage_users as canManageUsers",
  "can_manage_branch_info as canManageBranchInfo",
  "can_view_branch_reports as canViewBranchReports",
  "can_inter_branch as canInterBranch",
  "max_role as maxRole",
  "expires_at as expiresAt",
  "status",
  "reason",
  "created_at as createdAt",
  "revoked_by as revokedBy",
  "revoked_at as revokedAt",
  "revoke_reason as revokeReason",
];

function capabilitiesOf(r: RawDelegation): DelegationCapability[] {
  const out: DelegationCapability[] = [];
  if (r.canManageUsers) out.push("manage_users");
  if (r.canManageBranchInfo) out.push("manage_branch_info");
  if (r.canViewBranchReports) out.push("view_branch_reports");
  if (r.canInterBranch) out.push("inter_branch");
  return out;
}

async function hydrateDelegations(db: Knex, rows: RawDelegation[], nowIso: string): Promise<DelegationRow[]> {
  if (rows.length === 0) return [];
  const branchRows = await db("delegation_branches").whereIn("delegation_id", rows.map((r) => r.id)).select("delegation_id", "branch_id");
  const byDelegation = new Map<string, string[]>();
  for (const b of branchRows as Array<{ delegation_id: string; branch_id: string }>) {
    byDelegation.set(b.delegation_id, [...(byDelegation.get(b.delegation_id) ?? []), b.branch_id]);
  }
  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    grantorAccessId: r.grantorAccessId,
    granteeAccessId: r.granteeAccessId,
    capabilities: capabilitiesOf(r),
    branchIds: byDelegation.get(r.id) ?? [],
    maxRole: r.maxRole,
    expiresAt: r.expiresAt,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt,
    revokedBy: r.revokedBy,
    revokedAt: r.revokedAt,
    revokeReason: r.revokeReason,
    live: r.status === "ACTIVE" && (r.expiresAt === null || r.expiresAt > nowIso),
  }));
}

export async function listDelegations(
  db: Knex,
  companyId: string,
  filter: { granteeAccessId?: string; grantorAccessId?: string; includeInactive?: boolean } = {},
  now: Date = new Date(),
): Promise<DelegationRow[]> {
  let q = db("delegations").select(DELEGATION_COLUMNS).where({ company_id: companyId }).orderBy("created_at", "asc");
  if (filter.granteeAccessId) q = q.where({ grantee_access_id: filter.granteeAccessId });
  if (filter.grantorAccessId) q = q.where({ grantor_access_id: filter.grantorAccessId });
  if (!filter.includeInactive) q = q.where({ status: "ACTIVE" });
  const rows = await hydrateDelegations(db, await q, now.toISOString());
  return filter.includeInactive ? rows : rows.filter((r) => r.live);
}

/**
 * Delegasi yang BERLAKU untuk penerima saat ini. Dievaluasi terhadap kondisi SAAT INI:
 *  - belum kedaluwarsa dan berstatus ACTIVE;
 *  - pemberi masih ACTIVE dan masih memegang `delegation.manage` dari wewenang dasarnya (kedalaman 1: wewenang
 *    hasil delegasi tidak pernah membuat delegasi);
 *  - peran penerima masih memenuhi syarat (ADMIN/ACCOUNTANT) dan `max_role` masih di bawah perannya.
 * Bila salah satu gugur, delegasi tidak berlaku (menyusut aman) tanpa baris perlu diedit.
 */
export async function resolveActiveDelegation(
  db: Knex,
  companyId: string,
  grantee: { accessId: string; role: CompanyRole },
  now: Date = new Date(),
): Promise<ActiveDelegation | null> {
  if (!DELEGATION_ELIGIBLE_ROLES.includes(grantee.role)) return null;
  const [row] = await listDelegations(db, companyId, { granteeAccessId: grantee.accessId }, now);
  if (!row || row.capabilities.length === 0) return null;
  if (ROLE_RANK[row.maxRole] >= ROLE_RANK[grantee.role]) return null;
  const g = await db("company_access").where({ id: row.grantorAccessId, company_id: companyId, status: "ACTIVE" }).select("role").first();
  if (!g) return null;
  const ov = await loadActiveOverrides(db, row.grantorAccessId);
  if (!hasBasePermission({ role: g.role as CompanyRole, ...ov }, "delegation.manage")) return null;
  return {
    id: row.id,
    grantorAccessId: row.grantorAccessId,
    capabilities: new Set(row.capabilities),
    branchIds: new Set(row.branchIds),
    maxRole: row.maxRole,
    expiresAt: row.expiresAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Batas wewenang (pintu tunggal)
// ---------------------------------------------------------------------------------------------

/** Aturan umum sebelum mengubah wewenang user lain. */
function assertManageableTarget(actor: AuthzActor, target: AuthzTarget): void {
  if (actor.accessId === target.accessId) {
    throw new AuthorizationBoundaryError("SELF_MODIFICATION", "Anda tidak dapat mengubah wewenang Anda sendiri.");
  }
  if (target.role === "OWNER") {
    throw new AuthorizationBoundaryError("OWNER_PROTECTED", "Wewenang OWNER tidak dapat dibatasi atau ditambah lewat override/delegasi.");
  }
  if (!canManageRole(actor.role, target.role, null)) {
    throw new AuthorizationBoundaryError("ROLE_RANK_EXCEEDED", "Anda tidak berwenang mengelola user dengan peran ini.");
  }
}

/**
 * Target boleh disentuh aktor dalam cakupan pengelolaannya:
 *  - ALL: lolos (wewenang peran).
 *  - LIMITED: wajib punya delegasi manage_users yang berlaku; target ber-scope LIMITED, perannya <= max_role;
 *    untuk operasi atas user secara keseluruhan (override) seluruh cabang target harus di dalam cakupan efektif.
 *    Untuk operasi per-cabang cukup irisan (`requireAllTargetBranchesInside` = false); cabangnya diperiksa terpisah.
 */
export function assertTargetInManageScope(actor: AuthzActor, target: AuthzTarget, opts: { requireAllTargetBranchesInside: boolean }): ManageScope {
  const scope = getManageUsersScope(actor);
  if (!scope) {
    throw new AuthorizationBoundaryError("DELEGATION_REQUIRED", "Akun Anda dibatasi per cabang; mengelola user memerlukan delegasi aktif dari OWNER.");
  }
  if (scope.all) return scope;
  if (target.branchScope !== "LIMITED") {
    throw new AuthorizationBoundaryError("TARGET_OUT_OF_SCOPE", "User ini memiliki akses ke semua cabang, di luar cakupan delegasi Anda.");
  }
  if (ROLE_RANK[target.role] > ROLE_RANK[scope.maxRole]) {
    throw new AuthorizationBoundaryError("ROLE_EXCEEDS_DELEGATION", "Peran user ini melebihi peran maksimum pada delegasi Anda.");
  }
  if (opts.requireAllTargetBranchesInside && target.branchIds.some((b) => !scope.branchIds.has(b))) {
    throw new AuthorizationBoundaryError("TARGET_OUT_OF_SCOPE", "User ini memiliki akses ke cabang di luar cakupan delegasi Anda.");
  }
  return scope;
}

/** Aturan untuk operasi akses cabang (beri/cabut/pindah): target + setiap cabang yang disentuh harus dalam cakupan. */
export function assertBranchAccessBoundary(actor: AuthzActor, target: AuthzTarget, branchIds: string[]): void {
  assertManageableTarget(actor, target);
  const scope = assertTargetInManageScope(actor, target, { requireAllTargetBranchesInside: false });
  if (scope.all) return;
  for (const b of branchIds) {
    if (!scope.branchIds.has(b)) throw new AuthorizationBoundaryError("BRANCH_OUT_OF_SCOPE", "Cabang berada di luar cakupan delegasi Anda atau tidak ditemukan.");
  }
}

export function assertOverrideBoundary(
  actor: AuthzActor,
  target: AuthzTarget,
  permission: string,
  effect: "GRANT" | "DENY",
  action: "set" | "revoke",
): void {
  if (!isOverridablePermission(permission)) {
    throw new AuthorizationBoundaryError("PERMISSION_NOT_OVERRIDABLE", `Permission "${permission}" tidak dapat di-override per user; ia hanya mengikuti peran.`);
  }
  assertManageableTarget(actor, target);
  assertTargetInManageScope(actor, target, { requireAllTargetBranchesInside: true });
  // Memberi GRANT atau mencabut DENY = menambah kemampuan target: aktor harus memegangnya sendiri (wewenang dasar).
  const increases = (action === "set" && effect === "GRANT") || (action === "revoke" && effect === "DENY");
  if (increases && !hasBasePermission(actor, permission)) {
    throw new AuthorizationBoundaryError("PERMISSION_NOT_HELD", "Anda tidak dapat memberikan permission yang tidak Anda miliki.");
  }
  if (action === "set" && effect === "DENY" && !hasBasePermission(actor, permission) && actor.role !== "OWNER") {
    throw new AuthorizationBoundaryError("PERMISSION_NOT_HELD", "Anda tidak dapat membatasi permission yang tidak Anda miliki.");
  }
  if (action === "set" && effect === "GRANT" && target.role === "VIEWER" && !isReadOnlyOverridable(permission)) {
    throw new AuthorizationBoundaryError("READ_ONLY_ROLE", "Peran VIEWER hanya baca; permission ini tidak dapat diberikan kepadanya.");
  }
}

export interface DelegationInput {
  /** Kapabilitas tetap (Revisi 5 O.3). */
  capabilities: string[];
  maxRole: string;
  /** Delegasi tidak pernah "semua cabang"; bendera ini hanya ada agar permintaan semacam itu ditolak eksplisit. */
  scopeAll?: boolean;
  branchIds: string[];
  expiresAt?: string | null;
  reason?: string | null;
}

const MAX_DELEGATION_DAYS = 366;

export function assertDelegationBoundary(
  actor: AuthzActor,
  grantee: AuthzTarget,
  input: DelegationInput,
  companyBranchIds: ReadonlySet<string>,
  now: Date = new Date(),
): void {
  // Kedalaman 1: penerima delegasi tidak dapat mendelegasikan lagi (walau punya hak lain).
  if (actor.delegation) {
    throw new AuthorizationBoundaryError("DELEGATION_DEPTH_EXCEEDED", "Penerima delegasi tidak dapat membuat delegasi (maksimum satu tingkat).");
  }
  if (!hasBasePermission(actor, "delegation.manage")) {
    throw new AuthorizationBoundaryError("PERMISSION_NOT_HELD", "Hanya OWNER yang dapat membuat delegasi.");
  }
  assertManageableTarget(actor, grantee);
  if (!DELEGATION_ELIGIBLE_ROLES.includes(grantee.role)) {
    throw new AuthorizationBoundaryError("ROLE_NOT_ELIGIBLE", "Delegasi hanya dapat diberikan kepada user berperan ADMIN atau ACCOUNTANT.");
  }

  // kapabilitas
  if (input.capabilities.length === 0 || input.capabilities.some((c) => !isDelegationCapability(c))) {
    throw new AuthorizationBoundaryError("CAPABILITY_INVALID", `Kapabilitas delegasi harus dari: ${DELEGATION_CAPABILITIES.join(", ")}.`);
  }
  const probe = { role: grantee.role, grants: new Set<Permission>(), denies: new Set<Permission>() };
  for (const c of input.capabilities as DelegationCapability[]) {
    const required = ACTIVE_DELEGATION_CAPABILITIES[c];
    if (required && !hasBasePermission(probe, required)) {
      throw new AuthorizationBoundaryError("CAPABILITY_NOT_APPLICABLE", `Peran ${grantee.role} tidak memiliki permission dasar yang dibutuhkan kapabilitas "${c}".`);
    }
  }

  // max_role: di bawah peran penerima, tidak pernah ADMIN/OWNER
  if (!isDelegationMaxRole(input.maxRole) || ROLE_RANK[input.maxRole] >= ROLE_RANK[grantee.role]) {
    throw new AuthorizationBoundaryError("MAX_ROLE_INVALID", "Peran maksimum harus VIEWER, STAFF, atau ACCOUNTANT dan berada di bawah peran penerima.");
  }

  // cakupan: tidak pernah "semua cabang"; daftar cabang tidak boleh kosong; subset cakupan pemberi
  if (input.scopeAll) {
    throw new AuthorizationBoundaryError("SCOPE_ALL_NOT_ALLOWED", "Delegasi tidak dapat mencakup semua cabang; pilih cabang secara eksplisit.");
  }
  if (input.branchIds.length === 0) {
    throw new AuthorizationBoundaryError("SCOPE_EMPTY", "Pilih minimal satu cabang untuk delegasi ini.");
  }
  const mine = actor.branchScope === "ALL" ? new Set(companyBranchIds) : new Set((actor.allowedBranchIds ?? []).filter((id) => companyBranchIds.has(id)));
  for (const b of input.branchIds) {
    if (!mine.has(b)) throw new AuthorizationBoundaryError("BRANCH_OUT_OF_SCOPE", "Cabang berada di luar cakupan Anda atau tidak ditemukan.");
  }

  // masa berlaku
  if (input.expiresAt) {
    const t = Date.parse(input.expiresAt);
    if (Number.isNaN(t) || t <= now.getTime()) {
      throw new AuthorizationBoundaryError("INVALID_EXPIRY", "Masa berlaku harus berada di masa depan.");
    }
    if (t - now.getTime() > MAX_DELEGATION_DAYS * 86_400_000) {
      throw new AuthorizationBoundaryError("INVALID_EXPIRY", `Masa berlaku maksimum ${MAX_DELEGATION_DAYS} hari.`);
    }
  }
}

/** Siapa yang boleh mencabut sebuah delegasi: OWNER, pemberinya, atau penerimanya sendiri (melepas). */
export function canRevokeDelegation(actor: AuthzActor, delegation: DelegationRow): boolean {
  if (actor.role === "OWNER") return true;
  return delegation.grantorAccessId === actor.accessId || delegation.granteeAccessId === actor.accessId;
}

// ---------------------------------------------------------------------------------------------
// Tulis (dengan audit dalam transaksi yang sama)
// ---------------------------------------------------------------------------------------------

export async function setPermissionOverride(
  db: Knex,
  actor: AuthzActor,
  actorAudit: SystemActorContext,
  target: AuthzTarget,
  permission: string,
  effect: "GRANT" | "DENY",
  reason: string | null,
): Promise<{ id: string; replaced: boolean }> {
  assertOverrideBoundary(actor, target, permission, effect, "set");
  return db.transaction(async (trx) => {
    const existing = await trx("access_permission_overrides").where({ access_id: target.accessId, permission, status: "ACTIVE" }).first();
    if (existing && existing.effect === effect) throw new AuthorizationConflictError("Override yang sama sudah aktif untuk user ini.");
    const nowIso = new Date().toISOString();
    if (existing) {
      await trx("access_permission_overrides")
        .where({ id: existing.id })
        .update({ status: "REVOKED", revoked_by: actor.systemUserId, revoked_at: nowIso, revoke_reason: "digantikan override baru" });
    }
    const id = crypto.randomUUID();
    await trx("access_permission_overrides").insert({
      id,
      company_id: target.companyId,
      access_id: target.accessId,
      permission,
      effect,
      status: "ACTIVE",
      reason,
      created_by: actor.systemUserId,
      created_at: nowIso,
    });
    await appendSystemAudit(trx, {
      actor: actorAudit,
      action: AUTHZ_AUDIT_ACTIONS.OVERRIDE_CREATED,
      entityType: "permission_override",
      entityId: id,
      companyId: target.companyId,
      targetUserId: target.userId,
      before: existing ? { permission, effect: existing.effect } : null,
      after: { permission, effect },
      reason,
    });
    return { id, replaced: Boolean(existing) };
  });
}

export async function revokePermissionOverride(
  db: Knex,
  actor: AuthzActor,
  actorAudit: SystemActorContext,
  target: AuthzTarget,
  permission: string,
  reason: string | null,
): Promise<void> {
  await db.transaction(async (trx) => {
    const existing = await trx("access_permission_overrides").where({ access_id: target.accessId, permission, status: "ACTIVE" }).first();
    if (!existing) throw new AuthorizationNotFoundError("Override aktif untuk permission ini tidak ditemukan.");
    assertOverrideBoundary(actor, target, permission, existing.effect, "revoke");
    await trx("access_permission_overrides")
      .where({ id: existing.id })
      .update({ status: "REVOKED", revoked_by: actor.systemUserId, revoked_at: new Date().toISOString(), revoke_reason: reason });
    await appendSystemAudit(trx, {
      actor: actorAudit,
      action: AUTHZ_AUDIT_ACTIONS.OVERRIDE_REVOKED,
      entityType: "permission_override",
      entityId: existing.id,
      companyId: target.companyId,
      targetUserId: target.userId,
      before: { permission, effect: existing.effect },
      after: { status: "REVOKED" },
      reason,
    });
  });
}

export async function createDelegation(
  db: Knex,
  actor: AuthzActor,
  actorAudit: SystemActorContext,
  grantee: AuthzTarget,
  input: DelegationInput,
  companyBranchIds: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<{ id: string }> {
  assertDelegationBoundary(actor, grantee, input, companyBranchIds, now);
  const branchIds = [...new Set(input.branchIds)];
  const caps = new Set(input.capabilities as DelegationCapability[]);
  return db.transaction(async (trx) => {
    const nowIso = now.toISOString();
    // Delegasi lama penerima yang sudah kedaluwarsa: tutup dulu agar tidak menghalangi yang baru (satu aktif per penerima).
    const stale = await trx("delegations")
      .where({ grantee_access_id: grantee.accessId, status: "ACTIVE" })
      .whereNotNull("expires_at")
      .where("expires_at", "<=", nowIso)
      .select("id");
    for (const s of stale as Array<{ id: string }>) {
      await trx("delegations").where({ id: s.id }).update({ status: "REVOKED", revoked_at: nowIso, revoke_reason: "kedaluwarsa" });
      await appendSystemAudit(trx, {
        actor: { actorType: "system", actorLabel: "authorization" },
        action: AUTHZ_AUDIT_ACTIONS.DELEGATION_EXPIRED,
        entityType: "delegation",
        entityId: s.id,
        companyId: grantee.companyId,
        targetUserId: grantee.userId,
        after: { status: "REVOKED" },
      });
    }

    const id = crypto.randomUUID();
    try {
      await trx("delegations").insert({
        id,
        company_id: grantee.companyId,
        grantor_access_id: actor.accessId,
        grantee_access_id: grantee.accessId,
        can_manage_users: caps.has("manage_users") ? 1 : 0,
        can_manage_branch_info: caps.has("manage_branch_info") ? 1 : 0,
        can_view_branch_reports: caps.has("view_branch_reports") ? 1 : 0,
        can_inter_branch: caps.has("inter_branch") ? 1 : 0,
        max_role: input.maxRole,
        expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        status: "ACTIVE",
        reason: input.reason ?? null,
        created_at: nowIso,
      });
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) throw new AuthorizationConflictError("User ini sudah memiliki delegasi aktif; cabut dulu sebelum membuat yang baru.");
      throw err;
    }
    for (const branchId of branchIds) await trx("delegation_branches").insert({ delegation_id: id, branch_id: branchId });
    await appendSystemAudit(trx, {
      actor: actorAudit,
      action: AUTHZ_AUDIT_ACTIONS.DELEGATION_CREATED,
      entityType: "delegation",
      entityId: id,
      companyId: grantee.companyId,
      targetUserId: grantee.userId,
      branchId: branchIds.length === 1 ? branchIds[0] : null,
      after: { capabilities: [...caps], branchIds, maxRole: input.maxRole, expiresAt: input.expiresAt ?? null, grantorAccessId: actor.accessId },
      reason: input.reason ?? null,
    });
    return { id };
  });
}

export async function revokeDelegation(
  db: Knex,
  actor: AuthzActor,
  actorAudit: SystemActorContext,
  delegationId: string,
  reason: string | null,
): Promise<void> {
  await db.transaction(async (trx) => {
    const raw = (await trx("delegations").select(DELEGATION_COLUMNS).where({ id: delegationId, company_id: actor.companyId, status: "ACTIVE" }).first()) as RawDelegation | undefined;
    if (!raw) throw new AuthorizationNotFoundError("Delegasi aktif tidak ditemukan.");
    const [delegation] = await hydrateDelegations(trx, [raw], new Date().toISOString());
    if (!canRevokeDelegation(actor, delegation)) {
      // Seragam dengan "tidak ditemukan": tidak membocorkan keberadaan delegasi di luar wewenang.
      throw new AuthorizationNotFoundError("Delegasi aktif tidak ditemukan.");
    }
    await trx("delegations")
      .where({ id: delegationId })
      .update({ status: "REVOKED", revoked_by: actor.systemUserId, revoked_at: new Date().toISOString(), revoke_reason: reason });
    const grantee = await trx("company_access").where({ id: delegation.granteeAccessId }).select("system_user_id").first();
    await appendSystemAudit(trx, {
      actor: actorAudit,
      action: AUTHZ_AUDIT_ACTIONS.DELEGATION_REVOKED,
      entityType: "delegation",
      entityId: delegationId,
      companyId: actor.companyId,
      targetUserId: grantee?.system_user_id ?? null,
      branchId: delegation.branchIds.length === 1 ? delegation.branchIds[0] : null,
      before: { capabilities: delegation.capabilities, branchIds: delegation.branchIds, maxRole: delegation.maxRole, grantorAccessId: delegation.grantorAccessId },
      after: { status: "REVOKED" },
      reason,
    });
  });
}

// Pembatasan laju: satu entri per (aktor, perusahaan, jenis, operasi) per 30 detik -- mencegah banjir audit
// oleh permintaan terlarang berulang (jejak tetap ada; hanya pengulangan identik yang dirapatkan).
const boundaryAuditSeen = new Map<string, number>();
const BOUNDARY_AUDIT_WINDOW_MS = 30_000;

/** Hanya untuk pengujian: kosongkan pembatas laju audit. */
export function resetBoundaryAuditThrottleForTests(): void {
  boundaryAuditSeen.clear();
}

/** Catatan percobaan pelanggaran batas (best-effort, tidak boleh mengubah respons). */
export async function auditBoundaryDenied(
  db: Knex,
  actorAudit: SystemActorContext,
  companyId: string,
  targetUserId: string | null,
  detail: { code: string; permission?: string; capabilities?: string[]; branchIds?: string[]; operation: string },
): Promise<void> {
  try {
    const key = `${actorAudit.actorId ?? "-"}|${companyId}|${detail.code}|${detail.operation}`;
    const now = Date.now();
    if (now - (boundaryAuditSeen.get(key) ?? 0) < BOUNDARY_AUDIT_WINDOW_MS) return;
    boundaryAuditSeen.set(key, now);
    if (boundaryAuditSeen.size > 5000) boundaryAuditSeen.clear();
    await db.transaction(async (trx) => {
      await appendSystemAudit(trx, {
        actor: actorAudit,
        action: AUTHZ_AUDIT_ACTIONS.BOUNDARY_DENIED,
        entityType: "authorization",
        companyId,
        targetUserId,
        after: detail,
      });
    });
  } catch {
    /* best-effort */
  }
}
