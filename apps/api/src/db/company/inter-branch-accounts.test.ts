import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountInterBranchClassificationError, updateAccount } from "./account-service.js";
import { AccountPolicyChangeBlockedError, createInterBranchAccountPair, setAccountBranchPolicy } from "./account-policy-service.js";
import { InterBranchAccountAmbiguousError, InterBranchAccountMissingError, InterBranchAccountUnusableError, resolveInterBranchAccounts } from "./inter-branch-accounts.js";
import { addBranch, freshCompanyDb, seedBasics, testActor } from "./__fixtures__/branch-test-helpers.js";
import { interBranchWorld, type InterBranchWorld } from "./__fixtures__/inter-branch-test-helpers.js";

/** Resolver akun antar-cabang (dipilih sistem) + aturan akun F-7/K-2 di lapisan service. */

describe("resolveInterBranchAccounts", () => {
  let w: InterBranchWorld;
  beforeEach(async () => {
    w = await interBranchWorld();
  });
  afterEach(async () => {
    await w.db.destroy();
  });

  it("FROM mendebit ASSET[lawan=TO]; TO mengkredit LIABILITY[lawan=FROM] (Metro -> BL)", async () => {
    const r = await resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.bl });
    expect(r.fromDebit).toMatchObject({ id: w.ib["ASSET-BL"], accountType: "ASSET", counterpartBranchId: w.bl });
    expect(r.toCredit).toMatchObject({ id: w.ib["LIABILITY-METRO"], accountType: "LIABILITY", counterpartBranchId: w.metro });
  });

  it("arah dibalik (BL -> Metro) memilih pasangan yang berlawanan, tanpa kode atau id cabang yang ditulis di kode", async () => {
    const r = await resolveInterBranchAccounts(w.db, { fromBranchId: w.bl, toBranchId: w.metro });
    expect(r.fromDebit.id).toBe(w.ib["ASSET-METRO"]);
    expect(r.toCredit.id).toBe(w.ib["LIABILITY-BL"]);
  });

  it("model netto: bila hanya satu tipe ada, dipakai sebagai cadangan di kedua sisi", async () => {
    await w.db("accounts").where({ id: w.ib["LIABILITY-METRO"] }).update({ branch_policy: "ALL_BRANCH", counterpart_branch_id: null });
    const r = await resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.bl });
    expect(r.toCredit).toMatchObject({ id: w.ib["ASSET-METRO"], accountType: "ASSET" });
  });

  it("menolak dengan arahan bila akun belum dibuat atau cabang sama", async () => {
    const third = await addBranch(w.db, "C3", "Cabang 3");
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: third })).rejects.toBeInstanceOf(InterBranchAccountMissingError);
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: third })).rejects.toThrow(/belum dibuat/);
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.metro })).rejects.toBeInstanceOf(InterBranchAccountMissingError);
  });

  it("menolak akun yang tidak aktif atau terkunci -- tidak diam-diam beralih ke tipe lain", async () => {
    await w.db("accounts").where({ id: w.ib["ASSET-BL"] }).update({ is_active: false });
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.bl })).rejects.toBeInstanceOf(InterBranchAccountUnusableError);
    await w.db("accounts").where({ id: w.ib["ASSET-BL"] }).update({ is_active: true, is_locked: true });
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.bl })).rejects.toThrow(/dikunci/);
  });

  it("menolak akun yang melanggar aturan kas/arus kas (data lama di luar trigger)", async () => {
    await w.db.raw("DROP TRIGGER accounts_ib_cash_upd");
    await w.db("accounts").where({ id: w.ib["ASSET-BL"] }).update({ cash_flow_activity: "operating" });
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.bl })).rejects.toThrow(/arus kas/);
  });

  it("menolak keadaan ambigu (dua akun tipe yang sama untuk satu lawan) bila indeks unik tidak ada", async () => {
    await w.db.raw("DROP INDEX uq_accounts_inter_branch_pair");
    const asset = (await w.db("account_types").where({ code: "ASSET" }).first()).id;
    await w.db("accounts").insert({ id: crypto.randomUUID(), code: "AMBIGU", name: "Ambigu", account_type_id: asset, normal_balance: "debit", branch_policy: "INTER_BRANCH", counterpart_branch_id: w.bl });
    await expect(resolveInterBranchAccounts(w.db, { fromBranchId: w.metro, toBranchId: w.bl })).rejects.toBeInstanceOf(InterBranchAccountAmbiguousError);
  });
});

describe("aturan akun INTER_BRANCH di service (pesan ramah sebelum trigger)", () => {
  let w: InterBranchWorld;
  beforeEach(async () => {
    w = await interBranchWorld();
  });
  afterEach(async () => {
    await w.db.destroy();
  });

  it("updateAccount menolak menandai akun antar-cabang sebagai kas atau memberi klasifikasi arus kas", async () => {
    const id = w.ib["ASSET-BL"];
    await expect(updateAccount(w.db, id, { isCash: true }, testActor)).rejects.toBeInstanceOf(AccountInterBranchClassificationError);
    await expect(updateAccount(w.db, id, { cashFlowActivity: "operating" }, testActor)).rejects.toBeInstanceOf(AccountInterBranchClassificationError);
    await expect(updateAccount(w.db, id, { isCash: false, cashFlowActivity: null, name: "Antarkantor Aktiva BL" }, testActor)).resolves.toBeUndefined();
  });

  it("updateAccount pada akun biasa tidak berubah perilakunya", async () => {
    await expect(updateAccount(w.db, w.seed.hutangId, { cashFlowActivity: "operating" }, testActor)).resolves.toBeUndefined();
    await expect(updateAccount(w.db, w.seed.kasId, { isCash: true }, testActor)).resolves.toBeUndefined();
  });

  it("setAccountBranchPolicy menolak menjadikan akun kas / berklasifikasi arus kas sebagai antar-cabang", async () => {
    await updateAccount(w.db, w.seed.kasId, { isCash: true }, testActor);
    await expect(setAccountBranchPolicy(w.db, w.seed.kasId, { policy: "INTER_BRANCH", counterpartBranchId: w.bl, reason: "uji" }, testActor)).rejects.toBeInstanceOf(AccountInterBranchClassificationError);
    await updateAccount(w.db, w.seed.kasId, { isCash: false, cashFlowActivity: "operating" }, testActor);
    await expect(setAccountBranchPolicy(w.db, w.seed.kasId, { policy: "INTER_BRANCH", counterpartBranchId: w.bl, reason: "uji" }, testActor)).rejects.toBeInstanceOf(AccountInterBranchClassificationError);
  });

  it("setAccountBranchPolicy menolak duplikat (cabang lawan, tipe) dengan pesan ramah, bukan galat UNIQUE", async () => {
    const asset = (await w.db("account_types").where({ code: "ASSET" }).first()).id;
    const id = crypto.randomUUID();
    await w.db("accounts").insert({ id, code: "1999", name: "Akun biasa", account_type_id: asset, normal_balance: "debit" });
    await expect(setAccountBranchPolicy(w.db, id, { policy: "INTER_BRANCH", counterpartBranchId: w.bl, reason: "uji" }, testActor)).rejects.toBeInstanceOf(AccountPolicyChangeBlockedError);
    await expect(setAccountBranchPolicy(w.db, id, { policy: "INTER_BRANCH", counterpartBranchId: w.bl, reason: "uji" }, testActor)).rejects.toThrow(/sudah ada akun antar-cabang/i);
  });

  it("wizard pasangan akun tetap bekerja pada perusahaan baru, dan membuat akun yang memenuhi aturan", async () => {
    const db = await freshCompanyDb();
    await seedBasics(db);
    const a = await addBranch(db, "AA");
    const b = await addBranch(db, "BB");
    const out = await createInterBranchAccountPair(db, { branchAId: a, branchBId: b, accountTypeCode: "ASSET", confirm: true }, testActor);
    expect(out.created).toHaveLength(2);
    const rows = await db("accounts").where({ branch_policy: "INTER_BRANCH" }).select("is_cash", "cash_flow_activity");
    expect(rows.every((r: any) => !r.is_cash && r.cash_flow_activity === null)).toBe(true);
    await db.destroy();
  });
});
