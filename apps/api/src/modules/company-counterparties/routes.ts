import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import {
  listCounterparties,
  createCounterparty,
  getCounterpartyBalances,
  CounterpartyCodeRequiredError,
  CounterpartyNameRequiredError,
  CounterpartyCodeAlreadyExistsError,
} from "../../db/company/counterparty-service.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";
import { resolveRequestReportScope, replyScopeError } from "../../middleware/report-scope.js";
import { scopePayload } from "../../db/company/report-scope.js";

/**
 * Hutang & Piutang API (TASK-023 §6) -- permission REUSE `account.*`
 * (bukan permission baru): counterparty adalah master data COA-adjacent,
 * semantiknya paling dekat dgn Chart of Accounts (read = semua role,
 * create = ACCOUNTANT+), bukan konsep baru.
 */

const typeSchema = z.enum(["vendor", "customer"]);
const createSchema = z.object({ type: typeSchema, code: z.string().min(1), name: z.string().min(1) });

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendCounterpartyError(reply: FastifyReply, err: unknown) {
  if (err instanceof CounterpartyCodeRequiredError || err instanceof CounterpartyNameRequiredError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof CounterpartyCodeAlreadyExistsError) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyCounterpartiesRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { type?: string } }>(
    "/api/company-db/:companySlug/counterparties",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.read")] },
    async (request, reply) => {
      const parsedType = typeSchema.safeParse(request.query.type);
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const counterparties = await listCounterparties(db, parsedType.success ? parsedType.data : undefined);
        return reply.send({ counterparties });
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { type: string; scope?: string } }>(
    "/api/company-db/:companySlug/counterparties/balances",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.read")] },
    async (request, reply) => {
      const parsedType = typeSchema.safeParse(request.query.type);
      if (!parsedType.success) return reply.code(400).send({ error: "Query parameter type wajib 'vendor' atau 'customer'." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        // Phase 5: hanya SALDO yang mengikuti cakupan; master counterparty (nama vendor/pelanggan) tetap bersama (D4).
        const scope = await resolveRequestReportScope(request, db);
        const balances = await getCounterpartyBalances(db, parsedType.data, scope);
        return reply.send({ balances, scope: scopePayload(scope) });
      } catch (err) {
        if (await replyScopeError(request, reply, err)) return reply;
        request.log.error(err);
        return reply.code(500).send({ error: toUserErrorMessage(err) });
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/counterparties",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.create")] },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const { id } = await createCounterparty(db, parsed.data, actorFromSession(request.authUser!));
        return reply.code(201).send({ success: true, id });
      } catch (err) {
        request.log.error(err);
        return sendCounterpartyError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
