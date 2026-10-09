import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { getAccountLedger, getAccountLedgerByRange } from "../../db/company/ledger-service.js";
import { getTrialBalance } from "../../db/company/trial-balance-service.js";
import { AccountNotFoundError } from "../../db/company/account-service.js";
import { FiscalPeriodNotFoundError } from "../../db/company/fiscal-period.js";
import { InvalidDateRangeError } from "../../db/company/reporting/reporting-types.js";
import { resolveRequestReportScope, replyScopeError } from "../../middleware/report-scope.js";
import { combinedScopeOf, scopePayload } from "../../db/company/report-scope.js";
import { buildComparison, flatTrialBalance, ReportReconciliationError } from "../../db/company/reporting/report-comparison.js";
import { getInterBranchPosition } from "../../db/company/reporting/inter-branch-position.js";

/**
 * General Ledger + Trial Balance API (TASK-DB-ARCH-011 Part B §38),
 * read-only -- gate `report.read` (§37). Pola resolve Company DB SAMA
 * dgn module lain (TASK-DB-ARCH-007/010/011).
 */

function sendLedgerError(reply: FastifyReply, err: unknown) {
  if (err instanceof AccountNotFoundError || err instanceof FiscalPeriodNotFoundError) {
    return reply.code(404).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof InvalidDateRangeError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof ReportReconciliationError) return reply.code(500).send({ error: err.message, code: err.code });
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyLedgerRoutes(app: FastifyInstance) {
  // Ledger per RENTANG TANGGAL (fromDate & toDate, inklusif). `periodId` tetap
  // diterima untuk drill-down dari Trial Balance (diterjemahkan ke rentang
  // tanggal periode itu).
  app.get<{ Params: { companySlug: string; accountId: string }; Querystring: { periodId?: string; fromDate?: string; toDate?: string; scope?: string } }>(
    "/api/company-db/:companySlug/ledger/:accountId",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      const { periodId, fromDate, toDate } = request.query;
      if (!periodId && !(fromDate && toDate)) {
        return reply.code(400).send({ error: "Tanggal Dari dan Tanggal Sampai wajib diisi." });
      }

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const scope = await resolveRequestReportScope(request, db);
        const ledger = fromDate && toDate
          ? await getAccountLedgerByRange(db, request.params.accountId, fromDate, toDate, scope)
          : await getAccountLedger(db, request.params.accountId, periodId!, scope);
        return reply.send({ ...ledger, scope: scopePayload(scope) });
      } catch (err) {
        if (await replyScopeError(request, reply, err)) return reply;
        return sendLedgerError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { periodId?: string; scope?: string } }>(
    "/api/company-db/:companySlug/trial-balance",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      if (!request.query.periodId) return reply.code(400).send({ error: "periodId wajib diisi sbg query parameter." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const scope = await resolveRequestReportScope(request, db, { allowComparison: true });
        if (scope.mode === "COMPARISON") {
          const periodId = request.query.periodId;
          const comparison = await buildComparison(scope, (s) => getTrialBalance(db, periodId, s), flatTrialBalance);
          const period = await db("periods").where({ id: periodId }).first();
          const asOf = String(period?.end_date ?? "").slice(0, 10);
          return reply.send({ scope: scopePayload(scope), comparison, interBranch: asOf ? await getInterBranchPosition(db, combinedScopeOf(scope), asOf) : null });
        }
        const trialBalance = await getTrialBalance(db, request.query.periodId, scope);
        const body: Record<string, unknown> = { ...trialBalance, scope: scopePayload(scope) };
        if (scope.mode === "COMBINED_SELECTED" || scope.mode === "COMBINED_ALL") {
          const period = await db("periods").where({ id: request.query.periodId }).first();
          if (period) body.interBranch = await getInterBranchPosition(db, scope, String(period.end_date).slice(0, 10));
        }
        return reply.send(body);
      } catch (err) {
        if (await replyScopeError(request, reply, err)) return reply;
        return sendLedgerError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
