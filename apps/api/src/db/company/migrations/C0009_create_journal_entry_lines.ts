import type { Knex } from "knex";

/**
 * Baris jurnal -- padanan Company DB dari
 * db/master/migrations/0010_create_periods_journal_ledger.ts (bagian
 * `journal_entry_lines`). Tidak perlu `company_id` sendiri -- sudah scoped
 * transitif lewat `journal_entry_id` (yang filenya sendiri sudah satu
 * perusahaan, ADR-001 §8).
 *
 * BARU: `line_order` (Database_Schema.md §15 "journal_lines") -- urutan
 * tampil baris yang stabil, sebelumnya tidak ada.
 *
 * CHECK constraint `chk_journal_entry_lines_debit_credit` (Accounting_Rules
 * §11: "Satu journal line tidak boleh memiliki Debit > 0 AND Credit > 0
 * dalam waktu yang sama", Database_Schema.md §15: "debit >= 0, credit >= 0")
 * -- menegakkan invarian struktural di level database, bukan trigger
 * (instruksi §17/§26 Test 11: hindari trigger kompleks kalau CHECK sudah
 * cukup).
 *
 * FK `account_id` -> RESTRICT, `counterparty_id` -> RESTRICT (§18: akun/
 * counterparty yang masih direferensi baris jurnal tidak boleh terhapus
 * diam-diam). FK `journal_entry_id` -> CASCADE -- SENGAJA berbeda dari akun/
 * periode: baris jurnal adalah ISI dari satu entry (bukan entitas historis
 * independen), menghapus entry induknya (kalaupun suatu saat diizinkan
 * lewat prosedur khusus) secara wajar ikut menghapus barisnya sendiri,
 * bukan "menghilangkan riwayat terpisah".
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("journal_entry_lines", (t) => {
    t.string("id").primary();
    t.string("journal_entry_id").notNullable().references("id").inTable("journal_entries").onDelete("CASCADE");
    t.string("account_id").notNullable().references("id").inTable("accounts").onDelete("RESTRICT");
    t.decimal("debit", 18, 2).notNullable().defaultTo(0);
    t.decimal("credit", 18, 2).notNullable().defaultTo(0);
    t.string("memo");
    t.string("counterparty_id").references("id").inTable("counterparties").onDelete("RESTRICT");
    t.integer("line_order").notNullable().defaultTo(0);
    t.index(["account_id"]);
    t.index(["journal_entry_id"]);
    t.check(
      "debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0)",
      {},
      "chk_journal_entry_lines_debit_credit",
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("journal_entry_lines");
}
