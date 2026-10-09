import type { Knex } from "knex";

/**
 * Master vendor/pelanggan -- padanan Company DB dari
 * db/master/migrations/0010_create_periods_journal_ledger.ts (bagian
 * `counterparties`). TIDAK ADA `company_id` (ADR-001 §8), unique key
 * `(type, code)` saja.
 *
 * Field tambahan AR/AP (phone/email/address/credit_limit/payment_terms/
 * opening_balance, Database_Schema.md §16-17) SENGAJA TIDAK ditambahkan di
 * task ini -- di luar scope "accounting schema yang sudah disetujui saat
 * ini" (instruksi §7/§31 melarang memperluas modul AR/AP melampaui skema
 * yang sudah ada). Dicatat sbg keterbatasan yang diketahui, bukan gap baru.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("counterparties", (t) => {
    t.string("id").primary();
    t.string("type").notNullable().checkIn(["vendor", "customer"]);
    t.string("code").notNullable();
    t.string("name").notNullable();
    t.boolean("is_active").notNullable().defaultTo(true);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["type", "code"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("counterparties");
}
