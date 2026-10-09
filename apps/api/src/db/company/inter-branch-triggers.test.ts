import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JournalReferenceReservedError, createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "./journal-service.js";
import { nextRef, testActor } from "./__fixtures__/branch-test-helpers.js";
import { claimTransaction, completedTransaction, insertInterBranchJournal, interBranchWorld, proposeTransaction, reverseTransaction, type InterBranchWorld } from "./__fixtures__/inter-branch-test-helpers.js";

/** Penjaga database C0019 (lapisan terakhir): K-1 tautan jurnal, K-3 flag, F-2 awalan IB-, F-7 klasifikasi akun, K-2 indeks unik. */

let w: InterBranchWorld;
beforeEach(async () => {
  w = await interBranchWorld();
});
afterEach(async () => {
  await w.db.destroy();
});

const ibJournal = (o: Record<string, unknown>) => w.db("journal_entries").insert({ id: crypto.randomUUID(), entry_date: "2026-01-15", period_id: w.seed.periodId, status: "DRAFT", reference_no: `IB-X-${nextRef()}`, branch_id: w.metro, origin: "inter_branch", ...o });
const plainJournal = (o: Record<string, unknown> = {}) => w.db("journal_entries").insert({ id: crypto.randomUUID(), entry_date: "2026-01-15", period_id: w.seed.periodId, status: "DRAFT", reference_no: nextRef(), branch_id: w.metro, origin: "manual", ...o });
const waiting = () => proposeTransaction(w.db, { from: w.metro, to: w.bl, fromAccountId: w.seed.kasId, toAccountId: w.seed.hutangId });

describe("K-1: tautan IB pada jurnal -- INSERT", () => {
  it("menolak tautan tanpa transaksi induk", async () => {
    await expect(ibJournal({ inter_branch_transaction_id: "tidak-ada", inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/induk tidak ada/);
  });

  it("menolak induk yang belum COMPLETED (WAITING_APPROVAL tidak boleh punya jurnal)", async () => {
    const tx = await waiting();
    await expect(ibJournal({ reference_no: "IB-W-F", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/status transaksi/);
  });

  it("menolak cabang jurnal yang tidak sesuai sisi", async () => {
    const tx = await waiting();
    await claimTransaction(w.db, tx.id);
    await expect(ibJournal({ branch_id: w.bl, inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/cabang jurnal/);
    await expect(ibJournal({ branch_id: w.metro, inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "TO" })).rejects.toThrow(/cabang jurnal/);
  });

  it("menolak asal tidak konsisten: tautan dengan origin manual, origin inter_branch tanpa tautan", async () => {
    const tx = await waiting();
    await claimTransaction(w.db, tx.id);
    await expect(ibJournal({ origin: "manual", reference_no: "JU-MANUAL-1", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/harus berasal inter_branch/);
    await expect(ibJournal({ origin: "manual", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/IB:/);
    await expect(ibJournal({})).rejects.toThrow(/hanya untuk jurnal bertaut/);
  });

  it("menolak referensi jurnal IB yang tidak berawalan IB- (huruf kecil pun)", async () => {
    const tx = await waiting();
    await claimTransaction(w.db, tx.id);
    for (const reference_no of ["JU-1", "ib-2026-000001-F"]) {
      await expect(ibJournal({ reference_no, inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/berawalan IB-/);
    }
  });

  it("leg REVERSAL hanya sah setelah reversal_state = REVERSED", async () => {
    const tx = await completedTransaction(w);
    await expect(ibJournal({ reference_no: "IB-R-F", inter_branch_transaction_id: tx.id, inter_branch_leg: "REVERSAL", inter_branch_side: "FROM" })).rejects.toThrow(/status transaksi/);
  });

  it("menerima jurnal sah kedua sisi dan menolak slot ganda (UNIQUE C0015)", async () => {
    const tx = await completedTransaction(w);
    await expect(ibJournal({ reference_no: "IB-DUP-F", inter_branch_transaction_id: tx.id, inter_branch_leg: "ORIGINAL", inter_branch_side: "FROM" })).rejects.toThrow(/UNIQUE/i);
    expect(await w.db("journal_entries").where({ inter_branch_transaction_id: tx.id })).toHaveLength(2);
  });
});

describe("K-1: tautan IB pada jurnal -- UPDATE (tidak dapat ditempel, dipindah, atau diubah)", () => {
  it("menolak menempelkan tautan lengkap ke jurnal biasa maupun mengubah origin", async () => {
    const tx = await completedTransaction(w);
    await plainJournal({ id: "biasa-1", reference_no: "BIASA-1" });
    await expect(w.db("journal_entries").where({ id: "biasa-1" }).update({ inter_branch_transaction_id: tx.id, inter_branch_leg: "REVERSAL", inter_branch_side: "TO", origin: "inter_branch" })).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entries").where({ id: "biasa-1" }).update({ origin: "inter_branch" })).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entries").where({ id: "biasa-1" }).update({ inter_branch_transaction_id: tx.id })).rejects.toThrow();
  });

  it("menolak memindahkan sisi/transaksi, mengosongkan tautan, dan mengubah origin jurnal bertaut", async () => {
    const tx = await completedTransaction(w);
    const other = await completedTransaction(w);
    const id = tx.journals.from;
    await expect(w.db("journal_entries").where({ id }).update({ inter_branch_side: "TO" })).rejects.toThrow();
    await expect(w.db("journal_entries").where({ id }).update({ inter_branch_transaction_id: other.id })).rejects.toThrow();
    await expect(w.db("journal_entries").where({ id }).update({ inter_branch_transaction_id: null, inter_branch_leg: null, inter_branch_side: null })).rejects.toThrow();
    await expect(w.db("journal_entries").where({ id }).update({ origin: "manual" })).rejects.toThrow(/IB:/);
  });

  it("menolak memindahkan jurnal ke transaksi lain walau slot tujuan kosong (UNIQUE saja tidak cukup)", async () => {
    const tx = await completedTransaction(w);
    const empty = await waiting();
    await claimTransaction(w.db, empty.id);
    await expect(w.db("journal_entries").where({ id: tx.journals.from }).update({ inter_branch_transaction_id: empty.id })).rejects.toThrow(/IB:/);
    expect((await w.db("journal_entries").where({ id: tx.journals.from }).first()).inter_branch_transaction_id).toBe(tx.id);
  });

  it("menerima UPDATE yang tidak mengubah nilai (kompatibel dengan ORM)", async () => {
    const tx = await completedTransaction(w);
    await expect(w.db("journal_entries").where({ id: tx.journals.from }).update({ inter_branch_side: "FROM", inter_branch_leg: "ORIGINAL" })).resolves.toBe(1);
  });
});

describe("K-1: imutabilitas jurnal bertaut yang sudah diposting", () => {
  it("menolak ubah kolom inti, hapus header, ubah/hapus/tambah baris, dan transisi status mundur", async () => {
    const tx = await completedTransaction(w);
    const id = tx.journals.from;
    await expect(w.db("journal_entries").where({ id }).update({ entry_date: "2026-01-16" })).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entries").where({ id }).update({ reference_no: "IB-GANTI" })).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entries").where({ id }).update({ branch_id: w.bl })).rejects.toThrow();
    await expect(w.db("journal_entries").where({ id }).del()).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entry_lines").where({ journal_entry_id: id }).update({ debit: 1 })).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entry_lines").where({ journal_entry_id: id }).del()).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entry_lines").insert({ id: crypto.randomUUID(), journal_entry_id: id, account_id: w.seed.kasId, debit: 1, credit: 0, line_order: 9 })).rejects.toThrow(/IB:/);
    await expect(w.db("journal_entries").where({ id }).update({ status: "DRAFT" })).rejects.toThrow(/IB:/);
  });

  it("tetap mengizinkan POSTED -> REVERSED (yang dipakai reversal) dan menolak REVERSED -> POSTED", async () => {
    const tx = await completedTransaction(w);
    await w.db("journal_entries").where({ id: tx.journals.from }).update({ status: "REVERSED", is_reversed: true });
    await expect(w.db("journal_entries").where({ id: tx.journals.from }).update({ status: "POSTED" })).rejects.toThrow(/IB:/);
  });

  it("jurnal biasa tidak berubah perilakunya: buat, posting, reversal tetap berjalan", async () => {
    const { id } = await createDraftJournalEntry(w.db, { entryDate: "2026-01-15", periodId: w.seed.periodId, referenceNo: nextRef(), branchId: w.metro, lines: [{ accountId: w.seed.kasId, debit: 5, credit: 0 }, { accountId: w.seed.hutangId, debit: 0, credit: 5 }] }, testActor);
    await postJournalEntry(w.db, { journalEntryId: id }, testActor);
    await reverseJournalEntry(w.db, { journalEntryId: id, reversalReferenceNo: nextRef(), reason: "uji" }, testActor);
    expect((await w.db("journal_entries").where({ id }).first()).status).toBe("REVERSED");
  });

  it("jurnal REVERSAL dibuat header POSTED dulu baru barisnya (urutan reverseJournalEntry) dan lolos", async () => {
    const tx = await completedTransaction(w);
    await reverseTransaction(w, tx);
    expect(await w.db("journal_entries").where({ inter_branch_transaction_id: tx.id, inter_branch_leg: "REVERSAL" })).toHaveLength(2);
  });
});

describe("transaksi dan persetujuan antar-cabang", () => {
  it("transaksi baru harus WAITING_APPROVAL dan NOT_REVERSED", async () => {
    const tx = await waiting();
    const row = await w.db("inter_branch_transactions").where({ id: tx.id }).first();
    const clone = { ...row, id: crypto.randomUUID(), transaction_no: "IB-2026-900001", idempotency_key: "k-baru" };
    await expect(w.db("inter_branch_transactions").insert({ ...clone, status: "COMPLETED" })).rejects.toThrow(/WAITING_APPROVAL/);
    await expect(w.db("inter_branch_transactions").insert({ ...clone, reversal_state: "REVERSED" })).rejects.toThrow();
  });

  it("CHECK: cabang asal = tujuan, nominal <= 0, status tidak dikenal", async () => {
    const base = { transaction_date: "2026-01-15", description: "x", from_account_id: w.seed.kasId, to_account_suggested_id: w.seed.hutangId, status: "WAITING_APPROVAL", proposed_by: "m", amount: 10 };
    const ins = (o: Record<string, unknown>) => w.db("inter_branch_transactions").insert({ id: crypto.randomUUID(), transaction_no: `IB-2026-${Math.floor(Math.random() * 1e6)}`, type: "TRANSFER_KAS", from_branch_id: w.metro, to_branch_id: w.bl, idempotency_key: crypto.randomUUID(), ...base, ...o });
    await expect(ins({ to_branch_id: w.metro })).rejects.toThrow(/CHECK/i);
    await expect(ins({ amount: 0 })).rejects.toThrow(/CHECK/i);
    await expect(ins({ amount: -5 })).rejects.toThrow(/CHECK/i);
    await expect(ins({ status: "APPROVED" })).rejects.toThrow(/CHECK|WAITING_APPROVAL/);
    await expect(ins({})).resolves.toBeDefined();
  });

  it("kolom bisnis tidak dapat diubah, tidak dapat dihapus, nomor dan kunci idempotensi unik", async () => {
    const tx = await waiting();
    for (const patch of [{ amount: 1 }, { description: "lain" }, { to_branch_id: w.metro }, { transaction_date: "2026-01-16" }, { transaction_no: "IB-2026-777777" }, { proposed_by: "x" }]) {
      await expect(w.db("inter_branch_transactions").where({ id: tx.id }).update(patch)).rejects.toThrow();
    }
    await expect(w.db("inter_branch_transactions").where({ id: tx.id }).del()).rejects.toThrow(/tidak dapat dihapus/);
    const row = await w.db("inter_branch_transactions").where({ id: tx.id }).first();
    await expect(w.db("inter_branch_transactions").insert({ ...row, id: crypto.randomUUID(), transaction_no: "IB-2026-888888" })).rejects.toThrow(/UNIQUE/i);
    await expect(w.db("inter_branch_transactions").insert({ ...row, id: crypto.randomUUID(), idempotency_key: "beda" })).rejects.toThrow(/UNIQUE/i);
  });

  it("hanya transisi status dan reversal_state yang sah", async () => {
    const t1 = await waiting();
    await w.db("inter_branch_transactions").where({ id: t1.id }).update({ status: "REJECTED" });
    for (const to of ["WAITING_APPROVAL", "COMPLETED", "CANCELLED", "EXPIRED"]) {
      await expect(w.db("inter_branch_transactions").where({ id: t1.id }).update({ status: to })).rejects.toThrow(/transisi status/);
    }
    const t2 = await waiting();
    await expect(w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "REVERSAL_WAITING" })).rejects.toThrow(/CHECK/i);
    await claimTransaction(w.db, t2.id);
    await expect(w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "REVERSED" })).rejects.toThrow(/transisi reversal_state/);
    await w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "REVERSAL_WAITING" });
    await w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "NOT_REVERSED" });
    await w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "REVERSAL_WAITING" });
    await w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "REVERSED" });
    await expect(w.db("inter_branch_transactions").where({ id: t2.id }).update({ reversal_state: "NOT_REVERSED" })).rejects.toThrow(/transisi reversal_state/);
  });

  it("persetujuan: satu WAITING per transaksi, tidak dapat dihapus, final tidak dapat diubah, alasan wajib", async () => {
    const tx = await waiting();
    const base = { id: crypto.randomUUID(), transaction_id: tx.id, kind: "POST", status: "WAITING", requested_by: "maker-1", requested_by_branch_id: w.metro, requested_at: "2026-01-15T00:00:00Z", expires_at: "2026-02-01T00:00:00Z" };
    await expect(w.db("inter_branch_approvals").insert(base)).rejects.toThrow(/UNIQUE/i);
    const approval = await w.db("inter_branch_approvals").where({ transaction_id: tx.id }).first();
    await expect(w.db("inter_branch_approvals").where({ id: approval.id }).del()).rejects.toThrow(/tidak dapat dihapus/);
    await expect(w.db("inter_branch_approvals").where({ id: approval.id }).update({ requested_by: "orang-lain" })).rejects.toThrow(/tidak dapat diubah/);
    await expect(w.db("inter_branch_approvals").where({ id: approval.id }).update({ status: "REJECTED", decided_by: "approver-1", decided_at: "2026-01-16T00:00:00Z" })).rejects.toThrow(/CHECK/i);
    await w.db("inter_branch_approvals").where({ id: approval.id }).update({ status: "REJECTED", decided_by: "approver-1", decided_at: "2026-01-16T00:00:00Z", decision_reason: "Nominal tidak sesuai" });
    await expect(w.db("inter_branch_approvals").where({ id: approval.id }).update({ decision_reason: "diubah" })).rejects.toThrow(/final/);
    await expect(w.db("inter_branch_approvals").insert({ ...base, id: crypto.randomUUID(), kind: "REVERSE", status: "WAITING" })).rejects.toThrow(/CHECK/i);
  });

  it("self_approved hanya sah bila pelaku keputusan = pengaju", async () => {
    const tx = await waiting();
    const approval = await w.db("inter_branch_approvals").where({ transaction_id: tx.id }).first();
    await expect(w.db("inter_branch_approvals").where({ id: approval.id }).update({ status: "APPROVED", decided_by: "orang-lain", decided_at: "2026-01-16T00:00:00Z", self_approved: 1 })).rejects.toThrow(/CHECK/i);
  });
});

describe("K-3: flag multi-cabang tidak dapat dimatikan saat ada transaksi menunggu", () => {
  // langsung ke tabel (melewati service): trigger adalah penjaga TERAKHIR; pesan ramah service diuji di inter-branch-workflow.test.ts
  const off = (enabled = false) => w.db("company_profile").update({ multi_branch_enabled: enabled ? 1 : 0 });

  it("menolak saat ada WAITING_APPROVAL, lalu mengizinkan setelah diselesaikan", async () => {
    const tx = await waiting();
    await expect(off()).rejects.toThrow(/IB:.*menunggu/);
    expect((await w.db("company_profile").first()).multi_branch_enabled).toBe(1);
    await w.db("inter_branch_transactions").where({ id: tx.id }).update({ status: "CANCELLED" });
    await expect(off()).resolves.toBe(1);
  });

  it("menolak saat ada REVERSAL_WAITING (COMPLETED dengan permintaan reversal menunggu)", async () => {
    const tx = await completedTransaction(w);
    await w.db("inter_branch_transactions").where({ id: tx.id }).update({ reversal_state: "REVERSAL_WAITING" });
    await expect(off()).rejects.toThrow(/menunggu/);
    await w.db("inter_branch_transactions").where({ id: tx.id }).update({ reversal_state: "NOT_REVERSED" });
    await expect(off()).resolves.toBe(1);
  });

  it("status terminal tidak menghalangi, dan menyalakan flag selalu boleh", async () => {
    await completedTransaction(w);
    await expect(off()).resolves.toBe(1);
    await expect(off(true)).resolves.toBe(1);
  });
});

describe("F-2: awalan referensi IB- dicadangkan", () => {
  it("jurnal biasa (manual) tidak dapat memakai IB- dalam variasi huruf/spasi apa pun", async () => {
    for (const reference_no of ["IB-2026-000001", "ib-2026-000001", "  Ib-x", "iB-"]) {
      await expect(plainJournal({ reference_no })).rejects.toThrow(/dicadangkan/);
    }
  });

  it("service jurnal biasa juga tidak lolos (jalur create), dan referensi mirip yang sah tetap diterima", async () => {
    const lines = [{ accountId: w.seed.kasId, debit: 5, credit: 0 }, { accountId: w.seed.hutangId, debit: 0, credit: 5 }];
    await expect(createDraftJournalEntry(w.db, { entryDate: "2026-01-15", periodId: w.seed.periodId, referenceNo: "IB-2026-000123", lines }, testActor)).rejects.toBeInstanceOf(JournalReferenceReservedError);
    await expect(createDraftJournalEntry(w.db, { entryDate: "2026-01-15", periodId: w.seed.periodId, referenceNo: "  ib-2026-000123", lines }, testActor)).rejects.toBeInstanceOf(JournalReferenceReservedError);
    for (const referenceNo of ["IBX-1", "IB2026", "JU-1", "IMP-AB-1", "SALDO-AWAL-X"]) {
      await expect(createDraftJournalEntry(w.db, { entryDate: "2026-01-15", periodId: w.seed.periodId, referenceNo, lines }, testActor)).resolves.toBeDefined();
    }
  });

  it("reversal jurnal biasa tidak dapat memakai referensi berawalan IB-", async () => {
    const { id } = await createDraftJournalEntry(w.db, { entryDate: "2026-01-15", periodId: w.seed.periodId, referenceNo: nextRef(), branchId: w.metro, lines: [{ accountId: w.seed.kasId, debit: 5, credit: 0 }, { accountId: w.seed.hutangId, debit: 0, credit: 5 }] }, testActor);
    await postJournalEntry(w.db, { journalEntryId: id }, testActor);
    await expect(reverseJournalEntry(w.db, { journalEntryId: id, reversalReferenceNo: "ib-rev-1", reason: "uji" }, testActor)).rejects.toBeInstanceOf(JournalReferenceReservedError);
    expect((await w.db("journal_entries").where({ id }).first()).status).toBe("POSTED");
  });

  it("referensi IB yang sah tidak ditolak oleh keunikan referensi generik; referensi tanpa nilai (NULL) tidak terpengaruh", async () => {
    const tx = await completedTransaction(w);
    const refs = (await w.db("journal_entries").where({ inter_branch_transaction_id: tx.id }).select("reference_no")).map((r: any) => r.reference_no).sort();
    expect(refs).toEqual([`${tx.no}-F`, `${tx.no}-T`]);
    await expect(plainJournal({ reference_no: null })).resolves.toBeDefined();
  });
});

describe("F-7: akun INTER_BRANCH bukan akun kas dan tanpa klasifikasi arus kas", () => {
  const type = async (code: string) => (await w.db("account_types").where({ code }).first()).id as string;
  const newAccount = async (extra: Record<string, unknown>) =>
    w.db("accounts").insert({ id: crypto.randomUUID(), code: `X-${crypto.randomUUID().slice(0, 6)}`, name: "Uji", account_type_id: await type("ASSET"), normal_balance: "debit", ...extra });

  it("menolak INSERT akun antar-cabang bertanda kas atau berklasifikasi arus kas", async () => {
    await expect(newAccount({ branch_policy: "INTER_BRANCH", counterpart_branch_id: w.bl, is_cash: true })).rejects.toThrow(/IB:/);
    await expect(newAccount({ branch_policy: "INTER_BRANCH", counterpart_branch_id: w.metro, cash_flow_activity: "operating" })).rejects.toThrow(/IB:/);
  });

  it("menolak UPDATE is_cash / cash_flow_activity pada akun antar-cabang, dan menjadikan akun kas sebagai antar-cabang", async () => {
    const ibId = w.ib["ASSET-BL"];
    await expect(w.db("accounts").where({ id: ibId }).update({ is_cash: true })).rejects.toThrow(/IB:/);
    await expect(w.db("accounts").where({ id: ibId }).update({ cash_flow_activity: "financing" })).rejects.toThrow(/IB:/);
    await expect(w.db("accounts").where({ id: w.seed.kasId }).update({ is_cash: true })).resolves.toBe(1);
    await expect(w.db("accounts").where({ id: w.seed.kasId }).update({ branch_policy: "INTER_BRANCH", counterpart_branch_id: w.bl })).rejects.toThrow(/IB:/);
  });

  it("akun non-antar-cabang tetap bebas mengubah klasifikasi arus kas", async () => {
    await expect(w.db("accounts").where({ id: w.seed.hutangId }).update({ cash_flow_activity: "operating" })).resolves.toBe(1);
  });
});

describe("K-2: satu akun INTER_BRANCH per (cabang lawan, tipe akun)", () => {
  it("menolak duplikat, mengizinkan tipe lain atau cabang lawan lain, dan tidak mengganggu akun biasa", async () => {
    const asset = (await w.db("account_types").where({ code: "ASSET" }).first()).id as string;
    const liability = (await w.db("account_types").where({ code: "LIABILITY" }).first()).id as string;
    const mk = (code: string, account_type_id: string, extra: Record<string, unknown> = {}) =>
      w.db("accounts").insert({ id: crypto.randomUUID(), code, name: code, account_type_id, normal_balance: "debit", ...extra });
    await expect(mk("DUP-1", asset, { branch_policy: "INTER_BRANCH", counterpart_branch_id: w.bl })).rejects.toThrow(/UNIQUE/i);
    await expect(mk("DUP-2", liability, { branch_policy: "INTER_BRANCH", counterpart_branch_id: w.bl })).rejects.toThrow(/UNIQUE/i);
    const third = await w.db("branches").insert({ id: "cabang-3", code: "C3", name: "Cabang 3", status: "ACTIVE", is_head_office: 0, sort_order: 9 }).then(() => "cabang-3");
    await expect(mk("OK-1", asset, { branch_policy: "INTER_BRANCH", counterpart_branch_id: third })).resolves.toBeDefined();
    await expect(mk("PLAIN-1", asset)).resolves.toBeDefined();
    await expect(mk("PLAIN-2", asset)).resolves.toBeDefined();
  });
});

describe("INSERT OR REPLACE / UPSERT tidak dapat menjadi jalan pintas (recursive_triggers aktif pada koneksi aplikasi)", () => {
  it("REPLACE atas jurnal bertaut, baris jurnalnya, transaksi, dan persetujuan ditolak penjaga DELETE", async () => {
    const tx = await completedTransaction(w);
    const journal = await w.db("journal_entries").where({ id: tx.journals.from }).first();
    await expect(w.db.raw("INSERT OR REPLACE INTO journal_entries(id,entry_date,period_id,reference_no,status,branch_id,origin,inter_branch_transaction_id,inter_branch_leg,inter_branch_side) VALUES (?,?,?,?,?,?,?,?,?,?)", [journal.id, journal.entry_date, journal.period_id, journal.reference_no, "POSTED", w.bl, "inter_branch", tx.id, "ORIGINAL", "TO"])).rejects.toThrow(/IB:/);
    const line = await w.db("journal_entry_lines").where({ journal_entry_id: journal.id }).first();
    await expect(w.db.raw("INSERT OR REPLACE INTO journal_entry_lines(id,journal_entry_id,account_id,debit,credit,line_order) VALUES (?,?,?,?,?,?)", [line.id, journal.id, line.account_id, 1, 0, 0])).rejects.toThrow(/IB:/);
    const row = await w.db("inter_branch_transactions").where({ id: tx.id }).first();
    await expect(w.db("inter_branch_transactions").insert(row).onConflict("id").merge({ amount: 1 })).rejects.toThrow(/IB:/);
    await expect(w.db.raw("INSERT OR REPLACE INTO inter_branch_transactions(id,transaction_no,type,transaction_date,from_branch_id,to_branch_id,amount,description,from_account_id,to_account_suggested_id,status,proposed_by,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [row.id, row.transaction_no, row.type, row.transaction_date, row.from_branch_id, row.to_branch_id, 1, "x", row.from_account_id, row.to_account_suggested_id, "WAITING_APPROVAL", row.proposed_by, row.idempotency_key])).rejects.toThrow();
    const approval = await w.db("inter_branch_approvals").where({ transaction_id: tx.id }).first();
    await expect(w.db("inter_branch_approvals").insert(approval).onConflict("id").merge({ status: "WAITING" })).rejects.toThrow(/IB:/);
    expect(await w.db("journal_entries").where({ id: journal.id }).first()).toMatchObject({ inter_branch_side: "FROM", branch_id: w.metro });
    expect((await w.db("inter_branch_transactions").where({ id: tx.id }).first()).status).toBe("COMPLETED");
  });

  it("jurnal biasa tidak terpengaruh oleh recursive_triggers (REPLACE pada jurnal non-IB tetap berjalan)", async () => {
    await plainJournal({ id: "plain-1", reference_no: "PLAIN-1" });
    await expect(w.db.raw("INSERT OR REPLACE INTO journal_entries(id,entry_date,period_id,reference_no,status,branch_id,origin) VALUES (?,?,?,?,?,?,?)", ["plain-1", "2026-01-16", w.seed.periodId, "PLAIN-1", "DRAFT", w.metro, "manual"])).resolves.toBeDefined();
  });
});
