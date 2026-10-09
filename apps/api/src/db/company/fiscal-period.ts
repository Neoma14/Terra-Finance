import { isValidIsoDate } from "../../lib/calendar-date.js";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";

/**
 * Fiscal period enforcement -- TASK-DB-ARCH-005 (ARCH-005, lihat
 * Architecture_Contract.md "Open Items"). Berlaku utk Company DB (skema
 * `periods` dari migration `C0004`), BUKAN shared-DB lama
 * (`modules/journal/posting.ts`, tidak disentuh task ini).
 *
 * Dasar aturan -- Accounting_Rules.md §12-14 (APPROVED MASTER):
 *   §13 LOCKED  : user TIDAK BISA membuat/edit/delete/reversal jurnal,
 *                 "kecuali memiliki permission khusus".
 *   §14 CLOSED  : TIDAK BOLEH menerima "transaksi normal", adjustment
 *                 "harus melalui prosedur khusus".
 *
 * Baik LOCKED maupun CLOSED memblokir CREATE *dan* POST secara setara --
 * ini BUKAN asumsi, melainkan pembacaan literal §13/§14 (create termasuk
 * di larangan LOCKED, dan §14 tidak membedakan create vs post utk
 * "transaksi normal"). Klausa pengecualian ("permission khusus"/"prosedur
 * khusus") pada KEDUANYA **belum diimplementasikan** di sini -- RBAC
 * granular belum ada di codebase manapun (gap independen, lihat
 * Architecture_Contract.md "Security" & "Open Items"). Jadi saat ini fungsi
 * di bawah TIDAK PUNYA bypass sama sekali; menambah bypass tanpa sistem
 * permission yang sungguhan akan jadi lubang keamanan, bukan fitur.
 */

export type PeriodStatus = "OPEN" | "LOCKED" | "CLOSED";

export interface PeriodRow {
  id: string;
  label: string;
  status: PeriodStatus;
}

export class FiscalPeriodNotFoundError extends Error {
  readonly code = "FISCAL_PERIOD_NOT_FOUND" as const;
}

export class FiscalPeriodClosedError extends Error {
  readonly code = "FISCAL_PERIOD_CLOSED" as const;
}

export class FiscalPeriodLockedError extends Error {
  readonly code = "FISCAL_PERIOD_LOCKED" as const;
}

/** Load periode dari Company DB yang SEDANG AKTIF (parameter `db`/`trx`
 * eksplisit -- tidak pernah ada lookup global lintas company, lihat
 * Architecture_Contract.md "Isolation"). */
export async function loadPeriodOrThrow(db: Knex, periodId: string): Promise<PeriodRow> {
  const period = await db("periods").where({ id: periodId }).first();
  if (!period) {
    throw new FiscalPeriodNotFoundError(`Periode akuntansi dengan id "${periodId}" tidak ditemukan.`);
  }
  return period as PeriodRow;
}

/**
 * Satu-satunya tempat aturan "period harus OPEN" ditegakkan -- dipanggil
 * dari createDraftJournalEntry, postJournalEntry, DAN reverseJournalEntry
 * (journal-service.ts) supaya tidak ada jalur bypass lewat salah satu dari
 * ketiganya (§9 "Defense in Depth": tidak boleh ada bypass lewat
 * route/service lain).
 */
export function assertPeriodIsWritable(period: PeriodRow): void {
  if (period.status === "CLOSED") {
    throw new FiscalPeriodClosedError(
      `Jurnal tidak dapat diproses karena periode akuntansi "${period.label}" sudah ditutup (CLOSED).`,
    );
  }
  if (period.status === "LOCKED") {
    throw new FiscalPeriodLockedError(
      `Jurnal tidak dapat diproses karena periode akuntansi "${period.label}" sedang dikunci (LOCKED).`,
    );
  }
}

/**
 * TASK-023 hotfix -- GAP NYATA ditemukan saat user mencoba import jurnal
 * historis (Jan 2023 s/d Sep 2026) ke company BARU: seluruh 3813 transaksi
 * gagal validasi dgn "Periode akuntansi untuk tanggal X belum ada", krn
 * TIDAK ADA satu pun jalur di seluruh arsitektur company-db (ADR-001) utk
 * MEMBUAT periode -- `company-provisioning.ts` tidak pernah seed periode,
 * `modules/periods/routes.ts` (legacy) & `company-periods/routes.ts`
 * (baru) sama-sama cuma py list/close/lock, TIDAK PERNAH py create.
 * Satu-satunya company yang py periode adalah company yang DIMIGRASI dari
 * legacy (`legacy-company-migration.ts`, nyalin periode lama apa adanya).
 * Komentar TASK-DB-ARCH-014 eksplisit menyebut "periode dibuat eksplisit
 * lewat Period Lifecycle API (TASK-DB-ARCH-011)" sbg desain yang
 * dimaksud -- API itu ternyata tidak pernah benar-benar dibangun.
 * Diperbaiki di sini (bukan di luar scope TASK-023, krn ini LANGSUNG
 * menghalangi "Data Awal" & "Buku" berfungsi nyata).
 */
export class PeriodDateRangeInvalidError extends Error {
  readonly code = "PERIOD_DATE_RANGE_INVALID" as const;
}
export class PeriodOverlapError extends Error {
  readonly code = "PERIOD_OVERLAP" as const;
}
export class PeriodLabelRequiredError extends Error {
  readonly code = "PERIOD_LABEL_REQUIRED" as const;
}

export interface CreatePeriodInput {
  label: string;
  startDate: string;
  endDate: string;
  periodType: "month" | "quarter" | "year";
  fiscalYear: number;
}

/** Satu periode tidak boleh overlap dgn periode lain yang sudah ada --
 * unique constraint DB hanya di `label` (C0004), jadi tanggal yang
 * tumpang-tindih TIDAK dicegah DB-level. Kalau dibiarkan, dua periode
 * bisa mengklaim tanggal yang sama & `resolvePeriodForDate` (journal-
 * import-service.ts, pilih periode terbaru via orderBy start_date desc)
 * akan memilih salah satu secara implisit -- bukan korup data, tapi
 * ambigu & membingungkan, dicegah di sini drpd dibiarkan. */
async function assertNoOverlap(db: Knex, startDate: string, endDate: string, excludePeriodId?: string): Promise<void> {
  let query = db("periods").where("start_date", "<=", endDate).andWhere("end_date", ">=", startDate);
  if (excludePeriodId) query = query.andWhereNot({ id: excludePeriodId });
  const overlapping = await query.first();
  if (overlapping) {
    throw new PeriodOverlapError(
      `Rentang tanggal ${startDate} s/d ${endDate} tumpang tindih dengan periode "${overlapping.label}" (${overlapping.start_date} s/d ${overlapping.end_date}).`,
    );
  }
}

export async function createPeriod(db: Knex, input: CreatePeriodInput, actor: ActorContext): Promise<{ id: string }> {
  const label = input.label.trim();
  if (!label) throw new PeriodLabelRequiredError("Label periode tidak boleh kosong.");
  if (!isValidIsoDate(input.startDate) || !isValidIsoDate(input.endDate)) {
    throw new PeriodDateRangeInvalidError("Tanggal periode harus tanggal kalender yang valid (YYYY-MM-DD).");
  }
  if (input.startDate > input.endDate) {
    throw new PeriodDateRangeInvalidError("Tanggal mulai periode tidak boleh setelah tanggal selesai.");
  }
  await assertNoOverlap(db, input.startDate, input.endDate);

  const id = crypto.randomUUID();
  await db.transaction(async (trx) => {
    await trx("periods").insert({
      id,
      label,
      start_date: input.startDate,
      end_date: input.endDate,
      period_type: input.periodType,
      fiscal_year: input.fiscalYear,
      status: "OPEN",
    });
    await appendCompanyAudit(trx, {
      actor,
      action: "period.create",
      entityType: "period",
      entityId: id,
      after: { label, startDate: input.startDate, endDate: input.endDate, periodType: input.periodType, fiscalYear: input.fiscalYear },
    });
  });
  return { id };
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("id-ID", { month: "short", year: "numeric", timeZone: "UTC" });
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

export interface GenerateMonthlyPeriodsResult {
  created: number;
  skipped: number;
  skippedReasons: string[];
}

/** Buat SATU periode bulanan utk tiap bulan dalam rentang [fromDate,
 * toDate] inklusif -- idempotent: bulan yang sudah py periode (overlap)
 * DILEWATI (dicatat di `skippedReasons`), bukan error yang menggagalkan
 * seluruh batch. Dipakai "Data Awal" utk memudahkan setup periode
 * historis bertahun-tahun sekaligus (dibanding bikin satu-satu lewat
 * `createPeriod`), BUKAN logic akuntansi baru -- cuma wrapper pembuatan
 * periode berulang. */
export async function generateMonthlyPeriods(db: Knex, fromDate: string, toDate: string, actor: ActorContext): Promise<GenerateMonthlyPeriodsResult> {
  if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate)) throw new PeriodDateRangeInvalidError("Tanggal periode harus tanggal kalender yang valid (YYYY-MM-DD).");
  if (fromDate > toDate) throw new PeriodDateRangeInvalidError("Tanggal mulai tidak boleh setelah tanggal selesai.");

  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  let created = 0;
  let skipped = 0;
  const skippedReasons: string[] = [];

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor.getTime() <= end.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const monthEnd = lastDayOfMonth(year, month);

    try {
      await createPeriod(db, { label: monthLabel(year, month), startDate: monthStart, endDate: monthEnd, periodType: "month", fiscalYear: year }, actor);
      created++;
    } catch (err) {
      skipped++;
      skippedReasons.push(`${monthLabel(year, month)}: ${(err as Error).message}`);
    }

    cursor = new Date(Date.UTC(year, month + 1, 1));
  }

  return { created, skipped, skippedReasons };
}
