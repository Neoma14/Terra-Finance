import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import knexLib, { type Knex } from "knex";
import { afterEach, describe, expect, it } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { checkDatabaseIntegrity } from "./db-integrity.js";
import { up as upC0019 } from "./migrations/C0019_inter_branch.js";

/** Migrasi C0019: skema, pengaturan, idempotensi, `down`, dan tidak mengubah data yang sudah ada. */

const open: Knex[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.destroy();
});

function tempDb(): Knex {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "terra-ib-mig-")), "company.db");
  const db = knexLib({ ...baseKnexConfig, connection: { filename: file }, pool: { min: 1, max: 1, afterCreate: (c: any, d: any) => { c.pragma("foreign_keys = ON"); d(null, c); } } });
  open.push(db);
  return db;
}

const IB_TRIGGERS = [
  "accounts_ib_cash_ins", "accounts_ib_cash_upd", "company_profile_ib_flag_off",
  "inter_branch_approvals_final_immutable", "inter_branch_approvals_no_delete", "inter_branch_approvals_request_immutable",
  "inter_branch_transactions_immutable", "inter_branch_transactions_initial_state", "inter_branch_transactions_no_delete",
  "inter_branch_transactions_reversal_transition", "inter_branch_transactions_status_transition",
  "journal_entries_ib_core_upd", "journal_entries_ib_link_ins", "journal_entries_ib_link_upd", "journal_entries_ib_no_delete",
  "journal_entries_ib_ref_reserved", "journal_entries_ib_status_upd",
  "journal_entry_lines_ib_del", "journal_entry_lines_ib_ins", "journal_entry_lines_ib_upd",
];
const ibTriggers = async (db: Knex) => (await db("sqlite_master").where({ type: "trigger" }).whereIn("name", IB_TRIGGERS).select("name")).map((r: any) => r.name as string).sort();

const names = async (db: Knex, type: "table" | "trigger" | "index", like: string) =>
  (await db("sqlite_master").where({ type }).where("name", "like", like).select("name")).map((r: any) => r.name as string).sort();

describe("C0019 inter-branch: skema", () => {
  it("membuat dua tabel, kolom pengaturan (default 14, 1-90), trigger, dan indeks yang disetujui", async () => {
    const db = tempDb();
    await db.migrate.latest();
    expect(await names(db, "table", "inter_branch_%")).toEqual(["inter_branch_approvals", "inter_branch_transactions"]);
    expect((await db.migrate.list())[1]).toHaveLength(0);

    await db("company_profile").insert({ id: "p1", name: "PT Tes" });
    expect((await db("company_profile").first()).inter_branch_expiry_days).toBe(14);
    await db("company_profile").update({ inter_branch_expiry_days: 90 });
    await db("company_profile").update({ inter_branch_expiry_days: 1 });
    await expect(db("company_profile").update({ inter_branch_expiry_days: 0 })).rejects.toThrow(/CHECK/i);
    await expect(db("company_profile").update({ inter_branch_expiry_days: 91 })).rejects.toThrow(/CHECK/i);

    expect(await names(db, "index", "uq_%")).toEqual(expect.arrayContaining(["uq_accounts_inter_branch_pair", "uq_inter_branch_approvals_one_waiting", "uq_journal_entries_inter_branch_slot"]));
    expect(await ibTriggers(db)).toEqual(IB_TRIGGERS);
    // tidak ada indeks sekunder di luar yang disetujui (D-12): hanya UNIQUE/PK tabel IB
    const secondary = await db("sqlite_master").where({ type: "index", tbl_name: "inter_branch_transactions" }).whereNotNull("sql").select("name");
    expect(secondary.map((r: any) => r.name)).toEqual([]);
  });

  it("idempoten: menjalankan up() lagi tidak gagal dan tidak menggandakan apa pun", async () => {
    const db = tempDb();
    await db.migrate.latest();
    const before = await db("sqlite_master").count({ c: "*" }).first();
    await upC0019(db);
    expect(await db("sqlite_master").count({ c: "*" }).first()).toEqual(before);
  });

  it("down() menghapus tabel, trigger, indeks, dan kolom; up lagi pulih", async () => {
    const db = tempDb();
    await db.migrate.latest();
    await db("company_profile").insert({ id: "p1", name: "PT Tes" });
    await db.migrate.down();
    expect(await names(db, "table", "inter_branch_%")).toEqual([]);
    expect(await ibTriggers(db)).toEqual([]);
    expect(await names(db, "index", "uq_accounts_inter_branch_pair")).toEqual([]);
    expect(await db.schema.hasColumn("company_profile", "inter_branch_expiry_days")).toBe(false);
    expect(await db.schema.hasColumn("journal_entries", "inter_branch_transaction_id")).toBe(true);
    await db.migrate.up();
    expect(await names(db, "table", "inter_branch_%")).toHaveLength(2);
    expect((await db("company_profile").first()).inter_branch_expiry_days).toBe(14);
  });
});

describe("C0019 inter-branch: data yang sudah ada tidak berubah", () => {
  it("migrasi dari C0018 dengan data nyata: jumlah baris dan isi tetap, integrity_check ok, foreign_key_check 0", async () => {
    const db = tempDb();
    for (let i = 0; i < 18; i++) await db.migrate.up();
    expect(await db.schema.hasTable("inter_branch_transactions")).toBe(false);

    await db("company_profile").insert({ id: "p1", name: "PT Berdata" });
    const types = Object.fromEntries((await db("account_types").select("id", "code")).map((t: any) => [t.code, t.id]));
    await db("accounts").insert([
      { id: "a-kas", code: "1000", name: "Kas", account_type_id: types.ASSET, normal_balance: "debit", is_cash: true },
      { id: "a-hutang", code: "2000", name: "Hutang", account_type_id: types.LIABILITY, normal_balance: "credit", is_cash: false },
    ]);
    await db("periods").insert({ id: "p-jan", label: "Jan", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
    const hq = (await db("branches").where({ is_head_office: 1 }).first()).id;
    await db("journal_entries").insert({ id: "j1", entry_date: "2026-01-10", period_id: "p-jan", reference_no: "JU-1", status: "POSTED", branch_id: hq, origin: "manual" });
    await db("journal_entry_lines").insert([
      { id: "l1", journal_entry_id: "j1", account_id: "a-kas", debit: 100, credit: 0, line_order: 0 },
      { id: "l2", journal_entry_id: "j1", account_id: "a-hutang", debit: 0, credit: 100, line_order: 1 },
    ]);
    const snapshot = async () => ({
      journals: await db("journal_entries").orderBy("id"),
      lines: await db("journal_entry_lines").orderBy("id"),
      accounts: await db("accounts").orderBy("id"),
      profile: await db("company_profile").select("id", "name", "multi_branch_enabled"),
    });
    const before = await snapshot();

    await db.migrate.latest();

    expect(await snapshot()).toEqual(before);
    expect(await checkDatabaseIntegrity(db)).toEqual({ integrityOk: true, integrityMessages: ["ok"], foreignKeyViolations: 0 });
    expect((await db("inter_branch_transactions").count({ c: "*" }).first())!.c).toBe(0);
    expect((await db("company_profile").first()).multi_branch_enabled).toBe(0);
  });
});
