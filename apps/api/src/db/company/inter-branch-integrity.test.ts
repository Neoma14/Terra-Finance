import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyInterBranchIntegrity } from "./inter-branch-integrity.js";
import {
  claimTransaction,
  completedTransaction,
  insertInterBranchJournal,
  interBranchWorld,
  proposeTransaction,
  reverseTransaction,
  type InterBranchWorld,
} from "./__fixtures__/inter-branch-test-helpers.js";

/** `verifyInterBranchIntegrity`: sehat = daftar kosong; tiap invarian dilanggar sengaja (trigger dimatikan seperlunya) harus terdeteksi. */

let w: InterBranchWorld;
beforeEach(async () => {
  w = await interBranchWorld();
});
afterEach(async () => {
  await w.db.destroy();
});

const codes = async () => (await verifyInterBranchIntegrity(w.db)).map((v) => v.code);
/** Data rusak hanya dapat tercipta bila penjaga dilewati (mis. SQL mentah pada file); tes mematikannya untuk menyimulasikan. */
const bypass = (...triggers: string[]) => Promise.all(triggers.map((t) => w.db.raw(`DROP TRIGGER IF EXISTS ${t}`)));

describe("keadaan sehat", () => {
  it("database kosong, transaksi WAITING, COMPLETED, dan REVERSED semuanya bersih", async () => {
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    await proposeTransaction(w.db, { from: w.metro, to: w.bl, fromAccountId: w.seed.kasId, toAccountId: w.seed.hutangId });
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    const done = await completedTransaction(w);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    await reverseTransaction(w, done);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("transaksi ditolak/dibatalkan/kedaluwarsa tanpa jurnal bersih", async () => {
    for (const status of ["REJECTED", "CANCELLED", "EXPIRED"] as const) {
      const tx = await proposeTransaction(w.db, { from: w.metro, to: w.bl, fromAccountId: w.seed.kasId, toAccountId: w.seed.hutangId });
      await w.db("inter_branch_transactions").where({ id: tx.id }).update({ status });
      await w.db("inter_branch_approvals").where({ transaction_id: tx.id }).update({ status, ...(status === "REJECTED" ? { decided_by: "t", decided_at: "2026-01-16T00:00:00Z", decision_reason: "Tidak sesuai" } : {}) });
    }
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });
});

describe("pelanggaran terdeteksi", () => {
  it("I-3: jurnal pada transaksi yang tidak COMPLETED", async () => {
    const tx = await completedTransaction(w);
    await bypass("inter_branch_transactions_status_transition", "inter_branch_transactions_immutable");
    await w.db("inter_branch_transactions").where({ id: tx.id }).update({ status: "WAITING_APPROVAL" });
    expect(await codes()).toContain("JOURNAL_ON_UNCOMPLETED");
  });

  it("I-2: satu sisi hilang (setengah posted)", async () => {
    const tx = await completedTransaction(w);
    await bypass("journal_entries_ib_no_delete", "journal_entry_lines_ib_del");
    await w.db("journal_entry_lines").where({ journal_entry_id: tx.journals.to }).del();
    await w.db("journal_entries").where({ id: tx.journals.to }).del();
    expect(await codes()).toContain("LEG_MISSING");
  });

  it("I-5: nominal baris antar-cabang tidak sama dengan transaksi", async () => {
    const tx = await completedTransaction(w);
    await bypass("journal_entry_lines_ib_upd");
    await w.db("journal_entry_lines").where({ journal_entry_id: tx.journals.from, account_id: w.ib["ASSET-BL"] }).update({ debit: 999 });
    const found = await codes();
    expect(found).toContain("AMOUNT_MISMATCH");
    expect(found).toContain("JOURNAL_NOT_BALANCED");
  });

  it("I-5: arah terbalik (FROM mengkredit akun lawan)", async () => {
    const tx = await proposeTransaction(w.db, { from: w.metro, to: w.bl, fromAccountId: w.seed.kasId, toAccountId: w.seed.hutangId });
    await claimTransaction(w.db, tx.id);
    await insertInterBranchJournal(w.db, { txId: tx.id, leg: "ORIGINAL", side: "FROM", periodId: w.seed.periodId, lines: [{ accountId: w.ib["ASSET-BL"], debit: 0, credit: 1_000_000 }, { accountId: w.seed.kasId, debit: 1_000_000, credit: 0 }] });
    await insertInterBranchJournal(w.db, { txId: tx.id, leg: "ORIGINAL", side: "TO", periodId: w.seed.periodId, lines: [{ accountId: w.seed.hutangId, debit: 1_000_000, credit: 0 }, { accountId: w.ib["LIABILITY-METRO"], debit: 0, credit: 1_000_000 }] });
    expect(await codes()).toContain("AMOUNT_MISMATCH");
  });

  it("I-4: cabang jurnal tidak sesuai sisi", async () => {
    const tx = await completedTransaction(w);
    await bypass("journal_entries_ib_core_upd", "journal_entries_branch_locked_after_post");
    await w.db("journal_entries").where({ id: tx.journals.from }).update({ branch_id: w.bl });
    expect(await codes()).toContain("BRANCH_MISMATCH");
  });

  it("I-6: jurnal yatim, origin tanpa tautan, tautan tanpa origin", async () => {
    await bypass("journal_entries_ib_link_ins");
    const base = { entry_date: "2026-01-15", period_id: w.seed.periodId, status: "DRAFT", branch_id: w.metro };
    await w.db("journal_entries").insert({ ...base, id: "yatim", reference_no: "IB-YATIM", origin: "inter_branch", inter_branch_transaction_id: "tidak-ada", inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" });
    await w.db("journal_entries").insert({ ...base, id: "tanpa-tautan", reference_no: "IB-TT", origin: "inter_branch" });
    const tx = await proposeTransaction(w.db, { from: w.metro, to: w.bl, fromAccountId: w.seed.kasId, toAccountId: w.seed.hutangId });
    await claimTransaction(w.db, tx.id);
    await w.db("journal_entries").insert({ ...base, id: "salah-origin", reference_no: "JU-SO", origin: "manual", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" });
    const found = await codes();
    expect(found).toEqual(expect.arrayContaining(["ORPHAN_JOURNAL", "ORIGIN_WITHOUT_LINK", "LINK_WITHOUT_ORIGIN"]));
  });

  it("I-8/I-2: reversal satu sisi (leg REVERSAL tanpa pasangannya)", async () => {
    const tx = await completedTransaction(w);
    await reverseTransaction(w, tx);
    await bypass("journal_entries_ib_no_delete", "journal_entry_lines_ib_del");
    const rev = await w.db("journal_entries").where({ inter_branch_transaction_id: tx.id, inter_branch_leg: "REVERSAL", inter_branch_side: "TO" }).first();
    await w.db("journal_entry_lines").where({ journal_entry_id: rev.id }).del();
    await w.db("journal_entries").where({ id: rev.id }).del();
    expect(await codes()).toContain("LEG_MISSING");
  });

  it("I-9: persetujuan tidak sesuai status (COMPLETED tanpa POST APPROVED; REVERSAL_WAITING tanpa permintaan)", async () => {
    const tx = await completedTransaction(w);
    await bypass("inter_branch_approvals_final_immutable", "inter_branch_approvals_request_immutable");
    await w.db("inter_branch_approvals").where({ transaction_id: tx.id }).update({ status: "WAITING", decided_by: null, decided_at: null, self_approved: 0 });
    expect(await codes()).toContain("POST_APPROVAL_MISMATCH");
    await w.db("inter_branch_transactions").where({ id: tx.id }).update({ reversal_state: "REVERSAL_WAITING" });
    expect(await codes()).toContain("REVERSE_APPROVAL_MISMATCH");
  });

  it("I-11: penanda self_approved tidak konsisten dengan pelaku keputusan", async () => {
    const tx = await completedTransaction(w); // dimaker oleh maker-1, diputuskan approver-1 -> self_approved = 0
    await bypass("inter_branch_approvals_final_immutable");
    await w.db.raw("PRAGMA ignore_check_constraints = ON");
    await w.db("inter_branch_approvals").where({ transaction_id: tx.id }).update({ self_approved: 1 });
    expect(await codes()).toContain("SELF_APPROVED_INCONSISTENT");
  });

  it("F-7: akun antar-cabang berklasifikasi kas atau arus kas", async () => {
    await bypass("accounts_ib_cash_upd");
    await w.db("accounts").where({ id: w.ib["ASSET-BL"] }).update({ is_cash: true });
    const found = await verifyInterBranchIntegrity(w.db);
    expect(found).toEqual([expect.objectContaining({ code: "ACCOUNT_RULE", accountId: w.ib["ASSET-BL"] })]);
  });
});
