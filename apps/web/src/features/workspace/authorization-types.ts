import type { CompanyWorkspaceRole } from "./types.js";

/** Bentuk respons `modules/company-authorization/routes.ts` dan `modules/company-branches/routes.ts`.
 * Hanya tipe tampilan: seluruh keputusan izin ada di server (UI bukan lapisan keamanan). */

export type OverridablePermission = "interbranch.read" | "interbranch.create" | "interbranch.approve" | "interbranch.reverse" | "report.consolidated";

export const OVERRIDABLE_PERMISSION_OPTIONS: Array<{ value: OverridablePermission; label: string }> = [
  { value: "interbranch.read", label: "Melihat transaksi antar cabang" },
  { value: "interbranch.create", label: "Mengajukan transaksi antar cabang" },
  { value: "interbranch.approve", label: "Menyetujui transaksi antar cabang" },
  { value: "interbranch.reverse", label: "Meminta pembatalan (reversal) antar cabang" },
  { value: "report.consolidated", label: "Laporan gabungan cabang" },
];

export function permissionLabel(permission: string): string {
  return OVERRIDABLE_PERMISSION_OPTIONS.find((o) => o.value === permission)?.label ?? permission;
}

export interface BranchSummary {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "INACTIVE" | "CLOSED";
  isHeadOffice: boolean;
}

export interface BranchesResponse {
  multiBranchEnabled: boolean;
  branches: BranchSummary[];
}

export type DelegationCapability = "manage_users" | "manage_branch_info" | "view_branch_reports" | "inter_branch";
export type DelegationMaxRole = "VIEWER" | "STAFF" | "ACCOUNTANT";

/** Kapabilitas tetap (Revisi 5). `active` = sudah berefek pada fitur nyata; selain itu "prepared" (efek menyusul Phase 5/6). */
export const DELEGATION_CAPABILITY_OPTIONS: Array<{ value: DelegationCapability; label: string; hint: string; active: boolean }> = [
  { value: "manage_users", label: "Kelola user cabang", hint: "Menambah/mencabut/memindah akses cabang dan mengatur wewenang khusus user di cabang cakupan.", active: true },
  { value: "manage_branch_info", label: "Ubah info cabang", hint: "Mengubah nama, alamat, dan telepon cabang cakupan (bukan status/urutan).", active: true },
  { value: "view_branch_reports", label: "Lihat laporan cabang", hint: "Disiapkan: berlaku saat pelaporan per cabang tersedia.", active: false },
  { value: "inter_branch", label: "Transaksi antar cabang", hint: "Disiapkan: berlaku saat alur antar-cabang tersedia.", active: false },
];
export function capabilityLabel(c: string): string {
  return DELEGATION_CAPABILITY_OPTIONS.find((o) => o.value === c)?.label ?? c;
}

export interface DelegationView {
  id: string;
  capabilities: DelegationCapability[];
  maxRole: DelegationMaxRole;
  branchIds: string[];
  hiddenBranchCount: number;
  expiresAt: string | null;
  status: "ACTIVE" | "REVOKED";
  live: boolean;
  reason: string | null;
  createdAt: string;
  grantor: { userId: string; name: string };
  grantee: { userId: string; name: string };
  direction: "granted" | "received" | "managed";
  canRevoke: boolean;
}

export interface MyAuthorization {
  role: CompanyWorkspaceRole;
  scope: "ALL" | "LIMITED";
  permissions: string[];
  grants: string[];
  denies: string[];
  preparedPermissions: string[];
  delegation: {
    id: string;
    capabilities: DelegationCapability[];
    maxRole: DelegationMaxRole;
    expiresAt: string | null;
    effectiveBranchIds: Record<DelegationCapability, string[]>;
  } | null;
  delegationsReceived: DelegationView[];
  canDelegate: boolean;
}

export interface AuthorizationUser {
  userId: string;
  name: string;
  email: string | null;
  role: CompanyWorkspaceRole;
  status: "ACTIVE" | "SUSPENDED";
  branchScope: "ALL" | "LIMITED";
  self: boolean;
  branches: Array<{ id: string; code: string; name: string; status: string }>;
  hiddenBranchCount: number;
  roleDefaults: OverridablePermission[];
  overrides: Array<{ permission: OverridablePermission; effect: "GRANT" | "DENY"; reason: string | null; createdAt: string }>;
  delegation: DelegationView | null;
}

export interface CreateDelegationInput {
  granteeUserId: string;
  capabilities: DelegationCapability[];
  maxRole: DelegationMaxRole;
  branchIds: string[];
  expiresAt?: string | null;
  reason?: string | null;
}
