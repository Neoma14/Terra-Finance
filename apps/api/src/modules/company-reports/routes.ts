import type { FastifyInstance, FastifyReply } from "fastify";
import type { Knex } from "knex";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess, requirePermission } from "../../middleware/company-access-guard.js";
import { toUserErrorMessage } from "../../lib/error-message.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";
import { resolveRequestReportScope, replyScopeError } from "../../middleware/report-scope.js";
import { combinedScopeOf, scopePayload, type AuthorizedScope } from "../../db/company/report-scope.js";
import { buildComparison, flatBalanceSheet, flatEquity, flatIncomeStatement, ReportReconciliationError } from "../../db/company/reporting/report-comparison.js";
import { getInterBranchPosition } from "../../db/company/reporting/inter-branch-position.js";
import { getBalanceSheet } from "../../db/company/reporting/balance-sheet-service.js";
import { getIncomeStatement } from "../../db/company/reporting/income-statement-service.js";
import { getEquityStatement } from "../../db/company/reporting/equity-statement-service.js";
import { getCashFlowStatement } from "../../db/company/reporting/cash-flow-service.js";
import { InvalidDateRangeError, BalanceSheetNotBalancedError } from "../../db/company/reporting/reporting-types.js";
import { systemDb } from "../../db/system/index.js";
import { findCompanyRegistryBySlug } from "../../db/system/companies-registry.js";
import { EXPORT_KINDS, type ExportKind, type ExportFormat } from "../report-export/document.js";
import { buildExportDocument, ExportParamError } from "../report-export/build.js";
import { renderXlsx } from "../report-export/xlsx.js";
import { renderPdf } from "../report-export/pdf.js";
import { AccountNotFoundError } from "../../db/company/account-service.js";
import { FiscalPeriodNotFoundError } from "../../db/company/fiscal-period.js";

/**
 * Financial Reporting API (TASK-DB-ARCH-012 §13). Read-only, gate
 * `report.read` (permission existing sejak TASK-DB-ARCH-010, TIDAK
 * ditambah/diubah). Pola `requireAuth -> requireCompanyAccess ->
 * requirePermission` SAMA dgn seluruh module Company DB lain
 * (company-ledger/company-accounts/company-periods).
 *
 * Tidak ada audit log write di sini (§5 instruksi: "reporting read-only,
 * tidak perlu audit log per-GET") -- beda dgn journal/account/access
 * mutation routes yang SELALU appendCompanyAudit/appendSystemAudit.
 */

type ReportQuery = { companySlug: string };
type ReportQuerystring = { fromDate?: string; toDate?: string };

function sendReportError(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidDateRangeError) {
    return reply.code(400).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof BalanceSheetNotBalancedError) {
    // §Fail-safe: integrity bug, bukan kondisi laporan valid -- 500,
    // bukan 200 dgn angka yang salah/disembunyikan.
    return reply.code(500).send({ error: toUserErrorMessage(err) });
  }
  if (err instanceof ReportReconciliationError) {
    // Selisih rekonsiliasi komparasi = galat integritas; JANGAN disembunyikan atau dirapikan.
    return reply.code(500).send({ error: err.message, code: err.code });
  }
  return reply.code(500).send({ error: toUserErrorMessage(err) });
}

type ReportKindKey = "balance-sheet" | "income-statement" | "equity" | "cash-flow";

/**
 * Definisi laporan berbasis tanggal. `flat` null = komparasi per cabang belum didukung (Arus Kas: menunggu optimasi, D8).
 * Semua laporan memakai `resolveRequestReportScope` (otorisasi cakupan di server) dan memuat `scope` pada respons.
 */
const DATE_REPORTS = {
  "balance-sheet": { run: getBalanceSheet, flat: flatBalanceSheet },
  "income-statement": { run: getIncomeStatement, flat: flatIncomeStatement },
  equity: { run: getEquityStatement, flat: flatEquity },
  "cash-flow": { run: getCashFlowStatement, flat: null },
} as const;

const isCombinedMode = (mode: string) => mode === "COMBINED_SELECTED" || mode === "COMBINED_ALL";

export async function companyReportsRoutes(app: FastifyInstance) {
  const gate = { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] };

  for (const kind of Object.keys(DATE_REPORTS) as ReportKindKey[]) {
    const def = DATE_REPORTS[kind];
    app.get<{ Params: ReportQuery; Querystring: ReportQuerystring & { scope?: string } }>(
      `/api/company-db/:companySlug/reports/${kind}`,
      gate,
      async (request, reply) => {
        const { fromDate, toDate } = request.query;
        if (!fromDate || !toDate) return reply.code(400).send({ error: "fromDate dan toDate wajib diisi sbg query parameter." });

        const db = openCompanyDbForSlug(request.params.companySlug);
        try {
          const scope = await resolveRequestReportScope(request, db, { allowComparison: def.flat !== null });
          if (scope.mode === "COMPARISON" && def.flat) {
            const run = def.run as (db: Knex, from: string, to: string, scope?: AuthorizedScope) => Promise<never>;
            const comparison = await buildComparison(scope, (s) => run(db, fromDate, toDate, s), def.flat as never);
            return reply.send({ scope: scopePayload(scope), comparison, interBranch: await getInterBranchPosition(db, combinedScopeOf(scope), toDate) });
          }
          const report = await def.run(db, fromDate, toDate, scope);
          const body: Record<string, unknown> = { ...report, scope: scopePayload(scope) };
          if (isCombinedMode(scope.mode)) body.interBranch = await getInterBranchPosition(db, scope, toDate);
          return reply.send(body);
        } catch (err) {
          if (await replyScopeError(request, reply, err)) return reply;
          return sendReportError(reply, err);
        } finally {
          await db.destroy();
        }
      },
    );
  }

  /**
   * Export laporan ke .xlsx / .pdf (TASK-EXPORT). Gate SAMA dgn seluruh
   * laporan: requireAuth -> requireCompanyAccess -> requirePermission("report.read").
   * Parameter (fromDate/toDate atau periodId/accountId) mengikuti filter
   * halaman yang sedang dibuka; angka diambil dari service laporan yang
   * sama dgn endpoint JSON di atas.
   */
  app.get<{
    Params: { companySlug: string; kind: string };
    Querystring: { format?: string; fromDate?: string; toDate?: string; periodId?: string; accountId?: string; scope?: string };
  }>(
    "/api/company-db/:companySlug/reports/export/:kind",
    { preHandler: [requireAuth, requireCompanyAccess, requirePermission("report.read")] },
    async (request, reply) => {
      const kind = request.params.kind as ExportKind;
      if (!(EXPORT_KINDS as readonly string[]).includes(kind)) {
        return reply.code(404).send({ error: "Jenis laporan tidak dikenal." });
      }
      const format = request.query.format as ExportFormat | undefined;
      if (format !== "xlsx" && format !== "pdf") {
        return reply.code(400).send({ error: "Format harus xlsx atau pdf." });
      }

      const registryRow = await findCompanyRegistryBySlug(systemDb, request.params.companySlug);
      if (!registryRow) return reply.code(404).send({ error: "Perusahaan tidak ditemukan atau Anda tidak memiliki akses." });

      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        // Cakupan dievaluasi ULANG di awal request ekspor (bukan dari halaman); komparasi belum didukung untuk ekspor.
        const scope = await resolveRequestReportScope(request, db);
        const doc = await buildExportDocument(db, kind, request.query, registryRow.name, scope);
        const buffer = format === "xlsx" ? await renderXlsx(doc) : await renderPdf(doc);
        reply.header(
          "Content-Type",
          format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
        );
        reply.header("Content-Disposition", `attachment; filename="${doc.fileBase}.${format}"`);
        reply.header("Cache-Control", "no-store");
        return reply.send(buffer);
      } catch (err) {
        if (await replyScopeError(request, reply, err)) return reply;
        if (err instanceof ExportParamError) return reply.code(err.status).send({ error: err.message });
        if (err instanceof InvalidDateRangeError) return reply.code(400).send({ error: toUserErrorMessage(err) });
        if (err instanceof AccountNotFoundError || err instanceof FiscalPeriodNotFoundError) {
          return reply.code(404).send({ error: toUserErrorMessage(err) });
        }
        // Detail teknis hanya ke log server; client hanya menerima pesan generik.
        request.log.error({ err }, "report export failed");
        return reply.code(500).send({ error: "Gagal membuat laporan. Silakan coba lagi." });
      } finally {
        await db.destroy();
      }
    },
  );
}
