import { isoDateSchema } from "../../lib/calendar-date.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { listCompanyAuditLog } from "../../db/company/company-audit-log-service.js";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  entityType: z.string().optional(),
  fromDate: isoDateSchema.optional(),
  toDate: isoDateSchema.optional(),
});

/** Audit Log (TASK-023 §14) -- read-only, permission REUSE `users.manage`
 * (ADMIN/OWNER saja): isi audit log sensitif (siapa melakukan apa), level
 * visibilitas yang sama dgn manajemen akses pengguna, bukan `report.read`
 * (semua role) yang terlalu longgar utk data ini. */
export async function companyAuditLogRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/audit-log",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("users.manage")] },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const result = await listCompanyAuditLog(db, parsed.data);
        return reply.send(result);
      } finally {
        await db.destroy();
      }
    },
  );
}
