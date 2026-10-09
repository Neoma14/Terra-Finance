import type { Knex } from "knex";

/**
 * SATU baris saja per instalasi. `instance_fingerprint` mengikat lisensi
 * ini ke MESIN ini secara spesifik (bukan cuma ke license_key) -- lihat
 * modules/license/service.ts utk cara fingerprint dihitung & kenapa ini
 * yang mencegah satu license_key dipakai ulang di instalasi lain tanpa
 * aktivasi baru.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("license", (t) => {
    t.string("id").primary();
    t.string("license_key").notNullable().unique();
    t.string("client_name").notNullable();
    t.string("instance_fingerprint").notNullable();
    t.timestamp("activated_at").notNullable().defaultTo(knex.fn.now());
    t.timestamp("expires_at"); // null = tidak ada masa berlaku
    t.string("status").notNullable().defaultTo("active"); // 'active' | 'expired' | 'locked'
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("license");
}
