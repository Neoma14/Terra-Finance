import type { Knex } from "knex";

/**
 * Cache/snapshot neraca saldo per periode per akun -- padanan Company DB
 * dari db/master/migrations/0010_create_periods_journal_ledger.ts (bagian
 * `trial_balance_snapshots`). Tidak perlu `company_id` -- scoped transitif
 * lewat `period_id`/`account_id`.
 *
 * PENTING (instruksi §19): tabel ini adalah GENERATED SNAPSHOT/CACHE utk
 * mempercepat pembacaan laporan, BUKAN source of truth. Source of truth
 * tetap:
 *
 *   POSTED JOURNALS -> GENERAL LEDGER -> TRIAL BALANCE -> REPORTING
 *
 * (Accounting_Rules.md §36, Database_Schema.md §38). Baris di tabel ini
 * HARUS selalu dapat dihitung ulang dari `journal_entries`+
 * `journal_entry_lines` yang berstatus POSTED -- kalau pernah berbeda,
 * itu adalah ACCOUNTING INCONSISTENCY (Accounting_Rules.md §34), bukan
 * sumber kebenaran yang "dipercaya begitu saja".
 *
 * FK `period_id`/`account_id` -> RESTRICT (§18: snapshot tidak boleh
 * menggantung ke periode/akun yang sudah dihapus diam-diam).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("trial_balance_snapshots", (t) => {
    t.string("id").primary();
    t.string("period_id").notNullable().references("id").inTable("periods").onDelete("RESTRICT");
    t.string("account_id").notNullable().references("id").inTable("accounts").onDelete("RESTRICT");
    t.decimal("beginning_balance", 18, 2).notNullable().defaultTo(0);
    t.decimal("debit_total", 18, 2).notNullable().defaultTo(0);
    t.decimal("credit_total", 18, 2).notNullable().defaultTo(0);
    t.decimal("ending_balance", 18, 2).notNullable().defaultTo(0);
    t.unique(["period_id", "account_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("trial_balance_snapshots");
}
