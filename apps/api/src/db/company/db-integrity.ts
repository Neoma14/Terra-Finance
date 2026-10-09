import type { Knex } from "knex";

/**
 * Pemeriksaan integritas SQLite (PRAGMA integrity_check + foreign_key_check).
 * Dipakai upgrade company.db sebelum/sesudah migrasi (company-upgrade.ts) dan
 * oleh skrip verifikasi migrasi.
 */
export interface DatabaseIntegrityResult {
  /** `integrity_check` mengembalikan tepat "ok". */
  integrityOk: boolean;
  integrityMessages: string[];
  /** Jumlah pelanggaran foreign key (0 = bersih). */
  foreignKeyViolations: number;
}

export async function checkDatabaseIntegrity(db: Knex): Promise<DatabaseIntegrityResult> {
  const integrity = (await db.raw("PRAGMA integrity_check")) as Array<Record<string, string>>;
  const messages = integrity.map((r) => String(Object.values(r)[0]));
  const fk = (await db.raw("PRAGMA foreign_key_check")) as unknown[];
  return {
    integrityOk: messages.length === 1 && messages[0] === "ok",
    integrityMessages: messages,
    foreignKeyViolations: fk.length,
  };
}
