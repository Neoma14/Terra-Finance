import { totalsEqual } from "../../lib/money.js";
import type { Knex } from "knex";
import { createDraftJournalEntry, postJournalEntry, deleteDraftJournalEntry, reverseJournalEntry } from "./journal-service.js";
import type { ActorContext } from "./company-audit.js";
import { getHeadOfficeBranch } from "./branch-service.js";

/**
 * Opening Balance / Saldo Awal (TASK-DB-ARCH-016). BUKAN accounting
 * engine baru -- "Opening Balance" di sini adalah ORKESTRASI TIPIS di
 * atas mekanisme yang SUDAH ADA sejak TASK-DB-ARCH-005/011:
 * `journal_entries.is_opening_balance` (flag skema, C0008) + parameter
 * `isOpeningBalance` yang `createDraftJournalEntry` SUDAH terima & SUDAH
 * tag audit-nya scr berbeda (`JOURNAL_AUDIT_ACTIONS.OPENING_BALANCE_CREATE`)
 * -- fitur ini SEBENARNYA SUDAH ADA SEBAGIAN, task ini hanya
 * mengekspos & mengintegrasikannya scr utuh (review §1 instruksi).
 *
 * Konsekuensi penting: SATU "opening balance" = SATU journal_entries row
 * (banyak baris/akun jadi banyak journal_entry_lines dari SATU entry yang
 * sama) -- bukan banyak entry terpisah. Entry ini mengalir ke
 * ledger-service.ts/trial-balance-service.ts/reporting TANPA PERUBAHAN
 * APA PUN di file-file itu, krn mereka sudah query `journal_entries`/
 * `journal_entry_lines` apa adanya (§18 instruksi, dibuktikan test
 * integration).
 *
 * §9 instruksi -- "satu opening balance per company": skema TIDAK punya
 * unique constraint utk ini (tidak ada kolom/index yang menjaganya di
 * level DB), jadi aturan "hanya satu yang AKTIF (DRAFT/POSTED) pada satu
 * waktu" ditegakkan DI SINI (service layer), BUKAN migration baru --
 * konsisten dgn instruksi "jangan database redesign besar utk task ini".
 * Entry yang REVERSED dianggap riwayat (bukan "yang aktif"), sehingga
 * user BISA membuat opening balance baru setelah reversal (siklus yang
 * sama persis dgn Journal: reversal, bukan edit/hapus, utk mengubah
 * sesuatu yang sudah POSTED -- §21 instruksi: "jangan membuat mekanisme
 * berbahaya", reuse apa adanya).
 */

export class OpeningBalanceAlreadyExistsError extends Error {
  readonly code = "OPENING_BALANCE_ALREADY_EXISTS" as const;
}
export class OpeningBalanceNotFoundError extends Error {
  readonly code = "OPENING_BALANCE_NOT_FOUND" as const;
}
export class OpeningBalanceDuplicateAccountError extends Error {
  readonly code = "OPENING_BALANCE_DUPLICATE_ACCOUNT" as const;
}
export class OpeningBalanceNotEditableError extends Error {
  readonly code = "OPENING_BALANCE_NOT_EDITABLE" as const;
}

export interface OpeningBalanceLineInput {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string | null;
}

export interface OpeningBalanceLineSummary {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface OpeningBalanceSummary {
  exists: boolean;
  id: string | null;
  status: "DRAFT" | "POSTED" | "REVERSED" | null;
  entryDate: string | null;
  periodId: string | null;
  periodLabel: string | null;
  referenceNo: string | null;
  lines: OpeningBalanceLineSummary[];
  totalDebit: number;
  totalCredit: number;
  difference: number;
  isBalanced: boolean;
}

/** SATU-SATUNYA tempat "cari opening balance yang aktif" -- dipakai semua
 * fungsi di bawah, supaya definisi "yang aktif" (DRAFT/POSTED, BUKAN
 * REVERSED) konsisten di seluruh service ini. */
/** Multi-Branch: satu saldo awal aktif PER CABANG. Tanpa `branchId` -> Kantor Pusat (perilaku lama untuk perusahaan satu-cabang). */
async function resolveOpeningBranchId(db: Knex, branchId?: string): Promise<string> {
  return branchId ?? (await getHeadOfficeBranch(db)).id;
}

async function findActiveOpeningBalanceEntry(db: Knex, branchId?: string) {
  const branch = await resolveOpeningBranchId(db, branchId);
  return db("journal_entries")
    .where({ is_opening_balance: true, branch_id: branch })
    .whereIn("status", ["DRAFT", "POSTED"])
    .orderBy("created_at", "desc")
    .first();
}

function assertNoDuplicateAccounts(lines: OpeningBalanceLineInput[]): void {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.accountId)) {
      throw new OpeningBalanceDuplicateAccountError("Satu akun tidak boleh muncul lebih dari sekali pada saldo awal yang sama (§7: duplicate account = error, bukan digabung diam-diam).");
    }
    seen.add(line.accountId);
  }
}

export async function getOpeningBalance(db: Knex, branchId?: string): Promise<OpeningBalanceSummary> {
  const entry = await findActiveOpeningBalanceEntry(db, branchId);
  if (!entry) {
    return { exists: false, id: null, status: null, entryDate: null, periodId: null, periodLabel: null, referenceNo: null, lines: [], totalDebit: 0, totalCredit: 0, difference: 0, isBalanced: true };
  }

  const lines = await db("journal_entry_lines as jel")
    .join("accounts as a", "a.id", "jel.account_id")
    .where("jel.journal_entry_id", entry.id)
    .orderBy("jel.line_order")
    .select("jel.account_id as accountId", "a.code as accountCode", "a.name as accountName", "jel.debit", "jel.credit", "jel.memo");
  const period = await db("periods").where({ id: entry.period_id }).first();

  const lineSummaries: OpeningBalanceLineSummary[] = lines.map((l: any) => ({
    accountId: l.accountId,
    accountCode: l.accountCode,
    accountName: l.accountName,
    debit: Number(l.debit),
    credit: Number(l.credit),
    memo: l.memo,
  }));
  const totalDebit = lineSummaries.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lineSummaries.reduce((s, l) => s + l.credit, 0);

  return {
    exists: true,
    id: entry.id,
    status: entry.status,
    entryDate: entry.entry_date,
    periodId: entry.period_id,
    periodLabel: period?.label ?? null,
    referenceNo: entry.reference_no,
    lines: lineSummaries,
    totalDebit,
    totalCredit,
    difference: totalDebit - totalCredit,
    // TASK-020: konsisten dgn tolerance BALANCE_TOLERANCE di journal-
    // service.ts (yg SUNGGUHAN menggerbang commit) -- field display ini
    // sebelumnya pakai `===` ketat & bisa bilang "tidak balance" utk data
    // yg justru DITERIMA backend, membingungkan user.
    isBalanced: totalsEqual(totalDebit, totalCredit),
  };
}

function generateOpeningBalanceReferenceNo(): string {
  return `SALDO-AWAL-${Date.now().toString(36).toUpperCase()}`;
}

export interface CreateOpeningBalanceInput {
  entryDate: string;
  periodId: string;
  lines: OpeningBalanceLineInput[];
}

/** Create (manual ATAU import, SATU jalur yang sama -- lihat
 * opening-balance-import-service.ts). Balance check, validasi akun
 * aktif, dan validasi periode SEPENUHNYA diwariskan dari
 * `createDraftJournalEntry` (journal-service.ts, TIDAK diubah) -- yang
 * BARU hanya 2 aturan spesifik Opening Balance: (1) tidak boleh ada yang
 * aktif lebih dari satu, (2) tidak boleh duplicate akun antar baris. */
export async function createOpeningBalanceEntry(db: Knex, input: CreateOpeningBalanceInput, actor: ActorContext, branchId?: string): Promise<{ id: string }> {
  const branch = await resolveOpeningBranchId(db, branchId);
  const existing = await findActiveOpeningBalanceEntry(db, branch);
  if (existing) {
    throw new OpeningBalanceAlreadyExistsError(
      `Opening balance untuk cabang ini sudah ada (status ${existing.status}). Reversal (jika POSTED) atau hapus draft (jika DRAFT) terlebih dahulu sebelum membuat yang baru.`,
    );
  }
  assertNoDuplicateAccounts(input.lines);

  return createDraftJournalEntry(
    db,
    {
      entryDate: input.entryDate,
      periodId: input.periodId,
      referenceNo: generateOpeningBalanceReferenceNo(),
      description: "Saldo Awal",
      isOpeningBalance: true,
      branchId: branch,
      lines: input.lines,
    },
    actor,
  );
}

/** Edit -- HANYA kalau masih DRAFT, pola IDENTIK dgn Edit Journal
 * (TASK-DB-ARCH-014): delete-draft-lama + create-draft-baru ATOMIC dlm
 * SATU transaction luar (nested-transaction, pola yg sudah dibuktikan
 * atomic berulang kali). Nomor referensi DIPERTAHANKAN (bukan generate
 * baru) -- scr konsep tetap "opening balance yang sama", hanya datanya
 * direvisi. */
export async function updateOpeningBalanceDraft(db: Knex, input: CreateOpeningBalanceInput, actor: ActorContext, branchId?: string): Promise<{ id: string }> {
  const entry = await findActiveOpeningBalanceEntry(db, branchId);
  if (!entry) throw new OpeningBalanceNotFoundError("Opening balance belum dibuat.");
  if (entry.status !== "DRAFT") {
    throw new OpeningBalanceNotEditableError(`Opening balance berstatus ${entry.status}, tidak dapat diedit langsung -- gunakan Reversal (§21: read-only lebih aman drpd mekanisme edit berisiko thd data POSTED).`);
  }
  assertNoDuplicateAccounts(input.lines);

  let newId = "";
  await db.transaction(async (trx) => {
    await deleteDraftJournalEntry(trx, entry.id, actor);
    const created = await createDraftJournalEntry(
      trx,
      {
        entryDate: input.entryDate,
        periodId: input.periodId,
        referenceNo: entry.reference_no,
        description: "Saldo Awal",
        isOpeningBalance: true,
        branchId: entry.branch_id,
        lines: input.lines,
      },
      actor,
    );
    newId = created.id;
  });
  return { id: newId };
}

export async function deleteOpeningBalanceDraft(db: Knex, actor: ActorContext, branchId?: string): Promise<void> {
  const entry = await findActiveOpeningBalanceEntry(db, branchId);
  if (!entry) throw new OpeningBalanceNotFoundError("Opening balance belum dibuat.");
  if (entry.status !== "DRAFT") {
    throw new OpeningBalanceNotEditableError(`Opening balance berstatus ${entry.status}, tidak dapat dihapus -- gunakan Reversal.`);
  }
  await deleteDraftJournalEntry(db, entry.id, actor);
}

export async function postOpeningBalance(db: Knex, actor: ActorContext, branchId?: string): Promise<void> {
  const entry = await findActiveOpeningBalanceEntry(db, branchId);
  if (!entry) throw new OpeningBalanceNotFoundError("Opening balance belum dibuat.");
  await postJournalEntry(db, { journalEntryId: entry.id }, actor);
}

export interface ReverseOpeningBalanceInput {
  targetPeriodId?: string;
  reason: string;
  reversalEntryDate?: string;
}

export async function reverseOpeningBalance(db: Knex, input: ReverseOpeningBalanceInput, actor: ActorContext, branchId?: string): Promise<{ id: string }> {
  const entry = await findActiveOpeningBalanceEntry(db, branchId);
  if (!entry) throw new OpeningBalanceNotFoundError("Opening balance belum dibuat.");
  if (entry.status !== "POSTED") {
    throw new OpeningBalanceNotEditableError(`Opening balance berstatus ${entry.status}, hanya yang POSTED dapat di-reversal.`);
  }
  // Reversal selalu bertanggal & berperiode sama dengan jurnal asli
  // (aturan klien) -- diturunkan oleh reverseJournalEntry; nilai dari
  // client hanya divalidasi.
  return reverseJournalEntry(
    db,
    {
      journalEntryId: entry.id,
      reversalPeriodId: input.targetPeriodId,
      reversalEntryDate: input.reversalEntryDate,
      reversalReferenceNo: `${entry.reference_no}-REV`,
      reason: input.reason,
    },
    actor,
  );
}
