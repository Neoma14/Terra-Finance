import { isoDateSchema } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { getRatioAnalysis } from "../../db/company/ratio-analysis-service.js";
import { InvalidDateRangeError } from "../../db/company/reporting/reporting-types.js";

const querySchema = z.object({ fromDate: isoDateSchema, toDate: isoDateSchema });

/** Analisis (TASK-023 §10) -- read-only, gate `report.read` (sama dgn
 * Dashboard/Laporan Keuangan, krn sumber datanya literal sama). */
export async function companyAnalysisRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { fromDate?: string; toDate?: string } }>(
    "/api/company-db/:companySlug/analysis",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "fromDate & toDate wajib diisi." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const analysis = await getRatioAnalysis(db, parsed.data.fromDate, parsed.data.toDate);
        return reply.send(analysis);
      } catch (err) {
        if (err instanceof InvalidDateRangeError) return reply.code(400).send({ error: toUserErrorMessage(err) });
        return reply.code(500).send({ error: toUserErrorMessage(err) });
      } finally {
        await db.destroy();
      }
    },
  );
}
