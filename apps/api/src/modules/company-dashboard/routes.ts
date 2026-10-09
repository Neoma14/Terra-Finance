import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { getDashboardSummary } from "../../db/company/dashboard-service.js";
import { InvalidDateRangeError, BalanceSheetNotBalancedError } from "../../db/company/reporting/reporting-types.js";
import { resolveRequestReportScope, replyScopeError } from "../../middleware/report-scope.js";
import { scopePayload } from "../../db/company/report-scope.js";

/**
 * KPI Dashboard API (TASK-020). Pola IDENTIK dgn company-reports/routes.ts
 * (reuse `report.read` -- permission existing, TIDAK bikin permission baru,
 * §31 instruksi) -- satu-satunya endpoint baru, bukan N endpoint kecil,
 * krn frontend butuh seluruh KPI+trend+alerts SEKALIGUS utk satu halaman
 * (§28 instruksi: hindari N+1 request dari browser).
 */

type DashboardQuery = { companySlug: string };
type DashboardQuerystring = { fromDate?: string; toDate?: string; scope?: string };

function sendDashboardError(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidDateRangeError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof BalanceSheetNotBalancedError) {
    // §33 "DO NOT HIDE IT": integrity bug nyata, sama persis perilaku
    // /reports/balance-sheet -- 500 dgn pesan jelas, BUKAN dashboard yg
    // diam-diam menampilkan angka yang mungkin salah.
    return reply.code(500).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyDashboardRoutes(app: FastifyInstance) {
  app.get<{ Params: DashboardQuery; Querystring: DashboardQuerystring }>(
    "/api/company-db/:companySlug/dashboard",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      const { fromDate, toDate } = request.query;
      if (!fromDate || !toDate) return reply.code(400).send({ error: "fromDate dan toDate wajib diisi sbg query parameter." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const scope = await resolveRequestReportScope(request, db);
        const summary = await getDashboardSummary(db, fromDate, toDate, scope);
        return reply.send({ ...summary, scope: scopePayload(scope) });
      } catch (err) {
        if (await replyScopeError(request, reply, err)) return reply;
        return sendDashboardError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
