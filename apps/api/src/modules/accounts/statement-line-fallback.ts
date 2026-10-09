import crypto from "node:crypto";
import type { Knex } from "knex";

/**
 * Baris laporan "tampungan" per account_type -- dipakai `attachFallbackStatementLine`
 * di bawah supaya akun yang dibuat DI LUAR seeding awal (lewat endpoint
 * POST /accounts) SELALU ikut terhitung di Neraca/Laba-Rugi. Sama persis
 * logikanya dgn versi online (lihat modules/accounts/statement-line-fallback.ts
 * di sana untuk penjelasan lengkap kenapa ini WAJIB, bukan opsional) --
 * BEDA: scoped `company_id`.
 */
const FALLBACK_LINES: Record<string, { statementType: "balance_sheet" | "income_statement"; lineCode: string; lineLabel: string }> = {
  asset: { statementType: "balance_sheet", lineCode: "ca_other_imported", lineLabel: "Aset Lainnya" },
  liability: { statementType: "balance_sheet", lineCode: "cl_other_imported", lineLabel: "Liabilitas Lainnya" },
  equity: { statementType: "balance_sheet", lineCode: "eq_other_imported", lineLabel: "Ekuitas Lainnya" },
  revenue: { statementType: "income_statement", lineCode: "is_revenue_other_imported", lineLabel: "Pendapatan Lainnya" },
  expense: { statementType: "income_statement", lineCode: "is_expense_other_imported", lineLabel: "Beban Lainnya" },
};

export async function attachFallbackStatementLine(trx: Knex, companyId: string, accountId: string, accountType: string): Promise<void> {
  const fallback = FALLBACK_LINES[accountType];
  if (!fallback) return;

  let line = await trx("statement_lines")
    .where({ company_id: companyId, statement_type: fallback.statementType, line_code: fallback.lineCode })
    .first();
  if (!line) {
    const maxOrder = await trx("statement_lines")
      .where({ company_id: companyId, statement_type: fallback.statementType })
      .max("display_order as m")
      .first();
    const id = crypto.randomUUID();
    await trx("statement_lines").insert({
      id,
      company_id: companyId,
      statement_type: fallback.statementType,
      line_code: fallback.lineCode,
      line_label: fallback.lineLabel,
      display_order: Number(maxOrder?.m ?? 0) + 1,
    });
    line = { id };
  }

  await trx("statement_line_accounts")
    .insert({ id: crypto.randomUUID(), statement_line_id: line.id, account_id: accountId })
    .onConflict(["statement_line_id", "account_id"])
    .ignore();
}
