/** Persis bentuk response `GET/PATCH /api/company-db/:slug/profile`
 * (`modules/company-profile/routes.ts`). */
export interface CompanyProfile {
  id: string;
  name: string;
  tradeName: string | null;
  legalEntityType: string | null;
  industry: string | null;
  npwp: string | null;
  nib: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  currency: string;
  fiscalYearStartMonth: number;
}

export type UpdateCompanyProfileInput = Partial<Omit<CompanyProfile, "id">>;
