import type { Knex } from "knex";

/**
 * Referensi pajak perusahaan -- padanan Company DB dari
 * db/master/migrations/0011_create_tax_reference_settings.ts. Satu baris
 * per file (bukan per company_id lagi, ADR-001 §8) -- unique constraint
 * `company_id` lama (satu-satunya alasan kolom itu ada) jadi tidak perlu
 * sama sekali.
 *
 * Mengikuti TASK.md "TAX RULES" (satu-satunya dokumen tax rules di repo ini
 * -- tidak ada file terpisah bernama TAX_RULES.md, dicatat sbg
 * Documentation Discrepancy di laporan akhir krn instruksi task menyebut
 * nama file itu secara eksplisit):
 *   - tarif/aturan pajak TIDAK di-hardcode di sini (tabel ini cuma
 *     referensi umum per perusahaan -- UMKM facility, status PPN, catatan
 *     legal -- bukan tax_rules/tax_rates itu sendiri, yang di luar scope
 *     task ini, §20 instruksi: "do not build the full tax engine");
 *   - effective date & histori tax rule yang sesungguhnya belum ada tabel
 *     tersendiri di task ini (tax_rates/tax_types per Database_Schema.md
 *     §21-22 BELUM diimplementasikan -- sama seperti implementasi existing,
 *     bukan regresi baru, dicatat sbg keterbatasan).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tax_reference_settings", (t) => {
    t.string("id").primary();
    t.integer("umkm_facility_years").notNullable().defaultTo(3);
    t.text("legal_form_note").notNullable().defaultTo("");
    t.string("vat_status").notNullable().defaultTo("kena_pajak");
    t.text("vat_description").notNullable().defaultTo("");
    t.text("vat_legal_basis").notNullable().defaultTo("");
    t.text("withholding_notes").notNullable().defaultTo("[]");
    t.text("general_notes").notNullable().defaultTo("[]");
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tax_reference_settings");
}
