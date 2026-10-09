import { isoDateSchema } from "../../lib/calendar-date.js";
import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: rute legacy ini SEBELUMNYA cuma requireAuth (user mana pun yg
// login bisa akses company APA SAJA via slug -- IDOR/BOLA, lihat audit
// keamanan). Company lama SEKARANG sudah dimigrasi otomatis ke registry
// baru (lihat db/system/legacy-company-migration.ts, dijalankan tiap
// startup) dgn slug yg SAMA PERSIS -- `requireCompanyAccess` (cek thd
// registry+company_access baru) karena itu valid dipasang di sini juga,
// TANPA perlu sistem akses terpisah utk rute lama.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";
import { buildJournalHistoryWorkbook } from "./export-history.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { parseJournalExcel } from "./parser.js";
import { createJournalEntry, findOrCreatePeriodForDate, recomputeTrialBalanceForPeriod, reverseJournalEntry } from "./posting.js";
import { buildJournalTemplate } from "./template.js";

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
  memo: z.string().optional(),
  counterpartyId: z.string().optional().nullable(),
});

const manualEntrySchema = z.object({
  entryDate: isoDateSchema,
  referenceNo: z.string().optional(),
  description: z.string().optional(),
  lines: z.array(lineSchema).min(2),
});

const commitLineSchema = z.object({
  code: z.string().min(1), // kode akun (mis. "1100") dari hasil preview -- diresolve ke id di handler
  debit: z.number().min(0),
  credit: z.number().min(0),
  memo: z.string().optional(),
  counterpartyName: z.string().optional(),
});

const commitEntrySchema = z.object({
  referenceNo: z.string().nullable().optional(),
  date: z.string().min(1),
  description: z.string().optional(),
  lines: z.array(commitLineSchema).min(2),
});

const commitSchema = z.object({
  entries: z.array(commitEntrySchema).min(1),
});

const reversalSchema = z.object({
  reversalDate: z.string().min(1),
  referenceNo: z.string().min(1),
});

/**
 * Jurnal manual + riwayat + upload/commit massal dari Excel + export Excel
 * -- logika & field disamakan persis dgn modules/journal/routes.ts versi
 * online, scoped `company_id`.
 */
export async function journalRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/journal/template",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const accounts = await masterDb("accounts")
        .where({ company_id: company.id })
        .select("code", "name", "subledger_type as subledgerType")
        .orderBy("code");
      const buffer = await buildJournalTemplate(company.name, accounts);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="Template Jurnal - ${company.name}.xlsx"`)
        .send(buffer);
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/journal/preview",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan" });

      const buffer = await file.toBuffer();
      const parsed = await parseJournalExcel(buffer);

      const codes = [...new Set(parsed.entries.flatMap((e) => e.lines.map((l) => l.code)))];
      const knownAccounts = codes.length
        ? await masterDb("accounts").where({ company_id: company.id }).whereIn("code", codes).select("code")
        : [];
      const knownCodes = new Set(knownAccounts.map((a: any) => a.code));

      // Cek nomor jurnal yang SUDAH ADA di database -- entry begini BUKAN
      // error, tapi otomatis DILEWATI saat commit (lihat handler /commit di
      // bawah), supaya upload ulang file yang sebagian datanya sudah lama
      // diinput tidak perlu diedit manual dulu satu-satu.
      const referenceNos = [...new Set(parsed.entries.map((e) => e.referenceNo).filter((r): r is string => Boolean(r)))];
      const existingRefs = referenceNos.length
        ? await masterDb("journal_entries").where({ company_id: company.id }).whereIn("reference_no", referenceNos).select("reference_no")
        : [];
      const existingRefSet = new Set(existingRefs.map((r: any) => r.reference_no));

      for (const entry of parsed.entries) {
        entry.unknownAccountCodes = [...new Set(entry.lines.map((l) => l.code).filter((c) => !knownCodes.has(c)))];
        entry.alreadyExists = Boolean(entry.referenceNo && existingRefSet.has(entry.referenceNo));
      }

      const allBalanced = parsed.entries.every((e) => e.alreadyExists || (e.isBalanced && e.unknownAccountCodes.length === 0));
      return reply.send({ entries: parsed.entries, fileErrors: parsed.fileErrors, allBalanced });
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/journal/commit",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = commitSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      // SEMUA langkah di bawah dibungkus satu try/catch besar -- upload bisa
      // berisi ribuan transaksi, dan tanpa ini exception apapun yang lolos
      // akan jatuh ke default error handler generik, bukan pesan spesifik.
      const companyId = company.id;

      try {
        const accounts = await masterDb("accounts").where({ company_id: companyId }).select("id", "code", "subledger_type", "account_type");
        const accountByCode = new Map(accounts.map((a: any) => [a.code, a]));

        const referenceNos = [...new Set(parsed.data.entries.map((e) => e.referenceNo).filter((r): r is string => Boolean(r)))];
        const existingRefs = referenceNos.length
          ? await masterDb("journal_entries").where({ company_id: company.id }).whereIn("reference_no", referenceNos).select("reference_no")
          : [];
        const existingRefSet = new Set(existingRefs.map((r: any) => r.reference_no));

        // Cache counterparty yang sudah dicari/dibuat dalam commit ini supaya
        // nama vendor/pelanggan yang sama di banyak baris/entry tidak
        // membuat baris "counterparties" duplikat.
        const counterpartyCache = new Map<string, string>(); // key `${type}:${name.toLowerCase()}` -> id
        async function resolveCounterpartyId(subledgerType: string, name: string): Promise<string> {
          const type = subledgerType === "payable" ? "vendor" : "customer";
          const key = `${type}:${name.trim().toLowerCase()}`;
          const cached = counterpartyCache.get(key);
          if (cached) return cached;

          const existing = await masterDb("counterparties")
            .where({ company_id: companyId, type })
            .whereRaw("lower(name) = ?", [name.trim().toLowerCase()])
            .first();
          if (existing) {
            counterpartyCache.set(key, existing.id);
            return existing.id;
          }

          const id = crypto.randomUUID();
          const code = `${type === "vendor" ? "V" : "C"}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
          await masterDb("counterparties").insert({ id, company_id: companyId, type, code, name: name.trim() });
          counterpartyCache.set(key, id);
          return id;
        }

        // Validasi ulang di server (jangan cuma percaya preview client)
        // sebelum menyentuh DB sama sekali -- tolak semuanya kalau ADA satu
        // yang gagal. Periode TIDAK diminta dari user -- ditentukan (atau
        // dibuat otomatis per bulan kalender kalau belum ada) per entry dari
        // tanggalnya sendiri.
        const resolvedEntries: {
          referenceNo: string | null;
          date: string;
          periodId: string;
          description?: string;
          lines: { accountId: string; debit: number; credit: number; memo?: string; counterpartyId?: string }[];
        }[] = [];
        const skippedReferenceNumbers: string[] = [];
        for (const entry of parsed.data.entries) {
          if (entry.referenceNo && existingRefSet.has(entry.referenceNo)) {
            skippedReferenceNumbers.push(entry.referenceNo);
            continue;
          }

          const totalDebit = entry.lines.reduce((s, l) => s + l.debit, 0);
          const totalCredit = entry.lines.reduce((s, l) => s + l.credit, 0);
          if (Math.abs(totalDebit - totalCredit) > 1) {
            return reply.code(400).send({
              error: `Entry tanggal ${entry.date}${entry.referenceNo ? ` (${entry.referenceNo})` : ""} tidak balance: debit ${totalDebit} vs kredit ${totalCredit}`,
            });
          }

          const period = await findOrCreatePeriodForDate(masterDb, company.id, entry.date);

          const resolvedLines: { accountId: string; debit: number; credit: number; memo?: string; counterpartyId?: string }[] = [];
          for (const line of entry.lines) {
            const account = accountByCode.get(line.code);
            if (!account) {
              return reply.code(400).send({ error: `Kode akun "${line.code}" tidak ditemukan (entry tanggal ${entry.date})` });
            }
            let counterpartyId: string | undefined;
            if (line.counterpartyName?.trim()) {
              const subledgerType =
                account.subledger_type ?? (account.account_type === "asset" ? "receivable" : account.account_type === "liability" ? "payable" : null);
              if (subledgerType) {
                counterpartyId = await resolveCounterpartyId(subledgerType, line.counterpartyName);
              }
            }
            resolvedLines.push({ accountId: account.id, debit: line.debit, credit: line.credit, memo: line.memo, counterpartyId });
          }

          resolvedEntries.push({ referenceNo: entry.referenceNo ?? null, date: entry.date, periodId: period.id, description: entry.description, lines: resolvedLines });
        }

        // Posting SEMUA entry dulu TANPA recompute per-entry (skipRecompute),
        // baru recompute SEKALI per periode yang benar-benar terdampak di
        // akhir -- recompute men-scan semua akun+baris jurnal 1 periode
        // penuh, jadi mengulanginya per-entry (bisa ribuan kali utk file
        // besar) akan sangat lambat. SELURUH loop dibungkus SATU transaksi
        // luar -- kalau ada SATU entry gagal, SEMUA yang sempat berhasil di
        // batch ini ikut di-ROLLBACK.
        const created =
          resolvedEntries.length === 0
            ? []
            : await masterDb.transaction(async (trx) => {
                const createdRefs: string[] = [];
                const affectedPeriodIds = new Set<string>();
                for (const entry of resolvedEntries) {
                  const result = await createJournalEntry(trx, {
                    companyId: company.id,
                    entryDate: entry.date,
                    periodId: entry.periodId,
                    referenceNo: entry.referenceNo,
                    description: entry.description,
                    source: "import",
                    lines: entry.lines,
                    skipRecompute: true,
                  });
                  createdRefs.push(result.referenceNo);
                  affectedPeriodIds.add(entry.periodId);
                }

                for (const periodId of affectedPeriodIds) {
                  await recomputeTrialBalanceForPeriod(trx, company.id, periodId);
                }

                return createdRefs;
              });

        return reply.send({
          createdCount: created.length,
          referenceNumbers: created,
          skippedCount: skippedReferenceNumbers.length,
          skippedReferenceNumbers,
        });
      } catch (err) {
        request.log.error(err);
        return reply.code(409).send({ error: toUserErrorMessage(err) });
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/journal/manual",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = manualEntrySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const period = await findOrCreatePeriodForDate(masterDb, company.id, parsed.data.entryDate);

      try {
        const result = await createJournalEntry(masterDb, {
          companyId: company.id,
          entryDate: parsed.data.entryDate,
          periodId: period.id,
          referenceNo: parsed.data.referenceNo,
          description: parsed.data.description,
          source: "manual",
          createdBy: request.authUser!.id,
          lines: parsed.data.lines,
        });
        return reply.code(201).send(result);
      } catch (err) {
        request.log.error(err);
        return reply.code(409).send({ error: toUserErrorMessage(err) });
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/journal/reversal",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = reversalSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      try {
        const result = await reverseJournalEntry(masterDb, {
          companyId: company.id,
          reversalDate: parsed.data.reversalDate,
          referenceNo: parsed.data.referenceNo,
          createdBy: request.authUser!.id,
        });
        return reply.send(result);
      } catch (err) {
        request.log.error(err);
        return reply.code(409).send({ error: toUserErrorMessage(err) });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { periodId?: string; from?: string; to?: string } }>(
    "/api/c/:companySlug/journal",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { periodId, from, to } = request.query;
      const query = masterDb("journal_entry_lines as jel")
        .join("journal_entries as je", "je.id", "jel.journal_entry_id")
        .join("accounts as a", "a.id", "jel.account_id")
        .where("je.company_id", company.id)
        .select(
          "jel.journal_entry_id as journalEntryId",
          "a.code as accountCode",
          "a.name as accountName",
          "je.entry_date as entryDate",
          "je.reference_no as referenceNo",
          "je.description",
          "je.is_reversed as isReversed",
          "je.reversal_of_id as reversalOfId",
          "jel.debit",
          "jel.credit",
        )
        .orderBy("je.entry_date", "asc")
        .orderBy("je.reference_no", "asc")
        .orderBy("jel.debit", "desc");

      if (periodId) query.andWhere("je.period_id", periodId);
      if (from) query.andWhere("je.entry_date", ">=", from);
      if (to) query.andWhere("je.entry_date", "<=", to);

      const rows = await query;
      const lines = rows.map((r: any) => ({
        journalEntryId: r.journalEntryId,
        accountCode: r.accountCode,
        accountName: r.accountName,
        entryDate: r.entryDate,
        referenceNo: r.referenceNo,
        description: r.description,
        debit: Number(r.debit),
        credit: Number(r.credit),
        isReversed: !!r.isReversed,
        reversalOfId: r.reversalOfId,
      }));
      return reply.send({ lines });
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/journal/export",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      const rows = await masterDb("journal_entry_lines as jel")
        .join("journal_entries as je", "je.id", "jel.journal_entry_id")
        .join("accounts as a", "a.id", "jel.account_id")
        .where("je.company_id", company.id)
        .andWhere("je.entry_date", ">=", from)
        .andWhere("je.entry_date", "<=", to)
        .orderBy("je.entry_date", "asc")
        .orderBy("je.reference_no", "asc")
        .orderBy("jel.debit", "desc")
        .select(
          "a.code as accountCode",
          "a.name as accountName",
          "je.entry_date as entryDate",
          "je.reference_no as referenceNo",
          "je.description",
          "je.is_reversed as isReversed",
          "je.reversal_of_id as reversalOfId",
          "jel.debit",
          "jel.credit",
        );

      const exportRows = rows.map((r: any) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        entryDate: r.entryDate,
        referenceNo: r.referenceNo,
        description: r.description,
        isReversed: !!r.isReversed,
        reversalOfId: r.reversalOfId,
        debit: Number(r.debit),
        credit: Number(r.credit),
      }));

      const buffer = await buildJournalHistoryWorkbook(company.name, `${from} s/d ${to}`, exportRows);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="Riwayat Jurnal - ${company.name}.xlsx"`)
        .send(buffer);
    },
  );

  app.get<{ Params: { companySlug: string; id: string } }>(
    "/api/c/:companySlug/journal/:id",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const entry = await masterDb("journal_entries").where({ id: request.params.id, company_id: company.id }).first();
      if (!entry) return reply.code(404).send({ error: "Jurnal tidak ditemukan" });

      const lines = await masterDb("journal_entry_lines as jel")
        .join("accounts as a", "a.id", "jel.account_id")
        .leftJoin("counterparties as cp", "cp.id", "jel.counterparty_id")
        .where("jel.journal_entry_id", entry.id)
        .select(
          "jel.id",
          "jel.account_id as accountId",
          "a.code as accountCode",
          "a.name as accountName",
          "jel.debit",
          "jel.credit",
          "jel.memo",
          "jel.counterparty_id as counterpartyId",
          "cp.name as counterpartyName",
        );

      return reply.send({
        entry: {
          id: entry.id,
          entryDate: entry.entry_date,
          periodId: entry.period_id,
          referenceNo: entry.reference_no,
          description: entry.description,
          source: entry.source,
          isReversed: !!entry.is_reversed,
          reversalOfId: entry.reversal_of_id,
          createdAt: entry.created_at,
          lines,
        },
      });
    },
  );
}
