import { isoDateSchema } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { getTaxSettings, updateTaxSettings } from "../../db/company/tax-settings-service.js";
import { getIncomeStatement } from "../../db/company/reporting/income-statement-service.js";
import { InvalidDateRangeError } from "../../db/company/reporting/reporting-types.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";

/**
 * Pajak (TASK-023 §7) -- permission REUSE `company.read`/`company.update`
 * (sama dgn Company Profile, krn tax_reference_settings sama levelnya:
 * konfigurasi referensi perusahaan, bukan transaksi). "Dasar pengenaan"
 * di summary HANYA angka revenue dari Income Statement yang sudah ada --
 * TIDAK ADA kalkulasi tarif/pajak terhutang (itu akan mengada-ada tarif,
 * dilarang §7 instruksi).
 */

const updateSchema = z.object({
  umkmFacilityYears: z.number().int().min(0).optional(),
  legalFormNote: z.string().optional(),
  vatStatus: z.string().optional(),
  vatDescription: z.string().optional(),
  vatLegalBasis: z.string().optional(),
  withholdingNotes: z.array(z.string()).optional(),
  generalNotes: z.array(z.string()).optional(),
});
const summaryQuerySchema = z.object({ fromDate: isoDateSchema, toDate: isoDateSchema });

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

export async function companyTaxRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/tax-settings",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        return reply.send({ settings: await getTaxSettings(db) });
      } finally {
        await db.destroy();
      }
    },
  );

  app.patch<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/tax-settings",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        await updateTaxSettings(db, parsed.data, actorFromSession(request.authUser!));
        return reply.send({ success: true, settings: await getTaxSettings(db) });
      } catch (err) {
        request.log.error(err);
        return reply.code(400).send({ error: toUserErrorMessage(err) });
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { fromDate?: string; toDate?: string } }>(
    "/api/company-db/:companySlug/tax-summary",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      const parsed = summaryQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "fromDate & toDate wajib diisi." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const [settings, income] = await Promise.all([
          getTaxSettings(db),
          getIncomeStatement(db, parsed.data.fromDate, parsed.data.toDate),
        ]);
        return reply.send({
          settings,
          period: { fromDate: parsed.data.fromDate, toDate: parsed.data.toDate },
          revenue: income.revenue.total,
        });
      } catch (err) {
        if (err instanceof InvalidDateRangeError) return reply.code(400).send({ error: toUserErrorMessage(err) });
        return reply.code(500).send({ error: toUserErrorMessage(err) });
      } finally {
        await db.destroy();
      }
    },
  );
}
