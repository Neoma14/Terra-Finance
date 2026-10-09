import type { Knex } from "knex";
import crypto from "node:crypto";
import { parseAccountsImportExcel, type ParsedAccountRow } from "../../modules/company-accounts-import/parser.js";
import { createAccount } from "./account-service.js";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";

/**
 * COA Import (TASK-DB-ARCH-015 §10-16, "TERRA Import Standard"): UPLOAD ->
 * PARSE -> VALIDATE -> PREVIEW -> CONFIRM -> COMMIT -> AUDIT. Struktur
 * SAMA dgn `journal-import-service.ts` (TASK-DB-ARCH-014) -- REUSE pola,
 * bukan accounting engine/import-engine baru: commit memanggil
 * `createAccount` (account-service.ts, TIDAK diubah signature-nya utk
 * import) berulang di dalam SATU `db.transaction()` luar (nested-
 * transaction/savepoint, pola yg sudah dibuktikan atomic lewat test
 * journal-import-service.test.ts).
 *
 * Import HANYA membuat akun BARU -- TIDAK PERNAH meng-update akun yang
 * sudah ada (kode yg sudah ada di DB selalu DILEWATI, status EXISTING,
 * sama persis filosofi `alreadyExists` di journal import: idempotent,
 * tidak diam-diam menimpa data).
 */

export type AccountImportStatus = "NEW" | "EXISTING" | "WARNING" | "ERROR";

export interface ValidatedAccountImportRow {
  rowNumber: number;
  code: string;
  name: string;
  accountTypeCode: string | null;
  parentCode: string | null;
  normalBalance: "debit" | "credit" | null;
  isActive: boolean;
  isCash: boolean;
  cashFlowActivity: string | null;
  subledgerType: string | null;
  status: AccountImportStatus;
  issues: string[];
}

export interface AccountImportValidationResult {
  fileName: string;
  rows: ValidatedAccountImportRow[];
  totalRows: number;
  newCount: number;
  existingCount: number;
  warningCount: number;
  errorCount: number;
  fileErrors: string[];
  canCommit: boolean;
}

function findFileParentCycle(code: string, parentCode: string, fileRowsByCode: Map<string, ParsedAccountRow>): boolean {
  let current = parentCode;
  const visited = new Set<string>();
  while (current) {
    if (current === code) return true;
    if (visited.has(current)) return false; // cycle lain yg sudah ada, bukan melibatkan `code`
    visited.add(current);
    const row = fileRowsByCode.get(current);
    if (!row || !row.parentCode) return false;
    current = row.parentCode;
  }
  return false;
}

export async function validateAccountsImportBatch(db: Knex, buffer: Buffer, fileName: string): Promise<AccountImportValidationResult> {
  const parsed = await parseAccountsImportExcel(buffer);

  const accountTypes = await db("account_types").select("id", "code");
  const accountTypeIdByCode = new Map(accountTypes.map((t: any) => [t.code as string, t.id as string]));

  const codes = parsed.rows.map((r) => r.code).filter(Boolean);
  const existingAccounts = codes.length ? await db("accounts").whereIn("code", codes).select("id", "code", "account_type_id") : [];
  const existingByCode = new Map(existingAccounts.map((a: any) => [a.code as string, a]));

  const fileRowsByCode = new Map(parsed.rows.filter((r) => r.code).map((r) => [r.code, r]));
  const codeCountInFile = new Map<string, number>();
  for (const r of parsed.rows) if (r.code) codeCountInFile.set(r.code, (codeCountInFile.get(r.code) ?? 0) + 1);

  const rows: ValidatedAccountImportRow[] = parsed.rows.map((row) => {
    const issues: string[] = [];
    if (!row.code) issues.push("Kode wajib diisi.");
    if (!row.name) issues.push("Nama Akun wajib diisi.");
    if (row.code && (codeCountInFile.get(row.code) ?? 0) > 1) issues.push(`Kode "${row.code}" muncul lebih dari sekali di file ini.`);

    if (!row.accountTypeRaw) issues.push("Tipe wajib diisi.");
    else if (!row.accountTypeCode || !accountTypeIdByCode.has(row.accountTypeCode)) {
      issues.push(`Tipe "${row.accountTypeRaw}" tidak dikenal -- lihat sheet Referensi.`);
    }

    if (row.normalBalanceRaw && !row.normalBalance) issues.push(`Saldo Normal "${row.normalBalanceRaw}" tidak dikenal (harus Debit/Kredit atau kosong).`);
    if (row.cashFlowActivityRaw && !row.cashFlowActivity) issues.push(`Aktivitas Arus Kas "${row.cashFlowActivityRaw}" tidak dikenal.`);
    if (row.subledgerTypeRaw && !row.subledgerType) issues.push(`Kartu "${row.subledgerTypeRaw}" tidak dikenal.`);

    if (row.parentCode) {
      if (row.parentCode === row.code) {
        issues.push("Akun tidak boleh menjadi induk (parent) bagi dirinya sendiri.");
      } else {
        const existingParent = existingByCode.get(row.parentCode);
        const fileParent = fileRowsByCode.get(row.parentCode);
        if (!existingParent && !fileParent) {
          issues.push(`Kode Induk "${row.parentCode}" tidak ditemukan (baik di database maupun di file ini).`);
        } else if (fileParent && findFileParentCycle(row.code, row.parentCode, fileRowsByCode)) {
          issues.push(`Kode Induk "${row.parentCode}" membentuk struktur melingkar (cycle) dgn akun ini.`);
        }
      }
    }

    const existingAccount = row.code ? existingByCode.get(row.code) : undefined;
    let status: AccountImportStatus;
    const rowIssues: string[] = [];
    if (existingAccount) {
      const accountTypeId = row.accountTypeCode ? accountTypeIdByCode.get(row.accountTypeCode) : undefined;
      if (accountTypeId && accountTypeId !== existingAccount.account_type_id) {
        status = "WARNING";
        rowIssues.push(`Kode "${row.code}" sudah ada di database dengan tipe yang berbeda -- baris ini akan DILEWATI, data existing tidak diubah.`);
      } else {
        status = "EXISTING";
      }
    } else {
      status = issues.length > 0 ? "ERROR" : "NEW";
      if (status === "ERROR") rowIssues.push(...issues);
    }

    return {
      rowNumber: row.rowNumber,
      code: row.code,
      name: row.name,
      accountTypeCode: row.accountTypeCode,
      parentCode: row.parentCode,
      normalBalance: row.normalBalance,
      isActive: row.isActive,
      isCash: row.isCash,
      cashFlowActivity: row.cashFlowActivity,
      subledgerType: row.subledgerType,
      status,
      issues: rowIssues,
    };
  });

  const newCount = rows.filter((r) => r.status === "NEW").length;
  const existingCount = rows.filter((r) => r.status === "EXISTING").length;
  const warningCount = rows.filter((r) => r.status === "WARNING").length;
  const errorCount = rows.filter((r) => r.status === "ERROR").length;

  return {
    fileName,
    rows,
    totalRows: rows.length,
    newCount,
    existingCount,
    warningCount,
    errorCount,
    fileErrors: parsed.fileErrors,
    canCommit: errorCount === 0 && newCount > 0 && parsed.fileErrors.length === 0,
  };
}

export class AccountImportHasErrorsError extends Error {
  readonly code = "ACCOUNT_IMPORT_HAS_ERRORS" as const;
}
export class AccountImportNothingToCommitError extends Error {
  readonly code = "ACCOUNT_IMPORT_NOTHING_TO_COMMIT" as const;
}

export interface AccountImportCommitResult {
  createdCount: number;
  skippedCount: number;
  createdCodes: string[];
}

/**
 * ATOMIC COMMIT (§15). Parent BISA mengacu ke akun lain yang JUGA baru
 * dibuat dlm batch ini (bukan hanya akun existing) -- diproses multi-pass
 * (induk dulu, baru anak), BUKAN berdasar urutan baris di file, karena
 * user bebas menulis anak sebelum induknya di spreadsheet.
 */
export async function commitAccountsImportBatch(
  db: Knex,
  validation: AccountImportValidationResult,
  actor: ActorContext,
): Promise<AccountImportCommitResult> {
  if (validation.errorCount > 0) {
    throw new AccountImportHasErrorsError("Tidak dapat commit: masih ada baris berstatus ERROR di file ini.");
  }
  const toCreate = validation.rows.filter((r) => r.status === "NEW");
  if (toCreate.length === 0) {
    throw new AccountImportNothingToCommitError("Tidak ada akun baru untuk di-commit (semua kode sudah ada di database).");
  }

  const createdCodes: string[] = [];

  await db.transaction(async (trx) => {
    const existingAccounts = await trx("accounts").select("id", "code");
    const idByCode = new Map<string, string>(existingAccounts.map((a: any) => [a.code as string, a.id as string]));

    const remaining = [...toCreate];
    while (remaining.length > 0) {
      const progressBefore = createdCodes.length;
      for (const row of [...remaining]) {
        const parentResolvable = !row.parentCode || idByCode.has(row.parentCode);
        if (!parentResolvable) continue;

        const parentAccountId = row.parentCode ? idByCode.get(row.parentCode)! : null;
        const accountType = await trx("account_types").where({ code: row.accountTypeCode! }).first();
        const normalBalance = row.normalBalance ?? (accountType.normal_balance as "debit" | "credit");

        const { id } = await createAccount(
          trx,
          {
            code: row.code,
            name: row.name,
            accountTypeCode: row.accountTypeCode!,
            normalBalance,
            parentAccountId,
            cashFlowActivity: row.cashFlowActivity,
            isCash: row.isCash,
            subledgerType: row.subledgerType,
          },
          actor,
        );
        if (row.isActive === false) {
          await trx("accounts").where({ id }).update({ is_active: false });
        }

        idByCode.set(row.code, id);
        createdCodes.push(row.code);
        remaining.splice(remaining.indexOf(row), 1);
      }
      if (createdCodes.length === progressBefore) {
        // Tidak seharusnya tercapai (validasi sudah membuktikan graph
        // acyclic & seluruh parent resolvable) -- fail-safe, bukan infinite loop.
        throw new Error("Gagal resolve urutan parent-child saat commit (kemungkinan data berubah di antara preview & commit).");
      }
    }

    await appendCompanyAudit(trx, {
      actor,
      action: "account.import",
      entityType: "account_import_batch",
      entityId: crypto.randomUUID(),
      after: {
        fileName: validation.fileName,
        createdCount: createdCodes.length,
        skippedCount: validation.totalRows - createdCodes.length,
        createdCodes,
      },
    });
  });

  return { createdCount: createdCodes.length, skippedCount: validation.totalRows - createdCodes.length, createdCodes };
}
