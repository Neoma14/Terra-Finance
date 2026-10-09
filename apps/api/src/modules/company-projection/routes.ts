import { isoDateSchema } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { getProjection } from "../../db/company/projection-service.js";

const querySchema = z.object({
  asOfDate: isoDateSchema,
  monthsAhead: z.coerce.number().int().min(1).max(12).optional(),
});

/** Proyeksi (TASK-023 §11) -- read-only, reuse `report.read` (sumber
 * datanya sama dgn Dashboard). */
export async function companyProjectionRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { asOfDate?: string; monthsAhead?: string } }>(
    "/api/company-db/:companySlug/projection",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "asOfDate wajib diisi." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const projection = await getProjection(db, parsed.data.asOfDate, parsed.data.monthsAhead ?? 3);
        return reply.send(projection);
      } catch (err) {
        return reply.code(500).send({ error: toUserErrorMessage(err) });
      } finally {
        await db.destroy();
      }
    },
  );
}
