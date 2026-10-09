import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import systemKnexfile from "../system/knexfile.js";
import masterKnexfile from "../master/knexfile.js";
import companyKnexfile from "./knexfile.js";
import { createAccount } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "./journal-service.js";
import { getAccountLedgerByRange } from "./ledger-service.js";
import { getIncomeStatement } from "./reporting/income-statement-service.js";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { getCashFlowStatement } from "./reporting/cash-flow-service.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { getDashboardSummary } from "./dashboard-service.js";
import type { ActorContext } from "./company-audit.js";

// Modul backup ada di paket desktop (CommonJS, tanpa Electron) -- diuji langsung.
const require = createRequire(import.meta.url);
const backup = require("../../../../desktop/src/backup.js") as {
  runBackup: (dir: string, opts?: Record<string, unknown>) => { copied: string[]; skipped: string[]; backupDir: string };
  restoreBackup: (backupDir: string, target: string, opts?: Record<string, unknown>) => { restored: string[] };
};

const actor: ActorContext = { actorType: "user", actorId: "t", actorLabel: "T" };

async function migrated(file: string, config: object): Promise<Knex> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = knexLib({ ...(config as Knex.Config), connection: { filename: file } });
  await db.migrate.latest();
  return db;
}

describe("Backup & restore data (system + master + semua company.db)", () => {
  let root: string;
  let userData: string;
  let companyDb: Knex;
  let kas: string;
  let modal: string;
  let pend: string;
  let periodId: string;

  async function post(date: string, ref: string, d: string, c: string, amt: number) {
    const { id } = await createDraftJournalEntry(companyDb, { entryDate: date, periodId, referenceNo: ref, lines: [{ accountId: d, debit: amt, credit: 0 }, { accountId: c, debit: 0, credit: amt }] }, actor);
    await postJournalEntry(companyDb, { journalEntryId: id }, actor);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terra-backup-test-"));
    userData = path.join(root, "userdata");
    const sys = await migrated(path.join(userData, "terra-system.sqlite"), systemKnexfile);
    await sys("companies_registry").insert({ id: crypto.randomUUID(), slug: "pt-satu", name: "PT Satu", database_path: "x", status: "active", schema_version: 13, last_migration_status: "READY" });
    await sys.destroy();
    const master = await migrated(path.join(userData, "terra-finance.sqlite"), masterKnexfile);
    await master("company_profile").insert({ id: crypto.randomUUID(), name: "PT Satu" });
    await master.destroy();

    companyDb = await migrated(path.join(userData, "companies", "pt-satu", "company.db"), companyKnexfile);
    kas = (await createAccount(companyDb, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit", isCash: true, cashFlowActivity: "operating" }, actor)).id;
    modal = (await createAccount(companyDb, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    pend = (await createAccount(companyDb, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    periodId = crypto.randomUUID();
    await companyDb("periods").insert({ id: periodId, label: "Jan-Mar 2026", start_date: "2026-01-01", end_date: "2026-03-31", period_type: "quarter", fiscal_year: 2026, status: "OPEN" });
    await post("2026-01-02", "J1", kas, modal, 50_000);
    await post("2026-02-10", "J2", kas, pend, 12_000);
    await post("2026-03-05", "J3", kas, pend, 8_000);
  });

  afterEach(async () => {
    await companyDb.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("backup mencakup system DB, master DB, dan company.db; restore ke folder baru menghasilkan data yang SAMA (jurnal, ledger, laporan, dashboard)", async () => {
    // ambil angka dari sumber SEBELUM backup
    const srcLedger = await getAccountLedgerByRange(companyDb, kas, "2026-02-01", "2026-03-31");
    const srcIncome = await getIncomeStatement(companyDb, "2026-01-01", "2026-03-31");
    const srcBs = await getBalanceSheet(companyDb, "2026-01-01", "2026-03-31");
    const srcCf = await getCashFlowStatement(companyDb, "2026-01-01", "2026-03-31");
    const srcTb = await getTrialBalance(companyDb, periodId);
    const srcDash = await getDashboardSummary(companyDb, "2026-01-01", "2026-03-31");

    const result = backup.runBackup(userData);
    expect(result.copied).toHaveLength(3);
    expect(result.copied.some((f) => /^companies[\\/]pt-satu[\\/]company-.*\.db$/.test(f))).toBe(true);
    expect(result.copied.some((f) => /^terra-system-.*\.sqlite$/.test(f))).toBe(true);
    expect(result.copied.some((f) => /^terra-finance-.*\.sqlite$/.test(f))).toBe(true);

    // restore ke folder BARU (bukan folder data asli)
    const restoredDir = path.join(root, "restored");
    const restored = backup.restoreBackup(result.backupDir, restoredDir);
    expect(restored.restored.sort()).toEqual([path.join("companies", "pt-satu", "company.db"), "terra-finance.sqlite", "terra-system.sqlite"].sort());

    // buka hasil restore
    const rc = knexLib({ ...companyKnexfile, connection: { filename: path.join(restoredDir, "companies", "pt-satu", "company.db") } });
    const rs = knexLib({ ...systemKnexfile, connection: { filename: path.join(restoredDir, "terra-system.sqlite") } });
    try {
      expect((await rs("companies_registry").where({ slug: "pt-satu" }).first()).name).toBe("PT Satu");
      expect(Number((await rc("journal_entries").count<{ c: number }[]>("* as c"))[0].c)).toBe(3);
      expect(Number((await rc("journal_entry_lines").count<{ c: number }[]>("* as c"))[0].c)).toBe(6);
      expect(await getAccountLedgerByRange(rc, kas, "2026-02-01", "2026-03-31")).toEqual(srcLedger);
      expect(await getIncomeStatement(rc, "2026-01-01", "2026-03-31")).toEqual(srcIncome);
      expect(await getBalanceSheet(rc, "2026-01-01", "2026-03-31")).toEqual(srcBs);
      expect(await getCashFlowStatement(rc, "2026-01-01", "2026-03-31")).toEqual(srcCf);
      expect(await getTrialBalance(rc, periodId)).toEqual(srcTb);
      const dash = await getDashboardSummary(rc, "2026-01-01", "2026-03-31");
      expect(dash.ytd).toEqual(srcDash.ytd);
      expect(dash.kpis).toEqual(srcDash.kpis);
      expect(srcLedger.endingBalance).toBe(70_000);
      // audit log ikut terbawa (append-only trigger tetap ada)
      expect(Number((await rc("company_audit_log").count<{ c: number }[]>("* as c"))[0].c)).toBeGreaterThan(0);
      expect(await rc.schema.hasColumn("accounts", "is_locked")).toBe(true);
    } finally {
      await rc.destroy();
      await rs.destroy();
    }
  });

  it("tidak membuat salinan ganda bila tidak ada perubahan; hanya database yang berubah yang disalin lagi", async () => {
    const first = backup.runBackup(userData, { now: new Date("2026-10-05T01:00:00Z") });
    expect(first.copied).toHaveLength(3);

    const second = backup.runBackup(userData, { now: new Date("2026-10-05T07:00:00Z") });
    expect(second.copied).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);

    await new Promise((r) => setTimeout(r, 30));
    await post("2026-03-06", "J4", kas, pend, 1_000);
    const third = backup.runBackup(userData, { now: new Date("2026-10-05T13:00:00Z") });
    expect(third.copied).toHaveLength(1);
    expect(third.copied[0]).toMatch(/company-2026-10-05T13-00-00-000Z\.db$/);

    // restore ke titik waktu tertentu memakai backup yang berlaku saat itu
    const early = path.join(root, "restored-early");
    backup.restoreBackup(first.backupDir, early, { timestamp: "2026-10-05T07-00-00-000Z" });
    const rc = knexLib({ ...companyKnexfile, connection: { filename: path.join(early, "companies", "pt-satu", "company.db") } });
    try {
      expect(Number((await rc("journal_entries").count<{ c: number }[]>("* as c"))[0].c)).toBe(3);
    } finally {
      await rc.destroy();
    }
    const latest = path.join(root, "restored-latest");
    backup.restoreBackup(first.backupDir, latest);
    const rl = knexLib({ ...companyKnexfile, connection: { filename: path.join(latest, "companies", "pt-satu", "company.db") } });
    try {
      expect(Number((await rl("journal_entries").count<{ c: number }[]>("* as c"))[0].c)).toBe(4);
    } finally {
      await rl.destroy();
    }
  });

  it("retensi 30 hari menghapus backup lama TETAPI tidak pernah backup terbaru tiap database; restore tidak menimpa data yang ada", async () => {
    const backupDir = path.join(userData, "backups");
    backup.runBackup(userData, { now: new Date("2026-01-01T00:00:00Z") });
    // jadikan backup pertama tampak berumur >30 hari
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const touchAll = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) touchAll(full);
        else fs.utimesSync(full, old / 1000, old / 1000);
      }
    };
    touchAll(backupDir);
    // sumber juga "lama" (tidak berubah sejak backup) -> dilewati, dan satu-satunya
    // backup berumur 40 hari TIDAK boleh terhapus oleh retensi
    const older = (Date.now() - 41 * 24 * 60 * 60 * 1000) / 1000;
    for (const f of [path.join(userData, "terra-system.sqlite"), path.join(userData, "terra-finance.sqlite"), path.join(userData, "companies", "pt-satu", "company.db")]) fs.utimesSync(f, older, older);
    const again = backup.runBackup(userData, { now: new Date("2026-10-05T00:00:00Z") });
    expect(again.copied).toHaveLength(0);
    const companyBackups = () => fs.readdirSync(path.join(backupDir, "companies", "pt-satu"));
    expect(companyBackups()).toHaveLength(1);
    expect(fs.readdirSync(backupDir).filter((n) => n.endsWith(".sqlite"))).toHaveLength(2);

    // buat perubahan -> backup baru; backup 40 hari yang lama kini boleh dihapus, yang terbaru tetap
    await new Promise((r) => setTimeout(r, 30));
    await post("2026-03-07", "J5", kas, pend, 500);
    backup.runBackup(userData, { now: new Date("2026-10-06T00:00:00Z") });
    const names = companyBackups();
    expect(names.some((n) => n.includes("2026-10-06"))).toBe(true);
    expect(names.some((n) => n.includes("2026-01-01"))).toBe(false);

    // restore ke folder yang sudah berisi data -> ditolak (tidak menimpa diam-diam)
    expect(() => backup.restoreBackup(backupDir, userData)).toThrow(/sudah berisi/);
  });
});
