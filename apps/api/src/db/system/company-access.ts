import type { Knex } from "knex";
import type { CompanyRole } from "./rbac.js";

/**
 * Repository `company_access` (skema `S0010`). Nama kolom persis sesuai
 * migration -- tidak diasumsikan.
 */

export interface CompanyAccessRow {
  id: string;
  systemUserId: string;
  companyId: string;
  role: CompanyRole;
  status: "ACTIVE" | "SUSPENDED";
  /** Multi-Branch: ALL (default, perilaku lama) atau LIMITED (hanya cabang di user_branch_access; kosong = tidak melihat apa pun). */
  branchScope: "ALL" | "LIMITED";
  /** Preferensi konteks cabang terakhir -- hanya kenyamanan, divalidasi ulang tiap request. */
  defaultBranchId: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = [
  "id",
  "system_user_id as systemUserId",
  "company_id as companyId",
  "role",
  "status",
  "branch_scope as branchScope",
  "default_branch_id as defaultBranchId",
  "created_at as createdAt",
  "updated_at as updatedAt",
];

export async function findCompanyAccess(systemDb: Knex, systemUserId: string, companyId: string): Promise<CompanyAccessRow | undefined> {
  return systemDb("company_access").select(COLUMNS).where({ system_user_id: systemUserId, company_id: companyId }).first();
}

export async function findCompanyAccessById(systemDb: Knex, id: string): Promise<CompanyAccessRow | undefined> {
  return systemDb("company_access").select(COLUMNS).where({ id }).first();
}

/** TASK-DB-ARCH-011 §8 -- list seluruh access satu company (utk
 * `GET /api/company-db/:slug/access`, hanya dipanggil pemegang
 * `users.manage`). */
export async function listCompanyAccessForCompany(systemDb: Knex, companyId: string): Promise<CompanyAccessRow[]> {
  return systemDb("company_access").select(COLUMNS).where({ company_id: companyId }).orderBy("created_at", "asc");
}

/** §16 Owner Protection -- hitung OWNER berstatus ACTIVE di satu company.
 * Dipanggil SEBELUM downgrade-role/suspend/revoke terhadap seorang OWNER. */
export async function countActiveOwners(systemDb: Knex, companyId: string): Promise<number> {
  const row = await systemDb("company_access")
    .where({ company_id: companyId, role: "OWNER", status: "ACTIVE" })
    .count("* as c")
    .first();
  return Number((row as any)?.c ?? 0);
}

/** Dipakai GET /api/company-db (§17) -- hanya company dgn access ACTIVE
 * DAN registry ACTIVE (JOIN, bukan dua query terpisah yang bisa
 * inconsistent). */
export async function listAccessibleCompanies(
  systemDb: Knex,
  systemUserId: string,
): Promise<Array<{ companyId: string; slug: string; name: string; role: CompanyRole }>> {
  return systemDb("company_access as ca")
    .join("companies_registry as cr", "cr.id", "ca.company_id")
    .where("ca.system_user_id", systemUserId)
    .andWhere("ca.status", "ACTIVE")
    .andWhere("cr.status", "active")
    .select("cr.id as companyId", "cr.slug", "cr.name", "ca.role");
}

export interface GrantCompanyAccessInput {
  id: string;
  systemUserId: string;
  companyId: string;
  role: CompanyRole;
  /** Multi-Branch: default ALL (perilaku lama). Rute pemberian akses memakai LIMITED saat multi-cabang aktif (fail-closed). */
  branchScope?: "ALL" | "LIMITED";
}

/** INSERT saja -- dipanggil dari dalam transaction yang sama dgn registry
 * insert (company creation, modules/company/routes.ts) ATAU transaction
 * tersendiri utk grant/revoke manual (belum ada endpoint-nya di task ini,
 * disiapkan utk dipakai). */
export async function grantCompanyAccess(trx: Knex, input: GrantCompanyAccessInput): Promise<void> {
  await trx("company_access").insert({
    id: input.id,
    system_user_id: input.systemUserId,
    company_id: input.companyId,
    role: input.role,
    status: "ACTIVE",
    branch_scope: input.branchScope ?? "ALL",
  });
}

/** §12 Role Change -- UPDATE saja, dipanggil dari dalam transaction yang
 * sama dgn audit (`system_audit_log`, "company.access.role_changed"). */
export async function updateCompanyAccessRole(trx: Knex, id: string, role: CompanyRole): Promise<void> {
  await trx("company_access").where({ id }).update({ role, updated_at: new Date().toISOString() });
}

/** §13/§14 Suspend/Activate -- UPDATE status saja. */
export async function updateCompanyAccessStatus(trx: Knex, id: string, status: "ACTIVE" | "SUSPENDED"): Promise<void> {
  await trx("company_access").where({ id }).update({ status, updated_at: new Date().toISOString() });
}

/** §15 Revoke -- hard delete baris access (BUKAN company_access tabel itu
 * sendiri, satu baris relasi user-company saja; §16 Owner Protection WAJIB
 * dicek oleh CALLER sebelum memanggil ini). */
export async function deleteCompanyAccess(trx: Knex, id: string): Promise<void> {
  await trx("company_access").where({ id }).del();
}
