import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount } from "./account-service.js";
import {
  validateJournalImportBatch,
  commitJournalImportBatch,
  JournalImportHasErrorsError,
  JournalImportNothingToCommitError,
} from "./journal-import-service.js";
import type { ActorContext } from "./company-audit.js";

/**
 * Journal Import (TASK-DB-ARCH-014 §2-5). Fokus test: (1) parsing baris-
 * kosong-sbg-pemisah via `parseJournalExcel` yang di-reuse apa adanya,
 * (2) seluruh kategori validasi §4, (3) ATOMIC COMMIT -- SATU transaksi
 * gagal = SELURUH batch rollback (§5), dibuktikan lewat nested-transaction
 * (createDraftJournalEntry/postJournalEntry dipanggil berulang dgn `trx`
 * luar yang sama -- pola identik dgn commit massal shared-DB lama yang
 * sudah terbukti jalan, modules/journal/routes.ts).
 */

function freshTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function openCompanyDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}
const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

async function seedPeriod(db: Knex, label: string, startDate: string, endDate: string, status: "OPEN" | "LOCKED" | "CLOSED" = "OPEN"): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({ id, label, start_date: startDate, end_date: endDate, period_type: "month", fiscal_year: 2026, status });
  return id;
}

type Row = [string, string, string, string, string, number | null, number | null] | null;

/** Bangun buffer xlsx sheet "Jurnal" persis format yang dibaca
 * `parseJournalExcel` (header row 1, TANPA metadata di atasnya supaya
 * sederhana) -- `null` = baris kosong (pemisah antar transaksi, §2). */
async function buildTestWorkbook(rows: Row[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Jurnal");
  sheet.getRow(1).values = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"];
  rows.forEach((row, i) => {
    if (row) sheet.getRow(2 + i).values = row;
  });
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe("Journal Import (TASK-DB-ARCH-014)", () => {
  let tmpDir: string;
  let db: Knex;
  let kasId: string;
  let modalId: string;
  let bebanId: string;
  let periodId: string;

  beforeEach(async () => {
    tmpDir = freshTmpDir("terra-journal-import-test-");
    db = openCompanyDbAt(path.join(tmpDir, "company.db"));
    await db.migrate.latest();

    kasId = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modalId = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    bebanId = (await createAccount(db, { code: "6000", name: "Beban", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;

    periodId = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Parse + validate: 2 transaksi dipisah baris kosong, keduanya VALID", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV001", "Kas", "Setoran modal", 1_000_000, null],
      ["3000", "2026-01-05", "JV001", "Modal", "Setoran modal", null, 1_000_000],
      null,
      ["6000", "2026-01-10", "JV002", "Beban Listrik", "Bayar listrik", 500_000, null],
      ["1000", "2026-01-10", "JV002", "Kas", "Bayar listrik", null, 500_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");

    expect(result.totalTransactions).toBe(2);
    expect(result.totalLines).toBe(4);
    expect(result.validCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.canCommit).toBe(true);
    expect(result.transactions[0].referenceNo).toBe("JV001");
    expect(result.transactions[0].periodId).toBe(periodId);
    expect(result.transactions[1].referenceNo).toBe("JV002");
  });

  it("Tanpa No Jurnal & tanpa baris kosong: baris dikelompokkan PER TANGGAL (satu transaksi per tanggal)", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "", "Kas", "Hari 5 a", 100_000, null],
      ["3000", "2026-01-05", "", "Modal", "Hari 5 a", null, 100_000],
      ["6000", "2026-01-05", "", "Beban", "Hari 5 b", 30_000, null],
      ["1000", "2026-01-05", "", "Kas", "Hari 5 b", null, 30_000],
      ["1000", "2026-01-06", "", "Kas", "Hari 6", 200_000, null],
      ["3000", "2026-01-06", "", "Modal", "Hari 6", null, 200_000],
      ["6000", "2026-01-07", "", "Beban", "Hari 7", 10_000, null],
      ["1000", "2026-01-07", "", "Kas", "Hari 7", null, 10_000],
    ]);
    const result = await validateJournalImportBatch(db, buffer, "per-tanggal.xlsx");
    expect(result.transactions.map((t) => t.date)).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
    expect(result.transactions.map((t) => t.lines.length)).toEqual([4, 2, 2]);
    expect(result.transactions.every((t) => t.status === "VALID")).toBe(true);
    expect(result.canCommit).toBe(true);
  });

  it("Tanpa No Jurnal: baris kosong tetap memisahkan transaksi pada tanggal yang sama", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "", "Kas", "A", 100_000, null],
      ["3000", "2026-01-05", "", "Modal", "A", null, 100_000],
      null,
      ["6000", "2026-01-05", "", "Beban", "B", 30_000, null],
      ["1000", "2026-01-05", "", "Kas", "B", null, 30_000],
    ]);
    const result = await validateJournalImportBatch(db, buffer, "kosong.xlsx");
    expect(result.transactions).toHaveLength(2);
  });

  it("File besar tanpa No Jurnal (3.000 baris, 30 tanggal): commit berhasil, satu jurnal per tanggal, semua POSTED", async () => {
    const rows: Row[] = [];
    for (let day = 1; day <= 30; day++) {
      const date = `2026-01-${String(day).padStart(2, "0")}`;
      for (let k = 0; k < 50; k++) {
        rows.push(["1000", date, "", "Kas", `Penjualan ${day}-${k}`, 1_000 + k, null]);
        rows.push(["3000", date, "", "Modal", `Penjualan ${day}-${k}`, null, 1_000 + k]);
      }
    }
    const buffer = await buildTestWorkbook(rows);
    const validation = await validateJournalImportBatch(db, buffer, "besar.xlsx");
    expect(validation.transactions).toHaveLength(30);
    expect(validation.canCommit).toBe(true);
    const result = await commitJournalImportBatch(db, validation, actor);
    expect(result.committedCount).toBe(30);
    const posted = await db("journal_entries").where({ status: "POSTED" }).count<{ c: number }[]>("* as c");
    expect(Number(posted[0].c)).toBe(30);
    const lineCount = await db("journal_entry_lines").count<{ c: number }[]>("* as c");
    expect(Number(lineCount[0].c)).toBe(3000);
    // tanggal tiap jurnal = tanggalnya sendiri, bukan tanggal baris pertama file
    const dates = await db("journal_entries").distinct("entry_date").orderBy("entry_date");
    expect(dates).toHaveLength(30);
  });

  it("Dengan No Jurnal: pengelompokan tetap berdasarkan nomor (tidak dipecah per tanggal)", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV-X", "Kas", "X", 100_000, null],
      ["3000", "2026-01-05", "JV-X", "Modal", "X", null, 100_000],
    ]);
    const result = await validateJournalImportBatch(db, buffer, "nomor.xlsx");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].referenceNo).toBe("JV-X");
  });

  it("Validate: transaksi tidak balance -> ERROR, canCommit false", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV003", "Kas", "Tidak balance", 1_000_000, null],
      ["3000", "2026-01-05", "JV003", "Modal", "Tidak balance", null, 900_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.transactions[0].status).toBe("ERROR");
    expect(result.transactions[0].issues.some((i) => i.includes("Tidak balance"))).toBe(true);
    expect(result.canCommit).toBe(false);
  });

  it("Validate: kode akun tidak dikenal -> ERROR per baris", async () => {
    const buffer = await buildTestWorkbook([
      ["9999", "2026-01-05", "JV004", "Akun Asing", "Kode tidak dikenal", 1_000_000, null],
      ["3000", "2026-01-05", "JV004", "Modal", "Kode tidak dikenal", null, 1_000_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.transactions[0].status).toBe("ERROR");
    expect(result.transactions[0].lines[0].issues[0]).toContain('"9999" tidak ditemukan');
  });

  it("Validate: akun non-aktif -> ERROR", async () => {
    const { updateAccount } = await import("./account-service.js");
    await updateAccount(db, kasId, { isActive: false }, actor);

    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV005", "Kas", "Akun nonaktif", 1_000_000, null],
      ["3000", "2026-01-05", "JV005", "Modal", "Akun nonaktif", null, 1_000_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.transactions[0].status).toBe("ERROR");
    expect(result.transactions[0].lines[0].issues[0]).toContain("tidak aktif");
  });

  it("Validate: tanggal tanpa periode yang cocok -> ERROR (periode TIDAK di-auto-create)", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-06-05", "JV006", "Kas", "Luar periode", 1_000_000, null],
      ["3000", "2026-06-05", "JV006", "Modal", "Luar periode", null, 1_000_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.transactions[0].status).toBe("ERROR");
    expect(result.transactions[0].periodId).toBeNull();
    expect(result.transactions[0].issues.some((i) => i.includes("belum ada"))).toBe(true);
  });

  it("Validate: periode LOCKED -> ERROR", async () => {
    await seedPeriod(db, "Feb 2026", "2026-02-01", "2026-02-28", "LOCKED");
    const buffer = await buildTestWorkbook([
      ["1000", "2026-02-05", "JV007", "Kas", "Periode locked", 1_000_000, null],
      ["3000", "2026-02-05", "JV007", "Modal", "Periode locked", null, 1_000_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.transactions[0].status).toBe("ERROR");
    expect(result.transactions[0].issues.some((i) => i.includes("LOCKED"))).toBe(true);
  });

  it("Validate: satu baris punya Debit DAN Kredit sekaligus -> ERROR", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV008", "Kas", "Baris rusak", 1_000_000, 1_000_000],
      ["3000", "2026-01-05", "JV008", "Modal", "Baris rusak", null, 1_000_000],
    ]);

    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.transactions[0].status).toBe("ERROR");
    expect(result.transactions[0].lines[0].issues[0]).toContain("Debit dan Kredit sekaligus");
  });

  it("Parse: baris dgn 'No Jurnal' eksplisit yang sama digabung jadi SATU transaksi walau TIDAK berurutan", async () => {
    // explicitGroups (parser.ts) mengelompokkan by journalNo, bukan posisi
    // -- jadi baris JV009 di awal & akhir file (dipisah transaksi lain)
    // tetap jadi SATU grup, bukan error "duplikat referensi".
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV009", "Kas", "Baris pertama", 1_000_000, null],
      null,
      ["6000", "2026-01-06", "JV777", "Beban", "Transaksi lain di tengah", 50_000, null],
      ["1000", "2026-01-06", "JV777", "Kas", "Transaksi lain di tengah", null, 50_000],
      null,
      ["3000", "2026-01-05", "JV009", "Modal", "Baris kedua, tidak berurutan", null, 1_000_000],
    ]);
    const result = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(result.totalTransactions).toBe(2);
    const jv009 = result.transactions.find((t) => t.referenceNo === "JV009")!;
    expect(jv009.lines).toHaveLength(2);
    expect(jv009.status).toBe("VALID");
  });

  it("Validate: referenceNo SUDAH ADA di DB -> WARNING (alreadyExists), bukan ERROR", async () => {
    const firstUpload = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV010", "Kas", "Pertama", 1_000_000, null],
      ["3000", "2026-01-05", "JV010", "Modal", "Pertama", null, 1_000_000],
    ]);
    const firstValidation = await validateJournalImportBatch(db, firstUpload, "a.xlsx");
    await commitJournalImportBatch(db, firstValidation, actor);

    const secondUpload = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV010", "Kas", "Pertama", 1_000_000, null],
      ["3000", "2026-01-05", "JV010", "Modal", "Pertama", null, 1_000_000],
    ]);
    const secondValidation = await validateJournalImportBatch(db, secondUpload, "b.xlsx");
    expect(secondValidation.transactions[0].status).toBe("WARNING");
    expect(secondValidation.transactions[0].alreadyExists).toBe(true);
    expect(secondValidation.errorCount).toBe(0);
    expect(secondValidation.canCommit).toBe(false); // nol transaksi BARU utk di-commit
  });

  it("Validate: referenceNo berawalan IB- (dicadangkan untuk transaksi antar-cabang) -> ERROR, tidak dapat di-commit", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "ib-2026-000001", "Kas", "Dicadangkan", 1_000_000, null],
      ["3000", "2026-01-05", "ib-2026-000001", "Modal", "Dicadangkan", null, 1_000_000],
    ]);
    const validation = await validateJournalImportBatch(db, buffer, "dicadangkan.xlsx");
    expect(validation.transactions[0].status).toBe("ERROR");
    expect(validation.transactions[0].issues.join(" ")).toMatch(/awalan IB-/);
    expect(validation.canCommit).toBe(false);
  });

  it("Commit: transaksi VALID masuk DB sbg DRAFT->POSTED (source=import), referenceNo kosong di-auto-generate", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "", "Kas", "Tanpa No Jurnal", 1_000_000, null],
      ["3000", "2026-01-05", "", "Modal", "Tanpa No Jurnal", null, 1_000_000],
    ]);
    const validation = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(validation.canCommit).toBe(true);

    const result = await commitJournalImportBatch(db, validation, actor);
    expect(result.committedCount).toBe(1);
    expect(result.referenceNumbers).toHaveLength(1);
    expect(result.referenceNumbers[0]).toMatch(/^IMP-/);

    const entry = await db("journal_entries").where({ reference_no: result.referenceNumbers[0] }).first();
    expect(entry.status).toBe("POSTED");
    expect(entry.source).toBe("import");

    const auditRow = await db("company_audit_log").where({ action: "journal.import" }).first();
    expect(auditRow).toBeDefined();
    const after = JSON.parse(auditRow.after_json);
    expect(after.committedCount).toBe(1);
    expect(after.fileName).toBe("test.xlsx");
  });

  it("Commit: melempar JournalImportHasErrorsError kalau masih ada transaksi ERROR", async () => {
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV011", "Kas", "Tidak balance", 1_000_000, null],
      ["3000", "2026-01-05", "JV011", "Modal", "Tidak balance", null, 900_000],
    ]);
    const validation = await validateJournalImportBatch(db, buffer, "test.xlsx");
    await expect(commitJournalImportBatch(db, validation, actor)).rejects.toThrow(JournalImportHasErrorsError);

    const count = await db("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("Commit: melempar JournalImportNothingToCommitError kalau semua alreadyExists", async () => {
    const firstUpload = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV012", "Kas", "Pertama", 1_000_000, null],
      ["3000", "2026-01-05", "JV012", "Modal", "Pertama", null, 1_000_000],
    ]);
    await commitJournalImportBatch(db, await validateJournalImportBatch(db, firstUpload, "a.xlsx"), actor);

    const secondUpload = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV012", "Kas", "Pertama", 1_000_000, null],
      ["3000", "2026-01-05", "JV012", "Modal", "Pertama", null, 1_000_000],
    ]);
    const secondValidation = await validateJournalImportBatch(db, secondUpload, "b.xlsx");
    await expect(commitJournalImportBatch(db, secondValidation, actor)).rejects.toThrow(JournalImportNothingToCommitError);
  });

  it("TASK-020 CRITICAL FIX: transaksi TANPA 'No Jurnal' eksplisit (alur normal) tidak lagi bisa double-posting lewat re-upload file yang sama", async () => {
    // Reproduksi PERSIS laporan bug nyata: file tanpa kolom "No Jurnal"
    // diisi (journalNo "") -- generateAutoReferenceNo() SEBELUMNYA selalu
    // bikin referensi baru tiap commit, jadi commit yang sama 2x
    // menghasilkan 2 jurnal POSTED terpisah utk transaksi yang SAMA PERSIS.
    const buildNoRefUpload = () =>
      buildTestWorkbook([
        ["1000", "2026-01-05", "", "Kas", "Transaksi tanpa No Jurnal", 500_000, null],
        ["3000", "2026-01-05", "", "Modal", "Transaksi tanpa No Jurnal", null, 500_000],
      ]);

    const firstUpload = await buildNoRefUpload();
    const firstValidation = await validateJournalImportBatch(db, firstUpload, "a.xlsx");
    expect(firstValidation.transactions[0].alreadyExists).toBe(false);
    const firstResult = await commitJournalImportBatch(db, firstValidation, actor);
    expect(firstResult.committedCount).toBe(1);

    // Upload file IDENTIK kedua kalinya (mis. klien tidak sengaja re-upload)
    const secondUpload = await buildNoRefUpload();
    const secondValidation = await validateJournalImportBatch(db, secondUpload, "b.xlsx");
    expect(secondValidation.transactions[0].alreadyExists).toBe(true);
    expect(secondValidation.transactions[0].status).toBe("WARNING");
    await expect(commitJournalImportBatch(db, secondValidation, actor)).rejects.toThrow(JournalImportNothingToCommitError);

    const allEntries = await db("journal_entries").select("*");
    expect(allEntries).toHaveLength(1); // BUKAN 2 -- buktinya double-posting tidak lagi terjadi

    // Transaksi yang BENAR-BENAR berbeda (nominal beda) pada tanggal yang
    // SAMA tetap boleh masuk -- fingerprint HARUS beda, bukan cuma
    // ditolak krn tanggalnya sama.
    const differentAmountUpload = await buildTestWorkbook([
      ["1000", "2026-01-05", "", "Kas", "Transaksi lain, nominal beda", 750_000, null],
      ["3000", "2026-01-05", "", "Modal", "Transaksi lain, nominal beda", null, 750_000],
    ]);
    const thirdValidation = await validateJournalImportBatch(db, differentAmountUpload, "c.xlsx");
    expect(thirdValidation.transactions[0].alreadyExists).toBe(false);
    const thirdResult = await commitJournalImportBatch(db, thirdValidation, actor);
    expect(thirdResult.committedCount).toBe(1);
  });

  it("ATOMIC COMMIT (§5): 1 transaksi valid + 1 transaksi 'rusak setelah lolos preview' -> SELURUH BATCH ROLLBACK, nol yang masuk", async () => {
    // Simulasi race condition: dua transaksi lolos validasi (keduanya VALID
    // saat preview), tapi SETELAH preview, account line transaksi KEDUA
    // dinonaktifkan (assertAccountUsable di createDraftJournalEntry akan
    // menolaknya SAAT COMMIT, bukan saat preview) -- membuktikan commit
    // tetap re-validasi di dalam transaction (bukan cuma percaya preview),
    // DAN membuktikan nested-transaction (createDraftJournalEntry/
    // postJournalEntry dipanggil berulang dgn trx luar yang sama) benar2
    // atomic: transaksi PERTAMA yang valid TIDAK boleh ikut masuk DB kalau
    // transaksi KEDUA gagal di tengah batch.
    const buffer = await buildTestWorkbook([
      ["1000", "2026-01-05", "JV013", "Kas", "Valid pertama", 1_000_000, null],
      ["3000", "2026-01-05", "JV013", "Modal", "Valid pertama", null, 1_000_000],
      null,
      ["6000", "2026-01-10", "JV014", "Beban", "Akan dinonaktifkan", 200_000, null],
      ["1000", "2026-01-10", "JV014", "Kas", "Akan dinonaktifkan", null, 200_000],
    ]);
    const validation = await validateJournalImportBatch(db, buffer, "test.xlsx");
    expect(validation.canCommit).toBe(true); // lolos preview, KEDUANYA VALID

    const { updateAccount } = await import("./account-service.js");
    await updateAccount(db, bebanId, { isActive: false }, actor); // "race condition" setelah preview

    await expect(commitJournalImportBatch(db, validation, actor)).rejects.toThrow();

    const jv013 = await db("journal_entries").where({ reference_no: "JV013" }).first();
    const jv014 = await db("journal_entries").where({ reference_no: "JV014" }).first();
    expect(jv013).toBeUndefined(); // TIDAK ikut masuk walau valid sendiri
    expect(jv014).toBeUndefined();
    const totalCount = await db("journal_entries").count<{ count: string }>({ count: "*" }).first();
    expect(Number(totalCount?.count ?? 0)).toBe(0);
  });
});
