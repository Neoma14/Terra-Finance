import { isoDateSchema, isValidIsoDate } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import type { SessionUser } from "../auth/session-service.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug, CompanyNotFoundError } from "../../db/company/company-resolver.js";
import { InvalidCompanySlugError } from "../../db/system/company-db-path.js";
import {
  createDraftJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  deleteDraftJournalEntry,
  JournalPeriodRequiredError,
  JournalAlreadyPostedError,
  JournalNotPostableError,
  JournalNotBalancedError,
  JournalHasNoLinesError,
  JournalZeroAmountError,
  JournalInvalidLineError,
  JournalInvalidDateError,
  JournalReferenceExistsError,
  JournalReferenceReservedError,
  JournalEntryNotFoundError,
  JournalNotDraftError,
} from "../../db/company/journal-service.js";
import { FiscalPeriodNotFoundError, FiscalPeriodClosedError, FiscalPeriodLockedError } from "../../db/company/fiscal-period.js";
import { AccountNotFoundError, AccountInactiveError, AccountLockedError } from "../../db/company/account-service.js";
import { getJournalSettings, setMaxBackdateDays, JournalSettingsInvalidError } from "../../db/company/journal-policy.js";
import { CompanyProfileNotFoundError } from "../../db/company/company-profile-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import {
  resolveBranchAuthority,
  resolveWriteBranch,
  assertWritableObjectBranch,
  requireAccessibleBranch,
  replyBranchError,
} from "../../middleware/branch-authority.js";
import { JournalInterBranchLinkedError, JournalSystemProcessError } from "../../db/company/journal-service.js";

/**
 * API tipis utk Company DB journal (TASK-DB-ARCH-007) -- menyambungkan
 * `db/company/journal-service.ts` (TASK-DB-ARCH-005/006, TIDAK diubah
 * business logic-nya) ke HTTP, pakai authentication/session existing
 * (`requireAuth`, `modules/auth`). TIDAK ADA business rule baru di sini --
 * seluruh validasi fiscal period/balance/status tetap di service layer;
 * route hanya: autentikasi -> resolve Company DB -> bentuk ActorContext
 * dari session -> validasi BENTUK request (zod) -> panggil service ->
 * map error -> tutup koneksi.
 *
 * PATH PREFIX: "/api/company-db/:companySlug/..." -- SENGAJA BUKAN
 * "/api/c/:companySlug/journal" (prefix existing utk shared-DB lama,
 * `modules/journal/routes.ts`) karena keduanya backing store BERBEDA
 * TOTAL (terra-finance.sqlite vs company.db per-perusahaan) dan memakai
 * prefix yang sama akan collision/ambigu. Lihat Final Report bagian B utk
 * penjelasan lengkap keputusan ini.
 *
 * AUTHORIZATION (TASK-DB-ARCH-010 -- menutup vulnerability TASK-DB-ARCH-009):
 * tiap route sekarang `preHandler: [requireAuth, requireCompanyAccess, requirePermission(...)]`.
 * `requireCompanyAccess` (middleware/company-access-guard.ts) memverifikasi
 * company_access SEBELUM `openCompanyDbForSlug` dipanggil -- company.db
 * TIDAK PERNAH dibuka utk user yang tidak punya akses, terlepas dari apa
 * yang business service (journal-service.ts) akan lakukan. `role` yang
 * dipakai `requirePermission` SELALU dari `request.companyAccess` (hasil
 * verifikasi DB), TIDAK PERNAH dari body/params request.
 */

const journalLineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
  memo: z.string().optional().nullable(),
  counterpartyId: z.string().optional().nullable(),
});

const createJournalSchema = z.object({
  /** Opsional; bila diisi HARUS sama dengan cabang kerja aktif dan dalam akses user (divalidasi server). */
  branchId: z.string().min(1).optional(),
  referenceNo: z.string().min(1),
  description: z.string().optional().nullable(),
  periodId: z.string().min(1),
  entryDate: isoDateSchema,
  isOpeningBalance: z.boolean().optional(),
  lines: z.array(journalLineSchema).min(1),
});

// Reversal SELALU memakai periode & tanggal jurnal asli. Field di bawah
// dipertahankan opsional hanya agar klien lama tidak error; jika diisi dan
// berbeda dari jurnal asli, service menolak (400).
const reverseJournalSchema = z.object({
  targetPeriodId: z.string().min(1).optional(),
  reason: z.string().trim().min(1),
  reversalEntryDate: isoDateSchema.optional(),
});

// Proses "Reversal Jurnal" terpisah: pengguna menyebut referensi transaksi,
// tanggal transaksi, dan alasan. Referensi + tanggal harus cocok dengan
// jurnal asli (mencegah salah pilih jurnal).
const reversalByReferenceSchema = z.object({
  referenceNo: z.string().trim().min(1),
  entryDate: isoDateSchema,
  reason: z.string().trim().min(1),
});

const journalSettingsSchema = z.object({
  maxBackdateDays: z.number().int().min(0).max(3650).nullable(),
});

function actorFromSession(user: SessionUser): ActorContext {
  // `role` di `users` ('admin'|'staff') adalah role IN-APP klien, BUKAN
  // konsep "Administrator" (TTD maintenance, auth terpisah dgn token
  // bertanda tangan vendor -- modules/administrator/auth.ts). Route ini hanya dipasang
  // di belakang `requireAuth` (session user biasa), jadi actorType SELALU
  // 'user' -- TIDAK pernah diambil dari field request mana pun (§8/§21).
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

/** Map error dari company-resolver/journal-service ke HTTP response.
 * Pesan ke client SELALU lewat `toUserErrorMessage` (pola existing,
 * `lib/error-message.ts`) -- tidak pernah stack trace/path internal/SQL. */
async function fail(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (await replyBranchError(request, reply, err)) return reply;
  return sendServiceError(reply, err);
}

function sendServiceError(reply: FastifyReply, err: unknown) {
  if (
    err instanceof CompanyNotFoundError ||
    err instanceof FiscalPeriodNotFoundError ||
    err instanceof JournalEntryNotFoundError ||
    err instanceof AccountNotFoundError ||
    err instanceof CompanyProfileNotFoundError
  ) {
    return reply.code(404).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof InvalidCompanySlugError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (
    err instanceof JournalPeriodRequiredError ||
    err instanceof JournalNotBalancedError ||
    err instanceof JournalHasNoLinesError ||
    err instanceof JournalZeroAmountError ||
    err instanceof JournalInvalidLineError ||
    err instanceof JournalInvalidDateError ||
    err instanceof JournalSystemProcessError ||
    err instanceof JournalSettingsInvalidError
  ) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (
    err instanceof FiscalPeriodClosedError ||
    err instanceof FiscalPeriodLockedError ||
    err instanceof JournalAlreadyPostedError ||
    err instanceof JournalNotPostableError ||
    err instanceof JournalNotDraftError ||
    err instanceof JournalInterBranchLinkedError ||
    err instanceof JournalReferenceExistsError ||
    err instanceof JournalReferenceReservedError ||
    err instanceof AccountInactiveError ||
    err instanceof AccountLockedError
  ) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyJournalRoutes(app: FastifyInstance) {
  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const parsed = createJournalSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      let db;
      try {
        db = openCompanyDbForSlug(request.params.companySlug);
      } catch (err) {
        return fail(request, reply, err);
      }

      try {
        const data = parsed.data;
        const auth = await resolveBranchAuthority(request, db);
        const branch = resolveWriteBranch(auth, data.branchId);
        const { id } = await createDraftJournalEntry(
          db,
          {
            entryDate: data.entryDate,
            periodId: data.periodId,
            referenceNo: data.referenceNo,
            description: data.description ?? null,
            isOpeningBalance: data.isOpeningBalance ?? false,
            createdBy: request.authUser!.id,
            branchId: branch.id,
            lines: data.lines,
          },
          actorFromSession(request.authUser!),
        );
        return reply.code(201).send({ success: true, journalId: id, status: "DRAFT" });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/journal/:id/post",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.post")] },
    async (request, reply) => {
      let db;
      try {
        db = openCompanyDbForSlug(request.params.companySlug);
      } catch (err) {
        return fail(request, reply, err);
      }

      try {
        const target = await db("journal_entries").where({ id: request.params.id }).select("branch_id").first();
        if (target) assertWritableObjectBranch(await resolveBranchAuthority(request, db), target.branch_id);
        await postJournalEntry(db, { journalEntryId: request.params.id, postedBy: request.authUser!.id }, actorFromSession(request.authUser!));
        return reply.send({ success: true, journalId: request.params.id, status: "POSTED" });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/journal/:id/reverse",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.reverse")] },
    async (request, reply) => {
      const parsed = reverseJournalSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      let db;
      try {
        db = openCompanyDbForSlug(request.params.companySlug);
      } catch (err) {
        return fail(request, reply, err);
      }

      try {
        const original = await db("journal_entries").where({ id: request.params.id }).first();
        if (!original) return sendServiceError(reply, new JournalEntryNotFoundError(`Jurnal dengan id "${request.params.id}" tidak ditemukan.`));
        assertWritableObjectBranch(await resolveBranchAuthority(request, db), original.branch_id);

        const data = parsed.data;
        // Tanggal & periode reversal diturunkan dari jurnal asli oleh service;
        // nilai dari client (jika ada) hanya divalidasi, tidak pernah dipakai.
        const { id: reversalId } = await reverseJournalEntry(
          db,
          {
            journalEntryId: request.params.id,
            reversalPeriodId: data.targetPeriodId,
            reversalEntryDate: data.reversalEntryDate,
            reversalReferenceNo: `${original.reference_no}-REV`,
            reason: data.reason,
            reversedBy: request.authUser!.id,
          },
          actorFromSession(request.authUser!),
        );
        return reply.send({ success: true, originalJournalId: request.params.id, reversalJournalId: reversalId, status: "REVERSED" });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal/reversal",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.reverse")] },
    async (request, reply) => {
      const parsed = reversalByReferenceSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Referensi transaksi, tanggal transaksi, dan alasan reversal wajib diisi.", details: parsed.error.flatten() });

      let db;
      try {
        db = openCompanyDbForSlug(request.params.companySlug);
      } catch (err) {
        return fail(request, reply, err);
      }

      try {
        const data = parsed.data;
        const original = await db("journal_entries").where({ reference_no: data.referenceNo }).first();
        if (!original) {
          return sendServiceError(reply, new JournalEntryNotFoundError(`Jurnal dengan referensi "${data.referenceNo}" tidak ditemukan.`));
        }
        assertWritableObjectBranch(await resolveBranchAuthority(request, db), original.branch_id);
        const originalDate = String(original.entry_date).slice(0, 10);
        if (data.entryDate.slice(0, 10) !== originalDate) {
          return reply.code(400).send({ error: `Tanggal transaksi tidak cocok dengan jurnal "${data.referenceNo}" (tanggal jurnal: ${originalDate}). Reversal harus bertanggal sama dengan transaksi asli.` });
        }
        const { id: reversalId } = await reverseJournalEntry(
          db,
          {
            journalEntryId: original.id,
            reversalReferenceNo: `${original.reference_no}-REV`,
            reason: data.reason,
            reversedBy: request.authUser!.id,
          },
          actorFromSession(request.authUser!),
        );
        return reply.send({ success: true, originalJournalId: original.id, reversalJournalId: reversalId, reversalReferenceNo: `${original.reference_no}-REV`, reversalDate: originalDate, status: "REVERSED" });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal-settings",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        return reply.send(await getJournalSettings(db));
      } finally {
        await db.destroy();
      }
    },
  );

  app.put<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal-settings",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const parsed = journalSettingsSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Maksimal backdate harus bilangan bulat 0 sampai 3650 hari, atau kosong untuk tanpa batas.", details: parsed.error.flatten() });
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        await setMaxBackdateDays(db, parsed.data.maxBackdateDays, actorFromSession(request.authUser!));
        return reply.send({ success: true, ...(await getJournalSettings(db)) });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // §38 (TASK-DB-ARCH-011), DIPERLUAS TASK-DB-ARCH-014 §1 (filter tanggal/
  // search/status + pagination, utk Journal List UI baru) -- read-only,
  // gate "journal.read" tetap sama. HANYA menambah query-building di ROUTE
  // LAYER ini -- journal-service.ts TIDAK disentuh.
  app.get<{
    Params: { companySlug: string };
    Querystring: { periodId?: string; branchId?: string; fromDate?: string; toDate?: string; search?: string; status?: string; page?: string; pageSize?: string };
  }>(
    "/api/company-db/:companySlug/journals",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const q = request.query;
        for (const [k, v] of [["fromDate", q.fromDate], ["toDate", q.toDate]] as const) {
          if (v && !isValidIsoDate(v)) return reply.code(400).send({ error: `${k} "${v}" bukan tanggal yang valid (format YYYY-MM-DD).` });
        }
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));

        // Multi-Branch: daftar jurnal dibatasi ke cabang kerja aktif (atau satu cabang dalam akses bila `branchId` diberikan).
        const auth = await resolveBranchAuthority(request, db);
        const visibleBranchIds = q.branchId ? [requireAccessibleBranch(auth, q.branchId).id] : auth.context ? [auth.context.id] : [];
        let base = db("journal_entries").whereIn("branch_id", visibleBranchIds);
        if (q.periodId) base = base.where({ period_id: q.periodId });
        if (q.fromDate) base = base.andWhere("entry_date", ">=", q.fromDate);
        if (q.toDate) base = base.andWhere("entry_date", "<=", q.toDate);
        if (q.status) base = base.andWhere({ status: q.status });
        if (q.search) {
          base = base.andWhere((builder) => {
            builder.whereRaw("lower(reference_no) like ?", [`%${q.search!.toLowerCase()}%`]).orWhereRaw("lower(description) like ?", [
              `%${q.search!.toLowerCase()}%`,
            ]);
          });
        }

        const countRow = await base.clone().count<{ count: string }>({ count: "*" }).first();
        const journals = await base
          .clone()
          .select(
            "id",
            "entry_date as entryDate",
            "reference_no as referenceNo",
            "description",
            "status",
            "is_opening_balance as isOpeningBalance",
            "period_id as periodId",
            "branch_id as branchId",
            "origin",
          )
          .orderBy("entry_date", "desc")
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        return reply.send({ journals, total: Number(countRow?.count ?? 0), page, pageSize });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/journals/:id",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const entry = await db("journal_entries").where({ id: request.params.id }).first();
        if (!entry) return sendServiceError(reply, new JournalEntryNotFoundError(`Jurnal dengan id "${request.params.id}" tidak ditemukan.`));
        // Di luar akses -> 404 yang sama dengan "tidak ada" (tidak membocorkan jurnal cabang lain).
        requireAccessibleBranch(await resolveBranchAuthority(request, db), entry.branch_id);
        const lines = await db("journal_entry_lines").where({ journal_entry_id: request.params.id }).orderBy("line_order");
        return reply.send({ journal: entry, lines });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // §44 (TASK-DB-ARCH-014): Delete -- HANYA DRAFT (ditegakkan di
  // `deleteDraftJournalEntry`, journal-service.ts). Gate `journal.create`
  // (permission yang sama dgn membuat draft -- menghapus draft sendiri
  // adalah bagian dari siklus yang sama, bukan operasi destruktif baru
  // thd data yang sudah efektif).
  app.delete<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/journal/:id",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const target = await db("journal_entries").where({ id: request.params.id }).select("branch_id").first();
        if (target) assertWritableObjectBranch(await resolveBranchAuthority(request, db), target.branch_id);
        await deleteDraftJournalEntry(db, request.params.id, actorFromSession(request.authUser!));
        return reply.send({ success: true, journalId: request.params.id });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // §44: Edit -- HANYA DRAFT. BUKAN fungsi "update" baru di journal-
  // service.ts -- orkestrasi di ROUTE LAYER ini: hapus draft lama + buat
  // draft baru, DI DALAM SATU transaction luar (atomic, pola nested-
  // transaction yang sama dgn journal-import-service.ts) supaya tidak
  // pernah berakhir "draft lama terhapus tapi draft baru gagal dibuat".
  app.put<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/journal/:id",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const parsed = createJournalSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      const actor = actorFromSession(request.authUser!);
      try {
        const data = parsed.data;
        let newId = "";
        const target = await db("journal_entries").where({ id: request.params.id }).select("branch_id").first();
        const targetBranchId: string | undefined = target?.branch_id ?? undefined;
        if (target) assertWritableObjectBranch(await resolveBranchAuthority(request, db), target.branch_id);
        await db.transaction(async (trx) => {
          await deleteDraftJournalEntry(trx, request.params.id, actor);
          const created = await createDraftJournalEntry(
            trx,
            {
              entryDate: data.entryDate,
              periodId: data.periodId,
              referenceNo: data.referenceNo,
              description: data.description ?? null,
              isOpeningBalance: data.isOpeningBalance ?? false,
              createdBy: request.authUser!.id,
              branchId: targetBranchId,
              lines: data.lines,
            },
            actor,
          );
          newId = created.id;
        });
        return reply.send({ success: true, journalId: newId, status: "DRAFT" });
      } catch (err) {
        request.log.error(err);
        return fail(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
