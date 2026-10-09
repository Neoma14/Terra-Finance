import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";
import { getRatiosForRange, getRatioTrend } from "./calculator.js";
import { buildRatiosWorkbook } from "./export.js";

/** Rasio Keuangan (per template industri) untuk rentang tanggal bebas +
 * tren antar periode -- sama persis logikanya dgn modules/ratios/routes.ts
 * versi online. */
export async function ratioRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/ratios/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const result = await getRatiosForRange(masterDb, company.id, company.industry_template as any, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/ratios/trend",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const points = await getRatioTrend(masterDb, company.id, company.industry_template as any);
      return reply.send({ points });
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/ratios/export/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      let result;
      try {
        result = await getRatiosForRange(masterDb, company.id, company.industry_template as any, from, to);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const buffer = await buildRatiosWorkbook(company.name, result.periodLabel, result.ratios);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="Rasio Keuangan - ${company.name}.xlsx"`)
        .send(buffer);
    },
  );
}
