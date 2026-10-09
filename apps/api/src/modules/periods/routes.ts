import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";

export async function periodsRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/periods",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const periods = await masterDb("periods")
        .where({ company_id: company.id })
        .select(
          "id",
          "label",
          "start_date as startDate",
          "end_date as endDate",
          "period_type as periodType",
          "fiscal_year as fiscalYear",
          "is_closed as isClosed",
        )
        .orderBy("end_date", "desc");
      return reply.send({ periods });
    },
  );
}
