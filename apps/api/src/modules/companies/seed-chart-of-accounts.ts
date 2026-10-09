import crypto from "node:crypto";
import type { Knex } from "knex";
import type { ChartOfAccountsTemplate } from "./templates/index.js";

/** Seed chart of accounts + statement line mapping dari template industri
 * tertentu (lihat ./templates) -- dipanggil sekali saat perusahaan baru
 * dibuat. Sama logikanya dgn versi online, BEDA: scoped `company_id`
 * (bukan schema Postgres terpisah) & id dibuat eksplisit via
 * crypto.randomUUID() (SQLite tidak punya gen_random_uuid() bawaan). */
export async function seedChartOfAccounts(masterDb: Knex, companyId: string, template: ChartOfAccountsTemplate): Promise<void> {
  await masterDb.transaction(async (trx) => {
    const statementLineIds = new Map<string, string>();

    for (const acc of template.accounts) {
      const key = `${acc.statementType}:${acc.lineCode}`;
      if (!statementLineIds.has(key)) {
        const lineId = crypto.randomUUID();
        await trx("statement_lines").insert({
          id: lineId,
          company_id: companyId,
          statement_type: acc.statementType,
          line_code: acc.lineCode,
          line_label: acc.lineLabel,
          display_order: statementLineIds.size,
        });
        statementLineIds.set(key, lineId);
      }

      const accountId = crypto.randomUUID();
      await trx("accounts").insert({
        id: accountId,
        company_id: companyId,
        code: acc.code,
        name: acc.name,
        account_type: acc.accountType,
        account_subtype: acc.accountSubtype,
        normal_balance: acc.normalBalance,
        cash_flow_activity: acc.cashFlowActivity ?? null,
        is_cash: acc.isCash ?? false,
        subledger_type: acc.subledgerType ?? null,
      });

      await trx("statement_line_accounts").insert({
        id: crypto.randomUUID(),
        statement_line_id: statementLineIds.get(key),
        account_id: accountId,
      });
    }
  });
}
