import type { Knex } from "knex";

/** Hasil aturan deteksi transaksi tidak wajar -- murni informational,
 * TIDAK PERNAH otomatis memblokir transaksi apa pun (lihat
 * modules/anomaly/rules.ts). `reviewed_at`/`reviewed_by` diisi saat
 * Administrator sudah meninjau flag ini (bukan berarti "dihapus" --
 * riwayatnya tetap ada supaya track record anomali historis utuh). */
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
