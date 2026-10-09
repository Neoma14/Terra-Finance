import type { Knex } from "knex";

/**
 * Mapping akun <-> baris laporan -- padanan Company DB dari
 * db/master/migrations/0009_create_accounts_and_statement_lines.ts (bagian
 * `statement_line_accounts`). Ini tabel mapping/konfigurasi laporan murni
 * (bukan data transaksional/historis), jadi ON DELETE CASCADE di kedua FK
 * SESUAI & disengaja -- kebalikan dari aturan umum §18 instruksi (yang
 * utamanya menyasar data finansial transaksional: jurnal, akun, periode).
 * Menghapus satu baris mapping saat statement_line/account induknya
 * dihapus tidak menghilangkan riwayat apa pun, cuma konfigurasi tampilan
 * laporan.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("statement_line_accounts", (t) => {
    t.string("id").primary();
    t.string("statement_line_id").notNullable().references("id").inTable("statement_lines").onDelete("CASCADE");
    t.string("account_id").notNullable().references("id").inTable("accounts").onDelete("CASCADE");
    t.unique(["statement_line_id", "account_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("statement_line_accounts");
}
