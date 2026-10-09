import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { loadPeriodOrThrow, type PeriodStatus } from "./fiscal-period.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { countPendingInterBranchInRange } from "./inter-branch-lifecycle.js";
import type { Knex } from "knex";

/**
 * Period Closing (TASK-DB-ARCH-011 Part B §34-35). Status existing
 * `periods.status` (`OPEN|LOCKED|CLOSED`, `fiscal-period.ts`, TIDAK
 * diubah) -- file ini HANYA menambah state-transition service
 * (`lockPeriod`/`closePeriod`) + validasi sebelum CLOSED. Enforcement
 * "journal tidak bisa dibuat/post pada LOCKED/CLOSED" TETAP sepenuhnya di
 * `assertPeriodIsWritable` (TASK-DB-ARCH-005), tidak diduplikasi di sini.
 */

export class InvalidPeriodTransitionError extends Error {
  readonly code = "INVALID_PERIOD_TRANSITION" as const;
}

export class PeriodNotReadyToCloseError extends Error {
  readonly code = "PERIOD_NOT_READY_TO_CLOSE" as const;
  constructor(message: string, public readonly issues: string[]) {
    super(message);
  }
}

const TRANSITIONS: Record<PeriodStatus, PeriodStatus | null> = {
  OPEN: "LOCKED",
  LOCKED: "CLOSED",
  CLOSED: null,
};

export interface PeriodClosingValidation {
  canClose: boolean;
  issues: string[];
}

/** §35: cek SEBELUM CLOSED -- tidak ada jurnal DRAFT tersisa di periode
 * ini, DAN trial balance periode ini balance. TIDAK mengklaim "CLOSED
 * berarti semua data pasti benar" (§35) -- hanya dua pemeriksaan ini,
 * dilaporkan eksplisit sbg `issues`, bukan disembunyikan sbg "pasti aman". */
export async function validatePeriodForClosing(db: Knex, periodId: string): Promise<PeriodClosingValidation> {
  const issues: string[] = [];

  const draftCount = await db("journal_entries").where({ period_id: periodId, status: "DRAFT" }).count("* as c").first();
  if (Number((draftCount as any)?.c ?? 0) > 0) {
    issues.push(`Masih ada ${(draftCount as any).c} jurnal berstatus DRAFT pada periode ini -- post, void, atau hapus terlebih dahulu.`);
  }

  const range = await db("periods").where({ id: periodId }).first("start_date", "end_date");
  const pendingInterBranch = range ? await countPendingInterBranchInRange(db, String(range.start_date), String(range.end_date)) : 0;
  if (pendingInterBranch > 0) {
    issues.push(`Masih ada ${pendingInterBranch} transaksi/pembalikan antar-cabang yang menunggu persetujuan pada periode ini -- setujui, tolak, atau batalkan terlebih dahulu.`);
  }

  const trialBalance = await getTrialBalance(db, periodId);
  if (!trialBalance.isBalanced) {
    issues.push(`Trial balance periode ini tidak balance (selisih ${trialBalance.difference}).`);
  }

  return { canClose: issues.length === 0, issues };
}

async function transitionPeriod(db: Knex, periodId: string, toStatus: PeriodStatus, action: string, actor: ActorContext): Promise<void> {
  await db.transaction(async (trx) => {
    const period = await loadPeriodOrThrow(trx, periodId);
    const expectedNext = TRANSITIONS[period.status];
    if (expectedNext !== toStatus) {
      throw new InvalidPeriodTransitionError(
        `Periode "${period.label}" berstatus ${period.status}, tidak dapat bertransisi langsung ke ${toStatus}.`,
      );
    }

    await trx("periods")
      .where({ id: periodId })
      .update({ status: toStatus, closed_at: toStatus === "CLOSED" ? new Date().toISOString() : null, closed_by: toStatus === "CLOSED" ? actor.actorId ?? null : null });

    await appendCompanyAudit(trx, {
      actor,
      action,
      entityType: "period",
      entityId: periodId,
      before: { status: period.status },
      after: { status: toStatus },
    });
  });
}

/** OPEN -> LOCKED. Tidak butuh validasi trial-balance (itu syarat CLOSED,
 * §35), tapi tetap lewat `transitionPeriod` supaya audit & guard urutan
 * status konsisten. */
export async function lockPeriod(db: Knex, periodId: string, actor: ActorContext): Promise<void> {
  await transitionPeriod(db, periodId, "LOCKED", "period.lock", actor);
}

/** LOCKED -> CLOSED, WAJIB lolos `validatePeriodForClosing` dulu -- kalau
 * tidak, REJECT (§35: "jangan menganggap CLOSED otomatis berarti semua
 * accounting data benar" -- jadi javascript-level, closePeriod sendiri
 * MEMAKSA validasi lolos sebelum transisi, bukan percaya begitu saja). */
export async function closePeriod(db: Knex, periodId: string, actor: ActorContext): Promise<void> {
  const validation = await validatePeriodForClosing(db, periodId);
  if (!validation.canClose) {
    throw new PeriodNotReadyToCloseError("Periode belum dapat ditutup -- lihat daftar masalah.", validation.issues);
  }
  await transitionPeriod(db, periodId, "CLOSED", "period.close", actor);
}
