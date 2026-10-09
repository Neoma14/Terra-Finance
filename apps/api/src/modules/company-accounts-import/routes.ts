import type { FastifyInstance, FastifyReply } from "fastify";
import { UnreadableExcelFileError } from "../../lib/excel-upload.js";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import {
  validateAccountsImportBatch,
  commitAccountsImportBatch,
  AccountImportHasErrorsError,
  AccountImportNothingToCommitError,
} from "../../db/company/account-import-service.js";
import { buildAccountsImportTemplate } from "./template.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";

/**
 * COA Import API (TASK-DB-ARCH-015 §10-16). Pola IDENTIK dgn
 * `modules/company-journal-import/routes.ts` (TASK-DB-ARCH-014):
 * `/preview` dan `/commit` KEDUANYA menerima file, `/commit` me-RE-PARSE
 * & RE-VALIDASI dari awal (tidak percaya hasil preview sebelumnya).
 *
 * Permission: `account.create` cukup utk preview DAN commit (berbeda dari
 * journal import yg butuh create+post -- COA import murni CREATE, tidak
 * ada tahap kedua spt posting jurnal).
 */

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendImportError(reply: FastifyReply, err: unknown) {
  if (err instanceof UnreadableExcelFileError) {
    return reply.code(400).send({ error: err.message });
  }
  if (err instanceof AccountImportHasErrorsError || err instanceof AccountImportNothingToCommitError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyAccountsImportRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/accounts-import/template",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.create")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const profile = await db("company_profile").first();
        const buffer = await buildAccountsImportTemplate(profile?.name ?? request.params.companySlug);
        return reply
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="Template Import Akun.xlsx"`)
          .send(buffer);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/accounts-import/preview",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.create")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan." });
      const buffer = await file.toBuffer();

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const result = await validateAccountsImportBatch(db, buffer, file.filename);
        return reply.send(result);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/accounts-import/commit",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.create")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan." });
      const buffer = await file.toBuffer();

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const validation = await validateAccountsImportBatch(db, buffer, file.filename);
        const result = await commitAccountsImportBatch(db, validation, actorFromSession(request.authUser!));
        return reply.send({ success: true, ...result });
      } catch (err) {
        request.log.error(err);
        return sendImportError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // §16: Import History -- reuse `company_audit_log` (action
  // 'account.import'), TIDAK ADA tabel baru. Pola sama dgn journal-import.
  app.get<{ Params: { companySlug: string }; Querystring: { page?: string; pageSize?: string } }>(
    "/api/company-db/:companySlug/accounts-import/history",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const page = Math.max(1, Number(request.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize) || 20));

        const baseQuery = db("company_audit_log").where({ action: "account.import" });
        const countRow = await baseQuery.clone().count<{ count: string }>({ count: "*" }).first();
        const rows = await baseQuery
          .clone()
          .select("id", "actor_label as actorLabel", "created_at as createdAt", "after_json as afterJson")
          .orderBy("created_at", "desc")
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        const history = rows.map((r: any) => ({ id: r.id, actorLabel: r.actorLabel, createdAt: r.createdAt, ...JSON.parse(r.afterJson ?? "{}") }));
        return reply.send({ history, total: Number(countRow?.count ?? 0), page, pageSize });
      } finally {
        await db.destroy();
      }
    },
  );
}
