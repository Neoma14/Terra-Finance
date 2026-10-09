import type { FastifyReply, FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { hasBasePermission } from "../db/system/authorization.js";
import { ReportScopeError, resolveReportScope, type AuthorizedScope } from "../db/company/report-scope.js";
import { replyBranchError, resolveBranchAuthority } from "./branch-authority.js";

/**
 * Integrasi request untuk cakupan laporan (Phase 5A/5B). Seluruh masukan hak berasal dari `request.companyAccess`
 * (diisi `requireCompanyAccess` dari System DB tiap request) dan dari company.db milik handler; satu-satunya masukan
 * klien adalah string `scope` yang divalidasi `resolveReportScope`. Tidak ada cache izin.
 */
export async function resolveRequestReportScope(
  request: FastifyRequest,
  db: Knex,
  opts: { allowComparison?: boolean } = {},
): Promise<AuthorizedScope> {
  const access = request.companyAccess;
  if (!access) throw new ReportScopeError(404, "REPORT_SCOPE_NOT_FOUND", "Perusahaan tidak ditemukan atau Anda tidak memiliki akses.");
  const rawQuery = (request.query as { scope?: unknown } | undefined)?.scope;
  if (rawQuery !== undefined && typeof rawQuery !== "string") throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", "Parameter cakupan tidak valid.");

  const authority = await resolveBranchAuthority(request, db);
  return resolveReportScope({
    multiBranchEnabled: authority.multiBranchEnabled,
    allBranches: authority.branches,
    accessible: authority.accessible,
    context: authority.context,
    canConsolidate: hasBasePermission(access, "report.consolidated"),
    rawScope: rawQuery,
    allowComparison: opts.allowComparison,
  });
}

/** Membalas galat cakupan/cabang; true bila sudah dibalas. */
export async function replyScopeError(request: FastifyRequest, reply: FastifyReply, err: unknown): Promise<boolean> {
  if (err instanceof ReportScopeError) {
    void reply.code(err.status).send({ error: err.message, code: err.code });
    return true;
  }
  return replyBranchError(request, reply, err);
}
