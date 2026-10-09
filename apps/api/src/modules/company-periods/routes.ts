import { isoDateSchema } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { lockPeriod, closePeriod, validatePeriodForClosing, InvalidPeriodTransitionError, PeriodNotReadyToCloseError } from "../../db/company/period-closing-service.js";
import {
  FiscalPeriodNotFoundError,
  createPeriod,
  generateMonthlyPeriods,
  PeriodDateRangeInvalidError,
  PeriodOverlapError,
  PeriodLabelRequiredError,
} from "../../db/company/fiscal-period.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";

/**
 * Period Lifecycle API (TASK-DB-ARCH-011 Part B §38). Lock/Close digate
 * `company.update` (hanya OWNER/ADMIN, §37) -- menutup periode adalah
 * aksi administratif tingkat tinggi (mengunci SELURUH akuntansi periode
 * tsb), BUKAN level ACCOUNTANT (`journal.post`) -- keputusan permission
 * yang didokumentasikan, bukan default yang tidak dipikir.
 */

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendPeriodError(reply: FastifyReply, err: unknown) {
  if (err instanceof FiscalPeriodNotFoundError) {
    return reply.code(404).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof InvalidPeriodTransitionError) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof PeriodNotReadyToCloseError) {
    return reply.code(409).send({ error: toUserErrorMessage(err), issues: err.issues });
  }
  if (err instanceof PeriodDateRangeInvalidError || err instanceof PeriodLabelRequiredError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof PeriodOverlapError) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

const createPeriodSchema = z.object({
  label: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  periodType: z.enum(["month", "quarter", "year"]),
  fiscalYear: z.number().int(),
});
const generateMonthlySchema = z.object({ fromDate: isoDateSchema, toDate: isoDateSchema });

export async function companyPeriodsRoutes(app: FastifyInstance) {
  app.get(
    "/api/company-db/:companySlug/periods",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug((request.params as { companySlug: string }).companySlug);
      try {
        const periods = await db("periods").select("id", "label", "start_date as startDate", "end_date as endDate", "status").orderBy("start_date", "desc");
        return reply.send({ periods });
      } finally {
        await db.destroy();
      }
    },
  );

  // TASK-023 hotfix -- lihat komentar panjang di fiscal-period.ts
  // (createPeriod): tidak ada jalur create period di arsitektur ini sama
  // sekali sampai sekarang. Gate `company.update` (SAMA dgn lock/close) --
  // membuat periode adalah aksi administratif setara, bukan level
  // ACCOUNTANT.
  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/periods",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const parsed = createPeriodSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const { id } = await createPeriod(db, parsed.data, actorFromSession(request.authUser!));
        return reply.code(201).send({ success: true, id });
      } catch (err) {
        request.log.error(err);
        return sendPeriodError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/periods/generate-monthly",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const parsed = generateMonthlySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const result = await generateMonthlyPeriods(db, parsed.data.fromDate, parsed.data.toDate, actorFromSession(request.authUser!));
        return reply.code(201).send({ success: true, ...result });
      } catch (err) {
        request.log.error(err);
        return sendPeriodError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/periods/:id/closing-check",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("journal.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const validation = await validatePeriodForClosing(db, request.params.id);
        return reply.send(validation);
      } catch (err) {
        return sendPeriodError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/periods/:id/lock",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        await lockPeriod(db, request.params.id, actorFromSession(request.authUser!));
        return reply.send({ success: true, periodId: request.params.id, status: "LOCKED" });
      } catch (err) {
        request.log.error(err);
        return sendPeriodError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/periods/:id/close",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        await closePeriod(db, request.params.id, actorFromSession(request.authUser!));
        return reply.send({ success: true, periodId: request.params.id, status: "CLOSED" });
      } catch (err) {
        request.log.error(err);
        return sendPeriodError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
