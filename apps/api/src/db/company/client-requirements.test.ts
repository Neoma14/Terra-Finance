import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { createAccount, setAccountLocked } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "./journal-service.js";
import { getAccountLedgerByRange, getAccountLedger, isValidIsoDate } from "./ledger-service.js";
import { getDashboardSummary, fiscalYearStartFor } from "./dashboard-service.js";
import { getIncomeStatement } from "./reporting/income-statement-service.js";
import { getTrialBalance } from "./trial-balance-service.js";
import { getBalanceSheet } from "./reporting/balance-sheet-service.js";
import { setMaxBackdateDays, getJournalSettings, todayLocalDate, subtractDays } from "./journal-policy.js";
import type { ActorContext } from "./company-audit.js";

const actor: ActorContext = { actorType: "user", actorId: "test-user", actorLabel: "Test User" };

async function seedPeriod(db: Knex, label: string, start: string, end: string, year = 2026): Promise<string> {
  const id = crypto.randomUUID();
  await db("periods").insert({ id, label, start_date: start, end_date: end, period_type: "month", fiscal_year: year, status: "OPEN" });
  return id;
}

describe("Client requirements -- Ledger rentang tanggal", () => {
  let tmpDir: string;
  let db: Knex;
  let kas: string;
  let modal: string;
  let jan: string;
  let feb: string;
  let mar: string;

  async function post(date: string, periodId: string, ref: string, debitAcc: string, creditAcc: string, amount: number) {
    const { id } = await createDraftJournalEntry(
      db,
      { entryDate: date, periodId, referenceNo: ref, lines: [{ accountId: debitAcc, debit: amount, credit: 0 }, { accountId: creditAcc, debit: 0, credit: amount }] },
      actor,
    );
    await postJournalEntry(db, { journalEntryId: id }, actor);
    return id;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terra-cr-test-"));
    db = knexLib({ ...baseKnexConfig, connection: { filename: path.join(tmpDir, "company.db") } });
    await db.migrate.latest();
    kas = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modal = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    jan = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
    feb = await seedPeriod(db, "Feb 2026", "2026-02-01", "2026-02-28");
    mar = await seedPeriod(db, "Mar 2026", "2026-03-01", "2026-03-31");
    // 01 Jan +100, 15 Jan +200, 31 Jan +300, 01 Feb +400, 28 Feb +500, 10 Mar +600
    await post("2026-01-01", jan, "J1", kas, modal, 100);
    await post("2026-01-15", jan, "J2", kas, modal, 200);
    await post("2026-01-31", jan, "J3", kas, modal, 300);
    await post("2026-02-01", feb, "J4", kas, modal, 400);
    await post("2026-02-28", feb, "J5", kas, modal, 500);
    await post("2026-03-10", mar, "J6", kas, modal, 600);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1 hari: hanya transaksi pada tanggal itu, saldo awal = semua sebelum tanggal itu", async () => {
    const l = await getAccountLedgerByRange(db, kas, "2026-01-15", "2026-01-15");
    expect(l.lines.map((x) => x.referenceNo)).toEqual(["J2"]);
    expect(l.openingBalance).toBe(100);
    expect(l.endingBalance).toBe(300);
  });

  it("transaksi TEPAT pada fromDate dan toDate ikut (inklusif kedua ujung)", async () => {
    const l = await getAccountLedgerByRange(db, kas, "2026-01-15", "2026-01-31");
    expect(l.lines.map((x) => x.referenceNo)).toEqual(["J2", "J3"]);
    expect(l.openingBalance).toBe(100);
    expect(l.endingBalance).toBe(600);
  });

  it("1 minggu tanpa transaksi: kosong, saldo awal = saldo akhir", async () => {
    const l = await getAccountLedgerByRange(db, kas, "2026-01-16", "2026-01-22");
    expect(l.lines).toHaveLength(0);
    expect(l.openingBalance).toBe(300);
    expect(l.endingBalance).toBe(300);
  });

  it("1 bulan penuh (Januari)", async () => {
    const l = await getAccountLedgerByRange(db, kas, "2026-01-01", "2026-01-31");
    expect(l.lines).toHaveLength(3);
    expect(l.openingBalance).toBe(0);
    expect(l.endingBalance).toBe(600);
    expect(l.lines.map((x) => x.runningBalance)).toEqual([100, 300, 600]);
  });

  it("lintas bulan / lintas periode fiskal: saldo berjalan menyambung, saldo awal benar", async () => {
    const l = await getAccountLedgerByRange(db, kas, "2026-01-20", "2026-03-31");
    expect(l.lines.map((x) => x.referenceNo)).toEqual(["J3", "J4", "J5", "J6"]);
    expect(l.openingBalance).toBe(300);
    expect(l.lines.map((x) => x.runningBalance)).toEqual([600, 1000, 1500, 2100]);
    expect(l.endingBalance).toBe(2100);
  });

  it("rentang tanpa periode terdaftar / tanpa transaksi sama sekali tidak error", async () => {
    const l = await getAccountLedgerByRange(db, kas, "2027-05-01", "2027-05-31");
    expect(l.lines).toHaveLength(0);
    expect(l.openingBalance).toBe(2100);
    expect(l.endingBalance).toBe(2100);
  });

  it("ledger per periode (drill-down Trial Balance) = ledger rentang tanggal periode itu", async () => {
    const byPeriod = await getAccountLedger(db, kas, feb);
    const byRange = await getAccountLedgerByRange(db, kas, "2026-02-01", "2026-02-28");
    expect(byPeriod.lines).toEqual(byRange.lines);
    expect(byPeriod.openingBalance).toBe(byRange.openingBalance);
    expect(byPeriod.periodId).toBe(feb);
  });

  it("validasi tanggal: format salah, tanggal mustahil, from > to, kosong", async () => {
    await expect(getAccountLedgerByRange(db, kas, "2026-02-30", "2026-03-01")).rejects.toThrow(/bukan tanggal yang valid/);
    await expect(getAccountLedgerByRange(db, kas, "2026-13-01", "2026-03-01")).rejects.toThrow(/bukan tanggal yang valid/);
    await expect(getAccountLedgerByRange(db, kas, "01/02/2026", "2026-03-01")).rejects.toThrow(/bukan tanggal yang valid/);
    await expect(getAccountLedgerByRange(db, kas, "2026-03-02", "2026-03-01")).rejects.toThrow(/tidak boleh setelah/);
    await expect(getAccountLedgerByRange(db, kas, "", "2026-03-01")).rejects.toThrow(/wajib diisi/);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
  });

  it("akun tidak ada -> AccountNotFoundError", async () => {
    await expect(getAccountLedgerByRange(db, "tidak-ada", "2026-01-01", "2026-01-31")).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("REGRESI: baris dua jurnal bertanggal sama tidak saling menyelip (dikelompokkan per jurnal) dan urutannya stabil", async () => {
    // Tiap jurnal punya DUA baris pada akun yang sama (line_order 0 dan 1). Dulu urutan hanya
    // (entry_date, line_order) sehingga hasilnya X0,Y0,X1,Y1 -- baris jurnal bercampur.
    for (const ref of ["S-A", "S-B"]) {
      const { id } = await createDraftJournalEntry(
        db,
        { entryDate: "2026-02-14", periodId: feb, referenceNo: ref, lines: [
          { accountId: kas, debit: 10, credit: 0, memo: `${ref}-0` },
          { accountId: kas, debit: 0, credit: 3, memo: `${ref}-1` },
          { accountId: modal, debit: 0, credit: 7 },
        ] },
        actor,
      );
      await postJournalEntry(db, { journalEntryId: id }, actor);
    }
    const l = await getAccountLedgerByRange(db, kas, "2026-02-14", "2026-02-14");
    expect(l.lines.map((x) => x.memo)).toEqual(["S-A-0", "S-A-1", "S-B-0", "S-B-1"]);
    const again = await getAccountLedgerByRange(db, kas, "2026-02-14", "2026-02-14");
    expect(again.lines.map((x) => x.memo)).toEqual(l.lines.map((x) => x.memo));
  });

  it("REGRESI: jurnal yang direversal tetap tampil + reversal di tanggal yang sama; efek bersih nol", async () => {
    const id = await post("2026-02-14", feb, "REV-ME", kas, modal, 50);
    await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "REV-ME-REV", reason: "koreksi" }, actor);
    const l = await getAccountLedgerByRange(db, kas, "2026-02-14", "2026-02-14");
    expect(l.lines.map((x) => x.referenceNo).sort()).toEqual(["REV-ME", "REV-ME-REV"]);
    expect(l.endingBalance - l.openingBalance).toBe(0);
  });

  it("jurnal DRAFT tidak masuk ledger", async () => {
    await createDraftJournalEntry(db, { entryDate: "2026-02-15", periodId: feb, referenceNo: "DRAFT-1", lines: [{ accountId: kas, debit: 77, credit: 0 }, { accountId: modal, debit: 0, credit: 77 }] }, actor);
    const l = await getAccountLedgerByRange(db, kas, "2026-02-15", "2026-02-15");
    expect(l.lines).toHaveLength(0);
  });

  it("konsistensi: saldo akhir Ledger Kas = Trial Balance Kas = Neraca Kas (periode Februari)", async () => {
    const ledger = await getAccountLedgerByRange(db, kas, "2026-02-01", "2026-02-28");
    const tb = await getTrialBalance(db, feb);
    const tbKas = tb.rows.find((r) => r.code === "1000")!;
    expect(tbKas.debit - tbKas.credit).toBe(ledger.endingBalance);
    const bs = await getBalanceSheet(db, "2026-02-01", "2026-02-28");
    const kasLine = bs.assets.lines.find((l: { accountCode: string }) => l.accountCode === "1000") as { amount: number };
    expect(kasLine.amount).toBe(ledger.endingBalance);
  });
});

describe("Client requirements -- batas backdate & tanggal masa depan", () => {
  let tmpDir: string;
  let db: Knex;
  let kas: string;
  let modal: string;
  let period: string;
  const today = todayLocalDate();

  async function create(date: string, ref: string, opts: { opening?: boolean } = {}) {
    return createDraftJournalEntry(
      db,
      { entryDate: date, periodId: period, referenceNo: ref, isOpeningBalance: opts.opening, lines: [{ accountId: kas, debit: 10, credit: 0 }, { accountId: modal, debit: 0, credit: 10 }] },
      actor,
    );
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terra-cr-test-"));
    db = knexLib({ ...baseKnexConfig, connection: { filename: path.join(tmpDir, "company.db") } });
    await db.migrate.latest();
    kas = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modal = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    await db("company_profile").insert({ id: crypto.randomUUID(), name: "PT Uji" });
    // periode lebar yang memuat hari ini, 60 hari ke belakang & 10 hari ke depan
    period = await seedPeriod(db, "Lebar", subtractDays(today, 60), subtractDays(today, -10));
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tanpa batas backdate: hari ini dan 50 hari lalu boleh; besok SELALU ditolak", async () => {
    await expect(create(today, "A1")).resolves.toBeTruthy();
    await expect(create(subtractDays(today, 50), "A2")).resolves.toBeTruthy();
    await expect(create(subtractDays(today, -1), "A3")).rejects.toMatchObject({ code: "JOURNAL_INVALID_DATE" });
    await expect(create(subtractDays(today, -1), "A4")).rejects.toThrow(/tidak boleh lebih besar dari hari ini/);
  });

  it("batas 7 hari: hari ini, -1, -7 valid; -8 dan besok invalid", async () => {
    await setMaxBackdateDays(db, 7, actor);
    await expect(create(today, "B0")).resolves.toBeTruthy();
    await expect(create(subtractDays(today, 1), "B1")).resolves.toBeTruthy();
    await expect(create(subtractDays(today, 7), "B7")).resolves.toBeTruthy();
    await expect(create(subtractDays(today, 8), "B8")).rejects.toThrow(/melewati batas backdate/);
    await expect(create(subtractDays(today, -1), "BF")).rejects.toThrow(/tidak boleh lebih besar dari hari ini/);
    // tidak ada draft yang tersimpan dari yang ditolak
    const refs = (await db("journal_entries").select("reference_no")).map((r: { reference_no: string }) => r.reference_no).sort();
    expect(refs).toEqual(["B0", "B1", "B7"]);
  });

  it("batas 0 hari: hanya hari ini", async () => {
    await setMaxBackdateDays(db, 0, actor);
    await expect(create(today, "Z0")).resolves.toBeTruthy();
    await expect(create(subtractDays(today, 1), "Z1")).rejects.toThrow(/melewati batas backdate/);
  });

  it("jurnal saldo awal dikecualikan dari batas MUNDUR tetapi tidak dari masa depan", async () => {
    await setMaxBackdateDays(db, 1, actor);
    await expect(create(subtractDays(today, 40), "OB1", { opening: true })).resolves.toBeTruthy();
    await expect(create(subtractDays(today, -1), "OB2", { opening: true })).rejects.toThrow(/tidak boleh lebih besar dari hari ini/);
  });

  it("mengubah pengaturan tercatat di audit log dengan nilai sebelum/sesudah; nilai tidak valid ditolak", async () => {
    await setMaxBackdateDays(db, 7, actor);
    await setMaxBackdateDays(db, null, actor);
    const rows = await db("company_audit_log").where({ action: "journal_settings.change" }).orderBy("created_at");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].after_json)).toEqual({ maxBackdateDays: 7 });
    expect(JSON.parse(rows[1].before_json)).toEqual({ maxBackdateDays: 7 });
    await expect(setMaxBackdateDays(db, -1, actor)).rejects.toMatchObject({ code: "JOURNAL_SETTINGS_INVALID" });
    await expect(setMaxBackdateDays(db, 1.5, actor)).rejects.toMatchObject({ code: "JOURNAL_SETTINGS_INVALID" });
    const s = await getJournalSettings(db);
    expect(s.maxBackdateDays).toBeNull();
    expect(s.today).toBe(today);
  });

  it("reversal TIDAK terkena batas backdate (mengikuti tanggal jurnal asli), tetap bertanggal sama", async () => {
    const { id } = await create(subtractDays(today, 30), "OLD-1");
    await postJournalEntry(db, { journalEntryId: id }, actor);
    await setMaxBackdateDays(db, 3, actor);
    const rev = await reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "OLD-1-REV", reason: "koreksi" }, actor);
    const row = await db("journal_entries").where({ id: rev.id }).first();
    expect(String(row.entry_date).slice(0, 10)).toBe(subtractDays(today, 30));
  });
});

describe("Client requirements -- Lock / Unlock akun", () => {
  let tmpDir: string;
  let db: Knex;
  let kas: string;
  let modal: string;
  let period: string;
  const today = todayLocalDate();

  async function create(ref: string) {
    return createDraftJournalEntry(
      db,
      { entryDate: today, periodId: period, referenceNo: ref, lines: [{ accountId: kas, debit: 10, credit: 0 }, { accountId: modal, debit: 0, credit: 10 }] },
      actor,
    );
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terra-cr-test-"));
    db = knexLib({ ...baseKnexConfig, connection: { filename: path.join(tmpDir, "company.db") } });
    await db.migrate.latest();
    kas = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    modal = (await createAccount(db, { code: "3000", name: "Modal", accountTypeCode: "EQUITY", normalBalance: "credit" }, actor)).id;
    period = await seedPeriod(db, "Lebar", subtractDays(today, 60), subtractDays(today, -10));
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lock -> jurnal baru ditolak; unlock -> jurnal bisa dibuat; keduanya masuk audit log", async () => {
    await setAccountLocked(db, kas, true, actor);
    await expect(create("L1")).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect(await db("journal_entries").count<{ c: number }[]>("* as c").then((r) => r[0].c)).toBe(0);

    await setAccountLocked(db, kas, false, actor);
    await expect(create("L2")).resolves.toBeTruthy();

    const audit = await db("company_audit_log").whereIn("action", ["account.lock", "account.unlock"]).orderBy("created_at");
    expect(audit.map((a: { action: string }) => a.action)).toEqual(["account.lock", "account.unlock"]);
  });

  it("draft yang sudah dibuat lalu akunnya dikunci -> POST ditolak (cek ulang di dalam transaksi)", async () => {
    const { id } = await create("L3");
    await setAccountLocked(db, kas, true, actor);
    await expect(postJournalEntry(db, { journalEntryId: id }, actor)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect((await db("journal_entries").where({ id }).first()).status).toBe("DRAFT");
  });

  it("reversal jurnal yang memakai akun terkunci ditolak sampai di-unlock; jurnal asli tidak berubah", async () => {
    const { id } = await create("L4");
    await postJournalEntry(db, { journalEntryId: id }, actor);
    await setAccountLocked(db, kas, true, actor);
    await expect(reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "L4-REV", reason: "x" }, actor)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect((await db("journal_entries").where({ id }).first()).status).toBe("POSTED");
    await setAccountLocked(db, kas, false, actor);
    await expect(reverseJournalEntry(db, { journalEntryId: id, reversalReferenceNo: "L4-REV", reason: "x" }, actor)).resolves.toBeTruthy();
  });

  it("lock dua kali / unlock akun yang tidak terkunci ditolak; akun tidak ada -> not found", async () => {
    await setAccountLocked(db, kas, true, actor);
    await expect(setAccountLocked(db, kas, true, actor)).rejects.toMatchObject({ code: "ACCOUNT_LOCK_STATE" });
    await expect(setAccountLocked(db, modal, false, actor)).rejects.toMatchObject({ code: "ACCOUNT_LOCK_STATE" });
    await expect(setAccountLocked(db, "tidak-ada", true, actor)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("kolom locked_at / locked_by terisi saat lock dan dikosongkan saat unlock", async () => {
    await setAccountLocked(db, kas, true, actor);
    const locked = await db("accounts").where({ id: kas }).first();
    expect(Boolean(locked.is_locked)).toBe(true);
    expect(locked.locked_by).toBe("test-user");
    expect(locked.locked_at).toBeTruthy();
    await setAccountLocked(db, kas, false, actor);
    const unlocked = await db("accounts").where({ id: kas }).first();
    expect(Boolean(unlocked.is_locked)).toBe(false);
    expect(unlocked.locked_at).toBeNull();
  });
});

describe("Client requirements -- Dashboard YTD = Income Statement", () => {
  let tmpDir: string;
  let db: Knex;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terra-cr-test-"));
    db = knexLib({ ...baseKnexConfig, connection: { filename: path.join(tmpDir, "company.db") } });
    await db.migrate.latest();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fiscalYearStartFor: tahun fiskal Januari dan non-Januari", () => {
    expect(fiscalYearStartFor("2026-10-04", 1)).toBe("2026-01-01");
    expect(fiscalYearStartFor("2026-02-10", 4)).toBe("2025-04-01");
    expect(fiscalYearStartFor("2026-04-01", 4)).toBe("2026-04-01");
  });

  it("laba YTD dashboard = Laba Rugi Jan..toDate, walau rentang dashboard bulan ini kosong (tidak 0 palsu)", async () => {
    const kas = (await createAccount(db, { code: "1000", name: "Kas", accountTypeCode: "ASSET", normalBalance: "debit" }, actor)).id;
    const pendapatan = (await createAccount(db, { code: "4000", name: "Pendapatan", accountTypeCode: "REVENUE", normalBalance: "credit" }, actor)).id;
    const beban = (await createAccount(db, { code: "6000", name: "Beban", accountTypeCode: "EXPENSE", normalBalance: "debit" }, actor)).id;
    const jan = await seedPeriod(db, "Jan 2026", "2026-01-01", "2026-01-31");
    const feb = await seedPeriod(db, "Feb 2026", "2026-02-01", "2026-02-28");
    await seedPeriod(db, "Mar 2026", "2026-03-01", "2026-03-31");

    for (const [date, p, ref, d, c, amt] of [
      ["2026-01-10", jan, "R1", kas, pendapatan, 1000],
      ["2026-01-20", jan, "E1", beban, kas, 300],
      ["2026-02-05", feb, "R2", kas, pendapatan, 500],
    ] as const) {
      const { id } = await createDraftJournalEntry(db, { entryDate: date, periodId: p, referenceNo: ref, lines: [{ accountId: d, debit: amt, credit: 0 }, { accountId: c, debit: 0, credit: amt }] }, actor);
      await postJournalEntry(db, { journalEntryId: id }, actor);
    }

    // dashboard untuk Maret (tidak ada transaksi) -> netProfit bulan itu 0, tetapi YTD = 1000+500-300
    const dash = await getDashboardSummary(db, "2026-03-01", "2026-03-31");
    expect(dash.kpis.netProfit.value).toBe(0);
    const income = await getIncomeStatement(db, "2026-01-01", "2026-03-31");
    expect(income.netProfit).toBe(1200);
    expect(dash.ytd).toMatchObject({ fromDate: "2026-01-01", toDate: "2026-03-31", revenue: 1500, expense: 300, netProfit: income.netProfit });
  });
});
