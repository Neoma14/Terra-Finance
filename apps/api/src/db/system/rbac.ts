/**
 * RBAC MINIMAL (TASK-DB-ARCH-010 §11-13). Role company-scoped, permission
 * SENGAJA dasar (bukan ratusan permission granular) -- "permission
 * registry terkontrol dalam application layer" (§12), bukan tabel
 * database (belum diperlukan, role->permission tetap deterministic &
 * testable lewat object literal di bawah, bukan dihitung dinamis).
 */

export const COMPANY_ROLES = ["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const PERMISSIONS = [
  "company.read",
  "company.update",
  "users.read",
  "users.manage",
  "account.read",
  "account.create",
  "account.update",
  "account.lock",
  "journal.read",
  "journal.create",
  "journal.post",
  "journal.reverse",
  "report.read",
  "backup.create",
  "backup.restore",
  // Multi-Branch (Phase 1-2)
  "branch.read",
  "branch.manage",
  "branch.close",
  "branch.reopen",
  "user_branch.manage",
  "account.policy",
  // Multi-Branch Phase 3 -- otorisasi & delegasi. `interbranch.*` / `report.consolidated` baru
  // fondasi (fiturnya Phase 5/6) tetapi sudah dapat di-override / didelegasikan.
  "delegation.manage",
  "interbranch.read",
  "interbranch.create",
  "interbranch.approve",
  "interbranch.reverse",
  "report.consolidated",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: readonly Permission[] = ["company.read", "account.read", "journal.read", "report.read", "branch.read"];

const STAFF_PERMISSIONS: readonly Permission[] = [...VIEWER_PERMISSIONS, "journal.create", "interbranch.read", "interbranch.create"];

const ACCOUNTANT_PERMISSIONS: readonly Permission[] = [
  ...STAFF_PERMISSIONS,
  "account.create",
  "account.update",
  "journal.post",
  "journal.reverse",
  "interbranch.approve",
  "interbranch.reverse",
  "report.consolidated",
];

// ADMIN = administrasi company + seluruh permission accounting ACCOUNTANT,
// TAPI TIDAK backup.create/backup.restore (operasi paling berisiko,
// disengaja dipersempit ke OWNER saja -- keputusan dicatat, bukan
// diasumsikan dari §13 yang tidak merinci backup utk ADMIN).
// ADMIN: kelola cabang & akses cabang -- penegakan "hanya scope ALL" ada di guard cabang (middleware/branch-authority.ts);
// pembatasan untuk admin berdelegasi menunggu Phase 3-4. `branch.reopen` dan `account.policy` HANYA OWNER.
const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...ACCOUNTANT_PERMISSIONS,
  "account.lock",
  "company.update",
  "users.read",
  "users.manage",
  "branch.manage",
  "branch.close",
  "user_branch.manage",
];

const OWNER_PERMISSIONS: readonly Permission[] = PERMISSIONS; // full

const ROLE_PERMISSIONS: Record<CompanyRole, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER_PERMISSIONS),
  STAFF: new Set(STAFF_PERMISSIONS),
  ACCOUNTANT: new Set(ACCOUNTANT_PERMISSIONS),
  ADMIN: new Set(ADMIN_PERMISSIONS),
  OWNER: new Set(OWNER_PERMISSIONS),
};

/** Deterministic & testable -- nol lookup DB, nol input dari client (role
 * SELALU datang dari baris `company_access` yang sudah diverifikasi,
 * tidak pernah dari request payload, §21/§24 Privilege Escalation). */
export function hasPermission(role: CompanyRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isValidCompanyRole(value: string): value is CompanyRole {
  return (COMPANY_ROLES as readonly string[]).includes(value);
}

/** Pangkat peran. Dipakai HANYA untuk aturan "siapa boleh mengelola peran siapa". */
export const ROLE_RANK: Record<CompanyRole, number> = { VIEWER: 0, STAFF: 1, ACCOUNTANT: 2, ADMIN: 3, OWNER: 4 };

/**
 * Aturan anti eskalasi hak (server-side, bukan sekadar UI):
 *  - tidak ada yang boleh menetapkan peran yang lebih tinggi dari perannya sendiri;
 *  - tidak ada yang boleh mengubah/mencabut/menangguhkan akses yang pangkatnya lebih tinggi dari perannya;
 *  - peran OWNER (memberi, menerima, atau mengubah akses OWNER) hanya dapat dikelola oleh OWNER.
 * `targetCurrent` = peran target sekarang (null saat pemberian akses baru),
 * `next` = peran baru (null saat mencabut / mengubah status saja).
 */
export function canManageRole(actor: CompanyRole, targetCurrent: CompanyRole | null, next: CompanyRole | null): boolean {
  const a = ROLE_RANK[actor];
  if (targetCurrent && ROLE_RANK[targetCurrent] > a) return false;
  if (next && ROLE_RANK[next] > a) return false;
  if ((targetCurrent === "OWNER" || next === "OWNER") && actor !== "OWNER") return false;
  return true;
}

/**
 * Permission yang BOLEH di-override per user (GRANT/DENY) dan didelegasikan
 * (Multi-Branch Phase 3, Revisi 5 Z.3.2). Sengaja daftar tertutup, operasional
 * dan berisiko rendah. Permission administratif (users.manage, user_branch.manage,
 * branch.*, delegation.manage (OWNER), account.*, company.update, backup.*) HANYA mengikuti
 * role -- tidak ada jalur per-orang. Menambah isi daftar ini = perubahan kode terkaji.
 */
export const OVERRIDABLE_PERMISSIONS = [
  "interbranch.read",
  "interbranch.create",
  "interbranch.approve",
  "interbranch.reverse",
  "report.consolidated",
] as const satisfies readonly Permission[];
export type OverridablePermission = (typeof OVERRIDABLE_PERMISSIONS)[number];

/**
 * Permission yang SUDAH didefinisikan dan dapat di-override, tetapi BELUM mengendalikan fitur bisnis apa pun
 * (fiturnya Phase 5/6). Status: "prepared", bukan "implemented" -- saat Phase 5/6 dimulai tiap permission harus
 * dipasang pada endpoint/service yang relevan dan diuji sampai database/UI.
 */
export const PREPARED_PERMISSIONS: readonly Permission[] = OVERRIDABLE_PERMISSIONS;

/**
 * DELEGASI (Revisi 5 O.3 / Z.4): kapabilitas TETAP, bukan kombinasi bebas permission x cabang.
 *   manage_users        -> kelola akses cabang & override user pada cabang cakupan (AKTIF Phase 3)
 *   manage_branch_info  -> ubah info (nama/alamat/telepon) cabang cakupan          (AKTIF Phase 3)
 *   view_branch_reports -> dicatat; efeknya baru pada laporan per cabang           (prepared, Phase 5)
 *   inter_branch        -> dicatat; efeknya baru pada alur antar-cabang            (prepared, Phase 6)
 * `max_role` = peran tertinggi user yang boleh dikelola penerima; selalu di bawah peran penerima, tak pernah ADMIN/OWNER.
 * Hak efektif = irisan(delegasi, akses cabang penerima SAAT INI, permission efektif penerima SAAT INI).
 */
export const DELEGATION_CAPABILITIES = ["manage_users", "manage_branch_info", "view_branch_reports", "inter_branch"] as const;
export type DelegationCapability = (typeof DELEGATION_CAPABILITIES)[number];
export const DELEGATION_MAX_ROLES = ["VIEWER", "STAFF", "ACCOUNTANT"] as const;
export type DelegationMaxRole = (typeof DELEGATION_MAX_ROLES)[number];
/** Peran yang dapat menerima delegasi (harus punya peran di atas max_role). */
export const DELEGATION_ELIGIBLE_ROLES: readonly CompanyRole[] = ["ADMIN", "ACCOUNTANT"];
/** Kapabilitas yang berefek nyata di Phase 3 + permission peran yang WAJIB dimiliki penerima agar berefek (irisan). */
export const ACTIVE_DELEGATION_CAPABILITIES: Readonly<Partial<Record<DelegationCapability, Permission>>> = {
  manage_users: "user_branch.manage",
  manage_branch_info: "branch.manage",
};
export function isDelegationCapability(v: string): v is DelegationCapability {
  return (DELEGATION_CAPABILITIES as readonly string[]).includes(v);
}
export function isDelegationMaxRole(v: string): v is DelegationMaxRole {
  return (DELEGATION_MAX_ROLES as readonly string[]).includes(v);
}

export function isOverridablePermission(value: string): value is OverridablePermission {
  return (OVERRIDABLE_PERMISSIONS as readonly string[]).includes(value);
}

/** Permission yang mengubah data/keputusan: role baca-saja (VIEWER) tidak boleh menerimanya lewat override/delegasi. */
const READ_ONLY_OVERRIDABLE: readonly Permission[] = ["interbranch.read", "report.consolidated"];
export function isReadOnlyOverridable(permission: Permission): boolean {
  return READ_ONLY_OVERRIDABLE.includes(permission);
}
