import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyApi } from "../../lib/company-api-client.js";
import type { AccessibleCompany } from "./types.js";

export interface CreateCompanyInput {
  name: string;
  slug: string;
  currency: string;
  fiscalYearStartMonth: number;
}

export interface CreatedCompany {
  companyId: string;
  slug: string;
  name: string;
  status: string;
  role: string;
}

/** Tambah perusahaan -- reuse `POST /api/company-db` (provisioning, registry,
 * OWNER access sudah ada di backend). Slug dibuat dari nama di sisi klien
 * hanya sebagai identifier; backend yang memvalidasi & menolak duplikat. */
export function useCreateCompanyDb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompanyInput) => companyApi.post<CreatedCompany>("", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", "accessible-companies"] }),
  });
}

/** List company yang BOLEH diakses user yang login (bukan seluruh
 * registry) -- `GET /api/company-db`, sudah difilter server-side via
 * `company_access` ACTIVE (TASK-DB-ARCH-010/011). Dipakai Company
 * Selector DAN Company Switcher (satu query, dua tempat pakai lewat
 * react-query cache). */
export function useAccessibleCompanies() {
  return useQuery({
    queryKey: ["workspace", "accessible-companies"],
    queryFn: () => companyApi.get<{ companies: AccessibleCompany[] }>(""),
  });
}
