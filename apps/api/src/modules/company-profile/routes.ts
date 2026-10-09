import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { getCompanyProfile, updateCompanyProfile, CompanyProfileNotFoundError } from "../../db/company/company-profile-service.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";

/**
 * Company Profile API (TASK-023 §3/§13) -- "Perusahaan" (identitas) &
 * "Pengaturan" (currency/fiscal year) di frontend memanggil endpoint yang
 * SAMA, cuma mengirim subset field yang berbeda -- satu sumber kebenaran,
 * bukan dua service. Permission REUSE `company.read`/`company.update`
 * yang sudah ada sejak rbac.ts (TASK-DB-ARCH-010), tidak ada permission
 * baru.
 */

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  tradeName: z.string().nullable().optional(),
  legalEntityType: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  npwp: z.string().nullable().optional(),
  nib: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  province: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  currency: z.string().length(3).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendProfileError(reply: FastifyReply, err: unknown) {
  if (err instanceof CompanyProfileNotFoundError) {
    return reply.code(404).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(400).send({ error: toUserErrorMessage(err) });
}

export async function companyProfileRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/profile",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const profile = await getCompanyProfile(db);
        return reply.send({ profile });
      } catch (err) {
        return sendProfileError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.patch<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/profile",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("company.update")] },
    async (request, reply) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        await updateCompanyProfile(db, parsed.data, actorFromSession(request.authUser!));
        const profile = await getCompanyProfile(db);
        return reply.send({ success: true, profile });
      } catch (err) {
        request.log.error(err);
        return sendProfileError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );
}
