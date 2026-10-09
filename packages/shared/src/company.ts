import { z } from "zod";

export const companyStatusSchema = z.enum(["active", "archived"]);
export type CompanyStatus = z.infer<typeof companyStatusSchema>;

export const companyRoleSchema = z.enum(["owner", "analyst", "viewer"]);
export type CompanyRole = z.infer<typeof companyRoleSchema>;

// Menentukan template chart-of-accounts & statement lines yang di-seed saat
// provisioning -- masing-masing punya struktur laporan keuangan yang
// fundamentally berbeda (mis. bank tidak punya "aset lancar vs tetap",
// koperasi punya Simpanan Pokok/Wajib & SHU, bukan modal saham & laba
// ditahan biasa).
export const industryTemplateSchema = z.enum(["general", "hospital", "banking", "cooperative"]);
export type IndustryTemplate = z.infer<typeof industryTemplateSchema>;

export const INDUSTRY_TEMPLATE_LABELS: Record<IndustryTemplate, string> = {
  general: "Umum / Korporat (Migas, Manufaktur, Dagang, dll)",
  hospital: "Rumah Sakit",
  banking: "Perbankan",
  cooperative: "Koperasi",
};

export const createCompanySchema = z.object({
  name: z.string().min(2).max(200),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "slug hanya boleh huruf kecil, angka, dan tanda hubung"),
  industry: z.string().min(2).max(120).optional(),
  industryTemplate: industryTemplateSchema.default("general"),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  currency: z.string().length(3).default("IDR"),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export interface Company {
  id: string;
  slug: string;
  name: string;
  industry: string | null;
  industryTemplate: IndustryTemplate;
  status: CompanyStatus;
  fiscalYearStartMonth: number;
  currency: string;
  logoUrl: string | null;
  createdAt: string;
}

export interface CompanyAccess extends Company {
  roleInCompany: CompanyRole;
}
