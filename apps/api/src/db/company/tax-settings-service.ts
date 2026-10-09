import crypto from "node:crypto";
import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";

/**
 * Pajak (TASK-023 §7) -- tabel `tax_reference_settings` sudah ada sejak
 * C0011 (satu baris per file), tapi TIDAK ADA service/route yang
 * membacanya -- gap murni, bukan fitur baru, SAMA kelasnya dgn Company
 * Profile. Tabel ini HANYA referensi (status PPN, fasilitas UMKM, catatan
 * legal) -- BUKAN tax_rates/tax_types/tax engine (komentar migration
 * C0011 eksplisit: "do not build the full tax engine", di luar scope
 * TASK-023 §7 juga: "jangan mengarang tarif pajak atau aturan perpajakan
 * baru"). Dasar pengenaan (revenue) di-reuse dari `getIncomeStatement`
 * yang SAMA dgn Dashboard/Laporan Keuangan -- bukan dihitung ulang.
 */

export interface TaxSettingsRow {
  id: string;
  umkmFacilityYears: number;
  legalFormNote: string;
  vatStatus: string;
  vatDescription: string;
  vatLegalBasis: string;
  withholdingNotes: string[];
  generalNotes: string[];
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToTaxSettings(row: any): TaxSettingsRow {
  return {
    id: row.id,
    umkmFacilityYears: row.umkm_facility_years,
    legalFormNote: row.legal_form_note,
    vatStatus: row.vat_status,
    vatDescription: row.vat_description,
    vatLegalBasis: row.vat_legal_basis,
    withholdingNotes: parseJsonArray(row.withholding_notes),
    generalNotes: parseJsonArray(row.general_notes),
  };
}

/** `company-provisioning.ts` TIDAK PERNAH insert baris default ke tabel
 * ini (hanya mengecek tabelnya ADA, lihat REQUIRED_TABLES) -- gap nyata
 * yang berlaku utk company LAMA maupun BARU. Diperbaiki dgn lazy-seed
 * (insert sekali pakai nilai default skema C0011, BUKAN tarif/aturan
 * pajak yang dikarang) di sini drpd migration backfill terpisah --
 * idempotent, aman dipanggil berkali-kali (cek dulu sebelum insert). */
export async function getTaxSettings(db: Knex): Promise<TaxSettingsRow> {
  let row = await db("tax_reference_settings").first();
  if (!row) {
    await db("tax_reference_settings").insert({ id: crypto.randomUUID() });
    row = await db("tax_reference_settings").first();
  }
  if (!row) throw new Error("Pengaturan pajak tidak ditemukan.");
  return rowToTaxSettings(row);
}

export interface UpdateTaxSettingsInput {
  umkmFacilityYears?: number;
  legalFormNote?: string;
  vatStatus?: string;
  vatDescription?: string;
  vatLegalBasis?: string;
  withholdingNotes?: string[];
  generalNotes?: string[];
}

export async function updateTaxSettings(db: Knex, input: UpdateTaxSettingsInput, actor: ActorContext): Promise<void> {
  const existing = await getTaxSettings(db);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.umkmFacilityYears !== undefined) patch.umkm_facility_years = input.umkmFacilityYears;
  if (input.legalFormNote !== undefined) patch.legal_form_note = input.legalFormNote;
  if (input.vatStatus !== undefined) patch.vat_status = input.vatStatus;
  if (input.vatDescription !== undefined) patch.vat_description = input.vatDescription;
  if (input.vatLegalBasis !== undefined) patch.vat_legal_basis = input.vatLegalBasis;
  if (input.withholdingNotes !== undefined) patch.withholding_notes = JSON.stringify(input.withholdingNotes);
  if (input.generalNotes !== undefined) patch.general_notes = JSON.stringify(input.generalNotes);

  await db.transaction(async (trx) => {
    await trx("tax_reference_settings").where({ id: existing.id }).update(patch);
    await appendCompanyAudit(trx, {
      actor,
      action: "tax_setting.change",
      entityType: "tax_reference_settings",
      entityId: existing.id,
      before: existing,
      after: { ...existing, ...input },
    });
  });
}
