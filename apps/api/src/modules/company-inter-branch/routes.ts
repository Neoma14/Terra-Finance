import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { replyBranchError, resolveBranchAuthority, resolveWriteBranch } from "../../middleware/branch-authority.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { isoDateSchema } from "../../lib/calendar-date.js";
import { systemDb } from "../../db/system/index.js";
import { canActOnBranch } from "../../db/system/authorization.js";
import type { Permission } from "../../db/system/rbac.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { isMultiBranchEnabled, BranchNotOperationalError } from "../../db/company/branch-service.js";
import { AccountPolicyViolationError } from "../../db/company/account-branch-policy.js";
import { AccountInactiveError, AccountLockedError, AccountNotFoundError } from "../../db/company/account-service.js";
import { FiscalPeriodClosedError, FiscalPeriodLockedError, FiscalPeriodNotFoundError } from "../../db/company/fiscal-period.js";
import { JournalInvalidDateError, JournalReferenceExistsError, JournalReferenceReservedError } from "../../db/company/journal-service.js";
import { InterBranchAccountAmbiguousError, InterBranchAccountMissingError, InterBranchAccountUnusableError } from "../../db/company/inter-branch-accounts.js";
import {
  InterBranchBusyError,
  InterBranchDisabledError,
  InterBranchExpiredError,
  InterBranchForbiddenError,
  InterBranchIdempotencyConflictError,
  InterBranchNotFoundError,
  InterBranchStateChangedError,
  InterBranchValidationError,
  SelfApprovalNotAllowedError,
  approveInterBranch,
  approveInterBranchReversal,
  cancelInterBranch,
  cancelInterBranchReversal,
  getInterBranchSettings,
  proposeInterBranch,
  rejectInterBranch,
  rejectInterBranchReversal,
  requestInterBranchReversal,
  setInterBranchExpiryDays,
  type InterBranchPrincipal,
} from "../../db/company/inter-branch-service.js";
import { getInterBranchDetail, getInterBranchOptions, getInterBranchSummary, listInterBranch } from "../../db/company/inter-branch-queries.js";
import { INTER_BRANCH_STATUSES, INTER_BRANCH_TYPES } from "../../db/company/inter-branch-domain.js";

/**
 * Rute Inter-Branch. Semua keputusan otorisasi ada di server: requireAuth -> requireCompanyAccess (akses perusahaan +
 * cabang, dibaca dari System DB tiap request) -> flag multi-cabang (OFF => 404 seragam) -> permission dasar ->
 * wewenang per-cabang di service (`canActOnBranch`) -> aturan domain. Peran, `fromBranchId`, `companyId`, `userId`, dan
 * `status` dari body/query/header tidak pernah dipercaya untuk hak. Tidak ada PUT/PATCH/DELETE atas dokumen transaksi.
 */

const NOT_FOUND = { error: "Tidak ditemukan.", code: "NOT_FOUND" } as const;

const reasonSchema = z.object({ reason: z.string().max(500).default("") });
const createSchema = z.object({
  type: z.enum(INTER_BRANCH_TYPES),
  fromBranchId: z.string().min(1).optional(),
  toBranchId: z.string().min(1),
  transactionDate: isoDateSchema,
  amount: z.number().positive().max(999_999_999_999),
  fromAccountId: z.string().min(1),
  toAccountSuggestedId: z.string().min(1),
  description: z.string().max(500),
  referenceText: z.string().max(100).nullish(),
  fromCounterpartyId: z.string().min(1).nullish(),
  toCounterpartyId: z.string().min(1).nullish(),
  idempotencyKey: z.string().min(8).max(100),
});
const approveSchema = z.object({ confirmedAccountId: z.string().min(1).nullish() });
const listSchema = z.object({
  box: z.enum(["in", "out", "all"]).optional(),
  status: z.enum(INTER_BRANCH_STATUSES).optional(),
  type: z.enum(INTER_BRANCH_TYPES).optional(),
  fromBranchId: z.string().min(1).optional(),
  toBranchId: z.string().min(1).optional(),
  fromDate: isoDateSchema.optional(),
  toDate: isoDateSchema.optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
const settingsSchema = z.object({ expiryDays: z.number().int() });

function principalFor(request: FastifyRequest): InterBranchPrincipal {
  const access = request.companyAccess!;
  return {
    userId: access.systemUserId,
    role: access.role,
    actor: { actorType: "user", actorId: access.systemUserId, actorLabel: request.authUser!.fullName },
    canAct: (permission: Permission, branchId: string) => canActOnBranch(access, permission, branchId),
    userNames: async (ids) => {
      if (ids.length === 0) return new Map();
      const rows: Array<{ id: string; full_name: string }> = await systemDb("system_users").whereIn("id", ids).select("id", "full_name");
      return new Map(rows.map((r) => [r.id, r.full_name]));
    },
  };
}

const ACCOUNTING_RULE_ERRORS = [
  FiscalPeriodClosedError, FiscalPeriodLockedError, FiscalPeriodNotFoundError, JournalInvalidDateError, JournalReferenceExistsError, JournalReferenceReservedError,
  AccountInactiveError, AccountLockedError, AccountNotFoundError, AccountPolicyViolationError, BranchNotOperationalError,
  InterBranchAccountMissingError, InterBranchAccountAmbiguousError, InterBranchAccountUnusableError,
];

async function fail(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof InterBranchNotFoundError || err instanceof InterBranchDisabledError) return reply.code(404).send(NOT_FOUND);
  if (err instanceof InterBranchForbiddenError || err instanceof SelfApprovalNotAllowedError) return reply.code(403).send({ error: err.message, code: err.code });
  if (err instanceof InterBranchStateChangedError || err instanceof InterBranchExpiredError || err instanceof InterBranchIdempotencyConflictError) {
    return reply.code(409).send({ error: err.message, code: err.code });
  }
  if (err instanceof InterBranchBusyError) return reply.code(503).send({ error: err.message, code: err.code });
  if (err instanceof InterBranchValidationError) {
    const status = err.code === "INTER_BRANCH_INVALID_INPUT" || err.code === "INTER_BRANCH_REASON_REQUIRED" ? 400 : 422;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  if (ACCOUNTING_RULE_ERRORS.some((E) => err instanceof E)) {
    return reply.code(422).send({ error: toUserErrorMessage(err), code: (err as { code?: string }).code ?? "ACCOUNTING_RULE" });
  }
  if (await replyBranchError(request, reply, err)) return reply;
  request.log.error(err);
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

/** Membuka company.db milik slug terverifikasi; flag multi-cabang OFF => 404 seragam sebelum validasi apa pun. */
async function withDb(request: FastifyRequest, reply: FastifyReply, fn: (db: Knex, principal: InterBranchPrincipal) => Promise<unknown>) {
  let db: Knex;
  try {
    db = openCompanyDbForSlug(request.companyAccess!.slug);
  } catch (err) {
    return fail(request, reply, err);
  }
  try {
    if (!(await isMultiBranchEnabled(db))) return reply.code(404).send(NOT_FOUND);
    return await fn(db, principalFor(request));
  } catch (err) {
    return fail(request, reply, err);
  } finally {
    await db.destroy();
  }
}

export async function companyInterBranchRoutes(app: FastifyInstance) {
  const P = "/api/company-db/:companySlug/inter-branch";
  const guard = (permission: Permission) => ({ preHandler: [requireAuth, requireCompanyAccess, requirePermission(permission)] });
  type Params = { Params: { companySlug: string; id: string } };

  app.get(P, guard("interbranch.read"), async (request, reply) => {
    // Validasi input SETELAH cek flag (flag OFF => 404 seragam, termasuk untuk input tidak valid).
    return withDb(request, reply, async (db, principal) => {
      const parsed = listSchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Parameter tidak valid.", code: "INTER_BRANCH_INVALID_INPUT" });
      return reply.send(await listInterBranch(db, principal, parsed.data));
    });
  });

  app.get(`${P}/summary`, guard("interbranch.read"), async (request, reply) =>
    withDb(request, reply, async (db, principal) => reply.send(await getInterBranchSummary(db, principal))),
  );

  // Pilihan formulir: cabang asal = cabang kerja aktif yang divalidasi server; tujuan = cabang ACTIVE lain + kesiapan akun antarkantor
  app.get(`${P}/options`, guard("interbranch.create"), async (request, reply) =>
    withDb(request, reply, async (db, principal) => {
      const from = resolveWriteBranch(await resolveBranchAuthority(request, db));
      return reply.send(await getInterBranchOptions(db, principal, from.id));
    }),
  );

  app.get(`${P}/settings`, guard("interbranch.read"), async (request, reply) => withDb(request, reply, async (db) => reply.send(await getInterBranchSettings(db))));

  app.put(`${P}/settings`, guard("interbranch.read"), async (request, reply) => {
    return withDb(request, reply, async (db, principal) => {
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid.", code: "INTER_BRANCH_INVALID_INPUT" });
      await setInterBranchExpiryDays(db, principal, parsed.data.expiryDays);
      return reply.send(await getInterBranchSettings(db));
    });
  });

  app.get<Params>(`${P}/:id`, guard("interbranch.read"), async (request, reply) =>
    withDb(request, reply, async (db, principal) => reply.send(await getInterBranchDetail(db, principal, request.params.id))),
  );

  app.post(P, guard("interbranch.create"), async (request, reply) => {
    return withDb(request, reply, async (db, principal) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid.", code: "INTER_BRANCH_INVALID_INPUT", details: parsed.error.flatten() });
      // Cabang asal = cabang kerja aktif yang divalidasi server; nilai dari body hanya boleh sama dengan konteks.
      const from = resolveWriteBranch(await resolveBranchAuthority(request, db), parsed.data.fromBranchId);
      const result = await proposeInterBranch(db, principal, { ...parsed.data, fromBranchId: from.id });
      const detail = await getInterBranchDetail(db, principal, result.id);
      return reply.code(result.replayed ? 200 : 201).send({ success: true, replayed: result.replayed, transaction: detail });
    });
  });

  const action = <B>(path: string, permission: Permission, schema: z.ZodType<B, z.ZodTypeDef, unknown>, run: (db: Knex, principal: InterBranchPrincipal, id: string, body: B, request: FastifyRequest<Params>) => Promise<{ id: string }>) =>
    app.post<Params>(`${P}${path}`, guard(permission), async (request, reply) => {
      return withDb(request, reply, async (db, principal) => {
        const parsed = schema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid.", code: "INTER_BRANCH_INVALID_INPUT" });
        const result = await run(db, principal, request.params.id, parsed.data, request);
        return reply.send({ success: true, transaction: await getInterBranchDetail(db, principal, result.id) });
      });
    });

  action("/:id/approve", "interbranch.approve", approveSchema, (db, p, id, body) => approveInterBranch(db, p, id, body));
  action("/:id/reject", "interbranch.approve", reasonSchema, (db, p, id, body) => rejectInterBranch(db, p, id, body));
  action("/:id/cancel", "interbranch.create", reasonSchema, (db, p, id, body) => cancelInterBranch(db, p, id, body));
  action("/:id/reverse", "interbranch.reverse", reasonSchema, (db, p, id, body) => requestInterBranchReversal(db, p, id, body));
  action("/:id/reverse/:approvalId/approve", "interbranch.approve", z.object({}), (db, p, id, _body, request) =>
    approveInterBranchReversal(db, p, id, { approvalId: (request.params as { approvalId?: string }).approvalId }),
  );
  action("/:id/reverse/:approvalId/reject", "interbranch.approve", reasonSchema, (db, p, id, body, request) =>
    rejectInterBranchReversal(db, p, id, { ...body, approvalId: (request.params as { approvalId?: string }).approvalId }),
  );
  action("/:id/reverse/:approvalId/cancel", "interbranch.reverse", reasonSchema, (db, p, id, body, request) =>
    cancelInterBranchReversal(db, p, id, { ...body, approvalId: (request.params as { approvalId?: string }).approvalId }),
  );
}
