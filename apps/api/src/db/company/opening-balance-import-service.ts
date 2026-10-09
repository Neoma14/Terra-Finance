import { totalsEqual } from "../../lib/money.js";
import type { Knex } from "knex";
import { parseOpeningBalanceExcel } from "../../modules/company-opening-balance-import/parser.js";
import { resolvePeriodForDate } from "./journal-import-service.js";
import { listAccounts } from "./account-service.js";
import { createOpeningBalanceEntry, getOpeningBalance } from "./opening-balance-service.js";
import { postJournalEntry } from "./journal-service.js";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { getHeadOfficeBranch, requireBranch } from "./branch-service.js";
import { describePolicyViolation, loadPolicyAccounts } from "./account-branch-policy.js";

/**
 * Opening Balance Import (TASK-DB-ARCH-016 §10-17, "TERRA Import
 * Standard"): UPLOAD -> PARSE -> VALIDATE -> PREVIEW -> CONFIRM -> COMMIT
 * -> AUDIT. REUSE, bukan accounting engine baru:
 *   - `resolvePeriodForDate` (journal-import-service.ts, di-export TASK
 *     ini -- satu-satunya perubahan minimal pada file itu).
 *   - `createOpeningBalanceEntry` (opening-balance-service.ts) sbg SATU-
 *     SATUNYA jalur penulisan, dipakai baik oleh create manual MAUPUN
 *     commit import -- tidak ada jalur kedua yang bisa diam-diam berbeda
 *     aturannya (§18: "jangan membuat accounting engine baru").
 */

export type OpeningBalanceImportRowStatus = "VALID" | "WARNING" | "ERROR";

export interface ValidatedOpeningBalanceImportRow {
  rowNumber: number;
  code: string;
  name: string;
  accountId: string | null;
  debit: number;
  credit: number;
  memo: string;
  status: OpeningBalanceImportRowStatus;
  issues: string[];
}

export interface OpeningBalanceImportValidationResult {
  fileName: string;
  /** Cabang tujuan saldo awal (ditentukan server dari konteks kerja, bukan dari isi file). */
  branchId: string;
  openingDate: string | null;
  periodId: string | null;
  periodLabel: string | null;
  rows: ValidatedOpeningBalanceImportRow[];
  totalRows: number;
  validCount: number;
  warningCount: number;
  errorCount: number;
  totalDebit: number;
  totalCredit: number;
  difference: number;
  isBalanced: boolean;
  fileErrors: string[];
  canCommit: boolean;
}

export async function validateOpeningBalanceImportBatch(db: Knex, buffer: Buffer, fileName: string, branchId?: string): Promise<OpeningBalanceImportValidationResult> {
  const branch = branchId ? await requireBranch(db, branchId) : await getHeadOfficeBranch(db);
  const parsed = await parseOpeningBalanceExcel(buffer);
  const fileErrors = [...parsed.fileErrors];

  let periodId: string | null = null;
  let periodLabel: string | null = null;
  if (!parsed.openingDate) {
    fileErrors.push('"Tanggal Saldo Awal" wajib diisi di sheet (lihat sel B3 pada template).');
  } else {
    // §8: TIDAK auto-create periode -- periode harus SUDAH ADA & OPEN.
    const period = await resolvePeriodForDate(db, parsed.openingDate);
    if (!period) {
      fileErrors.push(`Periode akuntansi untuk tanggal ${parsed.openingDate} belum ada -- buat periode terlebih dahulu di menu Periode.`);
    } else if (period.status !== "OPEN") {
      fileErrors.push(`Periode "${period.label}" berstatus ${period.status}, tidak dapat menerima saldo awal.`);
    } else {
      periodId = period.id;
      periodLabel = period.label;
    }
  }

  // §9: hanya satu opening balance aktif pada satu waktu.
  const existing = await getOpeningBalance(db, branch.id);
  if (branch.status !== "ACTIVE") {
    fileErrors.push(`Cabang "${branch.name}" tidak aktif sehingga tidak dapat menerima saldo awal.`);
  }
  if (existing.exists) {
    fileErrors.push(`Opening balance untuk cabang "${branch.name}" sudah ada (status ${existing.status}) -- reversal/hapus draft terlebih dahulu.`);
  }

  const accounts = await listAccounts(db);
  const accountByCode = new Map(accounts.map((a) => [a.code, a]));
  const policyById = new Map((await loadPolicyAccounts(db, accounts.map((a) => a.id))).map((a) => [a.id, a]));
  const codeCount = new Map<string, number>();
  for (const r of parsed.rows) if (r.code) codeCount.set(r.code, (codeCount.get(r.code) ?? 0) + 1);

  const rows: ValidatedOpeningBalanceImportRow[] = parsed.rows.map((r) => {
    const issues: string[] = [];
    if (!r.code) issues.push("Kode Akun wajib diisi.");
    if (r.debit < 0 || r.credit < 0) issues.push("Nilai tidak boleh negatif.");
    if (r.debit > 0 && r.credit > 0) issues.push("Debit dan Kredit tidak boleh diisi bersamaan.");
    if (r.debit === 0 && r.credit === 0) issues.push("Baris harus memiliki Debit atau Kredit.");
    if (r.code && (codeCount.get(r.code) ?? 0) > 1) issues.push(`Kode akun "${r.code}" muncul lebih dari sekali di file ini (§7: duplicate = error).`);

    const account = r.code ? accountByCode.get(r.code) : undefined;
    const warnings: string[] = [];
    if (r.code && !account) {
      issues.push(`Akun "${r.code}" tidak ditemukan.`);
    } else if (account && !account.isActive) {
      issues.push(`Akun "${r.code} - ${account.name}" tidak aktif.`);
    } else if (account && policyById.get(account.id) && describePolicyViolation(policyById.get(account.id)!, branch, "opening_balance")) {
      issues.push(describePolicyViolation(policyById.get(account.id)!, branch, "opening_balance")!);
    } else if (account && ((r.debit > 0 && account.normalBalance === "credit") || (r.credit > 0 && account.normalBalance === "debit"))) {
      warnings.push(
        `Akun "${r.code}" bersaldo normal ${account.normalBalance === "debit" ? "Debit" : "Kredit"}, baris ini mengisi ${r.debit > 0 ? "Debit" : "Kredit"} -- periksa kembali jika ini bukan akun kontra.`,
      );
    }

    const status: OpeningBalanceImportRowStatus = issues.length > 0 ? "ERROR" : warnings.length > 0 ? "WARNING" : "VALID";
    return {
      rowNumber: r.rowNumber,
      code: r.code,
      name: account?.name ?? r.name,
      accountId: account?.id ?? null,
      debit: r.debit,
      credit: r.credit,
      memo: r.memo,
      status,
      issues: [...issues, ...warnings],
    };
  });

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  // BUG NYATA (TASK-020 audit): `===` ketat menolak file yg SEBENARNYA
  // balance scr akuntansi tapi kena floating point drift dari penjumlahan
  // JS (mis. hasil 30.299999999999997 drpd 30.3) -- file itu TIDAK PERNAH
  // bisa lolos ke commit sama sekali walopun `postJournalEntry` sendiri
  // (jalur manual/journal-import) SUDAH toleran thd ini (BALANCE_TOLERANCE
  // di journal-service.ts). Disamakan toleransinya di sini (modul ini
  // sendiri mengklaim "pola IDENTIK dgn journal-import-service.ts" di
  // komentar header, tapi sebelumnya menyimpang persis di titik ini).
  const isBalanced = totalsEqual(totalDebit, totalCredit); // UAT-002: tanpa toleransi
  if (rows.length > 0 && !isBalanced) {
    fileErrors.push(`Total Debit (${totalDebit}) tidak sama dengan Total Kredit (${totalCredit}) -- Opening Balance is not balanced.`);
  }

  const errorCount = rows.filter((r) => r.status === "ERROR").length;
  const warningCount = rows.filter((r) => r.status === "WARNING").length;
  const validCount = rows.filter((r) => r.status === "VALID").length;

  return {
    fileName,
    branchId: branch.id,
    openingDate: parsed.openingDate,
    periodId,
    periodLabel,
    rows,
    totalRows: rows.length,
    validCount,
    warningCount,
    errorCount,
    totalDebit,
    totalCredit,
    difference: totalDebit - totalCredit,
    isBalanced,
    fileErrors,
    canCommit: errorCount === 0 && fileErrors.length === 0 && rows.length > 0,
  };
}

export class OpeningBalanceImportHasErrorsError extends Error {
  readonly code = "OPENING_BALANCE_IMPORT_HAS_ERRORS" as const;
}

export interface OpeningBalanceImportCommitResult {
  id: string;
  lineCount: number;
}

/**
 * ATOMIC COMMIT (§17). `createOpeningBalanceEntry` dipanggil dgn `trx`
 * (bukan `db`) dari dalam SATU `db.transaction()` luar -- nested-
 * transaction/savepoint, pola yg sudah dibuktikan atomic berulang kali
 * (journal-import-service.ts, account-import-service.ts). Kalau SATU
 * baris gagal (mis. akun jadi nonaktif di antara preview & commit), audit
 * import yang menyertainya IKUT rollback juga -- tidak ada audit
 * "sukses" utk commit yang sebenarnya gagal.
 */
export async function commitOpeningBalanceImportBatch(
  db: Knex,
  validation: OpeningBalanceImportValidationResult,
  actor: ActorContext,
): Promise<OpeningBalanceImportCommitResult> {
  if (!validation.canCommit) {
    throw new OpeningBalanceImportHasErrorsError("Tidak dapat commit: masih ada error atau belum balance pada file ini.");
  }

  let createdId = "";
  await db.transaction(async (trx) => {
    const { id } = await createOpeningBalanceEntry(
      trx,
      {
        entryDate: validation.openingDate!,
        periodId: validation.periodId!,
        lines: validation.rows.map((r) => ({ accountId: r.accountId!, debit: r.debit, credit: r.credit, memo: r.memo || null })),
      },
      actor,
      validation.branchId,
    );
    createdId = id;
    // Commit import = create + LANGSUNG post (konsisten dgn permission
    // ganda journal.create+journal.post yg dipasang di route commit --
    // import bukan "draft menunggu approval", sama persis journal-import-
    // service.ts yang juga create+post dlm satu langkah commit.
    await postJournalEntry(trx, { journalEntryId: id }, actor);

    await appendCompanyAudit(trx, {
      actor,
      action: "opening_balance.import",
      entityType: "journal_entry",
      entityId: id,
      branchId: validation.branchId,
      after: { fileName: validation.fileName, rowCount: validation.rows.length, totalDebit: validation.totalDebit, totalCredit: validation.totalCredit },
    });
  });

  return { id: createdId, lineCount: validation.rows.length };
}
