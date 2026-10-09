import type { FastifyReply, FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { systemDb } from "../db/system/index.js";
import { appendSystemAudit } from "../db/system/system-audit.js";
import {
  AccountPolicyViolationError,
} from "../db/company/account-branch-policy.js";
import {
  BranchClosureBlockedError,
  BranchCodeExistsError,
  BranchHeadOfficeProtectedError,
  BranchInUseError,
  BranchInvalidInputError,
  BranchInvalidTransitionError,
  BranchNotFoundError,
  BranchNotOperationalError,
  JournalOriginNotSupportedError,
  MultiBranchDisabledError,
  getHeadOfficeBranch,
  isMultiBranchEnabled,
  listBranches,
  type BranchRow,
} from "../db/company/branch-service.js";
import { MultiBranchHasPendingInterBranchError } from "../db/company/inter-branch-lifecycle.js";
import { toUserErrorMessage } from "../lib/error-message.js";

/**
 * Otorisasi cabang TERPUSAT (Multi-Branch Phase 1-2).
 *
 * Urutan: Authentication -> Company Access -> Branch Access -> Active Branch
 * Context -> Permission -> Account Policy -> Transaction Rule.
 *  - Authentication / Company Access: requireAuth + requireCompanyAccess (sudah ada).
 *  - Branch Access: `request.companyAccess.branchScope/allowedBranchIds` diisi
 *    requireCompanyAccess dari System DB TIAP request (tanpa cache -> pencabutan
 *    berlaku di request berikutnya) + `enforceLimitedScopeRoute` (daftar izin).
 *  - Active Branch Context + validasi cabang: `resolveBranchAuthority`.
 *  - Permission: requirePermission (sudah ada).
 *  - Account Policy / Transaction Rule: journal-service (satu pintu semua jalur).
 * Frontend tidak pernah menjadi penentu; semua keputusan di server.
 */

export const BRANCH_CONTEXT_HEADER = "x-branch-context";

const P = "/api/company-db/:companySlug";

/**
 * Daftar route yang SUDAH sadar-cabang (menangani cabang sendiri). Akun
 * berscope LIMITED HANYA boleh memanggil route di daftar ini; semua route
 * lain (laporan, ledger, dashboard, pencarian, export, saldo counterparty,
 * audit log, dst. yang belum difilter per cabang -- Phase 5) DITOLAK secara
 * default (fail-closed), termasuk route baru yang lupa didaftarkan.
 * Akun scope ALL tidak terpengaruh (perilaku lama).
 */
export const BRANCH_AWARE_ROUTES: ReadonlySet<string> = new Set([
  // cabang & konteks
  `GET ${P}/branches`,
  `GET ${P}/branches/:id`,
  `PATCH ${P}/branches/:id`,
  `GET ${P}/branch-context`,
  `PUT ${P}/branch-context`,
  // akses cabang user (Phase 3): admin LIMITED mengelola di dalam cakupannya sendiri; dicek per-cabang di route
  `GET ${P}/access/:userId/branches`,
  `POST ${P}/access/:userId/branches`,
  `DELETE ${P}/access/:userId/branches/:branchId`,
  `POST ${P}/access/:userId/branches/transfer`,
  // otorisasi & delegasi (Phase 3): batas wewenang ditegakkan db/system/authorization.ts
  `GET ${P}/authorization/me`,
  `GET ${P}/authorization/users`,
  `GET ${P}/authorization/users/:userId`,
  `PUT ${P}/access/:userId/permission-overrides/:permission`,
  `DELETE ${P}/access/:userId/permission-overrides/:permission`,
  `GET ${P}/delegations`,
  `POST ${P}/delegations`,
  `DELETE ${P}/delegations/:id`,
  // antar-cabang (Inter-Branch): otorisasi per-cabang ditegakkan di service (canActOnBranch); flag OFF => 404
  `GET ${P}/inter-branch`,
  `GET ${P}/inter-branch/summary`,
  `GET ${P}/inter-branch/options`,
  `GET ${P}/inter-branch/settings`,
  `PUT ${P}/inter-branch/settings`,
  `GET ${P}/inter-branch/:id`,
  `POST ${P}/inter-branch`,
  `POST ${P}/inter-branch/:id/approve`,
  `POST ${P}/inter-branch/:id/reject`,
  `POST ${P}/inter-branch/:id/cancel`,
  `POST ${P}/inter-branch/:id/reverse`,
  `POST ${P}/inter-branch/:id/reverse/:approvalId/approve`,
  `POST ${P}/inter-branch/:id/reverse/:approvalId/reject`,
  `POST ${P}/inter-branch/:id/reverse/:approvalId/cancel`,
  // jurnal
  `POST ${P}/journal`,
  `PUT ${P}/journal/:id`,
  `DELETE ${P}/journal/:id`,
  `POST ${P}/journal/:id/post`,
  `POST ${P}/journal/:id/reverse`,
  `POST ${P}/journal/reversal`,
  `GET ${P}/journals`,
  `GET ${P}/journals/:id`,
  `GET ${P}/journal-settings`,
  // import jurnal (history sengaja tidak termasuk: memuat batch seluruh perusahaan)
  `GET ${P}/journal-import/template`,
  `POST ${P}/journal-import/preview`,
  `POST ${P}/journal-import/commit`,
  // saldo awal (per cabang)
  `GET ${P}/opening-balance`,
  `POST ${P}/opening-balance`,
  `PUT ${P}/opening-balance`,
  `DELETE ${P}/opening-balance`,
  `POST ${P}/opening-balance/post`,
  `POST ${P}/opening-balance/reverse`,
  `GET ${P}/opening-balance-import/template`,
  `POST ${P}/opening-balance-import/preview`,
  `POST ${P}/opening-balance-import/commit`,
  // laporan & pembacaan keuangan (Phase 5A/5B): cakupan dihitung server (middleware/report-scope.ts); LIMITED hanya cabang dalam aksesnya
  `GET ${P}/reports/balance-sheet`,
  `GET ${P}/reports/income-statement`,
  `GET ${P}/reports/equity`,
  `GET ${P}/reports/cash-flow`,
  `GET ${P}/reports/export/:kind`,
  `GET ${P}/trial-balance`,
  `GET ${P}/ledger/:accountId`,
  `GET ${P}/dashboard`,
  `GET ${P}/counterparties/balances`,
  `GET ${P}/search`,
  // data referensi bersama (COA satu per perusahaan, periode, profil dasar) -- tanpa angka saldo
  `GET ${P}/accounts`,
  `GET ${P}/accounts/:id`,
  `GET ${P}/account-types`,
  `GET ${P}/periods`,
  `GET ${P}/profile`,
]);

export function isBranchAwareRoute(method: string, pattern: string): boolean {
  return BRANCH_AWARE_ROUTES.has(`${method.toUpperCase()} ${pattern}`);
}

/** Dipanggil requireCompanyAccess: akun LIMITED ditolak pada route yang belum sadar-cabang. */
export function enforceLimitedScopeRoute(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const access = request.companyAccess;
  if (!access || access.branchScope !== "LIMITED") return undefined;
  const pattern = request.routeOptions?.url ?? "";
  if (isBranchAwareRoute(request.method, pattern)) return undefined;
  return reply.code(403).send({
    error: "Fitur ini belum mendukung akun yang dibatasi per cabang. Hubungi pemilik perusahaan.",
    code: "BRANCH_SCOPE_UNSUPPORTED",
  });
}

export class BranchAccessDeniedError extends Error {
  readonly code = "BRANCH_ACCESS_DENIED" as const;
}
export class BranchContextInvalidError extends Error {
  readonly code = "BRANCH_CONTEXT_INVALID" as const;
  constructor(
    message: string,
    public readonly allowedBranchIds: string[] = [],
  ) {
    super(message);
  }
}
export class BranchContextMismatchError extends Error {
  readonly code = "BRANCH_CONTEXT_MISMATCH" as const;
}

export interface BranchAuthority {
  scope: "ALL" | "LIMITED";
  multiBranchEnabled: boolean;
  headOffice: BranchRow;
  /** Semua cabang perusahaan yang belum dihapus. */
  branches: BranchRow[];
  /** Cabang dalam akses user (ALL = semua; LIMITED = irisan dengan user_branch_access). */
  accessible: BranchRow[];
  /** accessible yang berstatus ACTIVE -- satu-satunya yang boleh jadi konteks kerja / menerima transaksi baru. */
  operational: BranchRow[];
  /** Konteks kerja tervalidasi; null bila user tidak punya cabang operasional. */
  context: BranchRow | null;
  contextSource: "header" | "preference" | "default" | "none";
}

function headerValue(request: FastifyRequest): string | null {
  const raw = request.headers[BRANCH_CONTEXT_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Menentukan cabang-cabang yang boleh disentuh user dan konteks kerjanya.
 * `db` = koneksi company.db milik handler (sudah dibuka untuk slug yang
 * diverifikasi requireCompanyAccess -- cabang SELALU dibaca dari company.db
 * itu, sehingga id cabang perusahaan lain tidak pernah dapat di-resolve).
 */
export async function resolveBranchAuthority(request: FastifyRequest, db: Knex): Promise<BranchAuthority> {
  const access = request.companyAccess;
  if (!access) throw new BranchAccessDeniedError("Perusahaan tidak ditemukan atau Anda tidak memiliki akses.");

  const [branches, headOffice, multiBranchEnabled] = await Promise.all([listBranches(db), getHeadOfficeBranch(db), isMultiBranchEnabled(db)]);
  const allowed = access.allowedBranchIds ? new Set(access.allowedBranchIds) : null;
  const accessible = access.branchScope === "ALL" ? branches : branches.filter((b) => allowed?.has(b.id));
  const operational = accessible.filter((b) => b.status === "ACTIVE");
  const byId = new Map(operational.map((b) => [b.id, b]));

  let context: BranchRow | null = null;
  let contextSource: BranchAuthority["contextSource"] = "none";

  const header = headerValue(request);
  if (header) {
    const hit = byId.get(header);
    if (!hit) {
      throw new BranchContextInvalidError(
        "Cabang kerja yang dipilih tidak valid atau Anda tidak lagi memiliki akses ke cabang tersebut.",
        operational.map((b) => b.id),
      );
    }
    context = hit;
    contextSource = "header";
  } else if (access.defaultBranchId && byId.has(access.defaultBranchId)) {
    context = byId.get(access.defaultBranchId)!;
    contextSource = "preference";
  } else if (operational.length > 0) {
    context = byId.get(headOffice.id) ?? operational[0];
    contextSource = "default";
  }

  return { scope: access.branchScope, multiBranchEnabled, headOffice, branches, accessible, operational, context, contextSource };
}

/** Cabang harus ada DAN dalam akses user; selain itu 404 seragam (tidak membocorkan keberadaan cabang lain). */
export function requireAccessibleBranch(auth: BranchAuthority, branchId: string | null | undefined): BranchRow {
  const hit = branchId ? auth.accessible.find((b) => b.id === branchId) : undefined;
  if (!hit) throw new BranchAccessDeniedError("Cabang tidak ditemukan atau Anda tidak memiliki akses.");
  return hit;
}

/** Konteks kerja wajib ada untuk operasi tulis. */
export function requireContextBranch(auth: BranchAuthority): BranchRow {
  if (!auth.context) {
    throw new BranchContextInvalidError("Anda belum memiliki cabang aktif yang dapat dipakai bekerja. Hubungi pemilik perusahaan.", []);
  }
  return auth.context;
}

/**
 * Cabang untuk operasi TULIS baru (mis. membuat jurnal). Server menentukan
 * cabang dari konteks kerja; bila klien mengirim `branchId`, nilainya harus
 * sama dengan konteks (bukan jalan pintas untuk menembus akses) dan cabang
 * tersebut harus dalam akses user.
 */
export function resolveWriteBranch(auth: BranchAuthority, requestedBranchId?: string | null): BranchRow {
  const context = requireContextBranch(auth);
  if (requestedBranchId && requestedBranchId !== context.id) {
    requireAccessibleBranch(auth, requestedBranchId); // 404 bila di luar akses (tanpa membocorkan)
    throw new BranchContextMismatchError(
      "Cabang pada permintaan berbeda dengan cabang kerja aktif Anda. Pindah cabang kerja terlebih dahulu.",
    );
  }
  return context;
}

/** Operasi tulis pada objek yang sudah ada (jurnal): cabang objek harus dalam akses DAN sama dengan konteks kerja. */
export function assertWritableObjectBranch(auth: BranchAuthority, objectBranchId: string | null | undefined): BranchRow {
  const branch = requireAccessibleBranch(auth, objectBranchId);
  const context = requireContextBranch(auth);
  if (branch.id !== context.id) {
    throw new BranchContextMismatchError("Data ini milik cabang lain. Pindah cabang kerja terlebih dahulu.");
  }
  return branch;
}

// Pembatasan laju audit penolakan (hindari banjir log): satu entri per (user, jenis) per menit.
const deniedAuditSeen = new Map<string, number>();
const DENIED_AUDIT_WINDOW_MS = 60_000;

async function auditDenied(request: FastifyRequest, kind: string): Promise<void> {
  try {
    const access = request.companyAccess;
    const user = request.authUser;
    if (!access || !user) return;
    const key = `${user.id}|${access.companyId}|${kind}`;
    const now = Date.now();
    const last = deniedAuditSeen.get(key) ?? 0;
    if (now - last < DENIED_AUDIT_WINDOW_MS) return;
    deniedAuditSeen.set(key, now);
    if (deniedAuditSeen.size > 5000) deniedAuditSeen.clear();
    await systemDb.transaction(async (trx) => {
      await appendSystemAudit(trx, {
        actor: { actorType: "user", actorId: user.id, actorLabel: user.fullName },
        action: "security.branch_access_denied",
        entityType: "branch",
        companyId: access.companyId,
        targetUserId: access.systemUserId,
        after: { kind, method: request.method, route: request.routeOptions?.url ?? null },
      });
    });
  } catch {
    /* audit penolakan bersifat best-effort; tidak boleh mengubah respons */
  }
}

/**
 * Pemetaan error cabang/kebijakan -> HTTP. Mengembalikan true bila sudah
 * dibalas. Dipakai semua route yang sadar-cabang agar kode status seragam.
 */
export async function replyBranchError(request: FastifyRequest, reply: FastifyReply, err: unknown): Promise<boolean> {
  if (err instanceof BranchAccessDeniedError || err instanceof BranchNotFoundError) {
    void auditDenied(request, "branch_not_accessible");
    reply.code(404).send({ error: "Cabang tidak ditemukan atau Anda tidak memiliki akses.", code: "BRANCH_NOT_FOUND" });
    return true;
  }
  if (err instanceof BranchContextInvalidError) {
    void auditDenied(request, "context_invalid");
    reply.code(403).send({ error: err.message, code: err.code, allowedBranchIds: err.allowedBranchIds });
    return true;
  }
  if (err instanceof BranchContextMismatchError) {
    reply.code(409).send({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof BranchNotOperationalError) {
    reply.code(403).send({ error: err.message, code: err.code, status: err.status });
    return true;
  }
  if (err instanceof AccountPolicyViolationError) {
    reply.code(400).send({ error: err.message, code: err.code, accountCode: err.accountCode, policy: err.policy });
    return true;
  }
  if (err instanceof BranchClosureBlockedError) {
    reply.code(409).send({ error: err.message, code: err.code, blockers: err.blockers });
    return true;
  }
  if (err instanceof MultiBranchHasPendingInterBranchError) {
    reply.code(409).send({ error: err.message, code: err.code, waiting: err.waiting, reversalWaiting: err.reversalWaiting });
    return true;
  }
  if (err instanceof BranchCodeExistsError || err instanceof BranchInvalidTransitionError || err instanceof BranchInUseError) {
    reply.code(409).send({ error: toUserErrorMessage(err), code: err.code });
    return true;
  }
  if (err instanceof BranchInvalidInputError || err instanceof JournalOriginNotSupportedError) {
    reply.code(400).send({ error: toUserErrorMessage(err), code: err.code });
    return true;
  }
  if (err instanceof BranchHeadOfficeProtectedError || err instanceof MultiBranchDisabledError) {
    reply.code(403).send({ error: toUserErrorMessage(err), code: err.code });
    return true;
  }
  return false;
}
