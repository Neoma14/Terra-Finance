import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { industryTemplateSchema } from "@konsultan/shared";
import { requireAuth } from "../../middleware/auth-guard.js";
import type { SessionUser } from "../auth/session-service.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { systemDb } from "../../db/system/index.js";
import { findCompanyRegistryBySlug, insertCompanyRegistry } from "../../db/system/companies-registry.js";
import { appendSystemAudit, type SystemActorContext } from "../../db/system/system-audit.js";
import { InvalidCompanySlugError } from "../../db/system/company-db-path.js";
import { getCompanyDataRoot } from "../../db/company/company-resolver.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess, listAccessibleCompanies } from "../../db/system/company-access.js";
import {
  provisionCompanyDb,
  CompanyDirectoryExistsError,
  CompanyDatabaseExistsError,
  CompanyMigrationFailedError,
  CompanyCreationFailedError,
} from "../../db/company/company-provisioning.js";

/**
 * Company Creation & Registry Flow (TASK-DB-ARCH-008), DIPERLUAS
 * TASK-DB-ARCH-010 dgn identity bridge + company access (OWNER) + GET list.
 *
 * Endpoint: POST /api/company-db (create), GET /api/company-db (list
 * company yang BOLEH diakses user -- bukan seluruh registry, §17/§24
 * Company Enumeration).
 *
 * `created_by` GAP (TASK-DB-ARCH-008/009) -- RESOLVED (TASK-DB-ARCH-010):
 *   `ensureSystemIdentity()` (Identity Bridge, Option A --
 *   Identity_Architecture_Proposal.md) memastikan baris `system_users`
 *   ada dgn id YANG SAMA PERSIS dgn `request.authUser.id` (legacy),
 *   SEBELUM `companies_registry.created_by` diisi -- FK sekarang valid,
 *   bukan NULL lagi. Login flow (`modules/auth/routes.ts`) TIDAK disentuh.
 */

const createCompanySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  tradeName: z.string().optional().nullable(),
  legalEntityType: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  industryTemplate: industryTemplateSchema.optional(),
  npwp: z.string().optional().nullable(),
  nib: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  province: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  website: z.string().optional().nullable(),
  currency: z.string().length(3).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});

function actorFromSession(user: SessionUser): SystemActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendProvisioningError(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidCompanySlugError) {
    return reply.code(400).send({ error: toUserErrorMessage(err), code: "COMPANY_SLUG_INVALID" });
  }
  if (err instanceof CompanyDirectoryExistsError) {
    return reply.code(409).send({ error: toUserErrorMessage(err), code: "COMPANY_DIRECTORY_EXISTS" });
  }
  if (err instanceof CompanyDatabaseExistsError) {
    return reply.code(409).send({ error: toUserErrorMessage(err), code: "COMPANY_DATABASE_EXISTS" });
  }
  if (err instanceof CompanyMigrationFailedError) {
    return reply.code(500).send({ error: toUserErrorMessage(err), code: "COMPANY_MIGRATION_FAILED" });
  }
  if (err instanceof CompanyCreationFailedError) {
    return reply.code(500).send({ error: toUserErrorMessage(err), code: "COMPANY_CREATION_FAILED" });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err), code: "COMPANY_CREATION_FAILED" });
}

export async function companyRoutes(app: FastifyInstance) {
  app.post("/api/company-db", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createCompanySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });
    const data = parsed.data;

    const existing = await findCompanyRegistryBySlug(systemDb, data.slug);
    if (existing) {
      return reply.code(409).send({ error: `Perusahaan dengan slug "${data.slug}" sudah terdaftar.`, code: "COMPANY_ALREADY_EXISTS" });
    }

    let provisioned;
    try {
      provisioned = await provisionCompanyDb({
        dataRoot: getCompanyDataRoot(),
        slug: data.slug,
        profile: {
          name: data.name,
          tradeName: data.tradeName,
          legalEntityType: data.legalEntityType,
          industry: data.industry,
          industryTemplate: data.industryTemplate,
          npwp: data.npwp,
          nib: data.nib,
          address: data.address,
          city: data.city,
          province: data.province,
          postalCode: data.postalCode,
          phone: data.phone,
          email: data.email,
          website: data.website,
          currency: data.currency,
          fiscalYearStartMonth: data.fiscalYearStartMonth,
        },
      });
    } catch (err) {
      request.log.error(err);
      return sendProvisioningError(reply, err);
    }

    const registryId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const actor = actorFromSession(request.authUser!);
    try {
      // Identity bridge DI LUAR transaction System DB -- ensureSystemIdentity
      // melakukan upsert idempoten sendiri (lihat identity-bridge.ts), tidak
      // perlu ikut rollback registry (baris system_users yang sudah ada
      // tetap valid dipakai lagi kalau user yang sama bikin company lain).
      const systemUserId = await ensureSystemIdentity(systemDb, request.authUser!);

      await systemDb.transaction(async (trx) => {
        await insertCompanyRegistry(trx, {
          id: registryId,
          slug: data.slug,
          name: data.name,
          databasePath: provisioned.databasePath,
          schemaVersion: provisioned.migrationsApplied,
          createdBy: systemUserId, // GAP TASK-008/009 RESOLVED -- lihat komentar header file
        });

        // §18: company baru TIDAK BOLEH selesai dibuat tanpa owner/access
        // valid -- insert di TRANSACTION YANG SAMA dgn registry, supaya
        // kegagalan di sini ikut rollback registry (compensation yang
        // SUDAH ADA di catch block di bawah akan jalan utk kasus ini juga).
        await grantCompanyAccess(trx, {
          id: accessId,
          systemUserId,
          companyId: registryId,
          role: "OWNER",
        });

        await appendSystemAudit(trx, {
          actor,
          action: "company.register",
          entityType: "companies_registry",
          entityId: registryId,
          companyId: registryId,
          after: { slug: data.slug, name: data.name, databasePath: provisioned.databasePath },
        });
        await appendSystemAudit(trx, {
          actor,
          action: "company.access.granted",
          entityType: "company_access",
          entityId: accessId,
          companyId: registryId,
          after: { systemUserId, role: "OWNER" },
        });
      });
    } catch (err) {
      request.log.error(err);
      // Company DB sudah dibuat & valid, tapi registry/access gagal commit
      // (§12/§18) -- cleanup best-effort supaya tidak ada folder "yatim"
      // atau registry tanpa owner yang bisa membingungkan di masa depan.
      try {
        fs.rmSync(path.dirname(provisioned.databasePath), { recursive: true, force: true });
      } catch (cleanupErr) {
        request.log.error(cleanupErr);
      }
      return reply.code(500).send({ error: toUserErrorMessage(err), code: "COMPANY_REGISTRY_FAILED" });
    }

    return reply.code(201).send({
      success: true,
      companyId: registryId,
      slug: data.slug,
      name: data.name,
      status: "active",
      role: "OWNER",
    });
  });

  // §17: HANYA company dgn company_access ACTIVE milik user yang login --
  // TIDAK PERNAH seluruh registry (Company Enumeration, §24).
  app.get("/api/company-db", { preHandler: requireAuth }, async (request, reply) => {
    const systemUserId = await ensureSystemIdentity(systemDb, request.authUser!);
    const companies = await listAccessibleCompanies(systemDb, systemUserId);
    return reply.send({ companies });
  });
}
