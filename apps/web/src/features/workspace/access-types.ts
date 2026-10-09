import type { CompanyWorkspaceRole } from "./types.js";

/** Persis bentuk satu baris response `GET /api/company-db/:slug/access`
 * (`modules/company-access/routes.ts`) -- nama/email selalu dari
 * masterDb (canonical), bisa null kalau user legacy-nya sudah terhapus. */
export interface CompanyAccessUser {
  userId: string;
  name: string;
  email: string | null;
  role: CompanyWorkspaceRole;
  status: "ACTIVE" | "SUSPENDED";
}

export interface GrantAccessInput {
  userId: string; // id ATAU email (lihat komentar backend routes.ts)
  role: CompanyWorkspaceRole;
}
