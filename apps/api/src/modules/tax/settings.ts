import crypto from "node:crypto";
import type { Knex } from "knex";
import type { IndustryTemplate, TaxReference, TaxReferenceUpdateInput } from "@konsultan/shared";
import { getTaxReference as getDefaultTaxReference } from "./reference.js";

function rowToReference(row: any): TaxReference {
  return {
    id: row.id,
    umkmFacilityYears: row.umkm_facility_years,
    legalFormNote: row.legal_form_note,
    vat: { status: row.vat_status, description: row.vat_description, legalBasis: row.vat_legal_basis },
    withholdingNotes: JSON.parse(row.withholding_notes),
    generalNotes: JSON.parse(row.general_notes),
  };
}

/** Seed baris tax_reference_settings dari default template industri --
 * dipanggil sekali saat perusahaan baru dibuat, sama persis logikanya dgn
 * versi online, scoped `company_id`. */
export async function seedTaxReferenceSettings(masterDb: Knex, companyId: string, industryTemplate: IndustryTemplate): Promise<void> {
  const existing = await masterDb("tax_reference_settings").where({ company_id: companyId }).first();
  if (existing) return;
  const def = getDefaultTaxReference(industryTemplate);
  await masterDb("tax_reference_settings").insert({
    id: crypto.randomUUID(),
    company_id: companyId,
    umkm_facility_years: def.umkmFacilityYears,
    legal_form_note: def.legalFormNote,
    vat_status: def.vat.status,
    vat_description: def.vat.description,
    vat_legal_basis: def.vat.legalBasis,
    withholding_notes: JSON.stringify(def.withholdingNotes),
    general_notes: JSON.stringify(def.generalNotes),
  });
}

/** Baca referensi pajak perusahaan -- kalau baris belum ada (perusahaan
 * lama sebelum fitur ini ada), fallback ke default template TANPA
 * menyimpan (biar tidak diam-diam menulis data saat GET); baris baru akan
 * dibuat begitu user pertama kali menyimpan lewat PUT. Sama persis
 * logikanya dgn versi online, scoped `company_id`. */
export async function getTaxReferenceSettings(masterDb: Knex, companyId: string, industryTemplate: IndustryTemplate): Promise<TaxReference> {
  const row = await masterDb("tax_reference_settings").where({ company_id: companyId }).first();
  if (row) return rowToReference(row);
  return getDefaultTaxReference(industryTemplate);
}

export async function updateTaxReferenceSettings(masterDb: Knex, companyId: string, input: TaxReferenceUpdateInput): Promise<TaxReference> {
  const existing = await masterDb("tax_reference_settings").where({ company_id: companyId }).first();
  const values = {
    umkm_facility_years: input.umkmFacilityYears,
    legal_form_note: input.legalFormNote,
    vat_status: input.vat.status,
    vat_description: input.vat.description,
    vat_legal_basis: input.vat.legalBasis,
    withholding_notes: JSON.stringify(input.withholdingNotes),
    general_notes: JSON.stringify(input.generalNotes),
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    await masterDb("tax_reference_settings").where({ id: existing.id }).update(values);
    const updated = await masterDb("tax_reference_settings").where({ id: existing.id }).first();
    return rowToReference(updated);
  }
  const id = crypto.randomUUID();
  await masterDb("tax_reference_settings").insert({ id, company_id: companyId, ...values });
  const inserted = await masterDb("tax_reference_settings").where({ id }).first();
  return rowToReference(inserted);
}
