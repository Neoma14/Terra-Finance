import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";
import { getTaxEstimate, getTaxEstimateForRange } from "./calculator.js";
import { buildTaxEstimateWorkbook } from "./export.js";
import { getTaxReferenceSettings, updateTaxReferenceSettings } from "./settings.js";

interface Params {
  companySlug: string;
}

const updateSchema = z.object({
  umkmFacilityYears: z.number().int().min(0).max(20),
  legalFormNote: z.string(),
  vat: z.object({
    status: z.enum(["kena_pajak", "dikecualikan", "dibebaskan", "campuran"]),
    description: z.string(),
    legalBasis: z.string(),
  }),
  withholdingNotes: z.array(z.object({ title: z.string(), description: z.string(), legalBasis: z.string() })),
  generalNotes: z.array(z.string()),
});

/**
 * Estimasi PPh Badan (Normal + fasilitas Pasal 31E vs PPh Final UMKM) &
 * referensi PPN/pemotongan pajak per perusahaan -- sama persis logikanya
 * dgn modules/tax/routes.ts versi online. BEDA: tidak ada `roleInCompany`
 * (semua user di instalasi ini setara admin/staff, bukan viewer/editor per
 * perusahaan spt versi online multi-firm). BELUM ADA: export Excel (paket
 * offline sengaja tidak menyertakan `exceljs`) -- Print/PDF via browser
 * tetap tersedia di frontend.
 */
export async function taxRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>("/api/c/:companySlug/tax/reference", { preHandler: [requireAuth, requireCompanyAccess] }, async (request, reply) => {
    const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
    if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

    const reference = await getTaxReferenceSettings(masterDb, company.id, company.industry_template as any);
    return reply.send({ reference });
  });

  app.put<{ Params: Params }>("/api/c/:companySlug/tax/reference", { preHandler: [requireAuth, requireCompanyAccess] }, async (request, reply) => {
    const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
    if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

    const reference = await updateTaxReferenceSettings(masterDb, company.id, parsed.data);
    return reply.send({ reference });
  });

  app.get<{ Params: Params; Querystring: { periodId?: string } }>(
    "/api/c/:companySlug/tax/estimate",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const periodId = request.query.periodId;
      if (!periodId) return reply.code(400).send({ error: "periodId wajib diisi" });

      const period = await masterDb("periods").where({ id: periodId, company_id: company.id }).first();
      if (!period) return reply.code(400).send({ error: "Periode tidak ditemukan" });

      const estimate = await getTaxEstimate(masterDb, company.id, company.industry_template as any, period.id, period.label);
      return reply.send({ estimate });
    },
  );

  app.get<{ Params: Params; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/tax/estimate/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const estimate = await getTaxEstimateForRange(masterDb, company.id, company.industry_template as any, from, to);
        return reply.send({ estimate });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: Params; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/tax/estimate/export/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      let estimate;
      try {
        estimate = await getTaxEstimateForRange(masterDb, company.id, company.industry_template as any, from, to);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const buffer = await buildTaxEstimateWorkbook(company.name, estimate);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="Estimasi Pajak - ${company.name}.xlsx"`)
        .send(buffer);
    },
  );
}
