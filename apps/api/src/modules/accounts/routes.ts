import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { recordAudit } from "../audit/service.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";
import { carryAccountForward, createJournalEntry, findOrCreatePeriodForDate } from "../journal/posting.js";
import { getLedgerBalancesForRange } from "../ledger/balances-range.js";
import { attachFallbackStatementLine } from "./statement-line-fallback.js";
import { buildAccountsWorkbook } from "./export.js";
import { buildAccountsImportTemplate } from "./import-template.js";
import { parseAccountsExcel } from "./import-parser.js";

const importCommitRowSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  accountSubtype: z.string().min(1).max(50),
  normalBalance: z.enum(["debit", "credit"]),
  cashFlowActivity: z.enum(["operating", "investing", "financing"]).optional(),
  isCash: z.boolean().optional(),
  subledgerType: z.enum(["payable", "receivable"]).nullable().optional(),
  openingBalance: z.number().min(0).optional(),
});

const importCommitSchema = z.object({
  openingDate: z.string().optional(),
  rows: z.array(importCommitRowSchema).min(1),
});

const createAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  accountSubtype: z.string().min(1).max(50),
  normalBalance: z.enum(["debit", "credit"]),
  cashFlowActivity: z.enum(["operating", "investing", "financing"]).optional(),
  isCash: z.boolean().optional(),
  subledgerType: z.enum(["payable", "receivable"]).nullable().optional(),
  statementLineId: z.string().optional(),
  /** Saldo awal opsional untuk akun BARU -- sama persis logikanya dgn versi
   * online (posting jurnal "Saldo Awal" berpasangan dgn akun ekuitas
   * penyeimbang, lalu carry-forward maju dari periode itu). */
  openingBalance: z
    .object({
      amount: z.number().positive(),
      periodId: z.string().min(1),
    })
    .optional(),
});

/** Nama & kode akun ekuitas penyeimbang untuk jurnal "Saldo Awal" akun baru
 * -- sama persis logikanya dgn versi online. */
const OPENING_BALANCE_EQUITY_CODE = "3900";
const OPENING_BALANCE_EQUITY_NAME = "Saldo Awal (Penyesuaian)";

async function findOrCreateOpeningBalanceEquityAccount(trx: any, companyId: string): Promise<string> {
  const existing = await trx("accounts").where({ company_id: companyId, code: OPENING_BALANCE_EQUITY_CODE }).first();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await trx("accounts").insert({
    id,
    company_id: companyId,
    code: OPENING_BALANCE_EQUITY_CODE,
    name: OPENING_BALANCE_EQUITY_NAME,
    account_type: "equity",
    account_subtype: "opening_balance_adjustment",
    normal_balance: "credit",
  });
  await attachFallbackStatementLine(trx, companyId, id, "equity");
  return id;
}

const updateAccountSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]).optional(),
  accountSubtype: z.string().min(1).max(50).optional(),
  normalBalance: z.enum(["debit", "credit"]).optional(),
  cashFlowActivity: z.enum(["operating", "investing", "financing"]).nullable().optional(),
  isCash: z.boolean().optional(),
  subledgerType: z.enum(["payable", "receivable"]).nullable().optional(),
  statementLineId: z.string().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Chart of Accounts per perusahaan -- logika field & validasi disamakan
 * persis dgn modules/accounts/routes.ts versi online. BEDA/BELUM ADA di
 * fase ini (menyusul di Fase 3 "Jurnal & Buku Besar" karena butuh tabel
 * `periods`/`journal_entries` yang belum dibuat):
 *  - Input "Saldo Awal" saat tambah akun (posting jurnal otomatis).
 *  - Kolom saldo/mutasi di daftar akun (perlu trial_balance_snapshots).
 *  - Export Excel/Print (perlu data saldo per periode).
 * List & CRUD dasar (kode, nama, tipe, sub-tipe, saldo normal, mapping
 * baris laporan, status aktif) sudah lengkap & bisa dipakai sekarang.
 */
export async function accountsRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/accounts",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const accounts = await masterDb("accounts as a")
        .leftJoin("statement_line_accounts as sla", "sla.account_id", "a.id")
        .leftJoin("statement_lines as sl", "sl.id", "sla.statement_line_id")
        .where("a.company_id", company.id)
        .select(
          "a.id",
          "a.code",
          "a.name",
          "a.account_type as accountType",
          "a.account_subtype as accountSubtype",
          "a.normal_balance as normalBalance",
          "a.parent_account_id as parentAccountId",
          "a.is_active as isActive",
          "a.cash_flow_activity as cashFlowActivity",
          "a.is_cash as isCash",
          "a.subledger_type as subledgerType",
          "sl.id as statementLineId",
          "sl.line_code as statementLineCode",
          "sl.line_label as statementLineLabel",
        )
        .orderBy("a.code");
      return reply.send({ accounts });
    },
  );

  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/statement-lines",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const lines = await masterDb("statement_lines")
        .where({ company_id: company.id })
        .whereIn("statement_type", ["balance_sheet", "income_statement"])
        .orderBy(["statement_type", "display_order"])
        .select("id", "statement_type as statementType", "line_code as lineCode", "line_label as lineLabel", "display_order as displayOrder");
      return reply.send({ lines });
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/accounts",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = createAccountSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const data = parsed.data;

      const existing = await masterDb("accounts").where({ company_id: company.id, code: data.code }).first();
      if (existing) return reply.code(409).send({ error: `Kode akun "${data.code}" sudah dipakai` });

      const expectedStatementType = data.accountType === "revenue" || data.accountType === "expense" ? "income_statement" : "balance_sheet";
      let statementLine: { id: string; statement_type: string } | undefined;
      if (data.statementLineId) {
        statementLine = await masterDb("statement_lines").where({ id: data.statementLineId, company_id: company.id }).first();
        if (!statementLine) return reply.code(400).send({ error: "Baris laporan (mapping) tidak ditemukan" });
        if (statementLine.statement_type !== expectedStatementType) {
          return reply.code(400).send({
            error: `Baris laporan yang dipilih untuk jenis akun "${data.accountType}" harus dari laporan ${expectedStatementType === "balance_sheet" ? "Neraca" : "Laba Rugi"}`,
          });
        }
      }

      let openingPeriod: { id: string; start_date: string } | undefined;
      if (data.openingBalance) {
        openingPeriod = await masterDb("periods").where({ id: data.openingBalance.periodId, company_id: company.id }).first();
        if (!openingPeriod) return reply.code(400).send({ error: "Periode saldo awal tidak ditemukan" });
      }

      const accountId = crypto.randomUUID();
      const equityAccountId = await masterDb.transaction(async (trx) => {
        await trx("accounts").insert({
          id: accountId,
          company_id: company.id,
          code: data.code,
          name: data.name,
          account_type: data.accountType,
          account_subtype: data.accountSubtype,
          normal_balance: data.normalBalance,
          cash_flow_activity: data.cashFlowActivity ?? null,
          is_cash: data.isCash ?? false,
          subledger_type: data.subledgerType ?? null,
        });

        if (statementLine) {
          await trx("statement_line_accounts").insert({ id: crypto.randomUUID(), statement_line_id: statementLine.id, account_id: accountId });
        } else {
          await attachFallbackStatementLine(trx, company.id, accountId, data.accountType);
        }

        if (data.openingBalance && openingPeriod) {
          return findOrCreateOpeningBalanceEquityAccount(trx, company.id);
        }
        return null;
      });

      // Posting jurnal "Saldo Awal" + carry-forward maju DI LUAR transaksi
      // di atas -- createJournalEntry/carryAccountForward buka transaksi
      // sendiri (better-sqlite3 tidak dukung nested transaction).
      if (data.openingBalance && openingPeriod && equityAccountId) {
        const amount = data.openingBalance.amount;
        const debitNew = data.normalBalance === "debit" ? amount : 0;
        const creditNew = data.normalBalance === "credit" ? amount : 0;
        await createJournalEntry(masterDb, {
          companyId: company.id,
          entryDate: openingPeriod.start_date,
          periodId: openingPeriod.id,
          description: `Saldo Awal - ${data.name}`,
          source: "manual",
          createdBy: request.authUser?.id ?? null,
          skipRecompute: true,
          lines: [
            { accountId, debit: debitNew, credit: creditNew },
            { accountId: equityAccountId, debit: creditNew, credit: debitNew },
          ],
        });
        await carryAccountForward(masterDb, company.id, accountId, openingPeriod.id);
        await carryAccountForward(masterDb, company.id, equityAccountId, openingPeriod.id);
      }

      await recordAudit(masterDb, {
        actorType: "user",
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.fullName,
        action: "account.create",
        entityType: "accounts",
        entityId: accountId,
        after: { code: data.code, name: data.name, accountType: data.accountType },
      });

      return reply.code(201).send({ id: accountId });
    },
  );

  app.patch<{ Params: { companySlug: string; id: string } }>(
    "/api/c/:companySlug/accounts/:id",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = updateAccountSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const data = parsed.data;

      const account = await masterDb("accounts").where({ id: request.params.id, company_id: company.id }).first();
      if (!account) return reply.code(404).send({ error: "Akun tidak ditemukan" });

      const normalBalanceChanged = data.normalBalance !== undefined && data.normalBalance !== account.normal_balance;
      const accountTypeChanged = data.accountType !== undefined && data.accountType !== account.account_type;

      const nextAccountType = data.accountType ?? account.account_type;
      let statementLine: { id: string; statement_type: string } | undefined;
      if (data.statementLineId) {
        statementLine = await masterDb("statement_lines").where({ id: data.statementLineId, company_id: company.id }).first();
        if (!statementLine) return reply.code(400).send({ error: "Baris laporan (mapping) tidak ditemukan" });
        const expectedStatementType = nextAccountType === "revenue" || nextAccountType === "expense" ? "income_statement" : "balance_sheet";
        if (statementLine.statement_type !== expectedStatementType) {
          return reply.code(400).send({
            error: `Baris laporan yang dipilih untuk jenis akun "${nextAccountType}" harus dari laporan ${expectedStatementType === "balance_sheet" ? "Neraca" : "Laba Rugi"}`,
          });
        }
      }

      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch.name = data.name;
      if (data.accountType !== undefined) patch.account_type = data.accountType;
      if (data.accountSubtype !== undefined) patch.account_subtype = data.accountSubtype;
      if (data.normalBalance !== undefined) patch.normal_balance = data.normalBalance;
      if (data.cashFlowActivity !== undefined) patch.cash_flow_activity = data.cashFlowActivity;
      if (data.isCash !== undefined) patch.is_cash = data.isCash;
      if (data.subledgerType !== undefined) patch.subledger_type = data.subledgerType;
      if (data.isActive !== undefined) patch.is_active = data.isActive;

      await masterDb.transaction(async (trx) => {
        if (Object.keys(patch).length > 0) {
          await trx("accounts").where({ id: request.params.id }).update(patch);
        }
        if (statementLine) {
          await trx("statement_line_accounts")
            .whereIn("statement_line_id", trx("statement_lines").where({ company_id: company.id, statement_type: statementLine.statement_type }).select("id"))
            .andWhere({ account_id: request.params.id })
            .delete();
          await trx("statement_line_accounts").insert({ id: crypto.randomUUID(), statement_line_id: statementLine.id, account_id: request.params.id });
        }
      });

      await recordAudit(masterDb, {
        actorType: "user",
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.fullName,
        action: "account.update",
        entityType: "accounts",
        entityId: request.params.id,
        before: { name: account.name, isActive: !!account.is_active },
        after: data,
      });

      // account_type/normal_balance dipakai carryAccountForward (posting.ts)
      // utk arah debit/kredit & carry-forward -- kalau berubah, saldo akun
      // INI SAJA perlu di-carry-forward ulang, sama persis logikanya dgn
      // versi online (lihat komentar di sana).
      if (normalBalanceChanged || accountTypeChanged) {
        const earliestActivity = await masterDb("journal_entry_lines as jel")
          .join("journal_entries as je", "je.id", "jel.journal_entry_id")
          .join("periods as p", "p.id", "je.period_id")
          .where("jel.account_id", request.params.id)
          .orderBy("p.start_date", "asc")
          .first("p.id as periodId");
        if (earliestActivity) {
          await carryAccountForward(masterDb, company.id, request.params.id, earliestActivity.periodId);
        }
      }

      return reply.send({ success: true });
    },
  );

  // Hapus akun -- HANYA diizinkan kalau akun BELUM PERNAH dipakai di jurnal
  // manapun (tidak ada baris trial_balance_snapshots/journal_entry_lines
  // yang mereferensikannya) DAN bukan induk akun lain. Ini otomatis
  // menjamin syarat "saldo harus 0" (akun yang belum pernah dipakai
  // trivally bersaldo 0), SEKALIGUS mencegah jurnal lama yang sudah
  // diposting jadi rusak/tidak lengkap kalau salah satu barisnya
  // kehilangan akun rujukannya -- SQLite menolak DELETE lewat FK constraint
  // (PRAGMA foreign_keys ON) kalau dipaksa, jadi dicek dulu di sini supaya
  // pesan error-nya jelas, bukan error DB mentah.
  app.delete<{ Params: { companySlug: string; id: string } }>(
    "/api/c/:companySlug/accounts/:id",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const account = await masterDb("accounts").where({ id: request.params.id, company_id: company.id }).first();
      if (!account) return reply.code(404).send({ error: "Akun tidak ditemukan" });

      const hasJournalActivity = await masterDb("journal_entry_lines").where({ account_id: account.id }).first();
      if (hasJournalActivity) {
        return reply.code(409).send({ error: "Akun ini sudah pernah dipakai di jurnal, tidak bisa dihapus (nonaktifkan saja kalau tidak dipakai lagi)." });
      }

      const hasSnapshot = await masterDb("trial_balance_snapshots").where({ account_id: account.id }).first();
      if (hasSnapshot) {
        return reply.code(409).send({ error: "Akun ini masih punya catatan saldo, tidak bisa dihapus (nonaktifkan saja kalau tidak dipakai lagi)." });
      }

      const hasChildAccount = await masterDb("accounts").where({ parent_account_id: account.id }).first();
      if (hasChildAccount) {
        return reply.code(409).send({ error: "Akun ini adalah induk dari akun lain, tidak bisa dihapus." });
      }

      await masterDb("accounts").where({ id: account.id }).delete();

      await recordAudit(masterDb, {
        actorType: "user",
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.fullName,
        action: "account.delete",
        entityType: "accounts",
        entityId: account.id,
        before: { code: account.code, name: account.name },
      });

      return reply.send({ success: true });
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/accounts/export/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      let balances;
      try {
        balances = await getLedgerBalancesForRange(masterDb, company.id, from, to);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const rangeLabel = `${from} s/d ${to}`;
      const balanceRows = balances.map((b) => ({
        code: b.code,
        name: b.name,
        accountType: b.accountType,
        beginningBalance: b.beginningBalance,
        debitTotal: b.debitTotal,
        creditTotal: b.creditTotal,
        endingBalance: b.endingBalance,
      }));

      const buffer = await buildAccountsWorkbook(company.name, rangeLabel, balanceRows);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="Chart of Accounts - ${company.name} - ${rangeLabel}.xlsx"`)
        .send(buffer);
    },
  );

  // --- Import Chart of Accounts + Saldo Awal dari Excel -- fitur BARU
  // (tidak ada di versi online), utk konsultan yg pindah dari software
  // lama & sudah punya daftar akun+saldo sendiri, drpd input manual
  // satu-satu lewat modal "Tambah Akun". ---
  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/accounts/import/template",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const buffer = await buildAccountsImportTemplate(company.name);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="Template Import Akun - ${company.name}.xlsx"`)
        .send(buffer);
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/accounts/import/preview",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan" });

      const buffer = await file.toBuffer();
      const parsed = await parseAccountsExcel(buffer);

      const codes = parsed.rows.map((r) => r.code).filter(Boolean);
      const existingAccounts = codes.length ? await masterDb("accounts").where({ company_id: company.id }).whereIn("code", codes).select("code") : [];
      const existingCodes = new Set(existingAccounts.map((a: any) => a.code));
      for (const row of parsed.rows) {
        row.alreadyExists = existingCodes.has(row.code);
      }

      const allValid = parsed.rows.every((r) => r.alreadyExists || r.errors.length === 0);
      return reply.send({ rows: parsed.rows, fileErrors: parsed.fileErrors, openingDate: parsed.openingDate, allValid });
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/accounts/import/commit",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = importCommitSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
      const data = parsed.data;

      const needsOpeningDate = data.rows.some((r) => (r.openingBalance ?? 0) > 0);
      if (needsOpeningDate && !data.openingDate) {
        return reply.code(400).send({ error: "Tanggal Saldo Awal wajib diisi karena ada baris dengan saldo awal" });
      }

      const existing = await masterDb("accounts").where({ company_id: company.id }).select("code");
      const existingCodes = new Set(existing.map((a: any) => a.code));

      const newRows = data.rows.filter((r) => !existingCodes.has(r.code));
      const skippedCodes = data.rows.filter((r) => existingCodes.has(r.code)).map((r) => r.code);

      try {
        const openingPeriod = needsOpeningDate ? await findOrCreatePeriodForDate(masterDb, company.id, data.openingDate!) : null;

        const createdAccountIds: string[] = [];
        let equityAccountId: string | null = null;

        await masterDb.transaction(async (trx) => {
          for (const row of newRows) {
            const accountId = crypto.randomUUID();
            await trx("accounts").insert({
              id: accountId,
              company_id: company.id,
              code: row.code,
              name: row.name,
              account_type: row.accountType,
              account_subtype: row.accountSubtype,
              normal_balance: row.normalBalance,
              cash_flow_activity: row.cashFlowActivity ?? null,
              is_cash: row.isCash ?? false,
              subledger_type: row.subledgerType ?? null,
            });
            await attachFallbackStatementLine(trx, company.id, accountId, row.accountType);
            createdAccountIds.push(accountId);
          }

          if (openingPeriod && newRows.some((r) => (r.openingBalance ?? 0) > 0)) {
            equityAccountId = await findOrCreateOpeningBalanceEquityAccount(trx, company.id);
          }
        });

        // Posting jurnal "Saldo Awal" tiap akun + carry-forward DI LUAR
        // transaksi di atas -- createJournalEntry/carryAccountForward buka
        // transaksi sendiri (better-sqlite3 tidak dukung nested transaction).
        // Sama persis polanya dgn POST /accounts (satu akun), diulang per
        // baris di sini.
        if (openingPeriod && equityAccountId) {
          for (let i = 0; i < newRows.length; i++) {
            const row = newRows[i];
            const amount = row.openingBalance ?? 0;
            if (amount <= 0) continue;
            const accountId = createdAccountIds[i];
            const debitNew = row.normalBalance === "debit" ? amount : 0;
            const creditNew = row.normalBalance === "credit" ? amount : 0;
            await createJournalEntry(masterDb, {
              companyId: company.id,
              entryDate: data.openingDate!,
              periodId: openingPeriod.id,
              description: `Saldo Awal - ${row.name}`,
              source: "import",
              createdBy: request.authUser?.id ?? null,
              skipRecompute: true,
              lines: [
                { accountId, debit: debitNew, credit: creditNew },
                { accountId: equityAccountId, debit: creditNew, credit: debitNew },
              ],
            });
            await carryAccountForward(masterDb, company.id, accountId, openingPeriod.id);
          }
          await carryAccountForward(masterDb, company.id, equityAccountId, openingPeriod.id);
        }

        await recordAudit(masterDb, {
          actorType: "user",
          actorId: request.authUser!.id,
          actorLabel: request.authUser!.fullName,
          action: "account.import",
          entityType: "accounts",
          entityId: company.id,
          after: { createdCount: newRows.length, skippedCount: skippedCodes.length },
        });

        return reply.send({ createdCount: newRows.length, skippedCount: skippedCodes.length, skippedCodes });
      } catch (err) {
        request.log.error(err);
        return reply.code(409).send({ error: (err as Error).message });
      }
    },
  );
}
