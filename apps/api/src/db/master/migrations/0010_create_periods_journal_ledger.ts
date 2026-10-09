import type { Knex } from "knex";

/**
 * Jurnal & Buku Besar -- struktur kolom disamakan persis dgn tabel
 * `periods`/`journal_entries`/`journal_entry_lines`/`trial_balance_snapshots`/
 * `counterparties` di tenant schema versi online (lihat db/tenant/migrations
 * 0002-0004, 0007-0008), BEDA:
 *  - `company_id` di `periods`/`journal_entries`/`counterparties` (satu file
 *    SQLite dibagi per perusahaan lewat kolom, bukan schema Postgres
 *    terpisah) -- `journal_entry_lines`/`trial_balance_snapshots` TIDAK
 *    perlu company_id sendiri krn sudah scoped transitif lewat
 *    journal_entry_id/period_id/account_id yang company-nya sudah pasti.
 *  - Nomor jurnal otomatis (JRN-000123) pakai kolom counter
 *    `companies.journal_number_seq` yang di-increment dalam transaksi,
 *    BUKAN `CREATE SEQUENCE` Postgres (SQLite tidak punya sequence).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("companies", (t) => {
    t.integer("journal_number_seq").notNullable().defaultTo(0);
  });

  await knex.schema.createTable("periods", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies").onDelete("CASCADE");
    t.string("label").notNullable();
    t.date("start_date").notNullable();
    t.date("end_date").notNullable();
    t.string("period_type").notNullable(); // month|quarter|year
    t.integer("fiscal_year").notNullable();
    t.boolean("is_closed").notNullable().defaultTo(false);
    t.unique(["company_id", "label"]);
    t.index(["company_id", "end_date"]);
  });

  await knex.schema.createTable("counterparties", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies").onDelete("CASCADE");
    t.string("type").notNullable(); // vendor|customer
    t.string("code").notNullable();
    t.string("name").notNullable();
    t.boolean("is_active").notNullable().defaultTo(true);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["company_id", "type", "code"]);
  });

  await knex.schema.createTable("journal_entries", (t) => {
    t.string("id").primary();
    t.string("company_id").notNullable().references("id").inTable("companies").onDelete("CASCADE");
    t.date("entry_date").notNullable();
    t.string("period_id").notNullable().references("id").inTable("periods");
    t.string("reference_no");
    t.string("description");
    t.string("source").notNullable().defaultTo("manual"); // import|manual
    t.string("created_by");
    t.string("reversal_of_id").references("id").inTable("journal_entries");
    t.boolean("is_reversed").notNullable().defaultTo(false);
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["company_id", "reference_no"]);
    t.index(["period_id"]);
  });

  await knex.schema.createTable("journal_entry_lines", (t) => {
    t.string("id").primary();
    t.string("journal_entry_id").notNullable().references("id").inTable("journal_entries").onDelete("CASCADE");
    t.string("account_id").notNullable().references("id").inTable("accounts");
    t.decimal("debit", 18, 2).notNullable().defaultTo(0);
    t.decimal("credit", 18, 2).notNullable().defaultTo(0);
    t.string("memo");
    t.string("counterparty_id").references("id").inTable("counterparties");
    t.index(["account_id"]);
    t.index(["journal_entry_id"]);
  });

  await knex.schema.createTable("trial_balance_snapshots", (t) => {
    t.string("id").primary();
    t.string("period_id").notNullable().references("id").inTable("periods");
    t.string("account_id").notNullable().references("id").inTable("accounts");
    t.decimal("beginning_balance", 18, 2).notNullable().defaultTo(0);
    t.decimal("debit_total", 18, 2).notNullable().defaultTo(0);
    t.decimal("credit_total", 18, 2).notNullable().defaultTo(0);
    t.decimal("ending_balance", 18, 2).notNullable().defaultTo(0);
    t.unique(["period_id", "account_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("trial_balance_snapshots");
  await knex.schema.dropTableIfExists("journal_entry_lines");
  await knex.schema.dropTableIfExists("journal_entries");
  await knex.schema.dropTableIfExists("counterparties");
  await knex.schema.dropTableIfExists("periods");
  await knex.schema.alterTable("companies", (t) => {
    t.dropColumn("journal_number_seq");
  });
}
