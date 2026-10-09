import { isoDateSchema } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import {
  getOpeningBalance,
  createOpeningBalanceEntry,
  updateOpeningBalanceDraft,
  deleteOpeningBalanceDraft,
  postOpeningBalance,
  reverseOpeningBalance,
  OpeningBalanceAlreadyExistsError,
  OpeningBalanceNotFoundError,
  OpeningBalanceDuplicateAccountError,
  OpeningBalanceNotEditableError,
} from "../../db/company/opening-balance-service.js";
import {
  JournalPeriodRequiredError,
  JournalNotBalancedError,
  JournalHasNoLinesError,
  JournalZeroAmountError,
  JournalInvalidLineError,
  JournalInvalidDateError,
  JournalReferenceExistsError,
  JournalAlreadyPostedError,
  JournalNotPostableError,
  JournalNotDraftError,
  JournalEntryNotFoundError,
} from "../../db/company/journal-service.js";
import { FiscalPeriodNotFoundError, FiscalPeriodClosedError, FiscalPeriodLockedError } from "../../db/company/fiscal-period.js";
import { AccountNotFoundError, AccountInactiveError, AccountLockedError } from "../../db/company/account-service.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import { resolveBranchAuthority, requireContextBranch, resolveWriteBranch, replyBranchError } from "../../middleware/branch-authority.js";

/**
 * Opening Balance API (TASK-DB-ARCH-016 §3-9, §21). TIDAK ADA parameter
 * `:id` di URL -- hanya SATU opening balance aktif per company (service
 * layer yang menegakkan ini, lihat opening-balance-service.ts), jadi
 * route selalu beroperasi pada "yang aktif", bukan id arbitrary dari
 * client (defense tambahan thd privilege/company-isolation issue).
 *
 * Permission: `journal.*` (bukan permission baru) -- opening balance
 * SECARA HARFIAH adalah journal entry (is_opening_balance=true), jadi
 * gate yang sama dgn Journal module (TASK-DB-ARCH-014) dipakai apa adanya.
 */

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
  memo: z.string().optional().nullable(),
});
const upsertSchema = z.object({
  entryDate: isoDateSchema,
  periodId: z.string().min(1),
  lines: z.array(lineSchema).min(1),
});
const reverseSchema = z.object({
  targetPeriodId: z.string().min(1).optional(),
  reason: z.string().min(1),
  reversalEntryDate: isoDateSchema.optional(),
});

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

async function failOb(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (await replyBranchError(request, reply, err)) return reply;
  return sendOpeningBalanceError(reply, err);
}

function sendOpeningBalanceError(reply: FastifyReply, err: unknown) {
  if (err instanceof OpeningBalanceNotFoundError || err instanceof FiscalPeriodNotFoundError || err instanceof AccountNotFoundError || err instanceof JournalEntryNotFoundError) {
    return reply.code(404).send({ error: toUserErrorMessage(err) });
  }
  if (
    err instanceof JournalPeriodRequiredError ||
    err instanceof JournalNotBalancedError ||
    err instanceof JournalHasNoLinesError ||
    err instanceof JournalZeroAmountError ||
    err instanceof JournalInvalidLineError ||
    err instanceof JournalInvalidDateError ||
    err instanceof OpeningBalanceDuplicateAccountError
  ) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (
    err instanceof OpeningBalanceAlreadyExistsError ||
    err instanceof OpeningBalanceNotEditableError ||
    err instanceof FiscalPeriodClosedError ||
    err instanceof FiscalPeriodLockedError ||
    err instanceof JournalAlreadyPostedError ||
    err instanceof JournalNotPostableError ||
    err instanceof JournalNotDraftError ||
    err instanceof JournalReferenceExistsError ||
    err instanceof AccountInactiveError ||
    err instanceof AccountLockedError
  ) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyOpeningBalanceRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = requireContextBranch(await resolveBranchAuthority(request, db));
        return reply.send({ ...(await getOpeningBalance(db, branch.id)), branchId: branch.id });
      } catch (err) {
        request.log.error(err);
        return failOb(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const parsed = upsertSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const { id } = await createOpeningBalanceEntry(db, parsed.data, actorFromSession(request.authUser!), branch.id);
        return reply.code(201).send({ success: true, id, status: "DRAFT" });
      } catch (err) {
        request.log.error(err);
        return failOb(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.put<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const parsed = upsertSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const { id } = await updateOpeningBalanceDraft(db, parsed.data, actorFromSession(request.authUser!), branch.id);
        return reply.send({ success: true, id, status: "DRAFT" });
      } catch (err) {
        request.log.error(err);
        return failOb(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.delete<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.create")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        await deleteOpeningBalanceDraft(db, actorFromSession(request.authUser!), branch.id);
        return reply.send({ success: true });
      } catch (err) {
        request.log.error(err);
        return failOb(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance/post",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.post")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        await postOpeningBalance(db, actorFromSession(request.authUser!), branch.id);
        return reply.send({ success: true, status: "POSTED" });
      } catch (err) {
        request.log.error(err);
        return failOb(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/opening-balance/reverse",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.reverse")] },
    async (request, reply) => {
      const parsed = reverseSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const branch = resolveWriteBranch(await resolveBranchAuthority(request, db));
        const { id } = await reverseOpeningBalance(db, parsed.data, actorFromSession(request.authUser!), branch.id);
        return reply.send({ success: true, reversalJournalId: id, status: "REVERSED" });
      } catch (err) {
        request.log.error(err);
        return failOb(request, reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
