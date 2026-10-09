import "../../modules/company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama (mengarahkan DB ke folder temp)
import { TEST_COMPANY_DATA_ROOT } from "../../modules/company-journal/__fixtures__/legacy-db-env.js";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import systemKnexfile from "../system/knexfile.js";
import { systemDb } from "../system/index.js";
import companyKnexfile from "./knexfile.js";
import { upgradeExistingCompanyDatabases } from "./company-upgrade.js";
import { checkDatabaseIntegrity } from "./db-integrity.js";
import { createCompanyDb } from "./index.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { listAccounts } from "./account-service.js";
import { getOpeningBalance } from "./opening-balance-service.js";

const OLD_MIGRATION_COUNT = 13; // C0001..C0013 = skema sebelum Multi-Branch (C0014+)

interface Snapshot {
  journals: number;
  lines: number;
  accounts: number;
  periods: number;
  auditRows: number;
  /** id jurnal -> ringkasan tak berubah (tanggal, status, referensi, periode, total debit/kredit sen) */
  journalDigest: Record<string, string>;
  /** hash seluruh baris jurnal: urutan, akun, debit, kredit sen */
  linesDigest: string;
  accountsDigest: string;
  debitCents: number;
  creditCents: number;
}

async function snapshot(db: Knex): Promise<Snapshot> {
  const count = async (t: string) => Number(((await db(t).count({ c: "*" }).first()) as any).c);
  const journals = await db("journal_entries").select("id", "entry_date", "status", "reference_no", "period_id", "is_opening_balance", "source").orderBy("id");
  const lines = await db("journal_entry_lines").select("id", "journal_entry_id", "account_id", "debit", "credit", "line_order").orderBy("id");
  const accounts = await db("accounts").select("id", "code", "name", "account_type_id", "normal_balance", "is_active", "is_locked").orderBy("id");
  const sum = (await db("journal_entry_lines")
    .select(db.raw("COALESCE(SUM(CAST(ROUND(debit * 100) AS INTEGER)),0) as d"), db.raw("COALESCE(SUM(CAST(ROUND(credit * 100) AS INTEGER)),0) as c"))
    .first()) as any;
  const totals = new Map<string, { d: number; c: number }>();
  for (const l of lines as any[]) {
    const t = totals.get(l.journal_entry_id) ?? { d: 0, c: 0 };
    t.d += Math.round(Number(l.debit) * 100);
    t.c += Math.round(Number(l.credit) * 100);
    totals.set(l.journal_entry_id, t);
  }
  const journalDigest: Record<string, string> = {};
  for (const j of journals as any[]) {
    const t = totals.get(j.id) ?? { d: 0, c: 0 };
    journalDigest[j.id] = [String(j.entry_date).slice(0, 10), j.status, j.reference_no, j.period_id, j.is_opening_balance, j.source, t.d, t.c].join("|");
  }
  const hash = (rows: unknown[]) => crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return {
    journals: journals.length,
    lines: lines.length,
    accounts: accounts.length,
    periods: await count("periods"),
    auditRows: await count("company_audit_log"),
    journalDigest,
    linesDigest: hash(lines),
    accountsDigest: hash(accounts),
    debitCents: Number(sum.d),
    creditCents: Number(sum.c),
  };
}

describe("Migrasi Multi-Branch pada data yang sudah ada (C0014-C0018, S0011-S0013)", () => {
  const slug = "perusahaan-berdata";
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  let before: Snapshot;
  let periodId: string;
  let openingId: string;
  let balanceSheetBefore: { totalAssets: number; totalLiabilities: number; totalEquity: number } | null = null;

  beforeAll(async () => {
    const sysDb = knexLib(systemKnexfile);
    try {
      await sysDb.migrate.latest();
    } finally {
      await sysDb.destroy();
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Database PERSIS seperti versi sebelum Multi-Branch: hanya C0001..C0013, terisi data nyata.
    const old = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
    try {
      for (let i = 0; i < OLD_MIGRATION_COUNT; i++) await old.migrate.up();
      expect(await old.schema.hasTable("branches")).toBe(false);
      expect(await old.schema.hasColumn("journal_entries", "branch_id")).toBe(false);

      await old("company_profile").insert({ id: "prof-1", name: "PT Berdata" });
      const types = Object.fromEntries((await old("account_types").select("id", "code")).map((t: any) => [t.code, t.id]));
      const acc = async (id: string, code: string, name: string, type: string, normal: string, extra: Record<string, unknown> = {}) =>
        old("accounts").insert({ id, code, name, account_type_id: types[type], normal_balance: normal, ...extra });
      await acc("a-kas", "1000", "Kas", "ASSET", "debit");
      await acc("a-piutang", "1100", "Piutang", "ASSET", "debit");
      await acc("a-akum", "1900", "Akumulasi Penyusutan", "ASSET", "credit");
      await acc("a-hutang", "2000", "Hutang", "LIABILITY", "credit");
      await acc("a-modal", "3000", "Modal", "EQUITY", "credit");
      await acc("a-sales", "4000", "Penjualan", "REVENUE", "credit");
      await acc("a-beban", "6000", "Beban", "EXPENSE", "debit", { is_active: false });
      await acc("a-sistem", "3900", "Saldo Awal (Penyesuaian)", "EQUITY", "credit", { account_subtype: "opening_balance_adjustment" });
      await acc("a-terkunci", "1500", "Akun Terkunci", "ASSET", "debit", { is_locked: true });

      periodId = "p-jan";
      await old("periods").insert({ id: periodId, label: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31", period_type: "month", fiscal_year: 2026, status: "OPEN" });
      await old("periods").insert({ id: "p-feb", label: "Feb 2026", start_date: "2026-02-01", end_date: "2026-02-28", period_type: "month", fiscal_year: 2026, status: "OPEN" });

      const journal = async (id: string, ref: string, date: string, status: string, lines: Array<[string, number, number]>, extra: Record<string, unknown> = {}) => {
        await old("journal_entries").insert({ id, entry_date: date, period_id: date < "2026-02" ? "p-jan" : "p-feb", reference_no: ref, status, source: "manual", ...extra });
        for (let i = 0; i < lines.length; i++) {
          await old("journal_entry_lines").insert({ id: `${id}-l${i}`, journal_entry_id: id, account_id: lines[i][0], debit: lines[i][1], credit: lines[i][2], line_order: i });
        }
      };
      openingId = "j-open";
      await journal(openingId, "SALDO-AWAL-1", "2026-01-01", "POSTED", [["a-kas", 5000000.5, 0], ["a-modal", 0, 5000000.5]], { is_opening_balance: true });
      await journal("j-1", "JRN-1", "2026-01-05", "POSTED", [["a-kas", 1250000.25, 0], ["a-sales", 0, 1250000.25]]);
      await journal("j-2", "JRN-2", "2026-01-10", "REVERSED", [["a-piutang", 300000, 0], ["a-sales", 0, 300000]], { is_reversed: true });
      await journal("j-2r", "JRN-2-REV", "2026-01-10", "POSTED", [["a-sales", 300000, 0], ["a-piutang", 0, 300000]], { reversal_of_journal_id: "j-2", reversal_reason: "salah input" });
      await journal("j-3", "JRN-3", "2026-01-15", "POSTED", [["a-kas", 0, 700000.1], ["a-hutang", 700000.1, 0]], { source: "import" });
      await journal("j-4", "JRN-4", "2026-02-02", "DRAFT", [["a-kas", 10, 0], ["a-hutang", 0, 10]]);
      await journal("j-5", "JRN-5", "2026-02-03", "VOID", [["a-kas", 20, 0], ["a-hutang", 0, 20]]);
      for (let i = 0; i < 40; i++) {
        await journal(`j-bulk-${i}`, `BULK-${i}`, "2026-01-20", "POSTED", [["a-kas", 1000 + i, 0], ["a-sales", 0, 1000 + i]]);
      }
      await old("company_audit_log").insert({ id: "au-1", actor_type: "user", actor_label: "Tester", action: "journal.create", entity_type: "journal_entry", entity_id: "j-1" });

      before = await snapshot(old);
    } finally {
      await old.destroy();
    }

    await systemDb("companies_registry").insert({
      id: crypto.randomUUID(),
      slug,
      name: "PT Berdata",
      database_path: dbPath,
      status: "active",
      schema_version: 13,
      last_migration_status: "READY",
    });

    // sama persis dengan startup produksi
    await upgradeExistingCompanyDatabases();
  });

  afterAll(async () => {
    await systemDb.destroy();
  });

  const open = () => createCompanyDb(dbPath);

  it("tidak ada kehilangan data: jumlah jurnal, baris, akun, periode, dan audit identik; seluruh isi jurnal/baris/akun tidak berubah", async () => {
    const db = open();
    try {
      const after = await snapshot(db);
      expect(after.journals).toBe(before.journals);
      expect(after.lines).toBe(before.lines);
      expect(after.accounts).toBe(before.accounts);
      expect(after.periods).toBe(before.periods);
      expect(after.auditRows).toBe(before.auditRows); // migrasi tidak menambah/menghapus audit lama
      expect(after.journalDigest).toEqual(before.journalDigest);
      expect(after.linesDigest).toBe(before.linesDigest); // akun, debit, kredit, urutan baris tidak berubah
      expect(after.accountsDigest).toBe(before.accountsDigest); // mapping akun/tipe/saldo normal tidak berubah
      expect(after.debitCents).toBe(before.debitCents);
      expect(after.creditCents).toBe(before.creditCents);
    } finally {
      await db.destroy();
    }
  });

  it("semua jurnal lama otomatis milik Kantor Pusat; tidak ada branch_id NULL; asal jurnal diturunkan dari data lama", async () => {
    const db = open();
    try {
      const branches = await db("branches");
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({ code: "PUSAT", status: "ACTIVE", is_head_office: 1 });
      const hq = branches[0].id;
      expect(await db("journal_entries").whereNull("branch_id")).toHaveLength(0);
      expect(await db("journal_entries").whereNot("branch_id", hq)).toHaveLength(0);
      const origins = Object.fromEntries((await db("journal_entries").select("id", "origin")).map((r: any) => [r.id, r.origin]));
      expect(origins["j-open"]).toBe("opening_balance");
      expect(origins["j-3"]).toBe("import");
      expect(origins["j-1"]).toBe("manual");
      expect(origins["j-2r"]).toBe("manual");
      expect(await db("journal_entries").whereNotNull("inter_branch_transaction_id")).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it("semua akun lama seragam ALL_BRANCH tanpa cabang lawan (tidak diturunkan dari tipe/nama); multi-cabang mati", async () => {
    const db = open();
    try {
      const accounts = await listAccounts(db);
      expect(new Set(accounts.map((a) => a.branchPolicy))).toEqual(new Set(["ALL_BRANCH"]));
      expect(accounts.every((a) => a.counterpartBranchId === null)).toBe(true);
      // akun bertipe Equity dan akun bernama "Saldo Awal (Penyesuaian)" tetap ALL_BRANCH
      expect(accounts.find((a) => a.code === "3000")!.branchPolicy).toBe("ALL_BRANCH");
      expect(accounts.find((a) => a.code === "3900")!.branchPolicy).toBe("ALL_BRANCH");
      expect(Number(((await db("company_profile").first()) as any).multi_branch_enabled)).toBe(0);
    } finally {
      await db.destroy();
    }
  });

  it("laporan existing tetap benar setelah migrasi: Trial Balance & Neraca seimbang dan sama dengan perhitungan mentah dari data lama", async () => {
    const db = open();
    try {
      const tb = await getTrialBalance(db, periodId);
      expect(tb.isBalanced).toBe(true);
      const bs = await getBalanceSheet(db, "2026-01-01", "2026-02-28");
      expect(bs.isBalanced).toBe(true);
      // kas = 5.000.000,50 + 1.250.000,25 - 700.000,10 + sum(1000+i) i=0..39
      const bulk = Array.from({ length: 40 }, (_, i) => 1000 + i).reduce((s, v) => s + v, 0);
      const kas = bs.assets.lines.find((l) => l.accountCode === "1000")!;
      expect(Math.round(kas.amount * 100)).toBe(Math.round((5000000.5 + 1250000.25 - 700000.1 + bulk) * 100));
      balanceSheetBefore = { totalAssets: bs.totalAssets, totalLiabilities: bs.totalLiabilities, totalEquity: bs.totalEquity };
      // saldo awal lama terbaca sebagai milik Kantor Pusat
      const ob = await getOpeningBalance(db);
      expect(ob).toMatchObject({ exists: true, id: openingId, status: "POSTED", isBalanced: true });
    } finally {
      await db.destroy();
    }
  });

  it("integritas database: integrity_check ok dan foreign_key_check bersih sebelum & sesudah", async () => {
    const db = open();
    try {
      expect(await checkDatabaseIntegrity(db)).toEqual({ integrityOk: true, integrityMessages: ["ok"], foreignKeyViolations: 0 });
    } finally {
      await db.destroy();
    }
    const backup = knexLib({ ...companyKnexfile, connection: { filename: `${dbPath}.pre-C0014` } });
    try {
      expect(await checkDatabaseIntegrity(backup)).toEqual({ integrityOk: true, integrityMessages: ["ok"], foreignKeyViolations: 0 });
    } finally {
      await backup.destroy();
    }
  });

  it("salinan pengaman dibuat sebelum migrasi (.pre-upgrade dan .pre-C0014) dan masih berskema lama dengan data utuh", async () => {
    for (const suffix of [".pre-upgrade", ".pre-C0014"]) {
      expect(fs.existsSync(`${dbPath}${suffix}`), suffix).toBe(true);
      const bak = knexLib({ ...companyKnexfile, connection: { filename: `${dbPath}${suffix}` } });
      try {
        expect(await bak.schema.hasTable("branches")).toBe(false);
        expect(await bak.schema.hasColumn("journal_entries", "branch_id")).toBe(false);
        const snap = await snapshot(bak);
        expect(snap.linesDigest).toBe(before.linesDigest);
        expect(snap.journals).toBe(before.journals);
      } finally {
        await bak.destroy();
      }
    }
  });

  it("idempoten: menjalankan upgrade lagi tidak mengubah apa pun (data, jumlah cabang, salinan pengaman)", async () => {
    const stamp = fs.statSync(`${dbPath}.pre-C0014`).mtimeMs;
    const dbBefore = open();
    const digestBefore = (await snapshot(dbBefore)).linesDigest;
    await dbBefore.destroy();
    await upgradeExistingCompanyDatabases();
    await upgradeExistingCompanyDatabases();
    const db = open();
    try {
      expect(await db("branches")).toHaveLength(1);
      expect((await snapshot(db)).linesDigest).toBe(digestBefore);
      expect(await db("journal_entries")).toHaveLength(before.journals);
    } finally {
      await db.destroy();
    }
    expect(fs.statSync(`${dbPath}.pre-C0014`).mtimeMs).toBe(stamp);
    expect(balanceSheetBefore).not.toBeNull();
  });

  it("jurnal lama yang sudah POSTED tidak dapat dipindah cabang (trigger), dan trigger isi-otomatis Kantor Pusat bekerja untuk INSERT lama", async () => {
    const db = open();
    try {
      const hq = (await db("branches").where({ is_head_office: 1 }).first()).id;
      await expect(db("journal_entries").where({ id: "j-1" }).update({ branch_id: null })).rejects.toThrow();
      await db("journal_entries").insert({ id: "j-raw", entry_date: "2026-01-21", period_id: periodId, reference_no: "RAW-1", status: "DRAFT" });
      expect((await db("journal_entries").where({ id: "j-raw" }).first()).branch_id).toBe(hq);
    } finally {
      await db.destroy();
    }
  });

  it("System DB: user lama tetap scope ALL (perilaku tidak berubah) dan tabel user_branch_access tersedia", async () => {
    expect(await systemDb.schema.hasTable("user_branch_access")).toBe(true);
    expect(await systemDb.schema.hasColumn("company_access", "branch_scope")).toBe(true);
    expect(await systemDb("company_access").whereNot("branch_scope", "ALL")).toHaveLength(0);
  });
});
