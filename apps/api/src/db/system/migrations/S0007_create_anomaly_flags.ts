import type { Knex } from "knex";

/**
 * Hasil aturan deteksi anomali -- padanan System DB dari
 * db/master/migrations/0007_create_anomaly_flags.ts.
 *
 * KLASIFIKASI FINAL (TASK-DB-ARCH-002): SYSTEM DB, berdasarkan audit
 * pemanggilan NYATA di source code (bukan asumsi dari komentar/desain
 * aspirational):
 *
 *   - Satu-satunya call site `recordAnomaly()` saat ini ada di
 *     modules/administrator/routes.ts: (1) login Administrator di luar jam
 *     wajar, (2) setiap aksi "repair mode" Administrator -- keduanya event
 *     level-instalasi/maintenance, BUKAN alur accounting perusahaan klien.
 *   - Rule lain di modules/anomaly/rules.ts (amount_out_of_pattern,
 *     large_manual_entry, voided_transaction, unbalanced_account) adalah
 *     pure function yang SUDAH DISIAPKAN untuk dipakai modul jurnal/transaksi
 *     company-scoped nanti, TAPI belum ada satu pun call site nyata ke sana
 *     hari ini (dikonfirmasi lewat grep menyeluruh).
 *
 * Jika/ketika rule company-scoped tsb benar-benar mulai dipanggil dari
 * modules/journal atau modules/accounts di task mendatang, anomaly untuk
 * rule tsb perlu dicatat ke `company_audit_log`/tabel anomaly company-scoped
 * di company.db, BUKAN ke tabel ini -- dicatat sebagai risiko terbuka di
 * TASK-DB-ARCH-002 RESULT, bukan diselesaikan sekarang (scope task ini
 * hanya System DB foundation, tidak memindahkan/mengubah modul lain).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("anomaly_flags", (t) => {
    t.string("id").primary();
    t.string("rule_code").notNullable();
    t.string("severity").notNullable(); // 'low' | 'medium' | 'high'
    t.string("description").notNullable();
    t.string("entity_type");
    t.string("entity_id");
    t.timestamp("detected_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("reviewed_at");
    t.string("reviewed_by");
    t.index(["detected_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("anomaly_flags");
}
