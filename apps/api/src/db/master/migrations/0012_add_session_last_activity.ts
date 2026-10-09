import type { Knex } from "knex";

/**
 * Auto-logout idle (15 menit): sesi mencatat aktivitas pengguna terakhir.
 * Sesi yang sudah ada diberi nilai "sekarang" supaya tidak langsung
 * kedaluwarsa saat aplikasi di-upgrade.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("sessions", (t) => {
    t.string("last_activity_at");
  });
  await knex("sessions").update({ last_activity_at: new Date().toISOString() });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("sessions", (t) => {
    t.dropColumn("last_activity_at");
  });
}
