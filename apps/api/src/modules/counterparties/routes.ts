import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";

const createSchema = z.object({
  type: z.enum(["vendor", "customer"]),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
});

export async function counterpartyRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { type?: string } }>(
    "/api/c/:companySlug/counterparties",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const query = masterDb("counterparties").where({ company_id: company.id, is_active: true }).orderBy("name");
      if (request.query.type) query.andWhere({ type: request.query.type });
      const counterparties = await query.select("id", "type", "code", "name", "is_active as isActive");
      return reply.send({ counterparties });
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/counterparties",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const existing = await masterDb("counterparties").where({ company_id: company.id, type: parsed.data.type, code: parsed.data.code }).first();
      if (existing) return reply.code(409).send({ error: `Kode "${parsed.data.code}" sudah dipakai untuk tipe ini` });

      const id = crypto.randomUUID();
      await masterDb("counterparties").insert({ id, company_id: company.id, ...parsed.data });
      return reply.code(201).send({ id });
    },
  );
}
