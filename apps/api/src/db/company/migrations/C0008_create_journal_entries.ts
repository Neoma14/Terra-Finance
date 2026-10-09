import type { Knex } from "knex";

/**
 * Header jurnal -- padanan Company DB dari
 * db/master/migrations/0010_create_periods_journal_ledger.ts (bagian
 * `journal_entries`), MENUTUP GAP yang ditemukan audit TASK-DB-ARCH-001
 * (nol kolom status/is_opening_balance/posted_by/posted_at/reversal_reason
 * di implementasi shared-DB lama -- lihat Accounting_Rules.md §7-10,
 * Database_Schema.md §14):
 *
 *   - `status` (CHECK IN ('DRAFT','POSTED','REVERSED','VOID'),
 *     Accounting_Rules.md §7 -- 4 state, BUKAN 3 seperti contoh generik di
 *     instruksi task; dokumen yang approved diikuti, sesuai arahan
 *     instruksi "if the existing documentation defines another state
 *     model, follow the documentation instead").
 *   - `is_opening_balance` (Accounting_Rules.md §15) -- field skema saja;
 *     TIDAK ada logic auto-plug ke equity di task ini (§15 instruksi:
 *     jangan implementasikan workflow kalkulasi saldo awal, jangan
 *     auto-plug selisih).
 *   - `posted_by`, `posted_at` (Database_Schema.md §14) -- membedakan
 *     SIAPA/KAPAN create vs post (sebelumnya disatukan, tidak bisa
 *     dibedakan).
 *   - `reversal_of_journal_id` (nama lebih jelas drpd `reversal_of_id` lama,
 *     disarankan instruksi §16) + `reversal_reason` (Accounting_Rules.md
 *     §10 item 5, sebelumnya TIDAK PERNAH diminta/disimpan sama sekali).
 *
 * TIDAK ADA `company_id` (ADR-001 §8). Unique key `(reference_no)` saja.
 *
 * FK `period_id` -> RESTRICT (§18 instruksi: periode yang masih direferensi
 * jurnal tidak boleh terhapus diam-diam). FK self-ref
 * `reversal_of_journal_id` -> RESTRICT (jurnal asli tidak boleh hilang
 * selama ada reversal yang menunjuknya).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("journal_entries", (t) => {
    t.string("id").primary();
    t.date("entry_date").notNullable();
    t.string("period_id").notNullable().references("id").inTable("periods").onDelete("RESTRICT");
    t.string("reference_no");
    t.string("description");
    t.string("source").notNullable().defaultTo("manual").checkIn(["manual", "import"]);
    t.string("status").notNullable().defaultTo("DRAFT").checkIn(["DRAFT", "POSTED", "REVERSED", "VOID"]);
    t.boolean("is_opening_balance").notNullable().defaultTo(false);
    t.string("created_by");
    t.string("posted_by");
    t.timestamp("posted_at");
    t.string("reversal_of_journal_id").references("id").inTable("journal_entries").onDelete("RESTRICT");
    t.boolean("is_reversed").notNullable().defaultTo(false);
    t.text("reversal_reason");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["reference_no"]);
    t.index(["period_id"]);
    t.index(["status"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("journal_entries");
}
