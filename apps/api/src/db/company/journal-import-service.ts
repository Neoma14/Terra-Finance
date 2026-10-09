import { isValidIsoDate } from "../../lib/calendar-date.js";
import crypto from "node:crypto";
import type { Knex } from "knex";
import type { ParsedJournalEntry } from "@konsultan/shared";
import { parseJournalExcel } from "../../modules/journal/parser.js";
import { listAccounts } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry, JOURNAL_AUDIT_ACTIONS } from "./journal-service.js";
import { getHeadOfficeBranch, requireBranch } from "./branch-service.js";
import { describePolicyViolation, loadPolicyAccounts } from "./account-branch-policy.js";
import { JournalInvalidDateError } from "./journal-errors.js";
import { assertEntryDatePolicy } from "./journal-policy.js";
import { isReservedInterBranchReference } from "./inter-branch-domain.js";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";

/**
 * Journal Import (TASK-DB-ARCH-014 §2-5, "TERRA Import Standard" §7):
 * UPLOAD -> PARSE -> VALIDATE -> PREVIEW -> USER CONFIRM -> COMMIT -> AUDIT.
 *
 * REUSE, bukan accounting engine baru:
 *   - `parseJournalExcel` (modules/journal/parser.js, fungsi MURNI tanpa
 *     akses DB, dipakai verbatim TANPA DIUBAH) -- sudah menangani grouping
 *     baris-kosong-sbg-pemisah DAN grouping via kolom "No Jurnal" explisit,
 *     exact requirement §2 instruksi.
 *   - `createDraftJournalEntry` + `postJournalEntry` (journal-service.ts,
 *     TIDAK DIUBAH) -- commit SATU transaksi = create draft lalu post,
 *     persis siklus yang sama dgn entry manual, bukan jalur insert terpisah.
 *
 * PERBEDAAN DISENGAJA dari commit massal shared-DB lama
 * (`modules/journal/posting.ts`): periode TIDAK di-auto-create dari
 * tanggal -- Company DB (ADR-001) mengharuskan periode dibuat eksplisit
 * lewat Period Lifecycle API (TASK-DB-ARCH-011) sebelum jurnal apa pun
 * bisa masuk ke periode itu (fiscal-period.ts TIDAK diubah/ditambah auto-
 * create). Baris yang tanggalnya belum punya periode -> ERROR saat
 * validasi (bukan auto-create periode baru), didokumentasikan sbg
 * limitation, bukan bug.
 */

export type ImportItemStatus = "VALID" | "WARNING" | "ERROR";

export interface ImportValidatedLine {
  rowNumber: number;
  accountCode: string;
  accountId: string | null;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
  issues: string[];
}

export interface ImportValidatedTransaction {
  index: number;
  referenceNo: string | null;
  date: string;
  periodId: string | null;
  periodLabel: string | null;
  lines: ImportValidatedLine[];
  totalDebit: number;
  totalCredit: number;
  status: ImportItemStatus;
  /** true kalau referenceNo SUDAH ada di jurnal perusahaan ini -- bukan
   * error, otomatis DILEWATI saat commit (konvensi sama dgn shared-DB
   * lama, lihat modules/journal/routes.ts §"alreadyExists"). */
  alreadyExists: boolean;
  issues: string[];
}

export interface ImportValidationResult {
  fileName: string;
  /** Cabang tujuan import (ditentukan server dari konteks kerja, bukan dari isi file). */
  branchId: string;
  transactions: ImportValidatedTransaction[];
  totalTransactions: number;
  totalLines: number;
  totalDebit: number;
  totalCredit: number;
  validCount: number;
  warningCount: number;
  errorCount: number;
  fileErrors: string[];
  /** true kalau TIDAK ADA satu pun transaksi ERROR (alreadyExists/WARNING
   * tidak menghalangi) DAN ada minimal 1 transaksi yang akan benar-benar
   * di-commit. §4 instruksi: "Jika ada ERROR, SUBMIT harus disabled." */
  canCommit: boolean;
}

function toErrorStatus(issues: string[]): ImportItemStatus {
  return issues.length > 0 ? "ERROR" : "VALID";
}

/** Exported (satu-satunya perubahan "protected module" di TASK-DB-ARCH-016
 * -- cuma menambah kata kunci `export`, ZERO perubahan behavior/signature)
 * supaya `opening-balance-import-service.ts` bisa reuse LANGSUNG, bukan
 * menyalin ulang query "cari periode dari tanggal" yang sudah ada di sini. */
export async function resolvePeriodForDate(db: Knex, date: string): Promise<{ id: string; label: string; status: string } | null> {
  const period = await db("periods")
    .where("start_date", "<=", date)
    .andWhere("end_date", ">=", date)
    .orderBy("start_date", "desc")
    .first();
  return period ? { id: period.id, label: period.label, status: period.status } : null;
}

/** Sidik jari transaksi (tanggal + baris yg disortir) -- dipakai utk
 * deteksi duplikat KONTEN pada transaksi TANPA "No Jurnal" eksplisit (lihat
 * BUG NYATA di bawah). Normalisasi angka via `.toFixed(2)` (bukan nilai
 * mentah) supaya 100000 vs 100000.00 vs 100000.001 (floating point drift)
 * tetap dianggap sidik jari yg SAMA (hanya utk deteksi duplikat; keseimbangan
 * jurnal sendiri diperiksa TANPA toleransi di journal-service.ts). */
function transactionFingerprint(date: string, lines: Array<{ code: string; debit: number; credit: number }>): string {
  const sortedLines = [...lines]
    .map((l) => `${l.code}:${l.debit.toFixed(2)}:${l.credit.toFixed(2)}`)
    .sort();
  return `${date}|${sortedLines.join(",")}`;
}

/** PARSE + VALIDATE (§2-4 instruksi) -- TIDAK menulis apa pun ke DB. */
export async function validateJournalImportBatch(db: Knex, buffer: Buffer, fileName: string, branchId?: string): Promise<ImportValidationResult> {
  const branch = branchId ? await requireBranch(db, branchId) : await getHeadOfficeBranch(db);
  const parsed = await parseJournalExcel(buffer);

  const accounts = await listAccounts(db);
  const accountByCode = new Map(accounts.map((a) => [a.code, a]));
  const accountCodeById = new Map(accounts.map((a) => [a.id, a.code]));
  const policyById = new Map((await loadPolicyAccounts(db, accounts.map((a) => a.id))).map((a) => [a.id, a]));

  const referenceNos = [...new Set(parsed.entries.map((e) => e.referenceNo).filter((r): r is string => Boolean(r)))];
  const existingRefs = referenceNos.length ? await db("journal_entries").whereIn("reference_no", referenceNos).select("reference_no") : [];
  const existingRefSet = new Set(existingRefs.map((r: any) => r.reference_no as string));

  // BUG NYATA (TASK-020, terbukti via reproduksi langsung -- bukan dugaan):
  // transaksi TANPA "No Jurnal" eksplisit (alur normal yg diiklankan UI:
  // "satu transaksi = satu blok baris, dipisah baris kosong") SEBELUMNYA
  // TIDAK PERNAH terdeteksi sbg duplikat -- `generateAutoReferenceNo()`
  // selalu bikin referensi BARU tiap commit, jadi file yg SAMA yg
  // di-commit 2x menghasilkan 2 jurnal POSTED terpisah utk transaksi yg
  // SAMA PERSIS (double-posting akuntansi nyata). Diperbaiki dgn deteksi
  // duplikat BERBASIS KONTEN (tanggal + baris) utk transaksi yg tidak py
  // referenceNo -- dicek thd jurnal yg SUDAH ADA di tanggal yg sama.
  const noRefDates = [...new Set(parsed.entries.filter((e) => !e.referenceNo && e.date).map((e) => e.date))];
  const existingFingerprints = new Set<string>();
  if (noRefDates.length > 0) {
    // Duplikat berbasis konten dibandingkan HANYA dengan jurnal cabang yang sama (transaksi serupa di cabang lain bukan duplikat).
    const existingEntriesOnDates = await db("journal_entries").where({ branch_id: branch.id }).whereIn("entry_date", noRefDates).select("id", "entry_date");
    if (existingEntriesOnDates.length > 0) {
      const existingLines = await db("journal_entry_lines")
        .whereIn(
          "journal_entry_id",
          existingEntriesOnDates.map((e: any) => e.id),
        )
        .select("journal_entry_id", "account_id", "debit", "credit");
      const linesByEntryId = new Map<string, Array<{ code: string; debit: number; credit: number }>>();
      for (const line of existingLines as any[]) {
        const code = accountCodeById.get(line.account_id);
        if (!code) continue; // akun sudah tidak ada di COA aktif -- dilewati, tidak relevan utk perbandingan
        const arr = linesByEntryId.get(line.journal_entry_id) ?? [];
        arr.push({ code, debit: Number(line.debit), credit: Number(line.credit) });
        linesByEntryId.set(line.journal_entry_id, arr);
      }
      for (const e of existingEntriesOnDates as any[]) {
        const lines = linesByEntryId.get(e.id);
        if (!lines || lines.length === 0) continue;
        existingFingerprints.add(transactionFingerprint(e.entry_date, lines));
      }
    }
  }

  const transactions: ImportValidatedTransaction[] = [];
  for (let index = 0; index < parsed.entries.length; index++) {
    const entry: ParsedJournalEntry = parsed.entries[index];
    const issues: string[] = [];

    const alreadyExists = entry.referenceNo
      ? existingRefSet.has(entry.referenceNo)
      : Boolean(entry.date) && existingFingerprints.has(transactionFingerprint(entry.date, entry.lines.map((l) => ({ code: l.code, debit: l.debit, credit: l.credit }))));

    if (entry.referenceNo && isReservedInterBranchReference(entry.referenceNo)) {
      issues.push(`Nomor referensi "${entry.referenceNo}" memakai awalan IB- yang dicadangkan untuk transaksi antar-cabang.`);
    }
    if (!entry.date) {
      issues.push("Tanggal transaksi tidak terbaca/kosong.");
    } else if (!isValidIsoDate(entry.date)) {
      issues.push(`Tanggal "${entry.date}" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan format YYYY-MM-DD (mis. 2026-02-28).`);
    }
    if (entry.lines.length < 2) {
      issues.push("Transaksi minimal harus punya 2 baris (debit & kredit).");
    }
    if (!entry.isBalanced) {
      issues.push(`Tidak balance: debit ${entry.totalDebit} vs kredit ${entry.totalCredit}.`);
    }

    if (entry.date && isValidIsoDate(entry.date)) {
      // Kebijakan tanggal (tidak boleh melewati hari ini, batas backdate)
      // dicek juga di preview supaya pengguna tahu SEBELUM Submit.
      try {
        await assertEntryDatePolicy(db, entry.date);
      } catch (err) {
        if (err instanceof JournalInvalidDateError) issues.push(err.message);
        else throw err;
      }
    }

    let period: { id: string; label: string; status: string } | null = null;
    if (entry.date && isValidIsoDate(entry.date)) {
      period = await resolvePeriodForDate(db, entry.date);
      if (!period) {
        issues.push(`Periode akuntansi untuk tanggal ${entry.date} belum ada -- buat periode terlebih dahulu di menu Periode.`);
      } else if (period.status !== "OPEN") {
        issues.push(`Periode "${period.label}" berstatus ${period.status}, tidak dapat menerima jurnal baru.`);
      }
    }

    const lines: ImportValidatedLine[] = entry.lines.map((l) => {
      const lineIssues: string[] = [];
      const account = accountByCode.get(l.code);
      if (!account) {
        lineIssues.push(`Kode akun "${l.code}" tidak ditemukan.`);
      } else if (!account.isActive) {
        lineIssues.push(`Akun "${l.code} - ${account.name}" tidak aktif.`);
      } else if (account.isLocked) {
        lineIssues.push(`Akun "${l.code} - ${account.name}" sedang dikunci (locked).`);
      } else if (policyById.get(account.id) && describePolicyViolation(policyById.get(account.id)!, branch, "import")) {
        lineIssues.push(describePolicyViolation(policyById.get(account.id)!, branch, "import")!);
      }
      if (l.debit < 0 || l.credit < 0) {
        lineIssues.push("Nilai Debit/Kredit tidak boleh negatif.");
      }
      if (l.debit > 0 && l.credit > 0) {
        lineIssues.push("Satu baris tidak boleh memiliki Debit dan Kredit sekaligus.");
      }
      return {
        rowNumber: l.rowNumber,
        accountCode: l.code,
        accountId: account?.id ?? null,
        accountName: account?.name ?? l.accountName,
        memo: l.keterangan,
        debit: l.debit,
        credit: l.credit,
        issues: lineIssues,
      };
    });
    const lineIssueMessages = lines.flatMap((l) => l.issues.map((msg) => `Baris ${l.rowNumber}: ${msg}`));
    issues.push(...lineIssueMessages);

    const hasDebit = lines.some((l) => l.debit > 0);
    const hasCredit = lines.some((l) => l.credit > 0);
    if (!hasDebit || !hasCredit) {
      issues.push("Transaksi harus punya minimal satu baris debit dan satu baris kredit.");
    }

    const status: ImportItemStatus = alreadyExists ? "WARNING" : toErrorStatus(issues);

    transactions.push({
      index,
      referenceNo: entry.referenceNo,
      date: entry.date,
      periodId: period?.id ?? null,
      periodLabel: period?.label ?? null,
      lines,
      totalDebit: entry.totalDebit,
      totalCredit: entry.totalCredit,
      status,
      alreadyExists,
      issues,
    });
  }

  const validCount = transactions.filter((t) => t.status === "VALID").length;
  const warningCount = transactions.filter((t) => t.status === "WARNING").length;
  const errorCount = transactions.filter((t) => t.status === "ERROR").length;
  const willCommitCount = transactions.filter((t) => !t.alreadyExists && t.status !== "ERROR").length;

  return {
    fileName,
    branchId: branch.id,
    transactions,
    totalTransactions: transactions.length,
    totalLines: transactions.reduce((s, t) => s + t.lines.length, 0),
    totalDebit: transactions.reduce((s, t) => s + t.totalDebit, 0),
    totalCredit: transactions.reduce((s, t) => s + t.totalCredit, 0),
    validCount,
    warningCount,
    errorCount,
    fileErrors: parsed.fileErrors,
    canCommit: errorCount === 0 && willCommitCount > 0 && parsed.fileErrors.length === 0,
  };
}

export class JournalImportHasErrorsError extends Error {
  readonly code = "JOURNAL_IMPORT_HAS_ERRORS" as const;
}
export class JournalImportNothingToCommitError extends Error {
  readonly code = "JOURNAL_IMPORT_NOTHING_TO_COMMIT" as const;
}

export interface ImportCommitResult {
  committedCount: number;
  skippedCount: number;
  referenceNumbers: string[];
}

function generateAutoReferenceNo(): string {
  return `IMP-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

/**
 * COMMIT (§5 instruksi: Atomic Commit). Validasi ULANG dilakukan oleh
 * caller (route) lewat `validateJournalImportBatch` tepat sebelum fungsi
 * ini dipanggil (re-parse file yang SAMA, bukan percaya payload lama --
 * lihat komentar header `modules/company-journal-import/routes.ts`).
 *
 * SELURUH transaksi dibungkus SATU `db.transaction()` LUAR -- memanggil
 * `createDraftJournalEntry`/`postJournalEntry` (yang masing-masing SUDAH
 * membungkus `db.transaction()` SENDIRI di dalamnya) dgn `trx` luar sbg
 * parameter `db` membuat Knex membuat SAVEPOINT bersarang (bukan
 * transaction baru yg independen) -- satu entry gagal = SELURUH batch
 * rollback, bukan sebagian masuk. Pola IDENTIK dgn commit massal shared-
 * DB lama (`modules/journal/routes.ts` -> `posting.ts.createJournalEntry`
 * dipanggil berulang dgn `trx` yang sama), yang sudah terbukti jalan.
 */
export async function commitJournalImportBatch(
  db: Knex,
  validation: ImportValidationResult,
  actor: ActorContext,
): Promise<ImportCommitResult> {
  if (validation.errorCount > 0) {
    throw new JournalImportHasErrorsError("Tidak dapat commit: masih ada transaksi berstatus ERROR di file ini.");
  }
  const toCommit = validation.transactions.filter((t) => !t.alreadyExists);
  if (toCommit.length === 0) {
    throw new JournalImportNothingToCommitError("Tidak ada transaksi baru untuk di-commit (semua sudah pernah diinput sebelumnya).");
  }

  const referenceNumbers: string[] = [];

  await db.transaction(async (trx) => {
    for (const t of toCommit) {
      const referenceNo = t.referenceNo ?? generateAutoReferenceNo();
      const { id } = await createDraftJournalEntry(
        trx,
        {
          entryDate: t.date,
          periodId: t.periodId!,
          referenceNo,
          source: "import",
          branchId: validation.branchId,
          lines: t.lines.map((l) => ({ accountId: l.accountId!, debit: l.debit, credit: l.credit, memo: l.memo || null })),
        },
        actor,
      );
      await postJournalEntry(trx, { journalEntryId: id }, actor);
      referenceNumbers.push(referenceNo);
    }

    await appendCompanyAudit(trx, {
      actor,
      action: JOURNAL_AUDIT_ACTIONS.IMPORT,
      entityType: "journal_import_batch",
      entityId: crypto.randomUUID(),
      branchId: validation.branchId,
      after: {
        fileName: validation.fileName,
        branchId: validation.branchId,
        committedCount: toCommit.length,
        skippedCount: validation.transactions.length - toCommit.length,
        totalDebit: toCommit.reduce((s, t) => s + t.totalDebit, 0),
        totalCredit: toCommit.reduce((s, t) => s + t.totalCredit, 0),
        referenceNumbers,
      },
    });
  });

  return {
    committedCount: referenceNumbers.length,
    skippedCount: validation.transactions.length - referenceNumbers.length,
    referenceNumbers,
  };
}
