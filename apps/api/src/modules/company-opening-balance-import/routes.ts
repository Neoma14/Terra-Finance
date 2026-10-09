import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UnreadableExcelFileError } from "../../lib/excel-upload.js";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { listAccounts } from "../../db/company/account-service.js";
import { validateOpeningBalanceImportBatch, commitOpeningBalanceImportBatch, OpeningBalanceImportHasErrorsError } from "../../db/company/opening-balance-import-service.js";
import { OpeningBalanceAlreadyExistsError, OpeningBalanceDuplicateAccountError } from "../../db/company/opening-balance-service.js";
import { buildOpeningBalanceImportTemplate } from "./template.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import { resolveBranchAuthority, resolveWriteBranch, replyBranchError } from "../../middleware/branch-authority.js";

/**
 * Opening Balance Import API (TASK-DB-ARCH-016 §10-17). Pola IDENTIK dgn
 * `company-journal-import`/`company-accounts-import` (TASK-DB-ARCH-014/
 * 015): `/commit` me-RE-PARSE & RE-VALIDASI file dari awal. Permission
 * commit butuh `journal.create` DAN `journal.post` (commit = create+post
 * langsung, sama alasannya dgn journal import -- cegah STAFF auto-post
 * lewat jalur import).
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
  if (err instanceof OpeningBalanceImportHasErrorsError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof OpeningBalanceAlreadyExistsError || err instanceof OpeningBalanceDuplicateAccountError) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyOpeningBalanceImportRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance-import/template",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const accounts = await listAccounts(db, { isActive: true });
        const profile = await db("company_profile").first();
        const buffer = await buildOpeningBalanceImportTemplate(profile?.name ?? request.params.companySlug, accounts);
        return reply
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="Template Opening Balance.xlsx"`)
          .send(buffer);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance-import/preview",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan." });
      const buffer = await file.toBuffer();

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const result = await validateOpeningBalanceImportBatch(db, buffer, file.filename, branch.id);
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
    "/api/company-db/:companySlug/opening-balance-import/commit",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create"), requirePermission("journal.post")] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan." });
      const buffer = await file.toBuffer();

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const validation = await validateOpeningBalanceImportBatch(db, buffer, file.filename, branch.id);
        const result = await commitOpeningBalanceImportBatch(db, validation, actorFromSession(request.authUser!));
        return reply.send({ success: true, ...result });
      } catch (err) {
        request.log.error(err);
        return failImport(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
