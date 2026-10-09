import fs from "node:fs";
import knexLib from "knex";
import { systemDb } from "../system/index.js";
import companyKnexfile from "./knexfile.js";
import { resolveCompanyDbPath } from "./company-resolver.js";
import { checkDatabaseIntegrity } from "./db-integrity.js";

/**
 * Menyamakan skema SEMUA company.db yang sudah ada dengan migration
 * terbaru. Sebelumnya migration company.db hanya dijalankan saat
 * perusahaan DIBUAT, sehingga kolom baru tidak pernah sampai ke database
 * perusahaan yang dibuat versi lama. Dipanggil saat startup server.
 *
 * Aman untuk data: hanya berjalan bila ada migration tertunda, dan SEBELUM
 * mengubah apa pun file company.db disalin dulu:
 *   - `company.db.pre-upgrade` (satu salinan per versi skema, tidak menimpa
 *     salinan yang sudah ada) -- perilaku lama;
 *   - `company.db.pre-<migration pertama yang tertunda>` (mis. `.pre-C0014`),
 *     salinan khusus untuk migration yang akan dijalankan sekarang.
 * Multi-Branch: integritas (PRAGMA integrity_check + foreign_key_check)
 * diperiksa SEBELUM dan SESUDAH migrasi. Database yang sudah rusak tidak
 * dimigrasi; bila migrasi menimbulkan masalah integritas baru, file
 * dikembalikan dari salinan khusus tadi. Satu perusahaan gagal tidak
 * menghentikan perusahaan lain maupun server.
 */
export async function upgradeExistingCompanyDatabases(): Promise<void> {
  let slugs: string[];
  try {
    slugs = (await systemDb("companies_registry").select("slug")).map((r: { slug: string }) => r.slug);
  } catch {
    return;
  }
  for (const slug of slugs) {
    try {
      const dbPath = resolveCompanyDbPath(slug);
      if (!fs.existsSync(dbPath)) continue;
      let restoreFrom: string | null = null;
      const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
      try {
        const [, pending] = await db.migrate.list();
        if (pending.length === 0) continue;

        const before = await checkDatabaseIntegrity(db);
        if (!before.integrityOk) {
          console.error(`[company-upgrade] "${slug}": integrity_check GAGAL sebelum migrasi (${before.integrityMessages.slice(0, 3).join("; ")}) -- migrasi dilewati agar data tidak makin rusak.`);
          continue;
        }

        const legacyBackupPath = `${dbPath}.pre-upgrade`;
        if (!fs.existsSync(legacyBackupPath)) fs.copyFileSync(dbPath, legacyBackupPath);
        const firstPending = String((pending[0] as { file?: string; name?: string }).file ?? (pending[0] as { name?: string }).name ?? "unknown");
        const versionedBackupPath = `${dbPath}.pre-${firstPending.split("_")[0]}`;
        if (!fs.existsSync(versionedBackupPath)) fs.copyFileSync(dbPath, versionedBackupPath);

        await db.migrate.latest();

        const after = await checkDatabaseIntegrity(db);
        if (!after.integrityOk || after.foreignKeyViolations > before.foreignKeyViolations) {
          restoreFrom = versionedBackupPath;
          console.error(
            `[company-upgrade] "${slug}": pemeriksaan integritas SESUDAH migrasi gagal (integrity: ${after.integrityMessages.slice(0, 3).join("; ")}; pelanggaran FK ${before.foreignKeyViolations} -> ${after.foreignKeyViolations}). File akan dikembalikan dari ${versionedBackupPath}.`,
          );
        } else {
          console.log(`[company-upgrade] ${slug}: ${pending.length} migration diterapkan (integritas OK).`);
        }
      } finally {
        await db.destroy();
      }
      if (restoreFrom) fs.copyFileSync(restoreFrom, dbPath);
    } catch (err) {
      console.error(`[company-upgrade] GAGAL meng-upgrade "${slug}" -- dilewati, dicoba lagi saat startup berikutnya:`, err);
    }
  }
}
