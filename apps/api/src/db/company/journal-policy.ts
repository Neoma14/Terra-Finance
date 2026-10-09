import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { JournalInvalidDateError } from "./journal-errors.js";
import { CompanyProfileNotFoundError } from "./company-profile-service.js";

/**
 * Kebijakan tanggal jurnal BARU (permintaan klien):
 *
 *  1. Tanggal jurnal TIDAK PERNAH boleh lebih besar dari hari ini.
 *  2. Pemilik perusahaan dapat menetapkan batas mundur (`max_backdate_days`):
 *     tanggal jurnal minimal = hari ini - N hari. NULL = tanpa batas mundur.
 *  3. Jurnal saldo awal (is_opening_balance) dikecualikan dari batas MUNDUR
 *     (sifatnya memang tanggal awal pembukuan), tetapi tetap tidak boleh
 *     di masa depan.
 *
 * Dicek di service (dipakai create/edit/import/saldo awal), bukan di UI.
 * "Hari ini" = tanggal kalender lokal komputer yang menjalankan aplikasi.
 */

export class JournalFutureDateError extends JournalInvalidDateError {}
export class JournalBackdateLimitError extends JournalInvalidDateError {}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Tanggal kalender lokal (YYYY-MM-DD) -- bukan UTC, supaya "hari ini"
 * sama dengan yang dilihat pengguna. */
export function todayLocalDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function subtractDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export class JournalSettingsInvalidError extends Error {
  readonly code = "JOURNAL_SETTINGS_INVALID" as const;
}

export const MAX_BACKDATE_DAYS_LIMIT = 3650;

export async function getMaxBackdateDays(db: Knex): Promise<number | null> {
  const row = await db("company_profile").select("max_backdate_days as v").first();
  const v = row?.v;
  return v === null || v === undefined ? null : Number(v);
}

export async function getJournalSettings(db: Knex): Promise<{ maxBackdateDays: number | null; today: string; earliestAllowedDate: string | null }> {
  const maxBackdateDays = await getMaxBackdateDays(db);
  const today = todayLocalDate();
  return { maxBackdateDays, today, earliestAllowedDate: maxBackdateDays === null ? null : subtractDays(today, maxBackdateDays) };
}

export async function setMaxBackdateDays(db: Knex, days: number | null, actor: ActorContext): Promise<void> {
  if (days !== null && (!Number.isInteger(days) || days < 0 || days > MAX_BACKDATE_DAYS_LIMIT)) {
    throw new JournalSettingsInvalidError(`Maksimal backdate harus bilangan bulat 0 sampai ${MAX_BACKDATE_DAYS_LIMIT} hari, atau kosong untuk tanpa batas.`);
  }
  await db.transaction(async (trx) => {
    const profile = await trx("company_profile").first("id");
    if (!profile) throw new CompanyProfileNotFoundError("Profil perusahaan tidak ditemukan.");
    const before = await getMaxBackdateDays(trx);
    await trx("company_profile").where({ id: profile.id }).update({ max_backdate_days: days, updated_at: new Date().toISOString() });
    await appendCompanyAudit(trx, {
      actor,
      action: "journal_settings.change",
      entityType: "company_profile",
      entityId: "max_backdate_days",
      before: { maxBackdateDays: before },
      after: { maxBackdateDays: days },
    });
  });
}

/** `entryDate` HARUS sudah lolos validasi format kalender. */
export async function assertEntryDatePolicy(db: Knex, entryDate: string, opts: { isOpeningBalance?: boolean; today?: string } = {}): Promise<void> {
  const today = opts.today ?? todayLocalDate();
  if (entryDate > today) {
    throw new JournalFutureDateError(`Tanggal jurnal ${entryDate} tidak boleh lebih besar dari hari ini (${today}).`);
  }
  if (opts.isOpeningBalance) return;
  const maxDays = await getMaxBackdateDays(db);
  if (maxDays === null) return;
  const earliest = subtractDays(today, maxDays);
  if (entryDate < earliest) {
    throw new JournalBackdateLimitError(
      `Tanggal jurnal ${entryDate} melewati batas backdate (${maxDays} hari). Tanggal paling lama yang diizinkan: ${earliest}.`,
    );
  }
}
