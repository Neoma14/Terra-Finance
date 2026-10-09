import type { Knex } from "knex";

/**
 * Identitas firm konsultan ITU SENDIRI (padanan System DB dari
 * db/master/migrations/0002_create_company_profile.ts) -- BUKAN data
 * perusahaan klien. Satu instalasi = satu konsultan/firm = SATU baris di
 * sini, diisi lewat wizard setup awal (first-run).
 *
 * CATATAN AUDIT: tabel ini TIDAK tercantum eksplisit di daftar "SYSTEM DB
 * TARGET" pada instruksi TASK-DB-ARCH-002, tapi SUDAH didokumentasikan
 * sebagai System DB di System_DB_Schema.md §2 (disetujui pada task
 * sebelumnya). Tetap diimplementasikan di sini -- mengecualikannya akan
 * membuat identitas firm konsultan sendiri (dipakai nyata, lihat hasil
 * audit read-only: 1 baris terisi di terra-finance.sqlite existing) tidak
 * punya target database sama sekali, yang merupakan gap fondasi, bukan
 * penambahan field "karena terlihat berguna". Dilaporkan sebagai keputusan
 * eksplisit di TASK-DB-ARCH-002 RESULT, bukan asumsi diam-diam.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("company_profile", (t) => {
    t.string("id").primary();
    t.string("name").notNullable();
    t.string("industry");
    t.text("logo_data_uri");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("company_profile");
}
