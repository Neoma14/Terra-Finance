import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UnreadableExcelFileError } from "../../lib/excel-upload.js";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { listAccounts } from "../../db/company/account-service.js";
import {
  validateJournalImportBatch,
  commitJournalImportBatch,
  JournalImportHasErrorsError,
  JournalImportNothingToCommitError,
} from "../../db/company/journal-import-service.js";
import { buildCompanyJournalImportTemplate } from "./template.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import { resolveBranchAuthority, resolveWriteBranch, replyBranchError } from "../../middleware/branch-authority.js";

/**
 * Journal Import API (TASK-DB-ARCH-014 §2-6) -- "TERRA Import Standard"
 * (§7): UPLOAD -> PARSE -> VALIDATE -> PREVIEW -> USER CONFIRM -> COMMIT
 * -> AUDIT. Pola otorisasi SAMA dgn `company-journal/routes.ts`.
 *
 * `/preview` dan `/commit` KEDUANYA menerima file (bukan JSON hasil
 * preview) -- `/commit` me-RE-PARSE & RE-VALIDASI file yang sama dari
 * awal, TIDAK percaya hasil preview sebelumnya (§3/§5 instruksi: "upload
 * tidak boleh langsung masuk DB", "validasi ulang"). Desain ini SENGAJA
 * lebih ketat & lebih sederhana dari pola commit shared-DB lama (yang
 * mengirim balik JSON terstruktur ke /commit) -- tidak butuh session
 * cache/store baru di server; frontend menyimpan `File` yang sama di
 * state React supaya user tidak perlu pilih file ulang kalau commit
 * gagal (§5 "pertahankan data preview/import session bila memungkinkan").
 *
 * Permission commit MEMBUTUHKAN `journal.create` DAN `journal.post`
 * (bukan salah satu) -- commit membuat DRAFT lalu langsung POST dlm satu
 * langkah, jadi role yang hanya punya journal.create (STAFF, lihat
 * db/system/rbac.ts) TIDAK BOLEH commit import (akan bisa auto-post tanpa
 * izin journal.post kalau hanya dicek satu permission -- privilege
 * escalation lewat jalur import, dicegah di sini).
 */

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

async function failImport(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (await replyBranchError(request, reply, err)) return reply;
  return sendImportError(reply, err);
}

function sendImportError(reply: FastifyReply, err: unknown) {
  if (err instanceof UnreadableExcelFileError) {
    return reply.code(400).send({ error: err.message });
  }
  if (err instanceof JournalImportHasErrorsError || err instanceof JournalImportNothingToCommitError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyJournalImportRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal-import/template",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const accounts = await listAccounts(db, { isActive: true });
        const profile = await db("company_profile").first();
        const buffer = await buildCompanyJournalImportTemplate(profile?.name ?? request.params.companySlug, accounts);
        return reply
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="Template Jurnal.xlsx"`)
          .send(buffer);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal-import/preview",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan." });
      const buffer = await file.toBuffer();

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const result = await validateJournalImportBatch(db, buffer, file.filename, branch.id);
        return reply.send(result);
      } catch (err) {
        request.log.error(err);
        return failImport(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/journal-import/commit",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create"), requirePermission("journal.post")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan." });
      const buffer = await file.toBuffer();

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const validation = await validateJournalImportBatch(db, buffer, file.filename, branch.id);
        const result = await commitJournalImportBatch(db, validation, actorFromSession(request.authUser!));
        return reply.send({ success: true, ...result });
      } catch (err) {
        request.log.error(err);
        return failImport(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // §6: Import History -- REUSE `company_audit_log` existing (TIDAK ada
  // tabel/sistem audit baru), filter action='journal.import'.
  app.get<{ Params: { companySlug: string }; Querystring: { page?: string; pageSize?: string } }>(
    "/api/company-db/:companySlug/journal-import/history",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const page = Math.max(1, Number(request.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));

        const baseQuery = db("company_audit_log").where({ action: "journal.import" });
        const countRow = await baseQuery.clone().count<{ count: string }>({ count: "*" }).first();
        const rows = await baseQuery
          .clone()
          .select("id", "actor_label as actorLabel", "created_at as createdAt", "after_json as afterJson")
          .orderBy("created_at", "desc")
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        const history = rows.map((r: any) => ({
          id: r.id,
          actorLabel: r.actorLabel,
          createdAt: r.createdAt,
          ...JSON.parse(r.afterJson ?? "{}"),
        }));

        return reply.send({ history, total: Number(countRow?.count ?? 0), page, pageSize });
      } finally {
        await db.destroy();
      }
    },
  );
}
