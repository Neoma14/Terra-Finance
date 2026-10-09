import type { Knex } from "knex";

/**
 * Baris laporan (Neraca/Laba-Rugi) -- padanan Company DB dari
 * db/master/migrations/0009_create_accounts_and_statement_lines.ts (bagian
 * `statement_lines`). TIDAK ADA `company_id` (ADR-001 §8), unique key
 * `(statement_type, line_code)` saja.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("statement_lines", (t) => {
    t.string("id").primary();
    t.string("statement_type").notNullable(); // 'balance_sheet' | 'income_statement' | 'cash_flow'
    t.string("line_code").notNullable();
    t.string("line_label").notNullable();
    t.integer("display_order").notNullable().defaultTo(0);
    t.string("parent_line_id").references("id").inTable("statement_lines").onDelete("RESTRICT");
    t.unique(["statement_type", "line_code"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("statement_lines");
}
