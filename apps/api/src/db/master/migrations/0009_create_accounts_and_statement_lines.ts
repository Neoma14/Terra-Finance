import type { Knex } from "knex";

/**
 * Chart of Accounts + baris laporan (Neraca/Laba-Rugi) -- struktur kolom
 * SENGAJA disamakan persis dgn tabel `accounts`/`statement_lines`/
 * `statement_line_accounts` di tenant schema versi online (lihat
 * db/tenant/migrations/0001, 0006, 0008 & 0005_create_statement_lines.ts),
 * BEDA: semua tabel di sini punya kolom `company_id` (satu file SQLite
 * dibagi per perusahaan lewat kolom, bukan schema Postgres terpisah), dan
 * unique constraint kode akun jadi (company_id, code) bukan cuma (code).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("accounts", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies").onDelete("CASCADE");
    t.string("code").notNullable();
    t.string("name").notNullable();
    t.string("account_type").notNullable(); // asset|liability|equity|revenue|expense
    t.string("account_subtype");
    t.string("normal_balance").notNullable(); // debit|credit
    t.string("parent_account_id").references("id").inTable("accounts");
    t.boolean("is_active").notNullable().defaultTo(true);
    t.string("cash_flow_activity"); // operating|investing|financing|null
    t.boolean("is_cash").notNullable().defaultTo(false);
    t.string("subledger_type"); // payable|receivable|null
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["company_id", "code"]);
  });

  await knex.schema.createTable("statement_lines", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies").onDelete("CASCADE");
    t.string("statement_type").notNullable(); // balance_sheet|income_statement|cash_flow
    t.string("line_code").notNullable();
    t.string("line_label").notNullable();
    t.integer("display_order").notNullable().defaultTo(0);
    t.string("parent_line_id").references("id").inTable("statement_lines");
    t.unique(["company_id", "statement_type", "line_code"]);
  });

  await knex.schema.createTable("statement_line_accounts", (t) => {
    t.string("id").primary();
    t.string("statement_line_id").notNullable().references("id").inTable("statement_lines").onDelete("CASCADE");
    t.string("account_id").notNullable().references("id").inTable("accounts").onDelete("CASCADE");
    t.unique(["statement_line_id", "account_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("statement_line_accounts");
  await knex.schema.dropTableIfExists("statement_lines");
  await knex.schema.dropTableIfExists("accounts");
}
