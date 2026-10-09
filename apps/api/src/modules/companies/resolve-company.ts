import type { Knex } from "knex";

export interface CompanyRow {
  id: string;
  slug: string;
  name: string;
  industry: string | null;
  industry_template: string;
  status: string;
  fiscal_year_start_month: number;
  currency: string;
  logo_data_uri: string | null;
}

/** Dipakai SEMUA modul yang scoped per-perusahaan (accounts, journal,
 * statements, dst) -- satu tempat resolve `:companySlug` jadi row
 * `companies`, supaya konsisten & tidak duplikasi query di tiap modul. */
export async function resolveCompanyBySlug(masterDb: Knex, slug: string): Promise<CompanyRow | undefined> {
  return masterDb("companies").where({ slug }).first();
}
