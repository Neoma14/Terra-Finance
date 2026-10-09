import path from "node:path";
import type { Knex } from "knex";

/**
 * Antrean tulis per company.db di dalam proses (Inter-Branch, F-1).
 *
 * Setiap request membuka koneksi knex sendiri ke file yang sama. `better-sqlite3` bersifat sinkron: bila dua
 * transaksi tulis dari dua koneksi berjalan bersamaan, koneksi kedua menunggu kunci dengan memblokir event loop yang
 * sama, sehingga yang pertama tak sempat commit dan keduanya tertahan sampai batas waktu (`SQLITE_BUSY`, ±5 dtk).
 * Dengan menyerialkan aksi tulis Inter-Branch per file, yang kalah tidak pernah menyentuh kunci database: ia menunggu
 * giliran, lalu melihat keadaan akhir dan ditolak bersih oleh klaim bersyarat status (409), tanpa posting ganda.
 *
 * Hanya melindungi satu proses (cukup untuk desktop satu-pengguna); penjaga kebenarannya tetap klaim bersyarat status
 * dan UNIQUE di database, bukan antrean ini.
 */

const tails = new Map<string, Promise<unknown>>();

export function companyDbKey(db: Knex): string {
  const connection = db.client.config?.connection as { filename?: string } | undefined;
  return path.resolve(connection?.filename ?? "default").toLowerCase();
}

export function runExclusive<T>(db: Knex, task: () => Promise<T>): Promise<T> {
  const key = companyDbKey(db);
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, settled);
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return result;
}

/** `SQLITE_BUSY` berarti transaksi tidak dimulai/di-rollback; aksi aman diulang karena klaim status dan kunci idempotensi mencegah efek ganda. */
export function isSqliteBusy(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "SQLITE_BUSY";
}
