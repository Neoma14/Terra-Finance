import type { FastifyInstance } from "fastify";
import type { BenchmarkCompany, BenchmarkMetric } from "@konsultan/shared";
import { masterDb } from "../../db/master/index.js";
import { systemDb } from "../../db/system/index.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { listAccessibleCompanies } from "../../db/system/company-access.js";
import { requireAuth } from "../../middleware/auth-guard.js";
import { findPeriodsInRange } from "../periods/date-range.js";
import { buildContextForRange, getRatiosForRange, getUniversalMetrics } from "../ratios/calculator.js";
import { buildBenchmarkWorkbook } from "./export.js";
import type { SessionUser } from "../auth/session-service.js";

const UNIVERSAL_METRIC_LABELS: Record<string, { label: string; format: "currency" }> = {
  revenue: { label: "Pendapatan", format: "currency" },
  net_income: { label: "Laba Bersih / SHU", format: "currency" },
  total_assets: { label: "Total Aset", format: "currency" },
  total_liabilities: { label: "Total Liabilitas", format: "currency" },
  total_equity: { label: "Total Ekuitas", format: "currency" },
};

interface Query {
  from?: string;
  to?: string;
  companyIds?: string;
}

/**
 * Benchmarking lintas-perusahaan -- hitung langsung per perusahaan utk
 * rentang tanggal bebas, reuse kalkulator yang sama dgn Rasio
 * single-company, bukan tabel cache.
 *
 * TASK-021: SEBELUMNYA fungsi ini membaca `masterDb.companies` TANPA
 * filter sama sekali -- cocok dgn desain ASLI "satu instalasi = satu firm,
 * semua staf lihat semua klien", TAPI arsitektur baru (`company_access`
 * per-role, TASK-DB-ARCH-011) sekarang memungkinkan staf dibatasi hanya ke
 * company TERTENTU (lihat journal/accounts/ledger/reports/dashboard yang
 * sudah pakai `requireCompanyAccess`). Tanpa filter di sini, staf yang
 * company_access-nya SENGAJA dibatasi tetap bisa lihat rasio keuangan
 * company lain lewat Benchmarking -- celah isolasi yang sama persis
 * kelasnya dgn CRITICAL #1 (TASK-020), cuma terlewat krn rute ini bukan
 * `/api/c/:companySlug/*`. Diperbaiki dgn memfilter ke slug yang
 * `listAccessibleCompanies()` kembalikan utk user yang login, SEBELUM
 * query `companyIds` dari client diterapkan (jadi client tidak bisa
 * menyisipkan id company yang tidak ia punya akses lewat query string).
 */
async function computeBenchmarkResults(
  accessibleSlugs: string[],
  from: string,
  to: string,
  companyIds?: string,
): Promise<BenchmarkCompany[]> {
  if (accessibleSlugs.length === 0) return [];

  let companiesQuery = masterDb("companies").where({ status: "active" }).whereIn("slug", accessibleSlugs);

  if (companyIds) {
    const ids = companyIds.split(",").filter(Boolean);
    if (ids.length > 0) companiesQuery = companiesQuery.whereIn("id", ids);
  }

  const companies = await companiesQuery.select("id", "slug", "name", "industry_template as industryTemplate");

  const results: BenchmarkCompany[] = [];

  for (const company of companies as any[]) {
    const periods = await findPeriodsInRange(masterDb, company.id, from, to);
    if (periods.length === 0) continue; // perusahaan ini tidak punya data di rentang ini -- lewati, bukan tampilkan 0

    const [ctx, ratioResult] = await Promise.all([
      buildContextForRange(masterDb, company.id, from, to),
      getRatiosForRange(masterDb, company.id, company.industryTemplate, from, to),
    ]);

    const universalMetrics: BenchmarkMetric[] = getUniversalMetrics(ctx).map((m) => ({
      code: m.code,
      label: UNIVERSAL_METRIC_LABELS[m.code]?.label ?? m.code,
      format: UNIVERSAL_METRIC_LABELS[m.code]?.format ?? "currency",
      value: m.value,
    }));

    const industryMetrics: BenchmarkMetric[] = ratioResult.ratios.map((r) => ({
      code: r.code,
      label: r.label,
      format: r.format,
      value: r.value,
    }));

    results.push({
      companyId: company.id,
      companyName: company.name,
      companySlug: company.slug,
      industryTemplate: company.industryTemplate,
      periodLabel: `${from} s/d ${to}`,
      periodEndDate: to,
      universalMetrics,
      industryMetrics,
    });
  }

  return results;
}

async function getAccessibleSlugsForRequest(authUser: SessionUser): Promise<string[]> {
  const systemUserId = await ensureSystemIdentity(systemDb, authUser);
  const accessible = await listAccessibleCompanies(systemDb, systemUserId);
  return accessible.map((a) => a.slug);
}

export async function benchmarkRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Query }>("/api/benchmark", { preHandler: requireAuth }, async (request, reply) => {
    const { from, to, companyIds } = request.query;
    if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

    const accessibleSlugs = await getAccessibleSlugsForRequest(request.authUser!);
    const results = await computeBenchmarkResults(accessibleSlugs, from, to, companyIds);
    return reply.send({ companies: results });
  });

  app.get<{ Querystring: Query }>("/api/benchmark/export", { preHandler: requireAuth }, async (request, reply) => {
    const { from, to, companyIds } = request.query;
    if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

    const accessibleSlugs = await getAccessibleSlugsForRequest(request.authUser!);
    const results = await computeBenchmarkResults(accessibleSlugs, from, to, companyIds);
    const rangeLabel = `${from} s/d ${to}`;
    const buffer = await buildBenchmarkWorkbook(rangeLabel, results);

    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="Benchmarking Antar Perusahaan - ${rangeLabel}.xlsx"`)
      .send(buffer);
  });
}
