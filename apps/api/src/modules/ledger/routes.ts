import type { FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { masterDb } from "../../db/master/index.js";
import { requireAuth } from "../../middleware/auth-guard.js";
// TASK-020: lihat komentar sama di modules/journal/routes.ts.
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { resolveCompanyBySlug } from "../companies/resolve-company.js";
import { findPeriodsInRange } from "../periods/date-range.js";
import { getLedgerBalancesForRange } from "./balances-range.js";
import { buildLedgerWorkbook } from "./export.js";

const FLOW_TYPES = new Set(["revenue", "expense"]);

async function computeLedgerForRange(db: Knex, companyId: string, accountId: string, from: string, to: string) {
  const account = await db("accounts").where({ id: accountId, company_id: companyId }).first();
  if (!account) throw new Error("Akun tidak ditemukan");

  const periods = await findPeriodsInRange(db, companyId, from, to);
  if (periods.length === 0) throw new Error("Tidak ada periode yang mencakup rentang tanggal ini");

  const isFlow = FLOW_TYPES.has(account.account_type);
  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];

  const snapshots = await db("trial_balance_snapshots")
    .whereIn(
      "period_id",
      periods.map((p) => p.id),
    )
    .andWhere({ account_id: accountId })
    .select("period_id", "beginning_balance", "ending_balance");
  const snapshotByPeriod = new Map(snapshots.map((s: any) => [s.period_id, s]));

  const beginningBalance = isFlow ? 0 : Number((snapshotByPeriod.get(firstPeriod.id) as any)?.beginning_balance ?? 0);
  const endingBalance = isFlow
    ? snapshots.reduce((sum: number, s: any) => sum + Number(s.ending_balance), 0)
    : Number((snapshotByPeriod.get(lastPeriod.id) as any)?.ending_balance ?? beginningBalance);

  const rows = await db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .where("jel.account_id", accountId)
    .andWhere("je.entry_date", ">=", from)
    .andWhere("je.entry_date", "<=", to)
    .orderBy(["je.entry_date", "je.created_at"])
    .select(
      "je.id as journalEntryId",
      "je.entry_date as entryDate",
      "je.reference_no as referenceNo",
      "je.description",
      "je.is_reversed as isReversed",
      "jel.debit",
      "jel.credit",
    );

  let running = beginningBalance;
  const lines = rows.map((r: any) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    running = account.normal_balance === "debit" ? running + debit - credit : running + credit - debit;
    return {
      journalEntryId: r.journalEntryId,
      entryDate: r.entryDate,
      referenceNo: r.referenceNo,
      description: r.description,
      debit,
      credit,
      runningBalance: running,
      isReversed: !!r.isReversed,
    };
  });

  return {
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    normalBalance: account.normal_balance,
    periodId: lastPeriod.id,
    periodLabel: `${from} s/d ${to}`,
    beginningBalance,
    endingBalance,
    lines,
  };
}

/**
 * Buku Besar per akun -- logika disamakan persis dgn modules/ledger/routes.ts
 * versi online. BELUM ADA di fase ini: export Excel (butuh exceljs, bisa
 * ditambah nanti tanpa ubah struktur ini).
 */
export async function ledgerRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { periodId?: string; accountId?: string } }>(
    "/api/c/:companySlug/ledger",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { periodId, accountId } = request.query;
      if (!periodId || !accountId) return reply.code(400).send({ error: "periodId & accountId wajib diisi" });

      const account = await masterDb("accounts").where({ id: accountId, company_id: company.id }).first();
      if (!account) return reply.code(404).send({ error: "Akun tidak ditemukan" });

      const period = await masterDb("periods").where({ id: periodId, company_id: company.id }).first();
      if (!period) return reply.code(404).send({ error: "Periode tidak ditemukan" });

      const snapshot = await masterDb("trial_balance_snapshots").where({ period_id: periodId, account_id: accountId }).first();
      const beginningBalance = Number(snapshot?.beginning_balance ?? 0);
      const endingBalance = Number(snapshot?.ending_balance ?? beginningBalance);

      const rows = await masterDb("journal_entry_lines as jel")
        .join("journal_entries as je", "je.id", "jel.journal_entry_id")
        .where("je.period_id", periodId)
        .andWhere("jel.account_id", accountId)
        .orderBy(["je.entry_date", "je.created_at"])
        .select(
          "je.id as journalEntryId",
          "je.entry_date as entryDate",
          "je.reference_no as referenceNo",
          "je.description",
          "je.is_reversed as isReversed",
          "jel.debit",
          "jel.credit",
        );

      let running = beginningBalance;
      const lines = rows.map((r: any) => {
        const debit = Number(r.debit);
        const credit = Number(r.credit);
        running = account.normal_balance === "debit" ? running + debit - credit : running + credit - debit;
        return {
          journalEntryId: r.journalEntryId,
          entryDate: r.entryDate,
          referenceNo: r.referenceNo,
          description: r.description,
          debit,
          credit,
          runningBalance: running,
          isReversed: !!r.isReversed,
        };
      });

      return reply.send({
        result: {
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          normalBalance: account.normal_balance,
          periodId,
          periodLabel: period.label,
          beginningBalance,
          endingBalance,
          lines,
        },
      });
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { accountId?: string; from?: string; to?: string } }>(
    "/api/c/:companySlug/ledger/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { accountId, from, to } = request.query;
      if (!accountId || !from || !to) return reply.code(400).send({ error: "accountId, from, & to wajib diisi" });

      try {
        const result = await computeLedgerForRange(masterDb, company.id, accountId, from, to);
        return reply.send({ result });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { from?: string; to?: string } }>(
    "/api/c/:companySlug/ledger/balances/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { from, to } = request.query;
      if (!from || !to) return reply.code(400).send({ error: "from & to wajib diisi" });

      try {
        const balances = await getLedgerBalancesForRange(masterDb, company.id, from, to);
        return reply.send({ balances });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { periodId?: string } }>(
    "/api/c/:companySlug/ledger/balances",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { periodId } = request.query;
      if (!periodId) return reply.code(400).send({ error: "periodId wajib diisi" });

      const rows = await masterDb("accounts as a")
        .leftJoin("trial_balance_snapshots as tbs", function () {
          this.on("tbs.account_id", "=", "a.id").andOn("tbs.period_id", "=", masterDb.raw("?", [periodId]));
        })
        .where("a.company_id", company.id)
        .orderBy("a.code")
        .select(
          "a.id as accountId",
          "a.code",
          "a.name",
          "a.account_type as accountType",
          masterDb.raw('COALESCE(tbs.beginning_balance, 0) as "beginningBalance"'),
          masterDb.raw('COALESCE(tbs.debit_total, 0) as "debitTotal"'),
          masterDb.raw('COALESCE(tbs.credit_total, 0) as "creditTotal"'),
          masterDb.raw('COALESCE(tbs.ending_balance, 0) as "endingBalance"'),
        );

      const balances = rows.map((r: any) => ({
        ...r,
        beginningBalance: Number(r.beginningBalance),
        debitTotal: Number(r.debitTotal),
        creditTotal: Number(r.creditTotal),
        endingBalance: Number(r.endingBalance),
      }));
      return reply.send({ balances });
    },
  );

  app.get<{ Params: { companySlug: string }; Querystring: { accountId?: string; from?: string; to?: string } }>(
    "/api/c/:companySlug/ledger/export/range",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const company = await resolveCompanyBySlug(masterDb, request.params.companySlug);
      if (!company) return reply.code(404).send({ error: "Perusahaan tidak ditemukan" });

      const { accountId, from, to } = request.query;
      if (!accountId || !from || !to) return reply.code(400).send({ error: "accountId, from, & to wajib diisi" });

      let result;
      try {
        result = await computeLedgerForRange(masterDb, company.id, accountId, from, to);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const buffer = await buildLedgerWorkbook(
        company.name,
        result.accountCode,
        result.accountName,
        result.periodLabel,
        result.beginningBalance,
        result.endingBalance,
        result.lines,
      );
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header(
          "Content-Disposition",
          `attachment; filename="Buku Besar - ${result.accountCode} ${company.name} - ${result.periodLabel}.xlsx"`,
        )
        .send(buffer);
    },
  );
}
