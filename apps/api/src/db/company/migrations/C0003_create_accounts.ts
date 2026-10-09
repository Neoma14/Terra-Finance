import type { Knex } from "knex";

/**
 * Chart of Accounts -- padanan Company DB dari
 * db/master/migrations/0009_create_accounts_and_statement_lines.ts (bagian
 * `accounts`), DENGAN PERUBAHAN:
 *   - TIDAK ADA kolom `company_id` (ADR-001 §8 -- file ini sendiri SATU
 *     perusahaan). Unique key jadi `(code)` saja, bukan `(company_id, code)`.
 *   - `account_type_id` FK -> account_types (C0002) menggantikan kolom
 *     string `account_type` lama -- normalisasi sesuai §10.
 *   - `normal_balance` TETAP ada langsung di baris akun (bukan hanya
 *     diturunkan dari account_types) -- field eksplisit di
 *     Accounting_Rules.md §5, memungkinkan override per-akun bila
 *     benar-benar diperlukan di masa depan (tidak dipakai utk override hari
 *     ini, hanya skema yang disiapkan).
 *   - `is_system_account` (Accounting_Rules.md §5) BARU -- melindungi akun
 *     yang dibuat sistem sendiri (mis. akun penyeimbang saldo awal) dari
 *     edit/hapus sembarangan oleh user; belum ada enforcement-nya di task
 *     ini (hanya kolom skema, bukan service logic).
 *   - `updated_at` (Accounting_Rules.md §5) BARU -- sebelumnya hanya
 *     created_at.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("accounts", (t) => {
    t.string("id").primary();
    t.string("code").notNullable();
    t.string("name").notNullable();
    t.string("account_type_id").notNullable().references("id").inTable("account_types").onDelete("RESTRICT");
    t.string("account_subtype"); // mis. 'equity_retained', 'opening_balance_adjustment' -- dipakai posting.ts
    t.string("normal_balance").notNullable(); // 'debit' | 'credit'
    t.string("parent_account_id").references("id").inTable("accounts").onDelete("RESTRICT");
    t.boolean("is_active").notNullable().defaultTo(true);
    t.boolean("is_system_account").notNullable().defaultTo(false);
    t.string("cash_flow_activity"); // 'operating' | 'investing' | 'financing' | null
    t.boolean("is_cash").notNullable().defaultTo(false);
    t.string("subledger_type"); // 'payable' | 'receivable' | null
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["code"]);
    t.index(["account_type_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("accounts");
}
