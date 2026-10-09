import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";

/**
 * Company Profile CRUD (TASK-023 §3/§13) -- tabel `company_profile` sudah
 * ada sejak C0001 (satu baris per file, diisi saat provisioning,
 * `company-provisioning.ts`), tapi TIDAK ADA service/route yang
 * membacanya kembali/mengubahnya -- gap murni, bukan fitur baru. Tidak
 * ada migration tambahan.
 *
 * "Perusahaan" (identitas/kontak) & "Pengaturan" (currency/fiscal year
 * start) di frontend adalah DUA TAMPILAN dari SATU tabel ini -- field
 * yang sama, subset form yang berbeda, bukan dua service berbeda.
 */

export class CompanyProfileNotFoundError extends Error {
  readonly code = "COMPANY_PROFILE_NOT_FOUND" as const;
}

export interface CompanyProfileRow {
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

const COLUMNS = [
  "id",
  "name",
  "trade_name as tradeName",
  "legal_entity_type as legalEntityType",
  "industry",
  "npwp",
  "nib",
  "address",
  "city",
  "province",
  "postal_code as postalCode",
  "phone",
  "email",
  "website",
  "currency",
  "fiscal_year_start_month as fiscalYearStartMonth",
];

export async function getCompanyProfile(db: Knex): Promise<CompanyProfileRow> {
  const row = await db("company_profile").select(COLUMNS).first();
  if (!row) throw new CompanyProfileNotFoundError("Profil perusahaan tidak ditemukan.");
  return row;
}

export interface UpdateCompanyProfileInput {
  name?: string;
  tradeName?: string | null;
  legalEntityType?: string | null;
  industry?: string | null;
  npwp?: string | null;
  nib?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  currency?: string;
  fiscalYearStartMonth?: number;
}

export async function updateCompanyProfile(db: Knex, input: UpdateCompanyProfileInput, actor: ActorContext): Promise<void> {
  const existing = await getCompanyProfile(db);
  if (input.name !== undefined && !input.name.trim()) {
    throw new Error("Nama perusahaan tidak boleh kosong.");
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.tradeName !== undefined) patch.trade_name = input.tradeName;
  if (input.legalEntityType !== undefined) patch.legal_entity_type = input.legalEntityType;
  if (input.industry !== undefined) patch.industry = input.industry;
  if (input.npwp !== undefined) patch.npwp = input.npwp;
  if (input.nib !== undefined) patch.nib = input.nib;
  if (input.address !== undefined) patch.address = input.address;
  if (input.city !== undefined) patch.city = input.city;
  if (input.province !== undefined) patch.province = input.province;
  if (input.postalCode !== undefined) patch.postal_code = input.postalCode;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.email !== undefined) patch.email = input.email;
  if (input.website !== undefined) patch.website = input.website;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.fiscalYearStartMonth !== undefined) patch.fiscal_year_start_month = input.fiscalYearStartMonth;

  await db.transaction(async (trx) => {
    await trx("company_profile").where({ id: existing.id }).update(patch);
    await appendCompanyAudit(trx, {
      actor,
      action: "company_profile.change",
      entityType: "company_profile",
      entityId: existing.id,
      before: existing,
      after: { ...existing, ...input },
    });
  });
}
