import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { changeBranchStatus, setMultiBranchEnabled } from "./branch-service.js";
import { createCompanyDb } from "./index.js";
import { AccountInactiveError, updateAccount } from "./account-service.js";
import { FiscalPeriodClosedError } from "./fiscal-period.js";
import { JournalInvalidDateError } from "./journal-service.js";
import { closePeriod, lockPeriod, PeriodNotReadyToCloseError } from "./period-closing-service.js";
import { InterBranchAccountMissingError } from "./inter-branch-accounts.js";
import { verifyInterBranchIntegrity } from "./inter-branch-integrity.js";
import { MultiBranchHasPendingInterBranchError } from "./inter-branch-lifecycle.js";
import { getInterBranchDetail, getInterBranchSummary, listInterBranch } from "./inter-branch-queries.js";
import {
  InterBranchBusyError,
  InterBranchDisabledError,
  InterBranchExpiredError,
  InterBranchForbiddenError,
  InterBranchIdempotencyConflictError,
  InterBranchNotFoundError,
  InterBranchStateChangedError,
  InterBranchValidationError,
  SelfApprovalNotAllowedError,
  isIdempotencyUniqueViolation,
  approveInterBranch,
  approveInterBranchReversal,
  cancelInterBranch,
  cancelInterBranchReversal,
  proposeInterBranch,
  rejectInterBranch,
  rejectInterBranchReversal,
  requestInterBranchReversal,
  setInterBranchExpiryDays,
  type InterBranchPrincipal,
  type ProposeInput,
} from "./inter-branch-service.js";
import { testActor } from "./__fixtures__/branch-test-helpers.js";
import { cashAccounts, interBranchWorld, makePrincipal, type CashAccounts, type InterBranchWorld } from "./__fixtures__/inter-branch-test-helpers.js";

/** Alur Inter-Branch end-to-end di level service dengan otorisasi Phase 3 yang sungguhan (canActOnBranch). */

let w: InterBranchWorld;
let acc: CashAccounts;
let owner: InterBranchPrincipal;
let maker: InterBranchPrincipal;
let approver: InterBranchPrincipal;
let admin: InterBranchPrincipal;
let staff: InterBranchPrincipal;
let outsider: InterBranchPrincipal;

beforeEach(async () => {
  w = await interBranchWorld();
  acc = await cashAccounts(w);
  owner = makePrincipal({ userId: "owner-1", role: "OWNER" });
  maker = makePrincipal({ userId: "maker-1", role: "ACCOUNTANT", branches: [w.metro] });
  approver = makePrincipal({ userId: "approver-1", role: "ACCOUNTANT", branches: [w.bl] });
  admin = makePrincipal({ userId: "admin-1", role: "ADMIN", branches: [w.metro, w.bl] });
  staff = makePrincipal({ userId: "staff-1", role: "STAFF", branches: [w.bl] });
  outsider = makePrincipal({ userId: "out-1", role: "ACCOUNTANT", branches: [] });
});
afterEach(async () => {
  await w.db.destroy();
});

const input = (o: Partial<ProposeInput> = {}): ProposeInput => ({
  type: "TRANSFER_KAS",
  fromBranchId: w.metro,
  toBranchId: w.bl,
  transactionDate: "2026-01-15",
  amount: 1_000_000,
  fromAccountId: acc.kas,
  toAccountSuggestedId: acc.bank,
  description: "Setoran kas ke Bandar Lampung",
  idempotencyKey: crypto.randomUUID(),
  ...o,
});
const propose = async (who = maker, o: Partial<ProposeInput> = {}) => (await proposeInterBranch(w.db, who, input(o))).id;
const txRow = (id: string) => w.db("inter_branch_transactions").where({ id }).first();
const journalsOf = (id: string) => w.db("journal_entries").where({ inter_branch_transaction_id: id });
const auditActions = async (id: string) => (await w.db("company_audit_log").where({ entity_id: id, entity_type: "inter_branch_transaction" }).orderBy("rowid")).map((r: any) => r.action as string);
const linesOf = async (journalId: string) => (await w.db("journal_entry_lines").where({ journal_entry_id: journalId }).orderBy("line_order")).map((l: any) => ({ account: l.account_id, debit: Number(l.debit), credit: Number(l.credit) }));

describe("ajukan", () => {
  it("membuat pengajuan WAITING_APPROVAL bernomor IB-, TANPA jurnal, laporan tak berubah, audit CREATED + SUBMITTED", async () => {
    const before = await w.db("journal_entry_lines").count({ c: "*" }).first();
    const r = await proposeInterBranch(w.db, maker, input());
    expect(r.transactionNo).toMatch(/^IB-2026-\d{6}$/);
    expect(r.replayed).toBe(false);
    const tx = await txRow(r.id);
    expect(tx).toMatchObject({ status: "WAITING_APPROVAL", reversal_state: "NOT_REVERSED", proposed_by: "maker-1", from_branch_id: w.metro, to_branch_id: w.bl });
    expect(await journalsOf(r.id)).toHaveLength(0);
    expect(await w.db("journal_entry_lines").count({ c: "*" }).first()).toEqual(before);
    expect(await auditActions(r.id)).toEqual(["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED"]);
    const audit = await w.db("company_audit_log").where({ entity_id: r.id, action: "INTER_BRANCH_CREATED" }).first();
    expect(audit.branch_id).toBe(w.metro);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("idempoten: kunci sama mengembalikan pengajuan yang sama (replay), isi berbeda ditolak", async () => {
    const key = crypto.randomUUID();
    const a = await proposeInterBranch(w.db, maker, input({ idempotencyKey: key }));
    const b = await proposeInterBranch(w.db, maker, input({ idempotencyKey: key }));
    expect(b).toMatchObject({ id: a.id, replayed: true });
    await expect(proposeInterBranch(w.db, maker, input({ idempotencyKey: key, amount: 5 }))).rejects.toBeInstanceOf(InterBranchIdempotencyConflictError);
    expect((await w.db("inter_branch_transactions")).length).toBe(1);
  });

  it("balapan idempotensi lintas-proses: pra-cek lolos padahal pemenang sudah commit -> pecundang menerima replay (bukan galat UNIQUE mentah); isi berbeda -> konflik; tetap satu transaksi", async () => {
    const key = crypto.randomUUID();
    const winner = await proposeInterBranch(w.db, maker, input({ idempotencyKey: key }));
    // Pra-cek pertama (pembacaan `inter_branch_transactions`) disimulasikan tidak melihat pemenang: persis kondisi dua proses yang lolos pra-cek bersamaan.
    const blindOnce = (): Knex => {
      let blinded = false;
      return new Proxy(w.db, {
        apply(target, thisArg, args) {
          if (!blinded && args[0] === "inter_branch_transactions") {
            blinded = true;
            return { where: () => ({ first: async () => undefined }) };
          }
          return Reflect.apply(target as never, thisArg, args);
        },
      }) as Knex;
    };
    const loser = await proposeInterBranch(blindOnce(), maker, input({ idempotencyKey: key }));
    expect(loser).toMatchObject({ id: winner.id, transactionNo: winner.transactionNo, replayed: true });
    await expect(proposeInterBranch(blindOnce(), maker, input({ idempotencyKey: key, amount: 7 }))).rejects.toBeInstanceOf(InterBranchIdempotencyConflictError);
    expect((await w.db("inter_branch_transactions")).length).toBe(1);
    expect((await w.db("inter_branch_approvals")).length).toBe(1);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    expect(isIdempotencyUniqueViolation(Object.assign(new Error("UNIQUE constraint failed: inter_branch_transactions.proposed_by, inter_branch_transactions.idempotency_key"), { code: "SQLITE_CONSTRAINT_UNIQUE" }))).toBe(true);
    expect(isIdempotencyUniqueViolation(Object.assign(new Error("UNIQUE constraint failed: inter_branch_transactions.transaction_no"), { code: "SQLITE_CONSTRAINT_UNIQUE" }))).toBe(false);
    expect(isIdempotencyUniqueViolation(new Error("lain"))).toBe(false);
  });

  it("validasi: nominal, desimal, tanggal, jenis, cabang sama, keterangan", async () => {
    const bad: Array<Partial<ProposeInput>> = [{ amount: 0 }, { amount: -1 }, { amount: 10.123 }, { amount: Number.NaN }, { transactionDate: "2026-02-30" }, { type: "PERSEDIAAN" }, { toBranchId: w.metro }, { description: " " }, { idempotencyKey: "pendek" }];
    for (const o of bad) await expect(proposeInterBranch(w.db, maker, input(o)), JSON.stringify(o)).rejects.toBeInstanceOf(InterBranchValidationError);
  });

  it("validasi aturan: kas wajib untuk Transfer Kas; Pembebanan bukan kas-ke-kas; akun antar-cabang tidak boleh dipilih; tanggal masa depan & batas backdate", async () => {
    await expect(proposeInterBranch(w.db, maker, input({ toAccountSuggestedId: acc.hutang }))).rejects.toThrow(/akun kas/);
    await expect(proposeInterBranch(w.db, maker, input({ type: "PEMBEBANAN" }))).rejects.toThrow(/Transfer Kas/);
    await expect(proposeInterBranch(w.db, maker, input({ toAccountSuggestedId: w.ib["ASSET-BL"] }))).rejects.toThrow(/antar-cabang/);
    await expect(proposeInterBranch(w.db, maker, input({ transactionDate: "2999-01-01" }))).rejects.toBeInstanceOf(JournalInvalidDateError);
    await w.db("company_profile").update({ max_backdate_days: 30 });
    await expect(proposeInterBranch(w.db, maker, input())).rejects.toBeInstanceOf(JournalInvalidDateError);
  });

  it("menolak bila periode tidak ada/tidak OPEN, cabang non-aktif, atau akun antar-cabang belum dibuat (dengan arahan)", async () => {
    await expect(proposeInterBranch(w.db, maker, input({ transactionDate: "2025-06-01" }))).rejects.toThrow(/periode/i);
    await w.db("periods").update({ status: "LOCKED" });
    await expect(proposeInterBranch(w.db, maker, input())).rejects.toThrow(/LOCKED/);
    await w.db("periods").update({ status: "OPEN" });
    const third = crypto.randomUUID();
    await w.db("branches").insert({ id: third, code: "C3", name: "Cabang 3", status: "ACTIVE", is_head_office: 0, sort_order: 9 });
    const wide = makePrincipal({ userId: "wide", role: "ACCOUNTANT", branches: [w.metro, third] });
    await expect(proposeInterBranch(w.db, wide, input({ toBranchId: third }))).rejects.toBeInstanceOf(InterBranchAccountMissingError);
    await w.db("branches").where({ id: third }).update({ status: "INACTIVE" });
    await expect(proposeInterBranch(w.db, wide, input({ toBranchId: third }))).rejects.toBeInstanceOf(InterBranchValidationError);
  });

  it("otorisasi: tanpa permission create atau tanpa akses cabang asal ditolak; VIEWER tidak punya hak apa pun", async () => {
    const viewer = makePrincipal({ userId: "v", role: "VIEWER", branches: "ALL" });
    await expect(proposeInterBranch(w.db, viewer, input())).rejects.toBeInstanceOf(InterBranchForbiddenError);
    await expect(proposeInterBranch(w.db, approver, input())).rejects.toBeInstanceOf(InterBranchForbiddenError); // hanya punya akses BL
    const denied = makePrincipal({ userId: "d", role: "ACCOUNTANT", branches: [w.metro], denies: ["interbranch.create"] });
    await expect(proposeInterBranch(w.db, denied, input())).rejects.toBeInstanceOf(InterBranchForbiddenError);
    const granted = makePrincipal({ userId: "g", role: "STAFF", branches: [w.metro] });
    await expect(proposeInterBranch(w.db, granted, input())).resolves.toBeDefined(); // STAFF boleh mengajukan
  });
});

describe("setujui = terima = posting dua sisi atomik", () => {
  it("golden Metro -> BL Rp1.000.000: dua jurnal, tertaut, seimbang, akun pasangan dari counterpart_branch_id", async () => {
    const id = await propose();
    const result = await approveInterBranch(w.db, approver, id);
    expect(result).toMatchObject({ status: "COMPLETED" });
    const tx = await txRow(id);
    expect(tx).toMatchObject({ status: "COMPLETED", reversal_state: "NOT_REVERSED" });
    const journals = await journalsOf(id);
    expect(journals).toHaveLength(2);
    const from = journals.find((j: any) => j.inter_branch_side === "FROM")!;
    const to = journals.find((j: any) => j.inter_branch_side === "TO")!;
    expect(from).toMatchObject({ branch_id: w.metro, status: "POSTED", origin: "inter_branch", inter_branch_leg: "ORIGINAL", reference_no: `${tx.transaction_no}-F`, created_by: "maker-1", posted_by: "approver-1" });
    expect(to).toMatchObject({ branch_id: w.bl, status: "POSTED", reference_no: `${tx.transaction_no}-T` });
    expect(await linesOf(from.id)).toEqual([
      { account: w.ib["ASSET-BL"], debit: 1_000_000, credit: 0 },
      { account: acc.kas, debit: 0, credit: 1_000_000 },
    ]);
    expect(await linesOf(to.id)).toEqual([
      { account: acc.bank, debit: 1_000_000, credit: 0 },
      { account: w.ib["LIABILITY-METRO"], debit: 0, credit: 1_000_000 },
    ]);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    expect(await auditActions(id)).toEqual(["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED", "INTER_BRANCH_APPROVED", "INTER_BRANCH_POSTED", "INTER_BRANCH_COMPLETED"]);
    const detail = await getInterBranchDetail(w.db, admin, id);
    expect(detail).toMatchObject({ status: "COMPLETED", accountingEvent: "POSTED", reversalState: "NOT_REVERSED", selfApproved: false });
    expect(detail.journals).toHaveLength(2);
  });

  it("Pembebanan: penerima mengakui beban, pemberi mengurangi kas; akun penerima yang dikonfirmasi berbeda dari usulan dicatat", async () => {
    const id = await propose(maker, { type: "PEMBEBANAN", toAccountSuggestedId: acc.hutang });
    await approveInterBranch(w.db, approver, id, { confirmedAccountId: acc.beban });
    const to = (await journalsOf(id)).find((j: any) => j.inter_branch_side === "TO")!;
    expect((await linesOf(to.id))[0]).toEqual({ account: acc.beban, debit: 1_000_000, credit: 0 });
    expect(await auditActions(id)).toContain("INTER_BRANCH_ACCOUNT_CONFIRMED");
    const approval = await w.db("inter_branch_approvals").where({ transaction_id: id, kind: "POST" }).first();
    expect(approval.confirmed_account_id).toBe(acc.beban);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("SELF-APPROVAL: non-OWNER tidak dapat menyetujui/menolak miliknya sendiri walau memegang kedua cabang (ADMIN LIMITED, ACCOUNTANT)", async () => {
    for (const who of [admin, makePrincipal({ userId: "acct-both", role: "ACCOUNTANT", branches: [w.metro, w.bl] })]) {
      const id = await propose(who);
      await expect(approveInterBranch(w.db, who, id)).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
      await expect(rejectInterBranch(w.db, who, id, { reason: "membatalkan sendiri" })).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
      expect(await journalsOf(id)).toHaveLength(0);
      expect((await txRow(id)).status).toBe("WAITING_APPROVAL");
    }
  });

  it("OWNER: membuat, menyetujui, dan menyelesaikan transaksinya sendiri tanpa delegasi dan tanpa user lain; audit lengkap", async () => {
    const id = await propose(owner);
    await expect(approveInterBranch(w.db, owner, id)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(await journalsOf(id)).toHaveLength(2);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    const approved = await w.db("company_audit_log").where({ entity_id: id, action: "INTER_BRANCH_APPROVED" }).first();
    expect(JSON.parse(approved.after_json)).toMatchObject({ actorRole: "OWNER", makerEqualsApprover: true, self_approved: true });
    expect((await w.db("inter_branch_approvals").where({ transaction_id: id, kind: "POST" }).first()).self_approved).toBe(1);
  });

  it("OWNER tetap tunduk pada validasi domain: periode CLOSED, akun nonaktif, cabang non-aktif menolak OWNER", async () => {
    const a = await propose(owner);
    await w.db("periods").update({ status: "LOCKED" });
    await expect(approveInterBranch(w.db, owner, a)).rejects.toThrow();
    expect(await journalsOf(a)).toHaveLength(0);
    await w.db("periods").update({ status: "OPEN" });
    await updateAccount(w.db, acc.bank, { isActive: false }, testActor);
    await expect(approveInterBranch(w.db, owner, a)).rejects.toBeInstanceOf(AccountInactiveError);
    expect((await txRow(a)).status).toBe("WAITING_APPROVAL");
  });

  it("non-OWNER lain dapat menyetujui pengajuan OWNER (OWNER tidak mengunci keputusan orang lain)", async () => {
    const id = await propose(owner);
    await expect(approveInterBranch(w.db, approver, id)).resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("hak = permission efektif DAN akses cabang tujuan: STAFF, pemilik akses cabang asal saja, DENY, outsider ditolak/404", async () => {
    const id = await propose();
    await expect(approveInterBranch(w.db, staff, id)).rejects.toBeInstanceOf(InterBranchForbiddenError); // STAFF tak punya approve
    const onlyFrom = makePrincipal({ userId: "from-only", role: "ACCOUNTANT", branches: [w.metro] });
    await expect(approveInterBranch(w.db, onlyFrom, id)).rejects.toBeInstanceOf(InterBranchForbiddenError); // melihat, tetapi bukan penerima
    const denied = makePrincipal({ userId: "dn", role: "ACCOUNTANT", branches: [w.bl], denies: ["interbranch.approve"] });
    await expect(approveInterBranch(w.db, denied, id)).rejects.toBeInstanceOf(InterBranchForbiddenError);
    await expect(approveInterBranch(w.db, outsider, id)).rejects.toBeInstanceOf(InterBranchNotFoundError); // tak terlihat = 404
    await expect(approveInterBranch(w.db, approver, crypto.randomUUID())).rejects.toBeInstanceOf(InterBranchNotFoundError);
    expect(await journalsOf(id)).toHaveLength(0);
    const granted = makePrincipal({ userId: "gr", role: "STAFF", branches: [w.bl], grants: ["interbranch.approve"] });
    await expect(approveInterBranch(w.db, granted, id)).resolves.toMatchObject({ status: "COMPLETED" }); // GRANT menang atas role dasar
  });

  it("aksi berulang ditolak (409) tanpa posting ganda", async () => {
    const id = await propose();
    await approveInterBranch(w.db, approver, id);
    await expect(approveInterBranch(w.db, approver, id)).rejects.toBeInstanceOf(InterBranchStateChangedError);
    await expect(rejectInterBranch(w.db, approver, id, { reason: "terlambat menolak" })).rejects.toBeInstanceOf(InterBranchStateChangedError);
    await expect(cancelInterBranch(w.db, maker, id)).rejects.toBeInstanceOf(InterBranchStateChangedError);
    expect(await journalsOf(id)).toHaveLength(2);
  });

  it("periode ditutup SETELAH diajukan dan SEBELUM disetujui: ditolak, 0 jurnal, status tetap WAITING; penutupan periode diblokir selama menunggu", async () => {
    const id = await propose();
    const period = w.seed.periodId;
    await lockPeriod(w.db, period, testActor);
    await expect(closePeriod(w.db, period, testActor)).rejects.toBeInstanceOf(PeriodNotReadyToCloseError);
    await w.db("periods").update({ status: "CLOSED" }); // dilewati blocker (mis. data lama) -> posting tetap ditolak
    await expect(approveInterBranch(w.db, approver, id)).rejects.toBeInstanceOf(FiscalPeriodClosedError);
    expect(await journalsOf(id)).toHaveLength(0);
    expect((await txRow(id)).status).toBe("WAITING_APPROVAL");
    expect((await w.db("inter_branch_approvals").where({ transaction_id: id, kind: "POST" }).first()).status).toBe("WAITING");
  });

  it("kedaluwarsa: tidak dapat disetujui, ditandai EXPIRED + audit; tampil EXPIRED virtual saat dibaca", async () => {
    const id = (await proposeInterBranch(w.db, maker, input(), new Date("2026-01-10T00:00:00Z"))).id;
    const later = new Date("2026-03-01T00:00:00Z");
    expect((await getInterBranchDetail(w.db, approver, id, later)).status).toBe("EXPIRED");
    expect((await txRow(id)).status).toBe("WAITING_APPROVAL"); // membaca tidak menulis
    await expect(approveInterBranch(w.db, approver, id, {}, later)).rejects.toBeInstanceOf(InterBranchExpiredError);
    expect((await txRow(id)).status).toBe("EXPIRED");
    expect(await auditActions(id)).toContain("INTER_BRANCH_EXPIRED");
    expect(await journalsOf(id)).toHaveLength(0);
  });

  it("batas kedaluwarsa dibatasi batas backdate (D-11)", async () => {
    await w.db("company_profile").update({ max_backdate_days: 400 });
    const id = (await proposeInterBranch(w.db, maker, input({ transactionDate: "2026-01-15" }), new Date("2026-10-01T09:00:00"))).id;
    const approval = await w.db("inter_branch_approvals").where({ transaction_id: id }).first();
    expect(new Date(approval.expires_at).getTime()).toBeLessThanOrEqual(new Date(2027, 1, 19, 23, 59, 59, 999).getTime());
  });
});

describe("atomisitas: kegagalan di titik tulis mana pun membatalkan seluruh posting", () => {
  const injections: Array<[string, (ids: { bank: string; bl: string }) => string]> = [
    ["baris jurnal sisi TO (sisi FROM sudah diposting)", ({ bank }) => `CREATE TRIGGER inj BEFORE INSERT ON journal_entry_lines WHEN NEW.account_id = '${bank}' BEGIN SELECT RAISE(ABORT, 'inject'); END`],
    ["posting jurnal sisi TO", ({ bl }) => `CREATE TRIGGER inj BEFORE UPDATE OF status ON journal_entries WHEN NEW.status = 'POSTED' AND NEW.branch_id = '${bl}' BEGIN SELECT RAISE(ABORT, 'inject'); END`],
    ["audit POSTED", () => `CREATE TRIGGER inj BEFORE INSERT ON company_audit_log WHEN NEW.action = 'INTER_BRANCH_POSTED' BEGIN SELECT RAISE(ABORT, 'inject'); END`],
    ["audit COMPLETED", () => `CREATE TRIGGER inj BEFORE INSERT ON company_audit_log WHEN NEW.action = 'INTER_BRANCH_COMPLETED' BEGIN SELECT RAISE(ABORT, 'inject'); END`],
    ["audit APPROVED", () => `CREATE TRIGGER inj BEFORE INSERT ON company_audit_log WHEN NEW.action = 'INTER_BRANCH_APPROVED' BEGIN SELECT RAISE(ABORT, 'inject'); END`],
  ];

  for (const [name, ddl] of injections) {
    it(`gagal pada ${name}: tidak ada jurnal, status tetap WAITING, tidak ada audit keputusan; ulang setelah pulih menghasilkan tepat dua jurnal`, async () => {
      const id = await propose();
      await w.db.raw(ddl({ bank: acc.bank, bl: w.bl }));
      await expect(approveInterBranch(w.db, approver, id)).rejects.toThrow(/inject/);
      expect(await journalsOf(id)).toHaveLength(0);
      expect(await w.db("journal_entries").count({ c: "*" }).first()).toMatchObject({ c: 0 });
      expect(await txRow(id)).toMatchObject({ status: "WAITING_APPROVAL" });
      expect((await w.db("inter_branch_approvals").where({ transaction_id: id, kind: "POST" }).first()).status).toBe("WAITING");
      expect(await auditActions(id)).toEqual(["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED"]);
      expect(await w.db("company_audit_log").where("action", "like", "journal.%")).toHaveLength(0);
      await w.db.raw("DROP TRIGGER inj");
      await approveInterBranch(w.db, approver, id);
      expect(await journalsOf(id)).toHaveLength(2);
      expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    });
  }
});

describe("tolak, batalkan, siklus hidup cabang, dan flag", () => {
  it("tolak (alasan wajib) -> REJECTED tanpa jurnal; pengaju melihat alasan", async () => {
    const id = await propose();
    await expect(rejectInterBranch(w.db, approver, id, { reason: "pendek" })).rejects.toThrow(/minimal/);
    await rejectInterBranch(w.db, approver, id, { reason: "Nominal tidak sesuai dengan bukti setoran" });
    expect(await txRow(id)).toMatchObject({ status: "REJECTED" });
    expect(await journalsOf(id)).toHaveLength(0);
    const detail = await getInterBranchDetail(w.db, maker, id);
    expect(detail).toMatchObject({ status: "REJECTED", decisionReason: "Nominal tidak sesuai dengan bukti setoran" });
    expect(await auditActions(id)).toContain("INTER_BRANCH_REJECTED");
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("batal: pengaju atau OWNER; pihak lain/penerima tidak", async () => {
    const a = await propose();
    await expect(cancelInterBranch(w.db, approver, a)).rejects.toBeInstanceOf(InterBranchForbiddenError);
    await expect(cancelInterBranch(w.db, makePrincipal({ userId: "m2", role: "ACCOUNTANT", branches: [w.metro] }), a)).rejects.toBeInstanceOf(InterBranchForbiddenError);
    await cancelInterBranch(w.db, maker, a, { reason: "salah cabang" });
    expect(await txRow(a)).toMatchObject({ status: "CANCELLED" });
    const b = await propose();
    await cancelInterBranch(w.db, owner, b);
    expect(await txRow(b)).toMatchObject({ status: "CANCELLED" });
    expect(await auditActions(b)).toContain("INTER_BRANCH_CANCELLED");
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("cabang menjadi INACTIVE: pengajuan menunggu dibatalkan otomatis (audit), tidak ada jurnal", async () => {
    const id = await propose();
    await changeBranchStatus(w.db, w.bl, { to: "INACTIVE" }, testActor);
    expect(await txRow(id)).toMatchObject({ status: "CANCELLED" });
    expect((await w.db("company_audit_log").where({ entity_id: id, action: "INTER_BRANCH_CANCELLED" }).first()).reason).toMatch(/INACTIVE/);
    await expect(approveInterBranch(w.db, approver, id)).rejects.toBeInstanceOf(InterBranchStateChangedError);
    expect(await journalsOf(id)).toHaveLength(0);
  });

  it("K-3: flag tidak dapat dimatikan saat ada pengajuan menunggu (pesan jelas); setelah diselesaikan boleh", async () => {
    const id = await propose();
    await expect(setMultiBranchEnabled(w.db, false, testActor)).rejects.toBeInstanceOf(MultiBranchHasPendingInterBranchError);
    await expect(setMultiBranchEnabled(w.db, false, testActor)).rejects.toThrow(/1 transaksi antar-cabang yang menunggu/);
    expect(await txRow(id)).toMatchObject({ status: "WAITING_APPROVAL" });
    expect((await w.db("company_profile").first()).multi_branch_enabled).toBe(1);
    await cancelInterBranch(w.db, maker, id);
    await expect(setMultiBranchEnabled(w.db, false, testActor)).resolves.toBeUndefined();
  });

  it("K-3: pengajuan yang sudah kedaluwarsa ditandai EXPIRED lebih dulu sehingga tidak menghalangi mematikan flag", async () => {
    const id = (await proposeInterBranch(w.db, maker, input(), new Date("2026-01-10T00:00:00Z"))).id;
    await expect(setMultiBranchEnabled(w.db, false, testActor)).resolves.toBeUndefined();
    expect(await txRow(id)).toMatchObject({ status: "EXPIRED" });
    expect(await auditActions(id)).toContain("INTER_BRANCH_EXPIRED");
  });

  it("K-3: permintaan pembalikan yang menunggu juga menghalangi", async () => {
    const id = await propose();
    await approveInterBranch(w.db, approver, id);
    await requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" });
    await expect(setMultiBranchEnabled(w.db, false, testActor)).rejects.toThrow(/pembalikan yang menunggu/);
    await cancelInterBranchReversal(w.db, maker, id);
    await expect(setMultiBranchEnabled(w.db, false, testActor)).resolves.toBeUndefined();
  });

  it("K-3: flag OFF -> semua aksi/baca 404 (InterBranchDisabledError); data tetap; menyalakan lagi memulihkan", async () => {
    const done = await propose();
    await approveInterBranch(w.db, approver, done);
    await setMultiBranchEnabled(w.db, false, testActor);
    await expect(proposeInterBranch(w.db, maker, input())).rejects.toBeInstanceOf(InterBranchDisabledError);
    await expect(approveInterBranch(w.db, approver, done)).rejects.toBeInstanceOf(InterBranchDisabledError);
    await expect(listInterBranch(w.db, maker)).rejects.toBeInstanceOf(InterBranchDisabledError);
    await expect(getInterBranchDetail(w.db, maker, done)).rejects.toBeInstanceOf(InterBranchDisabledError);
    await setMultiBranchEnabled(w.db, true, testActor);
    expect((await getInterBranchDetail(w.db, maker, done)).status).toBe("COMPLETED");
  });

  it("pengaturan masa berlaku: hanya OWNER, 1-90 hari, diaudit", async () => {
    await expect(setInterBranchExpiryDays(w.db, admin, 7)).rejects.toBeInstanceOf(InterBranchForbiddenError);
    await expect(setInterBranchExpiryDays(w.db, owner, 0)).rejects.toBeInstanceOf(InterBranchValidationError);
    await expect(setInterBranchExpiryDays(w.db, owner, 91)).rejects.toBeInstanceOf(InterBranchValidationError);
    await setInterBranchExpiryDays(w.db, owner, 30);
    expect((await w.db("company_profile").first()).inter_branch_expiry_days).toBe(30);
    expect(await w.db("company_audit_log").where({ action: "INTER_BRANCH_SETTINGS_CHANGED" })).toHaveLength(1);
  });
});

describe("reversal berpasangan", () => {
  const completed = async () => {
    const id = await propose();
    await approveInterBranch(w.db, approver, id);
    return id;
  };

  it("minta (alasan wajib) -> lawan menyetujui -> 4 jurnal, asli REVERSED, saldo kembali, tidak ada jurnal asli yang diubah isinya", async () => {
    const id = await completed();
    const originals = await journalsOf(id);
    const snapshot = await Promise.all(originals.map(async (j: any) => ({ id: j.id, entry_date: j.entry_date, reference_no: j.reference_no, branch_id: j.branch_id, lines: await linesOf(j.id) })));
    await expect(requestInterBranchReversal(w.db, maker, id, { reason: "x" })).rejects.toThrow(/minimal/);
    await requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" });
    expect(await txRow(id)).toMatchObject({ status: "COMPLETED", reversal_state: "REVERSAL_WAITING" });
    await expect(approveInterBranchReversal(w.db, maker, id)).rejects.toBeInstanceOf(InterBranchForbiddenError); // pemohon tidak berwenang di cabang lawan
    await expect(approveInterBranchReversal(w.db, makePrincipal({ userId: "x", role: "ACCOUNTANT", branches: [w.metro] }), id)).rejects.toBeInstanceOf(InterBranchForbiddenError); // pihak di sisi yang sama dengan pemohon
    await approveInterBranchReversal(w.db, approver, id);
    expect(await txRow(id)).toMatchObject({ status: "COMPLETED", reversal_state: "REVERSED" });
    const all = await journalsOf(id);
    expect(all).toHaveLength(4);
    expect(all.filter((j: any) => j.inter_branch_leg === "REVERSAL")).toHaveLength(2);
    for (const j of snapshot) {
      const now = await w.db("journal_entries").where({ id: j.id }).first();
      expect(now).toMatchObject({ status: "REVERSED", entry_date: j.entry_date, reference_no: j.reference_no, branch_id: j.branch_id });
      expect(await linesOf(j.id)).toEqual(j.lines);
    }
    const net = await w.db("journal_entry_lines as l").join("journal_entries as j", "j.id", "l.journal_entry_id").where("j.inter_branch_transaction_id", id).groupBy("l.account_id").select("l.account_id", w.db.raw("round(sum(l.debit) - sum(l.credit), 2) as net"));
    expect(net.every((r: any) => Number(r.net) === 0)).toBe(true);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    expect(await auditActions(id)).toEqual(expect.arrayContaining(["INTER_BRANCH_REVERSAL_REQUESTED", "INTER_BRANCH_REVERSAL_APPROVED", "INTER_BRANCH_REVERSAL_POSTED"]));
    await expect(requestInterBranchReversal(w.db, maker, id, { reason: "membalik lagi, tidak boleh" })).rejects.toBeInstanceOf(InterBranchStateChangedError);
    await expect(approveInterBranchReversal(w.db, approver, id)).rejects.toBeInstanceOf(InterBranchStateChangedError);
  });

  it("OWNER meminta dan menyetujui pembalikannya sendiri; ADMIN yang memegang kedua cabang tidak", async () => {
    const a = await completed();
    await requestInterBranchReversal(w.db, admin, a, { reason: "Salah cabang tujuan" });
    await expect(approveInterBranchReversal(w.db, admin, a)).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
    await cancelInterBranchReversal(w.db, admin, a);
    const b = await completed();
    await requestInterBranchReversal(w.db, owner, b, { reason: "Salah cabang tujuan" });
    await approveInterBranchReversal(w.db, owner, b);
    expect((await txRow(b)).reversal_state).toBe("REVERSED");
  });

  it("tolak / batalkan / kedaluwarsa: kembali ke NOT_REVERSED tanpa jurnal baru; dapat diminta lagi", async () => {
    const id = await completed();
    await requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" });
    await rejectInterBranchReversal(w.db, approver, id, { reason: "Setoran sudah benar, tidak perlu" });
    expect((await txRow(id)).reversal_state).toBe("NOT_REVERSED");
    await requestInterBranchReversal(w.db, maker, id, { reason: "Minta ulang pembalikan" });
    await expect(cancelInterBranchReversal(w.db, approver, id)).rejects.toBeInstanceOf(InterBranchForbiddenError);
    await cancelInterBranchReversal(w.db, maker, id);
    expect((await txRow(id)).reversal_state).toBe("NOT_REVERSED");
    const base = new Date("2026-02-01T00:00:00Z");
    await requestInterBranchReversal(w.db, maker, id, { reason: "Minta ulang lagi" }, base);
    await expect(approveInterBranchReversal(w.db, approver, id, {}, new Date("2026-04-01T00:00:00Z"))).rejects.toBeInstanceOf(InterBranchStateChangedError);
    expect((await txRow(id)).reversal_state).toBe("NOT_REVERSED");
    expect(await journalsOf(id)).toHaveLength(2);
    expect(await auditActions(id)).toEqual(expect.arrayContaining(["INTER_BRANCH_REVERSAL_REJECTED", "INTER_BRANCH_REVERSAL_CANCELLED", "INTER_BRANCH_REVERSAL_EXPIRED"]));
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("periode asal ditutup: pembalikan ditolak jelas; jurnal asli utuh", async () => {
    const id = await completed();
    await requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" });
    await w.db("periods").update({ status: "CLOSED" });
    await expect(approveInterBranchReversal(w.db, approver, id)).rejects.toBeInstanceOf(FiscalPeriodClosedError);
    expect(await txRow(id)).toMatchObject({ reversal_state: "REVERSAL_WAITING" });
    expect(await journalsOf(id)).toHaveLength(2);
  });

  it("meminta pembalikan pada periode yang sudah tidak OPEN ditolak sejak awal dengan arahan membuat transaksi koreksi", async () => {
    const id = await completed();
    await w.db("periods").update({ status: "CLOSED" });
    await expect(requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" })).rejects.toThrow(/transaksi koreksi/);
    expect(await txRow(id)).toMatchObject({ reversal_state: "NOT_REVERSED" });
  });

  it("atomik: gagal pada jurnal reversal sisi TO membatalkan seluruh pembalikan", async () => {
    const id = await completed();
    await requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" });
    await w.db.raw(`CREATE TRIGGER inj BEFORE INSERT ON journal_entries WHEN NEW.inter_branch_leg = 'REVERSAL' AND NEW.inter_branch_side = 'TO' BEGIN SELECT RAISE(ABORT, 'inject'); END`);
    await expect(approveInterBranchReversal(w.db, approver, id)).rejects.toThrow(/inject/);
    expect(await journalsOf(id)).toHaveLength(2);
    expect((await journalsOf(id)).every((j: any) => j.status === "POSTED")).toBe(true);
    expect(await txRow(id)).toMatchObject({ reversal_state: "REVERSAL_WAITING" });
    await w.db.raw("DROP TRIGGER inj");
    await approveInterBranchReversal(w.db, approver, id);
    expect(await journalsOf(id)).toHaveLength(4);
  });
});

describe("daftar, detail, ringkasan: visibilitas per cabang dan DTO per sisi", () => {
  it("pengguna hanya melihat transaksi yang cabang asal/tujuannya terakses; kotak masuk/keluar; filter dan pencarian", async () => {
    const a = await propose(maker, { description: "Setoran alfa" });
    await propose(maker, { description: "Setoran beta", amount: 250_000 });
    expect((await listInterBranch(w.db, maker)).total).toBe(2);
    expect((await listInterBranch(w.db, approver)).total).toBe(2);
    expect((await listInterBranch(w.db, outsider)).total).toBe(0);
    expect((await listInterBranch(w.db, approver, { box: "in" })).total).toBe(2);
    expect((await listInterBranch(w.db, approver, { box: "out" })).total).toBe(0);
    expect((await listInterBranch(w.db, maker, { box: "out" })).total).toBe(2);
    expect((await listInterBranch(w.db, maker, { search: "alfa" })).items.map((i) => i.id)).toEqual([a]);
    expect((await listInterBranch(w.db, maker, { search: "%" })).total).toBe(0); // wildcard di-escape
    expect((await listInterBranch(w.db, maker, { status: "WAITING_APPROVAL", type: "TRANSFER_KAS", fromBranchId: w.metro, toBranchId: w.bl, fromDate: "2026-01-01", toDate: "2026-01-31" })).total).toBe(2);
    expect((await listInterBranch(w.db, maker, { status: "COMPLETED" })).total).toBe(0);
    expect((await listInterBranch(w.db, maker, { pageSize: 1, page: 2 })).items).toHaveLength(1);
    expect(await getInterBranchSummary(w.db, approver)).toEqual({ incomingWaiting: 2, outgoingWaiting: 0 });
    expect(await getInterBranchSummary(w.db, maker)).toEqual({ incomingWaiting: 0, outgoingWaiting: 2 });
    expect(await getInterBranchSummary(w.db, outsider)).toEqual({ incomingWaiting: 0, outgoingWaiting: 0 });
    await approveInterBranch(w.db, approver, a);
    expect(await getInterBranchSummary(w.db, approver)).toEqual({ incomingWaiting: 1, outgoingWaiting: 0 });
  });

  it("detail tak terlihat = 404 identik dengan tidak ada; DTO per sisi tidak membocorkan akun/jurnal sisi lawan", async () => {
    const id = await propose();
    await approveInterBranch(w.db, approver, id);
    await expect(getInterBranchDetail(w.db, outsider, id)).rejects.toBeInstanceOf(InterBranchNotFoundError);
    await expect(getInterBranchDetail(w.db, outsider, crypto.randomUUID())).rejects.toBeInstanceOf(InterBranchNotFoundError);
    const asReceiver = await getInterBranchDetail(w.db, approver, id);
    expect(asReceiver.fromAccount).toBeNull();
    expect(asReceiver.toAccountConfirmed).toMatchObject({ id: acc.bank });
    expect(asReceiver.journals.find((j) => j.side === "FROM")).toMatchObject({ journalId: null, lines: null });
    expect(asReceiver.journals.find((j) => j.side === "TO")!.lines).toHaveLength(2);
    const asSender = await getInterBranchDetail(w.db, maker, id);
    expect(asSender.fromAccount).toMatchObject({ id: acc.kas });
    expect(asSender.toAccountSuggested).toBeNull();
    expect(asSender.journals.find((j) => j.side === "TO")).toMatchObject({ journalId: null, lines: null });
    const both = await getInterBranchDetail(w.db, admin, id);
    expect(both.fromAccount).not.toBeNull();
    expect(both.journals.every((j) => j.lines !== null)).toBe(true);
    expect(both.history.map((h) => h.action)).toContain("INTER_BRANCH_COMPLETED");
  });

  it("kemampuan (UX) konsisten dengan aturan server: selfApprovalBlocked untuk non-OWNER, tombol OWNER, pembalikan", async () => {
    const id = await propose(admin);
    expect((await getInterBranchDetail(w.db, admin, id)).capabilities).toMatchObject({ canApprove: false, selfApprovalBlocked: true, canCancel: true });
    expect((await getInterBranchDetail(w.db, approver, id)).capabilities).toMatchObject({ canApprove: true, canReject: true, selfApprovalBlocked: false, canCancel: false });
    expect((await getInterBranchDetail(w.db, staff, id)).capabilities).toMatchObject({ canApprove: false });
    const own = await propose(owner);
    expect((await getInterBranchDetail(w.db, owner, own)).capabilities).toMatchObject({ canApprove: true, selfApprovalBlocked: false });
  });
});

describe("konkurensi: dua koneksi ke satu file, satu pemenang, tanpa SQLITE_BUSY dan tanpa posting ganda", () => {
  let other: Knex;
  beforeEach(() => {
    other = createCompanyDb((w.db.client.config.connection as { filename: string }).filename);
  });
  afterEach(async () => {
    await other.destroy();
  });

  const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as Error).constructor.name);

  it("dua penyetuju bersamaan", async () => {
    const id = await propose();
    const second = makePrincipal({ userId: "approver-2", role: "ACCOUNTANT", branches: [w.bl] });
    const results = await Promise.all([outcome(approveInterBranch(w.db, approver, id)), outcome(approveInterBranch(other, second, id))]);
    expect(results.sort()).toEqual(["InterBranchStateChangedError", "ok"]);
    expect(await journalsOf(id)).toHaveLength(2);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("setujui vs batalkan bersamaan: tepat satu menang", async () => {
    const id = await propose();
    const results = await Promise.all([outcome(approveInterBranch(w.db, approver, id)), outcome(cancelInterBranch(other, maker, id))]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results).not.toContain("InterBranchBusyError");
    const tx = await txRow(id);
    expect((await journalsOf(id)).length).toBe(tx.status === "COMPLETED" ? 2 : 0);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("dua permintaan reversal dan dua persetujuan reversal bersamaan", async () => {
    const id = await propose();
    await approveInterBranch(w.db, approver, id);
    const req = await Promise.all([outcome(requestInterBranchReversal(w.db, maker, id, { reason: "Salah input nominal setoran" })), outcome(requestInterBranchReversal(other, owner, id, { reason: "Salah input nominal setoran" }))]);
    expect(req.sort()).toEqual(["InterBranchStateChangedError", "ok"]);
    const second = makePrincipal({ userId: "approver-2", role: "ACCOUNTANT", branches: [w.bl, w.metro] });
    const decide = await Promise.all([outcome(approveInterBranchReversal(w.db, approver, id)), outcome(approveInterBranchReversal(other, second, id))]);
    expect(decide.filter((r) => r === "ok")).toHaveLength(1);
    expect(await journalsOf(id)).toHaveLength(4);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("pengajuan ganda dengan kunci idempotensi sama (klik ganda paralel): satu transaksi", async () => {
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([proposeInterBranch(w.db, maker, input({ idempotencyKey: key })), proposeInterBranch(other, maker, input({ idempotencyKey: key }))]);
    expect(a.id).toBe(b.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await w.db("inter_branch_transactions")).toHaveLength(1);
  });

  it("nomor transaksi unik pada banyak pengajuan paralel dari dua koneksi", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => proposeInterBranch(i % 2 ? other : w.db, maker, input())));
    expect(new Set(results.map((r) => r.transactionNo)).size).toBe(6);
  });

  it("SQLITE_BUSY dipetakan menjadi InterBranchBusyError (aman diulang) bila penulis lain di luar antrean menahan kunci", async () => {
    const id = await propose();
    const holder = await other.transaction();
    try {
      await holder("company_profile").update({ updated_at: new Date().toISOString() }); // menahan kunci tulis
      const busyConn = createCompanyDb((w.db.client.config.connection as { filename: string }).filename);
      await busyConn.raw("PRAGMA busy_timeout = 0");
      await expect(approveInterBranch(busyConn, approver, id)).rejects.toBeInstanceOf(InterBranchBusyError);
      await busyConn.destroy();
    } finally {
      await holder.rollback();
    }
    expect(await journalsOf(id)).toHaveLength(0);
    await approveInterBranch(w.db, approver, id); // setelah kunci dilepas, ulang aman: tepat dua jurnal
    expect(await journalsOf(id)).toHaveLength(2);
  });
});
