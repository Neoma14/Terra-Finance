import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";
import {
  getBalanceSheetForRange,
  getCashFlowDetailForRange,
  getCashFlowForRange,
  getEquityStatementForRange,
  getFinancialTrendForRange,
  getIncomeStatementForRange,
} from "./date-range-calculator.js";
import { buildStatementsWorkbook } from "./export.js";

/**
 * Neraca, Laba Rugi, Arus Kas (+ rincian per akun), Laporan Perubahan
 * Ekuitas, & Tren Finansial untuk rentang tanggal bebas -- sama persis
 * logikanya dgn modules/statements/date-range-calculator.ts versi online.
 */
export async function statementRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/balance-sheet",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const result = await getBalanceSheetForRange(masterDb, company.id, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/income-statement",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const result = await getIncomeStatementForRange(masterDb, company.id, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/cash-flow",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const result = await getCashFlowForRange(masterDb, company.id, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/equity",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const result = await getEquityStatementForRange(masterDb, company.id, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/export/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const [balanceSheet, incomeStatement, equityStatement, cashFlow, cashFlowDetail] = await Promise.all([
          getBalanceSheetForRange(masterDb, company.id, from, to),
          getIncomeStatementForRange(masterDb, company.id, from, to),
          getEquityStatementForRange(masterDb, company.id, from, to),
          getCashFlowForRange(masterDb, company.id, from, to),
          getCashFlowDetailForRange(masterDb, company.id, from, to),
        ]);

        const periodLabel = `${from} s/d ${to}`;
        const buffer = await buildStatementsWorkbook(company.name, periodLabel, {
          balanceSheet,
          incomeStatement,
          equityStatement,
          cashFlow,
          cashFlowDetail,
          balanceSheetPrior: null,
          incomeStatementPrior: null,
          priorPeriodLabel: null,
          preparedBy: request.authUser!.fullName,
        });

        return reply
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="Laporan Keuangan - ${company.name} - ${from} sd ${to}.xlsx"`)
          .send(buffer);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/trend/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      const points = await getFinancialTrendForRange(masterDb, company.id, from, to);
      return reply.send({ points });
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/statements/cash-flow/detail/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const result = await getCashFlowDetailForRange(masterDb, company.id, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
}
