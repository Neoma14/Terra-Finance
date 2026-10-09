import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { SeededAccounts } from "./__fixtures__/branch-test-helpers.js";
import { completedTransaction, interBranchWorld, type InterBranchWorld } from "./__fixtures__/inter-branch-test-helpers.js";
import {
  INTER_BRANCH_REVERSAL_STATES,
  INTER_BRANCH_STATUSES,
  allJournalReferencesFor,
  allocateTransactionNo,
  calculateExpiresAt,
  formatTransactionNo,
  isInterBranchExpired,
  isInterBranchType,
  isPendingInterBranch,
  isReservedInterBranchReference,
  isValidReversalTransition,
  isValidStateCombination,
  isValidStatusTransition,
  journalReferenceFor,
} from "./inter-branch-domain.js";

describe("tabel transisi (Spek §7)", () => {
  it("status: hanya WAITING_APPROVAL yang dapat berpindah, ke empat keadaan terminal; terminal tidak kembali", () => {
    for (const from of INTER_BRANCH_STATUSES) {
      for (const to of INTER_BRANCH_STATUSES) {
        const expected = from === "WAITING_APPROVAL" && to !== "WAITING_APPROVAL";
        expect(isValidStatusTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("reversal: NOT_REVERSED -> REVERSAL_WAITING -> REVERSED atau kembali; REVERSED terminal; tidak ada lompatan", () => {
    const allowed = new Set(["NOT_REVERSED>REVERSAL_WAITING", "REVERSAL_WAITING>REVERSED", "REVERSAL_WAITING>NOT_REVERSED"]);
    for (const from of INTER_BRANCH_REVERSAL_STATES) {
      for (const to of INTER_BRANCH_REVERSAL_STATES) {
        expect(isValidReversalTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it("kombinasi sah: reversal_state selain NOT_REVERSED hanya bila COMPLETED", () => {
    for (const s of INTER_BRANCH_STATUSES) {
      for (const r of INTER_BRANCH_REVERSAL_STATES) {
        expect(isValidStateCombination(s, r)).toBe(r === "NOT_REVERSED" || s === "COMPLETED");
      }
    }
  });

  it("pending (dasar K-3) = WAITING_APPROVAL atau REVERSAL_WAITING", () => {
    expect(isPendingInterBranch("WAITING_APPROVAL", "NOT_REVERSED")).toBe(true);
    expect(isPendingInterBranch("COMPLETED", "REVERSAL_WAITING")).toBe(true);
    for (const s of ["COMPLETED", "REJECTED", "CANCELLED", "EXPIRED"] as const) expect(isPendingInterBranch(s, "NOT_REVERSED")).toBe(false);
    expect(isPendingInterBranch("COMPLETED", "REVERSED")).toBe(false);
  });

  it("jenis MVP hanya TRANSFER_KAS dan PEMBEBANAN", () => {
    expect(isInterBranchType("TRANSFER_KAS")).toBe(true);
    expect(isInterBranchType("PEMBEBANAN")).toBe(true);
    for (const v of ["PERSEDIAAN", "transfer_kas", "", null, undefined, 1]) expect(isInterBranchType(v)).toBe(false);
  });
});

describe("referensi", () => {
  it("awalan IB- dicadangkan dengan normalisasi huruf besar-kecil dan spasi; yang mirip tidak ikut", () => {
    for (const r of ["IB-1", "ib-1", "  Ib-x", "\tIB-2026-000001-F"]) expect(isReservedInterBranchReference(r), r).toBe(true);
    for (const r of ["IBX-1", "IB2026", "JU-1", "XIB-1", "I B-1", "", null, undefined]) expect(isReservedInterBranchReference(r), String(r)).toBe(false);
  });

  it("nomor transaksi dan referensi jurnal deterministik", () => {
    expect(formatTransactionNo(2026, 1)).toBe("IB-2026-000001");
    expect(formatTransactionNo(2026, 999_999)).toBe("IB-2026-999999");
    expect(() => formatTransactionNo(2026, 0)).toThrow(RangeError);
    expect(() => formatTransactionNo(2026, 1_000_000)).toThrow(RangeError);
    expect(() => formatTransactionNo(99, 1)).toThrow(RangeError);
    expect(journalReferenceFor("IB-2026-000001", "ORIGINAL", "FROM")).toBe("IB-2026-000001-F");
    expect(journalReferenceFor("IB-2026-000001", "ORIGINAL", "TO")).toBe("IB-2026-000001-T");
    expect(journalReferenceFor("IB-2026-000001", "REVERSAL", "FROM")).toBe("IB-2026-000001-F-REV");
    expect(journalReferenceFor("IB-2026-000001", "REVERSAL", "TO")).toBe("IB-2026-000001-T-REV");
    expect(new Set(allJournalReferencesFor("IB-2026-000001")).size).toBe(4);
  });
});

describe("kedaluwarsa (Spek §6, D-11)", () => {
  const proposedAt = new Date(2026, 0, 10, 9, 30, 0); // waktu lokal
  const local = (iso: string) => new Date(iso);

  it("tanpa batas backdate: pengajuan + masa berlaku", () => {
    const exp = local(calculateExpiresAt({ proposedAt, expiryDays: 14, transactionDate: "2026-01-10", maxBackdateDays: null }));
    expect(exp.getTime()).toBe(new Date(2026, 0, 24, 9, 30, 0).getTime());
  });

  it("dibatasi akhir hari (tanggal transaksi + batas backdate) bila lebih awal", () => {
    // transaksi 2026-01-05, backdate 7 hari -> hari terakhir sah 2026-01-12; masa berlaku 14 hari lebih lama
    const exp = local(calculateExpiresAt({ proposedAt, expiryDays: 14, transactionDate: "2026-01-05", maxBackdateDays: 7 }));
    expect(exp.getTime()).toBe(new Date(2026, 0, 12, 23, 59, 59, 999).getTime());
  });

  it("memilih masa berlaku bila lebih awal dari batas backdate", () => {
    const exp = local(calculateExpiresAt({ proposedAt, expiryDays: 2, transactionDate: "2026-01-10", maxBackdateDays: 30 }));
    expect(exp.getTime()).toBe(new Date(2026, 0, 12, 9, 30, 0).getTime());
  });

  it("batas backdate 0 = berakhir akhir hari tanggal transaksi", () => {
    const exp = local(calculateExpiresAt({ proposedAt, expiryDays: 14, transactionDate: "2026-01-10", maxBackdateDays: 0 }));
    expect(exp.getTime()).toBe(new Date(2026, 0, 10, 23, 59, 59, 999).getTime());
  });

  it("menolak masa berlaku di luar 1-90 dan menilai kedaluwarsa dengan tegas", () => {
    for (const expiryDays of [0, 91, 1.5, -1]) expect(() => calculateExpiresAt({ proposedAt, expiryDays, transactionDate: "2026-01-10", maxBackdateDays: null })).toThrow(RangeError);
    const iso = "2026-01-20T00:00:00.000Z";
    expect(isInterBranchExpired(iso, new Date("2026-01-20T00:00:00.000Z"))).toBe(false);
    expect(isInterBranchExpired(iso, new Date("2026-01-20T00:00:00.001Z"))).toBe(true);
  });
});

describe("allocateTransactionNo", () => {
  let db: Knex;
  let seed: SeededAccounts;
  let w: InterBranchWorld;
  beforeEach(async () => {
    w = await interBranchWorld();
    db = w.db;
    seed = w.seed;
  });
  afterEach(async () => {
    await w.db.destroy();
  });

  it("mulai dari 1 per tahun dan naik per transaksi yang ada", async () => {
    expect(await allocateTransactionNo(db, "2026-01-15")).toBe("IB-2026-000001");
    await completedTransaction(w); // fixture memakai urutan sendiri; ambil nomor sesudah yang terbesar
    const next = await allocateTransactionNo(db, "2026-03-01");
    const max = (await db("inter_branch_transactions").max({ m: "transaction_no" }).first())!.m as string;
    expect(next > max).toBe(true);
    expect(await allocateTransactionNo(db, "2027-03-01")).toBe("IB-2027-000001");
  });

  it("melewati nomor yang referensi jurnal turunannya sudah dipakai (referensi lama berawalan IB- di mesin klien)", async () => {
    // data lama sebelum C0019: trigger F-2 hanya menjaga sisipan baru, jadi dimatikan sementara untuk menyimulasikannya
    await db.raw("DROP TRIGGER journal_entries_ib_ref_reserved");
    await db("journal_entries").insert({ id: "lama", entry_date: "2030-01-10", period_id: seed.periodId, reference_no: "IB-2030-000001-T", status: "DRAFT", branch_id: w.metro, origin: "manual" });
    expect(await allocateTransactionNo(db, "2030-01-10")).toBe("IB-2030-000002");
  });
});
