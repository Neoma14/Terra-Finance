import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { createCompanySchema, industryTemplateSchema } from "@konsultan/shared";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts -- HANYA
// dipasang di rute yang py :companySlug (GET list /api/companies & POST
// create SENGAJA TIDAK disentuh, keduanya tidak merujuk company spesifik).
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { recordAudit } from "../audit/service.js";
import { LogoUploadError, toDataUri } from "../../lib/image-upload.js";
import { seedChartOfAccounts } from "./seed-chart-of-accounts.js";
import { getTemplate } from "./templates/index.js";
import { seedTaxReferenceSettings } from "../tax/settings.js";

const COMPANY_COLUMNS = [
  "id",
  "slug",
  "name",
  "industry",
  "industry_template as industryTemplate",
  "status",
  "fiscal_year_start_month as fiscalYearStartMonth",
  "currency",
  "logo_data_uri as logoUrl",
  "created_at as createdAt",
];

const updateCompanySchema = z.object({
  name: z.string().min(2).max(200).optional(),
  industry: z.string().max(120).optional(),
  industryTemplate: industryTemplateSchema.optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  currency: z.string().length(3).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

/**
 * Perusahaan klien -- sengaja disamakan PERSIS dgn logika versi online
 * (skema `createCompanySchema` dari @konsultan/shared, slug dibuat CLIENT-
 * SIDE dari nama lalu dikirim apa adanya, endpoint tunggal berbasis slug
 * `/api/c/:companySlug` bukan `:id`) supaya modul CoA/Jurnal/Laporan yang
 * di-port berikutnya bisa mengikuti pola URL & konvensi yang sama. BEDA
 * dgn online: tidak ada `user_company_access` (semua user di instalasi ini
 * lihat semua perusahaan -- alat kerja internal satu firm, bukan platform
 * multi-firm), jadi tidak ada kolom `roleInCompany` di response.
 */
export async function companiesRoutes(app: FastifyInstance) {
  app.get("/api/companies", { preHandler: requireAuth }, async (_request, reply) => {
    const companies = await masterDb("companies").select(COMPANY_COLUMNS).orderBy("name");
    return reply.send({ companies });
  });

  app.get<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await masterDb("companies").select(COMPANY_COLUMNS).where({ slug: request.params.companySlug }).first();
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });
      return reply.send({ company });
    },
  );

  app.post("/api/companies", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createCompanySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    const data = parsed.data;

    const slugTaken = await masterDb("companies").where({ slug: data.slug }).first();
    if (slugTaken) return reply.code(409).send({ error: "Slug perusahaan sudah dipakai, coba nama lain" });

    const id = crypto.randomUUID();
    await masterDb("companies").insert({
      id,
      slug: data.slug,
      name: data.name,
      industry: data.industry ?? null,
      industry_template: data.industryTemplate,
      fiscal_year_start_month: data.fiscalYearStartMonth,
      currency: data.currency,
      created_by: request.authUser!.id,
    });

    // Seed Chart of Accounts + baris laporan default sesuai template
    // industri -- sama seperti provisioning perusahaan baru di versi
    // online, dilakukan LANGSUNG saat create (bukan langkah manual
    // terpisah) supaya perusahaan baru selalu siap pakai.
    await seedChartOfAccounts(masterDb, id, getTemplate(data.industryTemplate));
    await seedTaxReferenceSettings(masterDb, id, data.industryTemplate);

    await recordAudit(masterDb, {
      actorType: "user",
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.fullName,
      action: "company.create",
      entityType: "companies",
      entityId: id,
      after: { name: data.name, slug: data.slug, industryTemplate: data.industryTemplate },
    });

    const company = await masterDb("companies").select(COMPANY_COLUMNS).where({ id }).first();
    return reply.code(201).send({ company });
  });

  app.patch<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const parsed = updateCompanySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const existing = await masterDb("companies").where({ slug: request.params.companySlug }).first();
      if (!existing) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const data = parsed.data;
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.industry !== undefined) patch.industry = data.industry;
      if (data.industryTemplate !== undefined) patch.industry_template = data.industryTemplate;
      if (data.fiscalYearStartMonth !== undefined) patch.fiscal_year_start_month = data.fiscalYearStartMonth;
      if (data.currency !== undefined) patch.currency = data.currency;
      if (data.status !== undefined) patch.status = data.status;

      await masterDb("companies").where({ id: existing.id }).update(patch);

      await recordAudit(masterDb, {
        actorType: "user",
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.fullName,
        action: "company.update",
        entityType: "companies",
        entityId: existing.id,
        before: { name: existing.name, status: existing.status },
        after: data,
      });

      const company = await masterDb("companies").select(COMPANY_COLUMNS).where({ id: existing.id }).first();
      return reply.send({ company });
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/logo",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const existing = await masterDb("companies").where({ slug: request.params.companySlug }).first();
      if (!existing) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "File tidak ditemukan" });

      const buffer = await file.toBuffer();
      try {
        const dataUri = toDataUri(buffer, file.mimetype, file.filename);
        await masterDb("companies").where({ id: existing.id }).update({ logo_data_uri: dataUri });
        return reply.send({ logoUrl: dataUri });
      } catch (err) {
        if (err instanceof LogoUploadError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.delete<{ Params: { companySlug: string } }>(
    "/api/c/:companySlug/logo",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const existing = await masterDb("companies").where({ slug: request.params.companySlug }).first();
      if (!existing) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });
      await masterDb("companies").where({ id: existing.id }).update({ logo_data_uri: null });
      return reply.send({ ok: true });
    },
  );
}
