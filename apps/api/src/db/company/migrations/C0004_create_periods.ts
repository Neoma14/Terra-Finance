import type { Knex } from "knex";

/**
 * Periode akuntansi -- padanan Company DB dari
 * db/master/migrations/0010_create_periods_journal_ledger.ts (bagian
 * `periods`), DENGAN PERUBAHAN:
 *   - TIDAK ADA `company_id` (ADR-001 §8). Unique key `(label)` saja.
 *   - `status` (CHECK IN ('OPEN','LOCKED','CLOSED')) menggantikan
 *     `is_closed` boolean lama -- menutup gap audit TASK-DB-ARCH-001:
 *     Database_Schema.md §11 & Accounting_Rules.md §12-14 mewajibkan 3
 *     state, bukan 2. Field skema saja di task ini -- enforcement "period
 *     closed tidak boleh menerima jurnal baru" adalah tanggung jawab
 *     service layer (posting.ts) di task MENDATANG, TIDAK diimplementasikan
 *     di sini (§12 instruksi: "do not implement the full posting service").
 *   - `closed_at`, `closed_by` (Database_Schema.md §11) BARU.
 *   - `created_at` (Database_Schema.md §11) BARU -- sebelumnya tidak ada.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("periods", (t) => {
    t.string("id").primary();
    t.string("label").notNullable();
    t.date("start_date").notNullable();
    t.date("end_date").notNullable();
    t.string("period_type").notNullable(); // 'month' | 'quarter' | 'year'
    t.integer("fiscal_year").notNullable();
    t.string("status").notNullable().defaultTo("OPEN").checkIn(["OPEN", "LOCKED", "CLOSED"]);
    t.timestamp("closed_at");
    t.string("closed_by");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["label"]);
    t.index(["end_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("periods");
}
