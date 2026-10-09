import { isValidIsoDate } from "../../lib/calendar-date.js";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { loadPeriodOrThrow, assertPeriodIsWritable } from "./fiscal-period.js";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { assertAccountUsable } from "./account-service.js";
import { JournalInvalidDateError } from "./journal-errors.js";
import { assertEntryDatePolicy } from "./journal-policy.js";
import { sumCents, toCents } from "../../lib/money.js";
import {
  assertBranchAcceptsOrigin,
  getHeadOfficeBranch,
  BRANCH_AUDIT_ACTIONS,
  REGISTERED_SYSTEM_PROCESSES,
  type JournalOrigin,
} from "./branch-service.js";
import { assertAccountsAllowedForJournal } from "./account-branch-policy.js";
import { isReservedInterBranchReference } from "./inter-branch-domain.js";

/** Action identifier stabil (TASK-DB-ARCH-006 §10) -- dipakai utk filter/
 * report/audit search, BUKAN pesan bebas. */
export const JOURNAL_AUDIT_ACTIONS = {
  CREATE: "journal.create",
  POST: "journal.post",
  REVERSE: "journal.reverse",
  OPENING_BALANCE_CREATE: "opening_balance.create", // TASK-DB-ARCH-011 §36
  DELETE_DRAFT: "journal.delete_draft", // TASK-DB-ARCH-014 §44 -- lihat deleteDraftJournalEntry
  IMPORT: "journal.import", // TASK-DB-ARCH-014 §44 -- lihat journal-import-service.ts
} as const;

/**
 * Journal lifecycle service MINIMAL utk Company DB (skema `C0008`/`C0009`,
 * TASK-DB-ARCH-005). Scope SENGAJA dibatasi ke operasi yang dibutuhkan utk
 * menguji & menegakkan fiscal period enforcement -- BUKAN porting penuh
 * `modules/journal/posting.ts` (shared-DB lama). Tidak ada auto-numbering
 * referensi jurnal, tidak ada subledger auto-tagging, tidak ada trial
 * balance recompute -- semua itu di luar scope task ini (lihat Final
 * Report "Remaining Risks"), dibangun di task company-journal berikutnya.
 */

export type JournalEntryStatus = "DRAFT" | "POSTED" | "REVERSED" | "VOID";

export class JournalPeriodRequiredError extends Error {
  readonly code = "JOURNAL_PERIOD_REQUIRED" as const;
}

export class JournalAlreadyPostedError extends Error {
  readonly code = "JOURNAL_ALREADY_POSTED" as const;
}

export class JournalNotPostableError extends Error {
  readonly code = "JOURNAL_NOT_POSTABLE" as const;
}

export class JournalNotBalancedError extends Error {
  readonly code = "JOURNAL_NOT_BALANCED" as const;
}

export class JournalHasNoLinesError extends Error {
  readonly code = "JOURNAL_HAS_NO_LINES" as const;
}

export class JournalZeroAmountError extends Error {
  readonly code = "JOURNAL_ZERO_AMOUNT" as const;
}

/** Baris jurnal tidak valid bentuknya (UAT-011): harus tepat SATU sisi > 0. */
export class JournalInvalidLineError extends Error {
  readonly code = "JOURNAL_INVALID_LINE" as const;
}

export class JournalEntryNotFoundError extends Error {
  readonly code = "JOURNAL_ENTRY_NOT_FOUND" as const;
}

/** Proses sistem tidak terdaftar / origin system tanpa proses (Multi-Branch). */
export class JournalSystemProcessError extends Error {
  readonly code = "JOURNAL_SYSTEM_PROCESS_INVALID" as const;
}

/** Jurnal bertaut transaksi antar-cabang hanya boleh diubah lewat alur antar-cabang. */
export class JournalInterBranchLinkedError extends Error {
  readonly code = "JOURNAL_INTER_BRANCH_LINKED" as const;
}

/** Origin `inter_branch` hanya sah bersama tautan transaksi antar-cabang (dan sebaliknya). */
export class JournalInterBranchLinkRequiredError extends Error {
  readonly code = "JOURNAL_INTER_BRANCH_LINK_REQUIRED" as const;
}

export { JournalInvalidDateError };

export class JournalReferenceExistsError extends Error {
  readonly code = "JOURNAL_REFERENCE_EXISTS" as const;
}

/** Awalan `IB-` dicadangkan untuk jurnal transaksi antar-cabang (IB-1, F-2). Trigger C0019 adalah penjaga akhir; ini pesan ramah. */
export class JournalReferenceReservedError extends Error {
  readonly code = "JOURNAL_REFERENCE_RESERVED" as const;
}

/**
 * Tanggal jurnal WAJIB tanggal kalender nyata (YYYY-MM-DD) dan berada di
 * dalam rentang periode yang dipilih. Tanpa ini, jurnal bisa tercatat di
 * periode Januari dengan tanggal Maret (atau tanggal mustahil spt
 * "2026-13-45"): Trial Balance/Ledger (per periode) lalu tidak lagi sama
 * dengan Neraca/Laba Rugi/Dashboard (per rentang tanggal). Ditemukan di
 * Final UAT. Dipakai create DAN reversal supaya tidak ada jalur bypass.
 */
function assertEntryDateWithinPeriod(entryDate: string, period: { label: string; start_date?: unknown; end_date?: unknown }): void {
  if (!isValidIsoDate(entryDate)) {
    throw new JournalInvalidDateError(`Tanggal jurnal "${entryDate}" tidak valid. Gunakan format YYYY-MM-DD.`);
  }
  const start = String(period.start_date ?? "").slice(0, 10);
  const end = String(period.end_date ?? "").slice(0, 10);
  if (start && end && (entryDate < start || entryDate > end)) {
    throw new JournalInvalidDateError(
      `Tanggal jurnal ${entryDate} berada di luar periode "${period.label}" (${start} s/d ${end}).`,
    );
  }
}

function assertReferenceNotReserved(referenceNo: string, origin: JournalOrigin): void {
  if (origin !== "inter_branch" && isReservedInterBranchReference(referenceNo)) {
    throw new JournalReferenceReservedError(`Nomor referensi "${referenceNo}" memakai awalan IB- yang dicadangkan untuk transaksi antar-cabang. Gunakan awalan lain.`);
  }
}

async function assertReferenceNoAvailable(trx: Knex, referenceNo: string): Promise<void> {
  const existing = await trx("journal_entries").where({ reference_no: referenceNo }).first();
  if (existing) {
    throw new JournalReferenceExistsError(`Nomor referensi "${referenceNo}" sudah dipakai jurnal lain.`);
  }
}

/**
 * Simpan baris dalam potongan kecil. Satu `insert` multi-baris di SQLite
 * dibatasi jumlah variabel (kolom x baris) dan jumlah "union all" (500).
 * Jurnal dengan ribuan baris (mis. file import tanpa pemisah transaksi)
 * dulu gagal dengan "too many SQL variables" saat commit. Dijalankan di
 * dalam transaction pemanggil, jadi tetap atomic.
 */
const LINE_INSERT_CHUNK_SIZE = 400;
async function insertLinesInChunks(trx: Knex.Transaction, rows: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < rows.length; i += LINE_INSERT_CHUNK_SIZE) {
    await trx("journal_entry_lines").insert(rows.slice(i, i + LINE_INSERT_CHUNK_SIZE));
  }
}

// BUG NYATA (TASK-020 audit §4 instruksi: "Pastikan journal tidak dapat
// diposting jika... total debit > 0, total credit > 0"): SEBELUM ini,
// fungsi ini HANYA mengecek `lines.length > 0` dan selisih debit/kredit
// dalam toleransi -- `lines:[{debit:0,credit:0}]` lolos (0-0=0, dalam
// toleransi), menghasilkan jurnal POSTED permanen senilai nol, tanpa efek
// akuntansi nyata, melanggar double-entry dasar (harus py debit NYATA &
// kredit NYATA, bukan cuma "baris ada"). Jalur import (journal-import-
// service.ts) SUDAH mengecek ini sejak awal -- gap ini HANYA ada di jalur
// manual/API, sekarang disamakan.
/**
 * UAT-011: setiap baris harus punya TEPAT SATU sisi bernilai > 0 (debit XOR
 * kredit). Dulu hanya CHECK database yang menjaga ini, sehingga pelanggaran
 * muncul sebagai SqliteError -> HTTP 500. Sekarang ditolak di service sebelum
 * ada baris yang ditulis (jalur manual, import, Saldo Awal, dan posting).
 * Reversal sengaja tidak melewati ini: ia hanya menukar sisi baris asli.
 */
function assertLineShapes(lines: Array<{ debit: number; credit: number }>): void {
  lines.forEach((l, i) => {
    const n = i + 1;
    if (typeof l.debit !== "number" || typeof l.credit !== "number" || !Number.isFinite(l.debit) || !Number.isFinite(l.credit)) {
      throw new JournalInvalidLineError(`Baris ${n}: nilai debit/kredit harus berupa angka.`);
    }
    if (l.debit < 0 || l.credit < 0) {
      throw new JournalInvalidLineError(`Baris ${n}: nilai debit/kredit tidak boleh negatif.`);
    }
    const d = toCents(l.debit) > 0n;
    const c = toCents(l.credit) > 0n;
    if (d && c) {
      throw new JournalInvalidLineError(`Baris ${n}: satu baris tidak boleh berisi debit dan kredit sekaligus.`);
    }
    if (!d && !c) {
      throw new JournalInvalidLineError(`Baris ${n}: baris harus berisi debit atau kredit (salah satu, lebih dari nol).`);
    }
  });
}

function assertLinesBalanced(lines: Array<{ debit: number; credit: number }>): void {
  if (lines.length === 0) {
    throw new JournalHasNoLinesError("Jurnal harus punya minimal 1 baris.");
  }
  // Jurnal yang seluruhnya nol tetap memakai pesan lama (JournalZeroAmountError).
  if (lines.every((l) => l.debit === 0 && l.credit === 0)) {
    throw new JournalZeroAmountError("Jurnal harus memiliki nilai debit dan kredit lebih dari nol (minimal satu baris debit nyata dan satu baris kredit nyata).");
  }
  assertLineShapes(lines);
  // UAT-002: TANPA toleransi. Dulu selisih sampai Rp 1 lolos dan, setelah
  // diposting, membuat Neraca/Dashboard gagal (500) dan Trial Balance tidak
  // balance untuk semua periode sesudahnya.
  const totalDebit = sumCents(lines.map((l) => l.debit));
  const totalCredit = sumCents(lines.map((l) => l.credit));
  if (totalDebit !== totalCredit) {
    throw new JournalNotBalancedError(
      `Jurnal tidak dapat disimpan/diposting karena total debit dan kredit tidak sama: debit ${lines.reduce((s, l) => s + l.debit, 0)} vs kredit ${lines.reduce((s, l) => s + l.credit, 0)}.`,
    );
  }
  if (totalDebit <= 0n || totalCredit <= 0n) {
    throw new JournalZeroAmountError("Jurnal harus memiliki nilai debit dan kredit lebih dari nol (minimal satu baris debit nyata dan satu baris kredit nyata).");
  }
}

/**
 * Cek ulang keseimbangan dari BARIS YANG BENAR-BENAR TERSIMPAN (bukan dari
 * request) di dalam transaction yang sama -- dipanggil sesudah baris
 * di-insert (sebelum commit) dan tepat sebelum status jadi POSTED. Jika
 * tidak seimbang, exception membatalkan seluruh transaction (header, baris,
 * audit tidak ada yang tersimpan). Penjumlahan dilakukan SQLite dalam
 * bilangan bulat sen sehingga tidak ada drift floating-point.
 */
async function assertStoredJournalBalanced(trx: Knex.Transaction, journalEntryId: string): Promise<void> {
  const row = await trx("journal_entry_lines")
    .where({ journal_entry_id: journalEntryId })
    .select(
      trx.raw("COALESCE(SUM(CAST(ROUND(debit * 100) AS INTEGER)), 0) as d"),
      trx.raw("COALESCE(SUM(CAST(ROUND(credit * 100) AS INTEGER)), 0) as c"),
    )
    .first();
  const d = Number((row as { d: number }).d), c = Number((row as { c: number }).c);
  if (d !== c || d <= 0) {
    throw new JournalNotBalancedError(`Jurnal tidak dapat diposting karena total debit dan kredit tidak sama (debit ${d / 100}, kredit ${c / 100}).`);
  }
}

export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string | null;
  counterpartyId?: string | null;
}

export interface CreateDraftJournalEntryInput {
  entryDate: string;
  periodId: string;
  referenceNo: string;
  description?: string | null;
  source?: "manual" | "import";
  createdBy?: string | null;
  isOpeningBalance?: boolean;
  /** Cabang pemilik jurnal. Kosong -> Kantor Pusat (jalur lama yang belum sadar-cabang). Pemanggil request WAJIB memvalidasi akses lebih dulu. */
  branchId?: string;
  /** Asal jurnal -- ditetapkan server. Default diturunkan dari isOpeningBalance/source. */
  origin?: JournalOrigin;
  /** Wajib (dan hanya boleh) untuk origin = system; harus proses terdaftar. */
  systemProcess?: string | null;
  exceptionReason?: string | null;
  /**
   * Tautan transaksi antar-cabang (hanya dari prosedur posting Inter-Branch, tidak pernah dari request).
   * Bila ada: origin ditetapkan `inter_branch`, leg `ORIGINAL`, dan `side` mengikuti cabang pemberi/penerima.
   */
  interBranch?: { transactionId: string; side: "FROM" | "TO" };
  lines: JournalLineInput[];
}

/**
 * Buat jurnal berstatus DRAFT. CREATE DRAFT != POST JOURNAL (§12), TAPI
 * Accounting_Rules.md §13/§14 (lihat fiscal-period.ts) memang memblokir
 * CREATE juga saat periode LOCKED/CLOSED -- bukan hanya POST. Ini
 * keputusan yang DITENTUKAN dari dokumen approved, bukan diasumsikan.
 */
function assertSystemProcessConsistent(origin: JournalOrigin, systemProcess: string | null): void {
  if (origin === "system") {
    if (!systemProcess || !(REGISTERED_SYSTEM_PROCESSES as readonly string[]).includes(systemProcess)) {
      throw new JournalSystemProcessError("Jurnal sistem harus menyebut proses sistem yang terdaftar.");
    }
  } else if (systemProcess) {
    throw new JournalSystemProcessError("Proses sistem hanya boleh diisi untuk jurnal berasal sistem.");
  }
}

/** Setiap jurnal yang masuk ke cabang non-ACTIVE (pengecualian sah) wajib diaudit. */
async function appendNonActivePostingAudit(
  trx: Knex,
  actor: ActorContext,
  journalId: string,
  branchId: string,
  branchStatus: string,
  origin: JournalOrigin,
  systemProcess: string | null,
  reason: string | null,
): Promise<void> {
  await appendCompanyAudit(trx, {
    actor,
    action: BRANCH_AUDIT_ACTIONS.NONACTIVE_POSTING,
    entityType: "journal_entry",
    entityId: journalId,
    branchId,
    after: { branchStatus, origin, systemProcess },
    reason,
  });
}

export async function createDraftJournalEntry(
  db: Knex,
  input: CreateDraftJournalEntryInput,
  actor: ActorContext,
): Promise<{ id: string }> {
  if (!input.periodId) {
    throw new JournalPeriodRequiredError("Jurnal harus memiliki period_id.");
  }
  // Urutan validasi: (1) kalender nyata, (2) keseimbangan, baru (3) aturan bisnis
  // (periode, masa depan, backdate, akun). Tanggal tidak nyata ditolak dulu,
  // apa pun status periodenya.
  if (!isValidIsoDate(input.entryDate)) {
    throw new JournalInvalidDateError(`Tanggal jurnal "${input.entryDate}" tidak valid. Gunakan tanggal kalender yang nyata dengan format YYYY-MM-DD.`);
  }
  assertLinesBalanced(input.lines);

  const entryId = crypto.randomUUID();

  await db.transaction(async (trx) => {
    const period = await loadPeriodOrThrow(trx, input.periodId);
    assertPeriodIsWritable(period);
    assertEntryDateWithinPeriod(input.entryDate, period);
    await assertEntryDatePolicy(trx, input.entryDate, { isOpeningBalance: input.isOpeningBalance });
    await assertReferenceNoAvailable(trx, input.referenceNo);

    // TASK-DB-ARCH-011 §22: akun non-aktif tidak boleh dipakai jurnal BARU.
    // Dicek per baris, DI DALAM transaction yang sama -- account bisa saja
    // dinonaktifkan di antara request dibentuk & transaction dijalankan,
    // sama prinsipnya dgn re-check period (§11 race condition).
    if (input.interBranch && input.origin !== undefined && input.origin !== "inter_branch") {
      throw new JournalInterBranchLinkRequiredError("Jurnal bertaut transaksi antar-cabang harus berasal inter_branch.");
    }
    const origin: JournalOrigin = input.interBranch
      ? "inter_branch"
      : (input.origin ?? (input.isOpeningBalance ? "opening_balance" : input.source === "import" ? "import" : "manual"));
    if (origin === "inter_branch" && !input.interBranch) {
      throw new JournalInterBranchLinkRequiredError("Asal inter_branch hanya sah bersama tautan transaksi antar-cabang.");
    }
    assertSystemProcessConsistent(origin, input.systemProcess ?? null);
    assertReferenceNotReserved(input.referenceNo, origin);
    const branchId = input.branchId ?? (await getHeadOfficeBranch(trx)).id;
    const { branch, exception } = await assertBranchAcceptsOrigin(trx, branchId, origin);

    const uniqueAccountIds = [...new Set(input.lines.map((l) => l.accountId))];
    for (const accountId of uniqueAccountIds) {
      await assertAccountUsable(trx, accountId);
    }
    await assertAccountsAllowedForJournal(trx, uniqueAccountIds, branch, origin);

    await trx("journal_entries").insert({
      id: entryId,
      entry_date: input.entryDate,
      period_id: input.periodId,
      reference_no: input.referenceNo,
      description: input.description ?? null,
      source: input.source ?? "manual",
      status: "DRAFT",
      is_opening_balance: input.isOpeningBalance ?? false,
      created_by: input.createdBy ?? null,
      branch_id: branch.id,
      origin,
      system_process: input.systemProcess ?? null,
      exception_reason: input.exceptionReason ?? null,
      inter_branch_transaction_id: input.interBranch?.transactionId ?? null,
      inter_branch_leg: input.interBranch ? "ORIGINAL" : null,
      inter_branch_side: input.interBranch?.side ?? null,
    });

    const linesToInsert = input.lines.map((l, i) => ({
      id: crypto.randomUUID(),
      journal_entry_id: entryId,
      account_id: l.accountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? null,
      counterparty_id: l.counterpartyId ?? null,
      line_order: i,
    }));
    await insertLinesInChunks(trx, linesToInsert);
    await assertStoredJournalBalanced(trx, entryId);

    // Audit DI DALAM transaction yang sama (§13/§14 instruksi) -- kalau
    // insert audit ini gagal, seluruh insert journal_entries/lines di atas
    // ikut rollback, bukan cuma audit-nya yang diam-diam dilewati.
    await appendCompanyAudit(trx, {
      actor,
      // §29/§36: opening balance dapat dibedakan di audit trail SEJAK
      // create, bukan hanya lewat field `isOpeningBalance` di after_json.
      action: input.isOpeningBalance ? JOURNAL_AUDIT_ACTIONS.OPENING_BALANCE_CREATE : JOURNAL_AUDIT_ACTIONS.CREATE,
      entityType: "journal_entry",
      entityId: entryId,
      branchId: branch.id,
      after: {
        periodId: input.periodId,
        referenceNo: input.referenceNo,
        status: "DRAFT",
        isOpeningBalance: input.isOpeningBalance ?? false,
        lineCount: input.lines.length,
        branchId: branch.id,
        origin,
      },
    });
    if (exception) await appendNonActivePostingAudit(trx, actor, entryId, branch.id, branch.status, origin, input.systemProcess ?? null, input.exceptionReason ?? null);
  });

  return { id: entryId };
}

export interface PostJournalEntryInput {
  journalEntryId: string;
  postedBy?: string | null;
}

/**
 * Transisi DRAFT -> POSTED. Seluruh validasi (status jurnal, balance baris,
 * status periode) dibaca ULANG di dalam transaction yang sama sebelum
 * commit (§10 Transaction Safety, §11 Race Condition) -- lihat catatan
 * mekanisme concurrency di bagian bawah file ini.
 */
export async function postJournalEntry(db: Knex, input: PostJournalEntryInput, actor: ActorContext): Promise<void> {
  await db.transaction(async (trx) => {
    const entry = await trx("journal_entries").where({ id: input.journalEntryId }).first();
    if (!entry) {
      throw new JournalEntryNotFoundError(`Jurnal dengan id "${input.journalEntryId}" tidak ditemukan.`);
    }

    if (entry.status === "POSTED") {
      throw new JournalAlreadyPostedError(`Jurnal "${entry.reference_no}" sudah diposting sebelumnya.`);
    }
    if (entry.status !== "DRAFT") {
      throw new JournalNotPostableError(`Jurnal "${entry.reference_no}" berstatus ${entry.status}, tidak dapat diposting.`);
    }

    const lines = await trx("journal_entry_lines").where({ journal_entry_id: input.journalEntryId });
    assertLinesBalanced(lines.map((l: any) => ({ debit: Number(l.debit), credit: Number(l.credit) })));

    // BUG NYATA (TASK-020 audit): SEBELUM ini, akun non-aktif HANYA dicek
    // saat createDraftJournalEntry -- kalau akun dinonaktifkan SETELAH
    // draft dibuat tapi SEBELUM diposting, posting tetap lolos (persis
    // race condition yang SUDAH dicegah utk period di bawah, tapi TIDAK
    // utk account). Melanggar Accounting_Rules.md §22 "akun non-aktif
    // tidak boleh dipakai jurnal baru" -- posting jurnal draft lama =
    // menciptakan efek akuntansi baru thd akun itu. Re-check DI DALAM
    // transaction yang sama, pola identik dgn re-check period di bawah.
    const uniqueAccountIdsAtPost = [...new Set(lines.map((l: any) => l.account_id as string))];
    for (const accountId of uniqueAccountIdsAtPost) {
      await assertAccountUsable(trx, accountId);
    }
    // Cabang & kebijakan akun dicek ULANG saat posting: status cabang atau kebijakan akun bisa berubah sejak draft dibuat.
    const entryOrigin = (entry.origin ?? "manual") as JournalOrigin;
    const { branch: postBranch, exception: postException } = await assertBranchAcceptsOrigin(trx, entry.branch_id, entryOrigin);
    await assertAccountsAllowedForJournal(trx, uniqueAccountIdsAtPost, postBranch, entryOrigin);

    // Re-check period DI DALAM transaction yang sama, bukan memakai nilai
    // yang mungkin sudah dibaca sebelum transaction dimulai -- periode bisa
    // saja di-CLOSE setelah draft dibuat tapi sebelum diposting (§11).
    // Validasi ini (dan exception-nya) terjadi SEBELUM audit ditulis --
    // posting yang diblokir TIDAK PERNAH menghasilkan baris audit SUCCESS
    // (§12/§15), krn baris di bawah baru tercapai setelah lolos semua cek.
    const period = await loadPeriodOrThrow(trx, entry.period_id);
    assertPeriodIsWritable(period);
    // UAT-002: hitung ulang dari baris tersimpan tepat sebelum POSTED.
    await assertStoredJournalBalanced(trx, input.journalEntryId);

    const postedAt = new Date().toISOString();
    await trx("journal_entries").where({ id: input.journalEntryId }).update({
      status: "POSTED",
      posted_by: input.postedBy ?? null,
      posted_at: postedAt,
    });

    await appendCompanyAudit(trx, {
      actor,
      action: JOURNAL_AUDIT_ACTIONS.POST,
      entityType: "journal_entry",
      entityId: input.journalEntryId,
      branchId: entry.branch_id,
      before: { status: "DRAFT" },
      after: { status: "POSTED", postedAt },
    });
    if (postException) {
      await appendNonActivePostingAudit(trx, actor, input.journalEntryId, entry.branch_id, postBranch.status, entryOrigin, entry.system_process ?? null, entry.exception_reason ?? null);
    }
  });
}

export interface ReverseJournalEntryInput {
  journalEntryId: string;
  /** Opsional. Reversal SELALU memakai periode & tanggal jurnal asli; bila
   * diisi dan berbeda dari jurnal asli, ditolak (bukan diam-diam diganti). */
  reversalPeriodId?: string;
  reversalEntryDate?: string;
  reversalReferenceNo: string;
  reason: string;
  reversedBy?: string | null;
  /**
   * INTERNAL (prosedur reversal Inter-Branch; tidak pernah dibentuk dari request): id transaksi antar-cabang yang
   * harus sama dengan tautan jurnal asli. Tanpa ini jurnal bertaut tetap ditolak.
   */
  interBranchTransactionId?: string;
}

/**
 * Reversal = jurnal BARU dgn baris debit<->kredit ditukar, menunjuk jurnal
 * asli lewat `reversal_of_journal_id`. Jurnal asli (yang HARUS berstatus
 * POSTED) bertransisi ke REVERSED; jurnal reversal-nya sendiri berstatus
 * POSTED (ia adalah entry baru yang valid & efektif, bukan "jurnal yang
 * direversal"). Periode TUJUAN reversal (bisa beda dari periode asli, §13)
 * WAJIB melalui validasi fiscal period yang sama -- reversal TIDAK BOLEH
 * jadi jalur bypass ke periode closed (§13 instruksi task).
 */
export async function reverseJournalEntry(
  db: Knex,
  input: ReverseJournalEntryInput,
  actor: ActorContext,
): Promise<{ id: string }> {
  const reversalId = crypto.randomUUID();

  await db.transaction(async (trx) => {
    const original = await trx("journal_entries").where({ id: input.journalEntryId }).first();
    if (!original) {
      throw new JournalEntryNotFoundError(`Jurnal dengan id "${input.journalEntryId}" tidak ditemukan.`);
    }
    if (original.status !== "POSTED") {
      throw new JournalNotPostableError(
        `Jurnal "${original.reference_no}" berstatus ${original.status} -- hanya jurnal POSTED yang dapat di-reversal.`,
      );
    }
    const linkedToInterBranch = Boolean(original.inter_branch_transaction_id);
    if (linkedToInterBranch !== Boolean(input.interBranchTransactionId) || (linkedToInterBranch && (original.inter_branch_transaction_id !== input.interBranchTransactionId || original.inter_branch_leg !== "ORIGINAL"))) {
      throw new JournalInterBranchLinkedError(
        `Jurnal "${original.reference_no}" bagian dari transaksi antar-cabang dan hanya dapat di-reversal lewat alur antar-cabang.`,
      );
    }
    // Reversal = transaksi baru di cabang yang SAMA dengan jurnal asli; cabang non-ACTIVE hanya menerima reversal dari jalur sistem.
    const reversalOrigin: JournalOrigin = linkedToInterBranch ? "inter_branch" : original.origin === "system" ? "system" : "manual";
    const { branch: reversalBranch, exception: reversalException } = await assertBranchAcceptsOrigin(trx, original.branch_id, reversalOrigin);

    // Aturan klien: tanggal reversal = tanggal transaksi yang direversal
    // (bukan tanggal hari ini / akhir periode lain). Periode ikut jurnal asli.
    if (input.reversalEntryDate !== undefined && !isValidIsoDate(input.reversalEntryDate.slice(0, 10))) {
      throw new JournalInvalidDateError(`Tanggal reversal "${input.reversalEntryDate}" tidak valid. Gunakan tanggal kalender yang nyata dengan format YYYY-MM-DD.`);
    }
    const reversalEntryDate = String(original.entry_date).slice(0, 10);
    const reversalPeriodId: string = original.period_id;
    if (input.reversalEntryDate !== undefined && input.reversalEntryDate.slice(0, 10) !== reversalEntryDate) {
      throw new JournalInvalidDateError(
        `Tanggal reversal harus sama dengan tanggal transaksi yang direversal (${reversalEntryDate}), bukan ${input.reversalEntryDate}.`,
      );
    }
    if (input.reversalPeriodId !== undefined && input.reversalPeriodId !== reversalPeriodId) {
      throw new JournalInvalidDateError("Periode reversal harus sama dengan periode jurnal asli.");
    }
    const reversalPeriod = await loadPeriodOrThrow(trx, reversalPeriodId);
    assertPeriodIsWritable(reversalPeriod);
    assertEntryDateWithinPeriod(reversalEntryDate, reversalPeriod);
    assertReferenceNotReserved(input.reversalReferenceNo, reversalOrigin);
    await assertReferenceNoAvailable(trx, input.reversalReferenceNo);

    const originalLines = await trx("journal_entry_lines").where({ journal_entry_id: input.journalEntryId });

    // Sama dgn postJournalEntry di atas -- reversal MEMBUAT jurnal BARU
    // (dgn akun yg SAMA dari entry asli), jadi tunduk pada aturan yg sama
    // (Accounting_Rules.md §22): akun non-aktif tidak boleh dipakai jurnal
    // baru, termasuk jurnal reversal.
    const uniqueAccountIdsAtReversal = [...new Set(originalLines.map((l: any) => l.account_id as string))];
    for (const accountId of uniqueAccountIdsAtReversal) {
      await assertAccountUsable(trx, accountId);
    }

    const postedAt = new Date().toISOString();
    await trx("journal_entries").insert({
      id: reversalId,
      entry_date: reversalEntryDate,
      period_id: reversalPeriodId,
      reference_no: input.reversalReferenceNo,
      description: `Reversal dari ${original.reference_no}`,
      source: "manual",
      status: "POSTED",
      reversal_of_journal_id: input.journalEntryId,
      reversal_reason: input.reason,
      posted_by: input.reversedBy ?? null,
      posted_at: postedAt,
      branch_id: original.branch_id,
      origin: reversalOrigin,
      system_process: reversalOrigin === "system" ? original.system_process : null,
      inter_branch_transaction_id: linkedToInterBranch ? original.inter_branch_transaction_id : null,
      inter_branch_leg: linkedToInterBranch ? "REVERSAL" : null,
      inter_branch_side: linkedToInterBranch ? original.inter_branch_side : null,
    });

    const reversalLines = originalLines.map((l: any, i: number) => ({
      id: crypto.randomUUID(),
      journal_entry_id: reversalId,
      account_id: l.account_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
      memo: l.memo,
      counterparty_id: l.counterparty_id,
      line_order: i,
    }));
    await insertLinesInChunks(trx, reversalLines);

    await trx("journal_entries").where({ id: input.journalEntryId }).update({
      status: "REVERSED",
      is_reversed: true,
    });

    // entity_id merujuk ke jurnal ORIGINAL (subjek utama aksi reversal,
    // konsisten dgn konvensi recordAudit lama) -- id jurnal reversal
    // sendiri tetap tertelusur lewat after_json.reversalJournalId (C0012
    // cuma punya satu kolom entity_id, lihat Final Report bagian B).
    await appendCompanyAudit(trx, {
      actor,
      action: JOURNAL_AUDIT_ACTIONS.REVERSE,
      entityType: "journal_entry",
      entityId: input.journalEntryId,
      branchId: original.branch_id,
      before: { status: "POSTED" },
      after: {
        originalStatus: "REVERSED",
        reversalJournalId: reversalId,
        reversalStatus: "POSTED",
        reversalPeriodId,
        reversalEntryDate,
      },
      reason: input.reason,
    });
    if (reversalException) {
      await appendNonActivePostingAudit(trx, actor, reversalId, original.branch_id, reversalBranch.status, reversalOrigin, original.system_process ?? null, input.reason);
    }
  });

  return { id: reversalId };
}

export class JournalNotDraftError extends Error {
  readonly code = "JOURNAL_NOT_DRAFT" as const;
}

/**
 * Hapus jurnal DRAFT (TASK-DB-ARCH-014 §44 -- satu-satunya penambahan ke
 * file ini, SENGAJA dibuat SEKECIL & SESEMPIT mungkin). Alasan diperlukan:
 * modul Journal List/Edit baru (TASK-DB-ARCH-014) butuh "Delete/Edit jika
 * sesuai aturan status" -- status VALID yang bisa dihapus/diedit HANYA
 * DRAFT (belum pernah posting, nol efek akuntansi, Accounting_Rules.md §9
 * "posted tidak boleh diedit/dihapus" TIDAK berlaku krn entry ini belum
 * posted). Hard-delete (bukan soft/VOID) krn tidak ada histori akuntansi
 * yang perlu dipertahankan -- baris ini belum pernah "terjadi" scr
 * akuntansi. "Edit" (route layer, modules/company-journal/routes.ts)
 * dibangun di ATAS fungsi ini + `createDraftJournalEntry` (delete lama +
 * create baru dlm SATU transaction), BUKAN fungsi update baru -- supaya
 * tidak ada DUA cara membuat draft (hindari duplicate accounting engine).
 */
export async function deleteDraftJournalEntry(db: Knex, journalEntryId: string, actor: ActorContext): Promise<void> {
  await db.transaction(async (trx) => {
    const entry = await trx("journal_entries").where({ id: journalEntryId }).first();
    if (!entry) {
      throw new JournalEntryNotFoundError(`Jurnal dengan id "${journalEntryId}" tidak ditemukan.`);
    }
    if (entry.status !== "DRAFT") {
      throw new JournalNotDraftError(`Jurnal "${entry.reference_no}" berstatus ${entry.status}, hanya jurnal DRAFT yang dapat dihapus.`);
    }
    if (entry.inter_branch_transaction_id) {
      throw new JournalInterBranchLinkedError(`Jurnal "${entry.reference_no}" bagian dari transaksi antar-cabang dan tidak dapat dihapus sendiri.`);
    }

    await trx("journal_entry_lines").where({ journal_entry_id: journalEntryId }).del();
    await trx("journal_entries").where({ id: journalEntryId }).del();

    await appendCompanyAudit(trx, {
      actor,
      action: JOURNAL_AUDIT_ACTIONS.DELETE_DRAFT,
      entityType: "journal_entry",
      entityId: journalEntryId,
      branchId: entry.branch_id ?? null,
      before: { status: "DRAFT", referenceNo: entry.reference_no },
    });
  });
}

/**
 * CATATAN MEKANISME CONCURRENCY (§11): Company DB (better-sqlite3) dibuka
 * dgn `pool: { min:1, max:1 }` (lihat db/company/index.ts) -- SATU koneksi
 * per file, synchronous di level driver. Dalam satu proses Node, tidak ada
 * writer kedua yang bisa "menyelip" di antara baca-dan-tulis milik
 * `db.transaction()` yang sama. Karena itu `postJournalEntry`/
 * `reverseJournalEntry` di atas TIDAK memerlukan optimistic locking/kolom
 * versi tambahan -- re-check period DI DALAM transaction (bukan di luar)
 * sudah cukup: ia menjamin keputusan ACCEPT/REJECT dibuat dari baris
 * `periods` TERBARU yang ada saat transaction berjalan, bukan dari nilai
 * yang di-cache sebelum transaction dimulai (persis skenario Test 10 §17).
 * Solusi locking lebih kompleks (row version, SELECT ... FOR UPDATE) tidak
 * relevan utk SQLite single-writer dan sengaja TIDAK dibangun (§20: jangan
 * bikin solusi kompleks yang tidak diperlukan).
 */
