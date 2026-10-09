import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug, CompanyNotFoundError } from "../../db/company/company-resolver.js";
import {
  createAccount,
  updateAccount,
  getAccount,
  listAccountsPaginated,
  listAccountTypes,
  AccountCodeRequiredError,
  AccountNameRequiredError,
  AccountCodeAlreadyExistsError,
  AccountTypeNotFoundError,
  AccountNotFoundError,
  AccountParentNotFoundError,
  AccountParentCycleError,
  AccountNormalBalanceLockedError,
  AccountInterBranchClassificationError,
  SystemAccountProtectedError,
  AccountLockStateError,
  setAccountLocked,
} from "../../db/company/account-service.js";
import type { SessionUser } from "../auth/session-service.js";
import type { ActorContext } from "../../db/company/company-audit.js";

/**
 * Chart of Accounts API (TASK-DB-ARCH-011 Part B §38). Pola IDENTIK dgn
 * `modules/company-journal/routes.ts` (TASK-DB-ARCH-007/010): resolve
 * Company DB SETELAH authorization lolos, actor dari session, tutup
 * koneksi di `finally`. TIDAK ADA endpoint delete (§22: akun yang pernah
 * dipakai posted journal tidak boleh dihapus destructive -- gunakan
 * PATCH { isActive: false }).
 */

const createAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  accountTypeCode: z.string().min(1),
  normalBalance: z.enum(["debit", "credit"]),
  accountSubtype: z.string().optional().nullable(),
  parentAccountId: z.string().optional().nullable(),
  cashFlowActivity: z.string().optional().nullable(),
  isCash: z.boolean().optional(),
  subledgerType: z.string().optional().nullable(),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  normalBalance: z.enum(["debit", "credit"]).optional(),
  isActive: z.boolean().optional(),
  accountSubtype: z.string().optional().nullable(),
  parentAccountId: z.string().optional().nullable(),
  cashFlowActivity: z.string().optional().nullable(),
  isCash: z.boolean().optional(),
  subledgerType: z.string().optional().nullable(),
});

function actorFromSession(user: SessionUser): ActorContext {
  return { actorType: "user", actorId: user.id, actorLabel: user.fullName };
}

function sendAccountError(reply: FastifyReply, err: unknown) {
  if (
    err instanceof CompanyNotFoundError ||
    err instanceof AccountNotFoundError ||
    err instanceof AccountTypeNotFoundError ||
    err instanceof AccountParentNotFoundError
  ) {
    return reply.code(404).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof AccountCodeRequiredError || err instanceof AccountNameRequiredError || err instanceof AccountParentCycleError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (
    err instanceof AccountCodeAlreadyExistsError ||
    err instanceof AccountNormalBalanceLockedError ||
    err instanceof AccountInterBranchClassificationError ||
    err instanceof SystemAccountProtectedError ||
    err instanceof AccountLockStateError
  ) {
    return reply.code(409).send({ error: toUserErrorMessage(err) });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

export async function companyAccountsRoutes(app: FastifyInstance) {
  // TASK-DB-ARCH-015 §3: +search/filter/pagination (route-layer query
  // building, lihat `listAccountsPaginated` -- `listAccounts` lama TIDAK
  // diubah, caller lain (reporting-utils.ts dkk) tidak terdampak).
  app.get<{
    Params: { companySlug: string };
    Querystring: { isActive?: string; search?: string; accountTypeId?: string; parentAccountId?: string; page?: string; pageSize?: string };
  }>(
    "/api/company-db/:companySlug/accounts",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const q = request.query;
        const result = await listAccountsPaginated(db, {
          isActive: q.isActive !== undefined ? q.isActive === "true" : undefined,
          search: q.search,
          accountTypeId: q.accountTypeId,
          parentAccountId: q.parentAccountId,
          page: Number(q.page) || undefined,
          pageSize: Number(q.pageSize) || undefined,
        });
        return reply.send(result);
      } catch (err) {
        return sendAccountError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // §5: dropdown Account Type di form Create/Edit + filter COA List.
  app.get<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/account-types",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const accountTypes = await listAccountTypes(db);
        return reply.send({ accountTypes });
      } finally {
        await db.destroy();
      }
    },
  );

  app.get<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/accounts/:id",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.read")] },
    async (request, reply) => {
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const account = await getAccount(db, request.params.id);
        if (!account) return sendAccountError(reply, new AccountNotFoundError(`Akun dengan id "${request.params.id}" tidak ditemukan.`));
        return reply.send({ account });
      } finally {
        await db.destroy();
      }
    },
  );

  app.post<{ Params: { companySlug: string } }>(
    "/api/company-db/:companySlug/accounts",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.create")] },
    async (request, reply) => {
      const parsed = createAccountSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        const { id } = await createAccount(db, parsed.data, actorFromSession(request.authUser!));
        return reply.code(201).send({ success: true, accountId: id });
      } catch (err) {
        request.log.error(err);
        return sendAccountError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  app.patch<{ Params: { companySlug: string; id: string } }>(
    "/api/company-db/:companySlug/accounts/:id",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.update")] },
    async (request, reply) => {
      const parsed = updateAccountSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", details: parsed.error.flatten() });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        await updateAccount(db, request.params.id, parsed.data, actorFromSession(request.authUser!));
        return reply.send({ success: true, accountId: request.params.id });
      } catch (err) {
        request.log.error(err);
        return sendAccountError(reply, err);
      } finally {
        await db.destroy();
      }
    },
  );

  // Lock / Unlock akun -- akun terkunci ditolak oleh journal-service untuk
  // jurnal BARU (UI, API, import, saldo awal). Permission khusus account.lock.
  for (const [path, locked] of [["lock", true], ["unlock", false]] as const) {
    app.post<{ Params: { companySlug: string; id: string } }>(
      `/api/company-db/:companySlug/accounts/:id/${path}`,
      { preHandler: [requireAuth, requireCompanyAccess, requirePermission("account.lock")] },
      async (request, reply) => {
        const db = openCompanyDbForSlug(request.params.companySlug);
        try {
          await setAccountLocked(db, request.params.id, locked, actorFromSession(request.authUser!));
          return reply.send({ success: true, accountId: request.params.id, isLocked: locked });
        } catch (err) {
          request.log.error(err);
          return sendAccountError(reply, err);
        } finally {
          await db.destroy();
        }
      },
    );
  }
}
