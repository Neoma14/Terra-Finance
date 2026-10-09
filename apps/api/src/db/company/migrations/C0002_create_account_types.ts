import crypto from "node:crypto";
import type { Knex } from "knex";

/**
 * Tabel referensi klasifikasi akun -- Database_Schema.md §12 (APPROVED
 * MASTER doc), BELUM ADA di implementasi shared-DB lama (migration 0009
 * menyimpan account_type sbg string enum langsung di kolom `accounts`,
 * tanpa tabel referensi terpisah -- dicatat sbg risiko drift di audit
 * TASK-DB-ARCH-001/ADR). Company DB foundation ini MENORMALISASI dgn
 * membuat tabel referensi sungguhan, sesuai izin eksplisit TASK-DB-ARCH-003
 * §10 ("if the audit confirms that it is required, create it").
 *
 * Seed 9 baris tetap (Accounting_Rules.md §3 "ACCOUNT TYPES" + §4 "NORMAL
 * BALANCE") dilakukan di migration ini sendiri -- ini data referensi
 * skema/enum, BUKAN data klien, jadi tidak melanggar "jangan populate data
 * klien" (§11 instruksi task).
 *
 * CATATAN TERBUKA (dilaporkan, bukan diputuskan sepihak): Accounting_Rules.md
 * tidak menyebutkan normal_balance eksplisit utk tipe TAX, juga tidak
 * menyebutkan nilai `financial_statement` yang valid utk account_types.
 * Nilai di bawah (TAX -> credit, financial_statement null utk TAX) adalah
 * ASUMSI DEFAULT yang masuk akal (tax payable lebih umum drpd tax expense
 * murni) tapi BUKAN berasal dari dokumen yang approved -- lihat laporan
 * akhir, bagian "Documentation Discrepancies".
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("account_types", (t) => {
    t.string("id").primary();
    t.string("code").notNullable().unique();
    t.string("name").notNullable();
    t.string("normal_balance").notNullable(); // 'debit' | 'credit'
    t.string("financial_statement"); // 'balance_sheet' | 'income_statement' | null
    t.integer("sort_order").notNullable().defaultTo(0);
  });

  const seed: Array<{ code: string; name: string; normal_balance: string; financial_statement: string | null; sort_order: number }> = [
    { code: "ASSET", name: "Asset", normal_balance: "debit", financial_statement: "balance_sheet", sort_order: 10 },
    { code: "LIABILITY", name: "Liability", normal_balance: "credit", financial_statement: "balance_sheet", sort_order: 20 },
    { code: "EQUITY", name: "Equity", normal_balance: "credit", financial_statement: "balance_sheet", sort_order: 30 },
    { code: "REVENUE", name: "Revenue", normal_balance: "credit", financial_statement: "income_statement", sort_order: 40 },
    { code: "COGS", name: "Cost of Goods Sold", normal_balance: "debit", financial_statement: "income_statement", sort_order: 50 },
    { code: "EXPENSE", name: "Expense", normal_balance: "debit", financial_statement: "income_statement", sort_order: 60 },
    { code: "OTHER_INCOME", name: "Other Income", normal_balance: "credit", financial_statement: "income_statement", sort_order: 70 },
    { code: "OTHER_EXPENSE", name: "Other Expense", normal_balance: "debit", financial_statement: "income_statement", sort_order: 80 },
    // TAX: normal_balance & financial_statement TIDAK didefinisikan eksplisit
    // di Accounting_Rules.md -- lihat catatan di atas.
    { code: "TAX", name: "Tax", normal_balance: "credit", financial_statement: null, sort_order: 90 },
  ];

  await knex("account_types").insert(
    seed.map((row) => ({ id: crypto.randomUUID(), ...row })),
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("account_types");
}
