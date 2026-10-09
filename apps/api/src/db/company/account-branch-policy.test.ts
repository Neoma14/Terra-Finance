import crypto from "node:crypto";
import type { Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccountPolicyViolationError, describePolicyViolation, type PolicyAccount } from "./account-branch-policy.js";
import {
  AccountPolicyChangeBlockedError,
  InterBranchAccountPlanInvalidError,
  createInterBranchAccountPair,
  previewInterBranchAccountPair,
  setAccountBranchPolicy,
} from "./account-policy-service.js";
import { BranchInvalidInputError, changeBranchStatus, getHeadOfficeBranch } from "./branch-service.js";
import { AccountNotFoundError, getAccount, listAccounts, updateAccount } from "./account-service.js";
import { createDraftJournalEntry, postJournalEntry } from "./journal-service.js";
import { createOpeningBalanceEntry, getOpeningBalance, OpeningBalanceAlreadyExistsError } from "./opening-balance-service.js";
import { addBranch, freshCompanyDb, nextRef, seedBasics, testActor, type SeededAccounts } from "./__fixtures__/branch-test-helpers.js";

describe("Kebijakan cabang per akun (Multi-Branch Phase 2)", () => {
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

  const setPolicy = (accountId: string, policy: string, counterpart: string | null = null) =>
    db("accounts").where({ id: accountId }).update({ branch_policy: policy, counterpart_branch_id: counterpart });

  const draft = (branchId: string, a: string, b: string, extra: Record<string, unknown> = {}) =>
    createDraftJournalEntry(
      db,
      {
        entryDate: "2026-01-15",
        periodId: seed.periodId,
        referenceNo: nextRef(),
        branchId,
        lines: [
          { accountId: a, debit: 1000, credit: 0 },
          { accountId: b, debit: 0, credit: 1000 },
        ],
        ...extra,
      },
      testActor,
    );

  it("semua akun lama seragam ALL_BRANCH -- termasuk Equity/Asset/Liability; tidak ada logika berbasis tipe akun", async () => {
    const all = await listAccounts(db);
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((a) => a.branchPolicy))).toEqual(new Set(["ALL_BRANCH"]));
    // Akun Modal (Equity) boleh dipakai jurnal cabang non-pusat karena kebijakannya ALL_BRANCH.
    await expect(draft(metro, seed.kasId, seed.modalId)).resolves.toHaveProperty("id");
  });

  it("CENTRAL_ONLY: ditolak pada jurnal cabang non-pusat (manual), diterima pada Kantor Pusat", async () => {
    await setPolicy(seed.modalId, "CENTRAL_ONLY");
    await expect(draft(metro, seed.kasId, seed.modalId)).rejects.toBeInstanceOf(AccountPolicyViolationError);
    await expect(draft(metro, seed.kasId, seed.modalId)).rejects.toMatchObject({ code: "ACCOUNT_POLICY_VIOLATION", policy: "CENTRAL_ONLY", accountCode: "3000" });
    await expect(draft(hq, seed.kasId, seed.modalId)).resolves.toHaveProperty("id");
  });

  it("SYSTEM_ONLY: user (manual/import/opening_balance) ditolak walau di Kantor Pusat; proses sistem terdaftar diterima", async () => {
    await setPolicy(seed.bebanId, "SYSTEM_ONLY");
    await expect(draft(hq, seed.bebanId, seed.kasId)).rejects.toBeInstanceOf(AccountPolicyViolationError);
    await expect(draft(hq, seed.bebanId, seed.kasId, { source: "import" })).rejects.toBeInstanceOf(AccountPolicyViolationError);
    await expect(draft(hq, seed.bebanId, seed.kasId, { isOpeningBalance: true })).rejects.toBeInstanceOf(AccountPolicyViolationError);
    const ok = await draft(metro, seed.bebanId, seed.kasId, { origin: "system", systemProcess: "system_adjustment" });
    expect((await db("journal_entries").where({ id: ok.id }).first()).origin).toBe("system");
  });

  it("jurnal sistem harus menyebut proses terdaftar; proses sistem tidak boleh dipasang pada jurnal non-sistem", async () => {
    await expect(draft(hq, seed.kasId, seed.hutangId, { origin: "system" })).rejects.toThrow(/proses sistem yang terdaftar/);
    await expect(draft(hq, seed.kasId, seed.hutangId, { origin: "system", systemProcess: "proses_karangan" })).rejects.toThrow(/proses sistem yang terdaftar/);
    await expect(draft(hq, seed.kasId, seed.hutangId, { systemProcess: "system_adjustment" })).rejects.toThrow(/hanya boleh diisi untuk jurnal berasal sistem/);
  });

  it("INTER_BRANCH: jurnal manual/import/sistem ditolak; saldo awal diterima kecuali memakai akun yang menunjuk cabangnya sendiri", async () => {
    await setPolicy(seed.hutangId, "INTER_BRANCH", bandar); // akun dengan cabang lawan = Bandar Lampung
    await expect(draft(metro, seed.kasId, seed.hutangId)).rejects.toBeInstanceOf(AccountPolicyViolationError);
    await expect(draft(metro, seed.kasId, seed.hutangId, { source: "import" })).rejects.toBeInstanceOf(AccountPolicyViolationError);
    await expect(draft(metro, seed.kasId, seed.hutangId, { origin: "system", systemProcess: "system_adjustment" })).rejects.toBeInstanceOf(AccountPolicyViolationError);
    // saldo awal Metro memakai akun lawan Bandar Lampung -> boleh
    await expect(draft(metro, seed.kasId, seed.hutangId, { isOpeningBalance: true })).resolves.toHaveProperty("id");
    // tetapi Bandar Lampung tidak boleh memakai akun yang menunjuk dirinya sendiri sebagai lawan
    await expect(draft(bandar, seed.kasId, seed.hutangId, { isOpeningBalance: true })).rejects.toThrow(/cabang lawan/);
  });

  it("kebijakan tidak valid ditolak database (CHECK)", async () => {
    await expect(setPolicy(seed.kasId, "SEMUA_CABANG")).rejects.toThrow(/CHECK/i);
    await expect(
      db("accounts").insert({ id: crypto.randomUUID(), code: "X1", name: "X", account_type_id: (await db("account_types").first()).id, normal_balance: "debit", branch_policy: "BEBAS" }),
    ).rejects.toThrow(/CHECK/i);
  });

  it("INTER_BRANCH wajib counterpart; non-INTER_BRANCH wajib tanpa counterpart; counterpart harus cabang yang ada dan belum dihapus", async () => {
    await expect(setPolicy(seed.kasId, "INTER_BRANCH", null)).rejects.toThrow(/counterpart_branch_id wajib/);
    await expect(setPolicy(seed.kasId, "ALL_BRANCH", metro)).rejects.toThrow(/counterpart_branch_id wajib/);
    await expect(setPolicy(seed.kasId, "CENTRAL_ONLY", metro)).rejects.toThrow(/counterpart_branch_id wajib/);
    await expect(setPolicy(seed.kasId, "INTER_BRANCH", "cabang-fiktif")).rejects.toThrow();
    // insert langsung juga dijaga
    const t = (await db("account_types").first()).id;
    await expect(
      db("accounts").insert({ id: crypto.randomUUID(), code: "X2", name: "X", account_type_id: t, normal_balance: "debit", branch_policy: "INTER_BRANCH" }),
    ).rejects.toThrow(/counterpart_branch_id wajib/);
    // counterpart soft-deleted
    const gone = await addBranch(db, "HAPUS");
    await db("branches").where({ id: gone }).update({ deleted_at: new Date().toISOString() });
    await expect(setPolicy(seed.kasId, "INTER_BRANCH", gone)).rejects.toThrow(/Cabang lawan tidak ditemukan/);
    // jalur sah
    await setPolicy(seed.kasId, "INTER_BRANCH", metro);
    expect((await getAccount(db, seed.kasId))!.counterpartBranchId).toBe(metro);
  });

  it("nama akun tidak mempengaruhi kebijakan maupun cabang lawan", async () => {
    await updateAccount(db, seed.kasId, { name: "Antarkantor Passiva - Bandar Lampung" }, testActor);
    const renamed = (await getAccount(db, seed.kasId))!;
    expect(renamed.branchPolicy).toBe("ALL_BRANCH");
    expect(renamed.counterpartBranchId).toBeNull();
    // masih diperlakukan sebagai akun biasa
    await expect(draft(metro, seed.kasId, seed.hutangId)).resolves.toHaveProperty("id");

    // akun INTER_BRANCH yang diberi nama "Kas" tetap terkunci dari jurnal manual
    await setPolicy(seed.bebanId, "INTER_BRANCH", bandar);
    await updateAccount(db, seed.bebanId, { name: "Kas Besar" }, testActor);
    await expect(draft(metro, seed.bebanId, seed.hutangId)).rejects.toBeInstanceOf(AccountPolicyViolationError);
  });

  it("kebijakan dicek ulang saat POSTING (draft lama tidak lolos bila kebijakan akun berubah)", async () => {
    const { id } = await draft(metro, seed.kasId, seed.modalId);
    await setPolicy(seed.modalId, "CENTRAL_ONLY");
    await expect(postJournalEntry(db, { journalEntryId: id }, testActor)).rejects.toBeInstanceOf(AccountPolicyViolationError);
    expect((await db("journal_entries").where({ id }).first()).status).toBe("DRAFT");
  });

  it("describePolicyViolation: fungsi murni, tidak membaca tipe/nama akun", () => {
    const acc = (policy: PolicyAccount["branchPolicy"], counterpart: string | null = null): PolicyAccount => ({ id: "a", code: "1", name: "Nama Apa Saja", branchPolicy: policy, counterpartBranchId: counterpart });
    const hqBranch = { id: "h", name: "Pusat", isHeadOffice: true };
    const br = { id: "b", name: "Cabang", isHeadOffice: false };
    expect(describePolicyViolation(acc("ALL_BRANCH"), br, "manual")).toBeNull();
    expect(describePolicyViolation(acc("CENTRAL_ONLY"), hqBranch, "manual")).toBeNull();
    expect(describePolicyViolation(acc("CENTRAL_ONLY"), br, "system")).not.toBeNull();
    expect(describePolicyViolation(acc("SYSTEM_ONLY"), hqBranch, "system")).toBeNull();
    expect(describePolicyViolation(acc("SYSTEM_ONLY"), hqBranch, "opening_balance")).not.toBeNull();
    expect(describePolicyViolation(acc("INTER_BRANCH", "x"), br, "opening_balance")).toBeNull();
    expect(describePolicyViolation(acc("INTER_BRANCH", "b"), br, "opening_balance")).not.toBeNull();
    expect(describePolicyViolation(acc("INTER_BRANCH", "x"), br, "manual")).not.toBeNull();
  });

  describe("setAccountBranchPolicy (OWNER)", () => {
    it("mengubah kebijakan dengan alasan wajib, mencatat audit before/after dan dampak baris lama", async () => {
      const metroJournal = await draft(metro, seed.kasId, seed.modalId);
      await postJournalEntry(db, { journalEntryId: metroJournal.id }, testActor);
      await expect(setAccountBranchPolicy(db, seed.modalId, { policy: "CENTRAL_ONLY", reason: "" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
      const impact = await setAccountBranchPolicy(db, seed.modalId, { policy: "CENTRAL_ONLY", reason: "Modal hanya dikelola pusat" }, testActor);
      expect(impact).toMatchObject({ totalLines: 1, nonHeadOfficeLines: 1 });
      const audit = await db("company_audit_log").where({ action: "account.policy_changed", entity_id: seed.modalId }).first();
      expect(JSON.parse(audit.before_json).branchPolicy).toBe("ALL_BRANCH");
      expect(JSON.parse(audit.after_json).branchPolicy).toBe("CENTRAL_ONLY");
      expect(audit.reason).toBe("Modal hanya dikelola pusat");
      // posting lama tidak berubah
      expect((await db("journal_entries").where({ id: metroJournal.id }).first()).status).toBe("POSTED");
    });

    it("INTER_BRANCH wajib cabang lawan yang valid; non-INTER_BRANCH tidak boleh punya; akun tak dikenal -> 404", async () => {
      await expect(setAccountBranchPolicy(db, seed.hutangId, { policy: "INTER_BRANCH", reason: "antar cabang" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
      await expect(setAccountBranchPolicy(db, seed.hutangId, { policy: "ALL_BRANCH", counterpartBranchId: metro, reason: "salah" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
      await expect(setAccountBranchPolicy(db, seed.hutangId, { policy: "INTER_BRANCH", counterpartBranchId: "tidak-ada", reason: "antar cabang" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
      await expect(setAccountBranchPolicy(db, "akun-tak-ada", { policy: "ALL_BRANCH", reason: "xxx" }, testActor)).rejects.toBeInstanceOf(AccountNotFoundError);
      await setAccountBranchPolicy(db, seed.hutangId, { policy: "INTER_BRANCH", counterpartBranchId: metro, reason: "antar cabang" }, testActor);
      expect((await getAccount(db, seed.hutangId))!).toMatchObject({ branchPolicy: "INTER_BRANCH", counterpartBranchId: metro });
    });

    it("akun yang sudah dipakai jurnal tidak boleh berubah identitas antar-cabangnya", async () => {
      const used = await draft(metro, seed.kasId, seed.hutangId);
      await postJournalEntry(db, { journalEntryId: used.id }, testActor);
      await expect(setAccountBranchPolicy(db, seed.hutangId, { policy: "INTER_BRANCH", counterpartBranchId: bandar, reason: "ubah" }, testActor)).rejects.toBeInstanceOf(AccountPolicyChangeBlockedError);

      await setAccountBranchPolicy(db, seed.bebanId, { policy: "INTER_BRANCH", counterpartBranchId: bandar, reason: "akun antar cabang" }, testActor);
      const ib = await draft(metro, seed.kasId, seed.bebanId, { isOpeningBalance: true });
      await postJournalEntry(db, { journalEntryId: ib.id }, testActor);
      await expect(setAccountBranchPolicy(db, seed.bebanId, { policy: "INTER_BRANCH", counterpartBranchId: metro, reason: "ganti lawan" }, testActor)).rejects.toBeInstanceOf(AccountPolicyChangeBlockedError);
      await expect(setAccountBranchPolicy(db, seed.bebanId, { policy: "ALL_BRANCH", reason: "lepas status" }, testActor)).rejects.toBeInstanceOf(AccountPolicyChangeBlockedError);
    });

    it("cabang lawan yang sudah ditutup ditolak", async () => {
      await changeBranchStatus(db, bandar, { to: "CLOSED", reason: "Tutup cabang" }, testActor);
      await expect(setAccountBranchPolicy(db, seed.hutangId, { policy: "INTER_BRANCH", counterpartBranchId: bandar, reason: "antar cabang" }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
    });
  });

  describe("pembuatan terpandu akun antar-cabang (preview + konfirmasi)", () => {
    const input = (extra: Record<string, unknown> = {}) => ({ branchAId: metro, branchBId: bandar, accountTypeCode: "LIABILITY" as const, ...extra });

    it("preview tidak mengubah apa pun dan mengusulkan dua akun, masing-masing menunjuk cabang lawannya", async () => {
      const before = (await listAccounts(db)).length;
      const plan = await previewInterBranchAccountPair(db, input());
      expect(plan.canConfirm).toBe(true);
      expect(plan.items).toHaveLength(2);
      expect(plan.items[0]).toMatchObject({ counterpartBranchId: bandar, action: "create", proposed: { name: "Antarkantor Passiva - Bandar Lampung", normalBalance: "credit" } });
      expect(plan.items[1]).toMatchObject({ counterpartBranchId: metro, action: "create" });
      expect((await listAccounts(db)).length).toBe(before);
    });

    it("tanpa konfirmasi ditolak; dengan konfirmasi membuat dua akun INTER_BRANCH dalam satu COA", async () => {
      await expect(createInterBranchAccountPair(db, { ...input(), confirm: false }, testActor)).rejects.toBeInstanceOf(BranchInvalidInputError);
      expect((await listAccounts(db)).filter((a) => a.branchPolicy === "INTER_BRANCH")).toHaveLength(0);

      const res = await createInterBranchAccountPair(db, { ...input({ codeCounterpartB: "1901", codeCounterpartA: "1902" }), confirm: true }, testActor);
      expect(res.created.map((c) => c.code).sort()).toEqual(["1901", "1902"]);
      const ib = (await listAccounts(db)).filter((a) => a.branchPolicy === "INTER_BRANCH");
      expect(ib).toHaveLength(2);
      const forBandar = ib.find((a) => a.code === "1901")!;
      const forMetro = ib.find((a) => a.code === "1902")!;
      expect(forBandar.counterpartBranchId).toBe(bandar); // dipakai Metro
      expect(forMetro.counterpartBranchId).toBe(metro); // dipakai Bandar Lampung
      expect(forBandar.normalBalance).toBe("credit");
      // audit tiap akun
      expect(await db("company_audit_log").where({ action: "account.inter_branch_created" })).toHaveLength(2);
    });

    it("pembuatan ulang tidak menggandakan: preview menandai 'exists' dan tidak ada yang bisa dikonfirmasi", async () => {
      await createInterBranchAccountPair(db, { ...input(), confirm: true }, testActor);
      const plan = await previewInterBranchAccountPair(db, input());
      expect(plan.items.map((i) => i.action)).toEqual(["exists", "exists"]);
      expect(plan.canConfirm).toBe(false);
      await expect(createInterBranchAccountPair(db, { ...input(), confirm: true }, testActor)).rejects.toBeInstanceOf(InterBranchAccountPlanInvalidError);
    });

    it("konflik kode atau cabang ditutup membatalkan seluruh rencana (tidak ada akun setengah jadi)", async () => {
      const conflict = await previewInterBranchAccountPair(db, input({ codeCounterpartB: "1000" })); // kode Kas sudah ada
      expect(conflict.canConfirm).toBe(false);
      expect(conflict.items[0].action).toBe("conflict");
      const before = (await listAccounts(db)).length;
      await expect(createInterBranchAccountPair(db, { ...input({ codeCounterpartB: "1000" }), confirm: true }, testActor)).rejects.toBeInstanceOf(InterBranchAccountPlanInvalidError);
      expect((await listAccounts(db)).length).toBe(before);

      await changeBranchStatus(db, bandar, { to: "CLOSED", reason: "Tutup cabang" }, testActor);
      const closed = await previewInterBranchAccountPair(db, input());
      expect(closed.canConfirm).toBe(false);
      expect(closed.issues.join(" ")).toMatch(/sudah ditutup/);
    });

    it("validasi masukan: cabang sama, cabang tidak ada, tipe akun tidak valid", async () => {
      await expect(previewInterBranchAccountPair(db, input({ branchBId: metro }))).rejects.toBeInstanceOf(BranchInvalidInputError);
      await expect(previewInterBranchAccountPair(db, input({ branchBId: "tidak-ada" }))).rejects.toBeInstanceOf(BranchInvalidInputError);
      await expect(previewInterBranchAccountPair(db, input({ accountTypeCode: "EQUITY" }))).rejects.toBeInstanceOf(BranchInvalidInputError);
    });
  });

  describe("saldo awal per cabang + kebijakan", () => {
    const lines = (a: string, b: string) => [
      { accountId: a, debit: 2500, credit: 0 },
      { accountId: b, debit: 0, credit: 2500 },
    ];

    it("satu saldo awal aktif PER CABANG: Metro dan Bandar Lampung masing-masing boleh punya satu, Pusat tidak terpengaruh", async () => {
      const input = { entryDate: "2026-01-02", periodId: seed.periodId };
      await createOpeningBalanceEntry(db, { ...input, lines: lines(seed.kasId, seed.modalId) }, testActor, metro);
      await createOpeningBalanceEntry(db, { ...input, lines: lines(seed.kasId, seed.modalId) }, testActor, bandar);
      await expect(createOpeningBalanceEntry(db, { ...input, lines: lines(seed.kasId, seed.modalId) }, testActor, metro)).rejects.toBeInstanceOf(OpeningBalanceAlreadyExistsError);
      expect((await getOpeningBalance(db, metro)).exists).toBe(true);
      expect((await getOpeningBalance(db, bandar)).exists).toBe(true);
      expect((await getOpeningBalance(db)).exists).toBe(false); // Kantor Pusat belum punya
      await createOpeningBalanceEntry(db, { ...input, lines: lines(seed.kasId, seed.modalId) }, testActor); // tanpa branchId -> Pusat
      expect((await getOpeningBalance(db)).exists).toBe(true);
    });

    it("saldo awal mengikuti kebijakan akun: CENTRAL_ONLY ditolak di cabang non-pusat, diterima di Pusat", async () => {
      await setPolicy(seed.modalId, "CENTRAL_ONLY");
      const input = { entryDate: "2026-01-02", periodId: seed.periodId, lines: lines(seed.kasId, seed.modalId) };
      await expect(createOpeningBalanceEntry(db, input, testActor, metro)).rejects.toBeInstanceOf(AccountPolicyViolationError);
      await expect(createOpeningBalanceEntry(db, input, testActor)).resolves.toHaveProperty("id");
    });
  });
});
