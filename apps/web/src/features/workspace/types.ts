/**
 * Tipe utk company-scoped workspace baru (TASK-DB-ARCH-013). SENGAJA
 * TIDAK reuse `CompanyRole`/`CompanyAccess` dari `@konsultan/shared` --
 * tipe itu milik model LEGACY (role lowercase "owner"/"analyst"/"viewer",
 * tanpa per-user access). Role di sini mencerminkan `db/system/rbac.ts`
 * (API baru): 5 role uppercase. Ini HANYA label tipe utk tampilan (badge),
 * BUKAN sistem RBAC frontend baru -- keputusan izin SEPENUHNYA tetap di
 * backend (`requireCompanyAccess`/`requirePermission`), sesuai instruksi
 * "jangan membuat sistem RBAC baru di frontend".
 */
export type CompanyWorkspaceRole = "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";

/** Persis bentuk response `GET /api/company-db` (`listAccessibleCompanies`,
 * db/system/company-access.ts) -- hanya company yang company_access-nya
 * ACTIVE milik user yang login, bukan seluruh registry. */
export interface AccessibleCompany {
  companyId: string;
  slug: string;
  name: string;
  role: CompanyWorkspaceRole;
}
