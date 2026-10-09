import type { Knex } from "knex";

/**
 * Dua kolom kebijakan, keduanya ADITIF (tidak mengubah/menghapus data lama):
 *
 *   - `company_profile.max_backdate_days` -- batas mundur tanggal jurnal
 *     baru, diatur OWNER/ADMIN. NULL = tidak ada batas mundur (perilaku
 *     lama dipertahankan sampai pemilik perusahaan menetapkan angka).
 *     Tanggal MASA DEPAN selalu ditolak, apa pun nilainya.
 *   - `accounts.is_locked` (+ `locked_at`, `locked_by`) -- akun terkunci
 *     tidak boleh dipakai jurnal baru (dicek di service, bukan di UI).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("company_profile", (t) => {
    t.integer("max_backdate_days");
  });
  await knex.schema.alterTable("accounts", (t) => {
    t.boolean("is_locked").notNullable().defaultTo(false);
    t.timestamp("locked_at");
    t.string("locked_by");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("accounts", (t) => {
    t.dropColumn("locked_by");
    t.dropColumn("locked_at");
    t.dropColumn("is_locked");
  });
  await knex.schema.alterTable("company_profile", (t) => {
    t.dropColumn("max_backdate_days");
  });
}
