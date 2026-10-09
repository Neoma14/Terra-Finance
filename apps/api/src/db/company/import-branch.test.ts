import ExcelJS from "exceljs";
import type { Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { commitJournalImportBatch, validateJournalImportBatch } from "./journal-import-service.js";
import { commitOpeningBalanceImportBatch, validateOpeningBalanceImportBatch } from "./opening-balance-import-service.js";
import { changeBranchStatus, getHeadOfficeBranch } from "./branch-service.js";
import { addBranch, freshCompanyDb, seedBasics, testActor, type SeededAccounts } from "./__fixtures__/branch-test-helpers.js";

type Row = [string, string, string, string, string, number | null, number | null] | null;

async function journalWorkbook(rows: Row[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Jurnal");
  sheet.getRow(1).values = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"];
  rows.forEach((row, i) => {
    if (row) sheet.getRow(2 + i).values = row;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("Import jurnal / saldo awal sadar-cabang (Multi-Branch Phase 2)", () => {
  let db: Knex;
  let seed: SeededAccounts;
  let metro: string;
  let bandar: string;
  let hq: string;

  beforeEach(async () => {
    db = await freshCompanyDb();
    seed = await seedBasics(db);
    metro = await addBranch(db, "METRO", "Cabang Metro");
    bandar = await addBranch(db, "BL", "Bandar Lampung");
    hq = (await getHeadOfficeBranch(db)).id;
  });
  afterEach(async () => {
    await db.destroy();
  });

  const sameRows: Row[] = [
    ["1000", "2026-01-12", "", "Kas", "Penjualan", 4000, null],
    ["2000", "2026-01-12", "", "Hutang", "Penjualan", null, 4000],
  ];

  it("import masuk ke cabang tujuan (ditentukan server), origin = import, dan dicatat pada audit batch", async () => {
    const validation = await validateJournalImportBatch(db, await journalWorkbook(sameRows), "metro.xlsx", metro);
    expect(validation.branchId).toBe(metro);
    expect(validation.canCommit).toBe(true);
    await commitJournalImportBatch(db, validation, testActor);
    const journals = await db("journal_entries");
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ branch_id: metro, origin: "import", status: "POSTED", source: "import" });
  });

  it("deteksi duplikat berbasis isi hanya terhadap jurnal CABANG YANG SAMA: transaksi identik di cabang lain bukan duplikat", async () => {
    await commitJournalImportBatch(db, await validateJournalImportBatch(db, await journalWorkbook(sameRows), "a.xlsx", metro), testActor);

    const again = await validateJournalImportBatch(db, await journalWorkbook(sameRows), "b.xlsx", metro);
    expect(again.transactions[0].alreadyExists).toBe(true); // duplikat di Metro

    const other = await validateJournalImportBatch(db, await journalWorkbook(sameRows), "c.xlsx", bandar);
    expect(other.transactions[0].alreadyExists).toBe(false); // bukan duplikat di Bandar Lampung
    await commitJournalImportBatch(db, other, testActor);
    expect((await db("journal_entries").where({ branch_id: bandar })).length).toBe(1);
    expect((await db("journal_entries")).length).toBe(2);
  });

  it("validasi menandai akun CENTRAL_ONLY pada cabang non-pusat sebagai ERROR (dan commit ditolak); di Kantor Pusat lolos", async () => {
    await db("accounts").where({ id: seed.modalId }).update({ branch_policy: "CENTRAL_ONLY" });
    const rows: Row[] = [
      ["1000", "2026-01-13", "", "Kas", "Setoran modal", 9000, null],
      ["3000", "2026-01-13", "", "Modal", "Setoran modal", null, 9000],
    ];
    const atMetro = await validateJournalImportBatch(db, await journalWorkbook(rows), "m.xlsx", metro);
    expect(atMetro.canCommit).toBe(false);
    expect(atMetro.errorCount).toBe(1);
    expect(atMetro.transactions[0].issues.join(" ")).toMatch(/CENTRAL_ONLY/);
    await expect(commitJournalImportBatch(db, atMetro, testActor)).rejects.toThrow();
    expect(await db("journal_entries")).toHaveLength(0);

    const atHq = await validateJournalImportBatch(db, await journalWorkbook(rows), "h.xlsx", hq);
    expect(atHq.canCommit).toBe(true);
  });

  it("import ke akun SYSTEM_ONLY / INTER_BRANCH ditolak pada validasi", async () => {
    await db("accounts").where({ id: seed.bebanId }).update({ branch_policy: "SYSTEM_ONLY" });
    await db("accounts").where({ id: seed.hutangId }).update({ branch_policy: "INTER_BRANCH", counterpart_branch_id: bandar });
    const v = await validateJournalImportBatch(
      db,
      await journalWorkbook([
        ["6000", "2026-01-14", "", "Beban", "x", 100, null],
        ["2000", "2026-01-14", "", "Hutang", "x", null, 100],
      ]),
      "p.xlsx",
      metro,
    );
    expect(v.canCommit).toBe(false);
    const msg = v.transactions[0].issues.join(" ");
    expect(msg).toMatch(/SYSTEM_ONLY/);
    expect(msg).toMatch(/transaksi antar-cabang/);
  });

  it("commit atomik: bila satu transaksi gagal karena cabang berubah menjadi tidak aktif di antara preview dan commit, tidak ada yang tersimpan", async () => {
    const validation = await validateJournalImportBatch(
      db,
      await journalWorkbook([
        ["1000", "2026-01-12", "", "Kas", "a", 100, null],
        ["2000", "2026-01-12", "", "Hutang", "a", null, 100],
        null,
        ["1000", "2026-01-13", "", "Kas", "b", 200, null],
        ["2000", "2026-01-13", "", "Hutang", "b", null, 200],
      ]),
      "dua.xlsx",
      metro,
    );
    expect(validation.canCommit).toBe(true);
    await changeBranchStatus(db, metro, { to: "INACTIVE" }, testActor);
    await expect(commitJournalImportBatch(db, validation, testActor)).rejects.toThrow(/tidak aktif/);
    expect(await db("journal_entries")).toHaveLength(0);
    expect(await db("company_audit_log").where({ action: "journal.import" })).toHaveLength(0);
  });

  describe("import saldo awal per cabang", () => {
    const obWorkbook = async (rows: Array<[string, string, number | null, number | null]>): Promise<Buffer> => {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("Opening Balance");
      sheet.getRow(1).values = ["Opening Balance"];
      sheet.getRow(3).values = ["Tanggal Saldo Awal", "2026-01-02"];
      sheet.getRow(5).values = ["Kode Akun", "Nama Akun", "Debit", "Kredit", "Keterangan"];
      rows.forEach((r, i) => (sheet.getRow(6 + i).values = [r[0], r[1], r[2], r[3], ""]));
      return Buffer.from(await wb.xlsx.writeBuffer());
    };

    it("saldo awal diimpor per cabang; cabang yang sama tidak bisa dua kali, cabang lain tetap bisa", async () => {
      const buf = await obWorkbook([["1000", "Kas", 800, null], ["3000", "Modal", null, 800]]);
      const first = await validateOpeningBalanceImportBatch(db, buf, "ob.xlsx", metro);
      if (!first.canCommit) throw new Error(JSON.stringify(first.fileErrors) + JSON.stringify(first.rows.map((r) => r.issues)));
      expect(first.branchId).toBe(metro);
      await commitOpeningBalanceImportBatch(db, first, testActor);
      expect((await db("journal_entries").where({ is_opening_balance: 1 }).first()).branch_id).toBe(metro);

      const second = await validateOpeningBalanceImportBatch(db, buf, "ob2.xlsx", metro);
      expect(second.canCommit).toBe(false);
      expect(second.fileErrors.join(" ")).toMatch(/sudah ada/);

      const other = await validateOpeningBalanceImportBatch(db, buf, "ob3.xlsx", bandar);
      expect(other.canCommit).toBe(true);
    });

    it("saldo awal ke akun CENTRAL_ONLY pada cabang non-pusat ditandai ERROR pada validasi", async () => {
      await db("accounts").where({ id: seed.modalId }).update({ branch_policy: "CENTRAL_ONLY" });
      const buf = await obWorkbook([["1000", "Kas", 800, null], ["3000", "Modal", null, 800]]);
      const v = await validateOpeningBalanceImportBatch(db, buf, "ob.xlsx", metro);
      expect(v.canCommit).toBe(false);
      expect(v.rows.find((r) => r.code === "3000")!.issues.join(" ")).toMatch(/CENTRAL_ONLY/);
      expect((await validateOpeningBalanceImportBatch(db, buf, "ob.xlsx", hq)).canCommit).toBe(true);
    });

    it("cabang tidak aktif tidak dapat menerima saldo awal", async () => {
      await changeBranchStatus(db, bandar, { to: "INACTIVE" }, testActor);
      const buf = await obWorkbook([["1000", "Kas", 800, null], ["3000", "Modal", null, 800]]);
      const v = await validateOpeningBalanceImportBatch(db, buf, "ob.xlsx", bandar);
      expect(v.canCommit).toBe(false);
      expect(v.fileErrors.join(" ")).toMatch(/tidak aktif/);
    });
  });
});
