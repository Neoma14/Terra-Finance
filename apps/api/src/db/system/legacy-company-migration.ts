import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { masterDb } from "../master/index.js";
import { systemDb } from "./index.js";
import { findCompanyRegistryBySlug, insertCompanyRegistry } from "./companies-registry.js";
import { grantCompanyAccess } from "./company-access.js";
import { appendSystemAudit, type SystemActorContext } from "./system-audit.js";
import { ensureSystemIdentity } from "./identity-bridge.js";
import { getCompanyDataRoot } from "../company/company-resolver.js";
import { createCompanyDb } from "../company/index.js";
import { provisionCompanyDb } from "../company/company-provisioning.js";
import { createAccount, updateAccount } from "../company/account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "../company/journal-service.js";
import { appendCompanyAudit, type ActorContext } from "../company/company-audit.js";
import type { SessionUser } from "../../modules/auth/session-service.js";

/**
 * TASK-020 -- Migrasi SATU KALI (idempoten, aman dijalankan tiap startup)
 * dari perusahaan "legacy" (`masterDb.companies`, tanpa kontrol akses
 * per-user sama sekali -- lihat komentar di migrations/0008_create_companies.ts
 * "semua user di instalasi ini bisa lihat semua perusahaan") ke arsitektur
 * baru (`systemDb.companies_registry` + `company_access` per-role + file
 * company.db sendiri, ADR-001 Option B).
 *
 * KENAPA INI DIPERLUKAN: audit keamanan (TASK-020) menemukan rute
 * `/api/c/:companySlug/*` (journal/accounts/ledger/dll lama) TIDAK PUNYA
 * pengecekan akses per-perusahaan sama sekali (requireAuth saja) -- user
 * mana pun yang login bisa baca/tulis company APA SAJA di rute ini hanya
 * dgn tahu slug-nya. Memasang `requireCompanyAccess` BEGITU SAJA di rute
 * lama akan membuatnya 404 PERMANEN utk SEMUA company lama (company_access
 * blm pernah diisi utk mereka) -- lebih merusak drpd bug yg diperbaiki.
 * Solusi yg benar: migrasikan datanya ke arsitektur baru (yg SUDAH py
 * kontrol akses benar), lalu alihkan UI "Perusahaan" ke jalur baru, baru
 * rute lama yang berbahaya dicabut (lihat server.ts).
 *
 * DIJALANKAN SETELAH runMigrations()/runSystemMigrations() (server.ts) --
 * BUTUH kedua skema itu sudah siap. Satu company legacy yang gagal
 * dimigrasi TIDAK BOLEH menghentikan startup server atau migrasi company
 * lain -- dicatat ke console.error/warn, dilewati, server tetap jalan
 * (company itu tetap ada di masterDb, bisa dicoba lagi migrasinya di
 * startup berikutnya krn fungsi ini idempoten per-company).
 */

const MIGRATION_ACTOR_LABEL = "Migrasi Otomatis dari Sistem Lama (TASK-020)";

const KNOWN_LEGACY_ACCOUNT_TYPES = new Set(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);

function legacyAccountTypeToCode(accountType: string): string {
  const upper = String(accountType ?? "").toUpperCase();
  return KNOWN_LEGACY_ACCOUNT_TYPES.has(upper) ? upper : "ASSET";
}

function generateMigratedReferenceNo(legacyId: string): string {
  return `LEGACY-${legacyId.slice(0, 8).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

export async function migrateLegacyCompaniesToNewArchitecture(): Promise<void> {
  const legacyCompanies = await masterDb("companies").select("*");
  for (const company of legacyCompanies) {
    try {
      await migrateOneLegacyCompany(company);
    } catch (err) {
      console.error(
        `[legacy-company-migration] GAGAL memigrasi company lama "${company.slug}" (${company.name}) -- dilewati, akan dicoba lagi saat startup berikutnya:`,
        err,
      );
    }
  }
}

async function migrateOneLegacyCompany(company: any): Promise<void> {
  const alreadyMigrated = await findCompanyRegistryBySlug(systemDb, company.slug);
  if (alreadyMigrated) return;

  console.log(`[legacy-company-migration] Memigrasi company lama "${company.name}" (slug: "${company.slug}")...`);

  let creator = company.created_by ? await masterDb("users").where({ id: company.created_by }).first() : undefined;
  if (!creator) {
    // Data lama bisa saja kehilangan created_by (user yg bikin sudah
    // dihapus, dsb) -- fallback ke user aktif TERLAMA di instalasi ini
    // supaya company tetap bisa dimigrasi dgn SATU owner yang jelas drpd
    // gagal total. Dicatat sbg warning (bukan dilewati diam-diam).
    creator = await masterDb("users").where({ is_active: true }).orderBy("created_at", "asc").first();
    if (creator) {
      console.warn(
        `[legacy-company-migration] Company "${company.slug}" tidak py created_by valid -- owner baru diisi user tertua ("${creator.email}").`,
      );
    }
  }
  if (!creator) {
    throw new Error(`Tidak ada satu pun user aktif di instalasi ini -- tidak bisa menentukan owner utk company "${company.slug}".`);
  }

  const creatorSessionUser: SessionUser = {
    id: creator.id,
    email: creator.email,
    fullName: creator.full_name,
    role: creator.role,
    avatarUrl: null,
  };

  const provisioned = await provisionCompanyDb({
    dataRoot: getCompanyDataRoot(),
    slug: company.slug,
    profile: {
      name: company.name,
      industry: company.industry ?? null,
      industryTemplate: company.industry_template ?? "general",
      currency: company.currency ?? "IDR",
      fiscalYearStartMonth: company.fiscal_year_start_month ?? 1,
    },
  });

  const registryId = crypto.randomUUID();
  const accessId = crypto.randomUUID();
  const systemUserId = await ensureSystemIdentity(systemDb, creatorSessionUser);
  const sysActor: SystemActorContext = { actorType: "system", actorId: null, actorLabel: MIGRATION_ACTOR_LABEL };

  try {
    await systemDb.transaction(async (trx) => {
      await insertCompanyRegistry(trx, {
        id: registryId,
        slug: company.slug,
        name: company.name,
        databasePath: provisioned.databasePath,
        schemaVersion: provisioned.migrationsApplied,
        createdBy: systemUserId,
      });
      await grantCompanyAccess(trx, { id: accessId, systemUserId, companyId: registryId, role: "OWNER" });
      await appendSystemAudit(trx, {
        actor: sysActor,
        action: "company.register",
        entityType: "companies_registry",
        entityId: registryId,
        companyId: registryId,
        after: { slug: company.slug, name: company.name, migratedFromLegacyCompanyId: company.id },
      });
      await appendSystemAudit(trx, {
        actor: sysActor,
        action: "company.access.granted",
        entityType: "company_access",
        entityId: accessId,
        companyId: registryId,
        after: { systemUserId, role: "OWNER", reason: "legacy_migration" },
      });
    });
  } catch (err) {
    try {
      fs.rmSync(path.dirname(provisioned.databasePath), { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(`[legacy-company-migration] Cleanup folder gagal utk "${company.slug}":`, cleanupErr);
    }
    throw err;
  }

  await migrateLegacyAccountingData(company, provisioned.databasePath, registryId);
}

async function migrateLegacyAccountingData(company: any, databasePath: string, registryId: string): Promise<void> {
  const db = createCompanyDb(databasePath);
  const actor: ActorContext = { actorType: "system", actorId: null, actorLabel: MIGRATION_ACTOR_LABEL };

  try {
    // --- Accounts (multi-pass -- parent_account_id bisa forward-reference,
    // pola SAMA dgn account-import-service.ts commitAccountsImportBatch) ---
    const legacyAccounts = await masterDb("accounts").where({ company_id: company.id }).select("*");
    const legacyToNewAccountId = new Map<string, string>();
    let remaining = [...legacyAccounts];
    let guard = 0;
    while (remaining.length > 0 && guard <= legacyAccounts.length + 1) {
      guard++;
      const stillRemaining: typeof remaining = [];
      for (const acc of remaining) {
        const parentReady = !acc.parent_account_id || legacyToNewAccountId.has(acc.parent_account_id);
        if (!parentReady) {
          stillRemaining.push(acc);
          continue;
        }
        const { id: newId } = await createAccount(
          db,
          {
            code: acc.code,
            name: acc.name,
            accountTypeCode: legacyAccountTypeToCode(acc.account_type),
            normalBalance: acc.normal_balance === "credit" ? "credit" : "debit",
            accountSubtype: acc.account_subtype ?? null,
            parentAccountId: acc.parent_account_id ? (legacyToNewAccountId.get(acc.parent_account_id) ?? null) : null,
            cashFlowActivity: acc.cash_flow_activity ?? null,
            isCash: Boolean(acc.is_cash),
            subledgerType: acc.subledger_type ?? null,
          },
          actor,
        );
        legacyToNewAccountId.set(acc.id, newId);
        if (!acc.is_active) {
          await updateAccount(db, newId, { isActive: false }, actor);
        }
      }
      if (stillRemaining.length === remaining.length) {
        console.warn(
          `[legacy-company-migration] "${company.slug}": ${stillRemaining.length} akun dilewati (parent tidak ditemukan/cycle di data lama).`,
        );
        break;
      }
      remaining = stillRemaining;
    }

    // --- Periods (insert langsung -- data migrasi murni, bukan aksi user
    // live, jadi tidak lewat service layer; status SEMENTARA dipaksa OPEN
    // supaya jurnal bisa diposting di bawah, dikembalikan ke status asli
    // di akhir fungsi ini) ---
    const legacyPeriods = await masterDb("periods").where({ company_id: company.id }).select("*");
    const legacyToNewPeriodId = new Map<string, string>();
    for (const p of legacyPeriods) {
      const newId = crypto.randomUUID();
      await db("periods").insert({
        id: newId,
        label: p.label,
        start_date: p.start_date,
        end_date: p.end_date,
        period_type: p.period_type,
        fiscal_year: p.fiscal_year,
        status: "OPEN",
      });
      legacyToNewPeriodId.set(p.id, newId);
    }

    // --- Journal entries + lines -- LEWAT createDraftJournalEntry +
    // postJournalEntry sungguhan (bukan raw insert) supaya seluruh
    // validasi/audit trail/invariant yang sama dgn entry live tetap
    // berlaku utk data hasil migrasi ini (balance check, dst). Legacy
    // TIDAK punya konsep DRAFT (lihat migrations/0010 -- tidak ada kolom
    // status), jadi setiap entry lama dianggap sudah POSTED. ---
    const legacyEntries = await masterDb("journal_entries")
      .where({ company_id: company.id })
      .orderBy("entry_date", "asc")
      .select("*");
    const legacyToNewJournalId = new Map<string, string>();
    const usedReferenceNos = new Set<string>();

    for (const entry of legacyEntries) {
      const periodId = legacyToNewPeriodId.get(entry.period_id);
      if (!periodId) {
        console.warn(`[legacy-company-migration] "${company.slug}": jurnal "${entry.id}" dilewati -- periode tidak ditemukan.`);
        continue;
      }
      const legacyLines = await masterDb("journal_entry_lines").where({ journal_entry_id: entry.id }).select("*");
      const mappedLines = legacyLines
        .map((l: any) => {
          const accountId = legacyToNewAccountId.get(l.account_id);
          return accountId ? { accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? null } : null;
        })
        .filter((l): l is { accountId: string; debit: number; credit: number; memo: string | null } => l !== null);

      if (mappedLines.length !== legacyLines.length || mappedLines.length === 0) {
        console.warn(
          `[legacy-company-migration] "${company.slug}": jurnal "${entry.id}" dilewati -- ada baris dgn akun yang tidak berhasil dimigrasi.`,
        );
        continue;
      }

      let referenceNo: string = entry.reference_no ?? generateMigratedReferenceNo(entry.id);
      while (usedReferenceNos.has(referenceNo)) referenceNo = generateMigratedReferenceNo(entry.id);
      usedReferenceNos.add(referenceNo);

      try {
        const { id: newJournalId } = await createDraftJournalEntry(
          db,
          {
            entryDate: entry.entry_date,
            periodId,
            referenceNo,
            description: entry.description ?? null,
            source: entry.source === "import" ? "import" : "manual",
            lines: mappedLines,
          },
          actor,
        );
        await postJournalEntry(db, { journalEntryId: newJournalId }, actor);
        legacyToNewJournalId.set(entry.id, newJournalId);
      } catch (err) {
        console.warn(
          `[legacy-company-migration] "${company.slug}": jurnal "${entry.id}" (ref lama: ${entry.reference_no ?? "-"}) GAGAL dimigrasi: ${(err as Error).message}`,
        );
      }
    }

    // --- Tandai pasangan reversal (legacy: is_reversed + reversal_of_id --
    // SETELAH keduanya sudah diposting di atas sbg entry independen) ---
    for (const entry of legacyEntries) {
      if (!entry.reversal_of_id) continue;
      const newReversalId = legacyToNewJournalId.get(entry.id);
      const newOriginalId = legacyToNewJournalId.get(entry.reversal_of_id);
      if (!newReversalId || !newOriginalId) continue;
      await db("journal_entries").where({ id: newOriginalId }).update({ status: "REVERSED", is_reversed: true });
      await db("journal_entries").where({ id: newReversalId }).update({ reversal_of_journal_id: newOriginalId });
    }

    // --- Kembalikan status period final (legacy cuma py is_closed boolean,
    // tidak ada LOCKED -- dipetakan ke CLOSED, selain itu tetap OPEN) ---
    for (const p of legacyPeriods) {
      if (!p.is_closed) continue;
      const newId = legacyToNewPeriodId.get(p.id);
      if (!newId) continue;
      await db("periods").where({ id: newId }).update({ status: "CLOSED", closed_at: new Date().toISOString() });
    }

    await appendCompanyAudit(db, {
      actor,
      action: "company.migrated_from_legacy",
      entityType: "company",
      entityId: registryId,
      after: {
        legacyCompanyId: company.id,
        accountsMigrated: legacyToNewAccountId.size,
        periodsMigrated: legacyToNewPeriodId.size,
        journalsMigrated: legacyToNewJournalId.size,
      },
    });

    console.log(
      `[legacy-company-migration] "${company.slug}" selesai: ${legacyToNewAccountId.size} akun, ${legacyToNewPeriodId.size} periode, ${legacyToNewJournalId.size} jurnal dimigrasi.`,
    );
  } finally {
    await db.destroy();
  }
}
