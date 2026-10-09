import type { Knex } from "knex";

/**
 * Referensi pajak per perusahaan (perlakuan PPN, kewajiban pemotongan,
 * catatan umum) -- sama persis logikanya dgn `tax_reference_settings`
 * versi online (satu baris per tenant schema), BEDA: satu baris per
 * `company_id` di SQLite (bukan satu tenant schema = satu baris implisit).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tax_reference_settings", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().unique().references("id").inTable("companies");
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
