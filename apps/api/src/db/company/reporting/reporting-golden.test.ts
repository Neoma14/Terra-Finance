import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshCompanyDb, addBranch, headOfficeId, testActor } from "../__fixtures__/branch-test-helpers.js";
import { createDraftJournalEntry, postJournalEntry, reverseJournalEntry } from "../journal-service.js";
import { createCounterparty, getCounterpartyBalances } from "../counterparty-service.js";
import { getBalanceSheet } from "./balance-sheet-service.js";
import { getIncomeStatement } from "./income-statement-service.js";
import { getEquityStatement } from "./equity-statement-service.js";
import { getCashFlowStatement } from "./cash-flow-service.js";
import { getTrialBalance } from "../trial-balance-service.js";
import { getAccountLedgerByRange } from "../ledger-service.js";
import { getDashboardSummary } from "../dashboard-service.js";

/**
 * PHASE 5.0 -- GOLDEN MASTER dalam suite (deterministik, ±120 jurnal, 3 cabang, akun kontra, kas, hutang/piutang, reversal).
 *
 * Dua jaminan:
 *  (1) SUMBER TRANSAKSI -> ANGKA: setiap angka layanan dibandingkan dengan oracle independen yang menghitung langsung dari baris
 *      jurnal (SQL), bukan lewat layanan laporan. Ini juga menetapkan HASIL YANG DIHARAPKAN PER CAKUPAN CABANG (perusahaan, tiap cabang,
 *      gabungan terpilih) yang harus dipenuhi layanan bercakupan di 5A/5B.
 *  (2) SNAPSHOT: hash keluaran laporan perusahaan-penuh dikunci di `__golden__/reporting-small.snapshot.json`. Phase 5A (dengan flag OFF
 *      atau cakupan seluruh perusahaan) HARUS menghasilkan hash yang sama. Perbarui hanya dengan UPDATE_GOLDEN=1 dan persetujuan.
 */

const SNAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "__golden__", "reporting-small.snapshot.json");
const STATUS = ["POSTED", "REVERSED"];
const FLOW = new Set(["REVENUE", "EXPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"]);
const PROFIT_SIGN: Record<string, number> = { REVENUE: 1, OTHER_INCOME: 1, COGS: -1, EXPENSE: -1, OTHER_EXPENSE: -1 };
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
/** Buang id acak (jurnal/entri) agar hash stabil; id akun, id periode, dan kode tetap (deterministik). */
const stable = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "journalEntryId" || k === "counterpartyId" || k === "createdAt" || k === "id" && typeof x === "string" && x.length === 36 ? undefined : x)));

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Acc { id: string; code: string; type: string; nb: "debit" | "credit"; tnb: "debit" | "credit"; isCash: boolean }

class Oracle {
  constructor(private db: Knex, private accounts: Acc[], private branchIds: string[] | null) {}
  private base() {
    const q = this.db("journal_entry_lines as jel").join("journal_entries as je", "je.id", "jel.journal_entry_id").whereIn("je.status", STATUS);
    return this.branchIds ? q.whereIn("je.branch_id", this.branchIds) : q;
  }
  async sum(a: Acc, from: string | null, to: string | null, inclusive = true, periodId?: string) {
    let q = this.base().where("jel.account_id", a.id);
    if (from) q = q.andWhere("je.entry_date", ">=", from);
    if (to) q = q.andWhere("je.entry_date", inclusive ? "<=" : "<", to);
    if (periodId) q = q.andWhere("je.period_id", periodId);
    const r = (await q.select(this.db.raw("COALESCE(SUM(jel.debit),0) d"), this.db.raw("COALESCE(SUM(jel.credit),0) c"), this.db.raw("COUNT(*) n")).first()) as any;
    return { d: Number(r.d), c: Number(r.c), n: Number(r.n) };
  }
  signed = (a: Acc, d: number, c: number) => (a.nb === "debit" ? d - c : c - d);
  canonSign = (a: Acc, own: number) => (a.nb === a.tnb ? own : -own);
  async balanceSheet(toDate: string) {
    const t: Record<string, number> = { ASSET: 0, LIABILITY: 0, EQUITY: 0 };
    const per: Record<string, Record<string, number>> = { ASSET: {}, LIABILITY: {}, EQUITY: {} };
    let bridge = 0;
    for (const a of this.accounts) {
      const s = await this.sum(a, null, toDate);
      const own = this.signed(a, s.d, s.c);
      if (a.type in t && own !== 0) { const amt = this.canonSign(a, own); t[a.type] += amt; per[a.type][a.code] = amt; }
      if (FLOW.has(a.type)) bridge += PROFIT_SIGN[a.type] * this.canonSign(a, own);
    }
    return { assets: t.ASSET, liabilities: t.LIABILITY, equity: t.EQUITY + bridge, bridge, per, difference: t.ASSET - (t.LIABILITY + t.EQUITY + bridge) };
  }
  async incomeStatement(from: string, to: string) {
    const t: Record<string, number> = {};
    for (const a of this.accounts.filter((x) => FLOW.has(x.type))) {
      const s = await this.sum(a, from, to);
      const own = this.signed(a, s.d, s.c);
      if (own !== 0) t[a.type] = (t[a.type] ?? 0) + this.canonSign(a, own);
    }
    const g = (k: string) => t[k] ?? 0;
    const gross = g("REVENUE") - g("COGS");
    const op = gross - g("EXPENSE");
    return { gross, op, net: op + g("OTHER_INCOME") - g("OTHER_EXPENSE") };
  }
  async trialBalanceSigned(periodId: string, start: string) {
    const out: Record<string, number> = {};
    let bridge = 0;
    for (const a of this.accounts) {
      const mv = await this.sum(a, null, null, true, periodId);
      const op = FLOW.has(a.type) ? 0 : (() => 0)();
      const opening = FLOW.has(a.type) ? 0 : await this.sum(a, null, start, false).then((s) => this.signed(a, s.d, s.c));
      void op;
      const ending = opening + this.signed(a, mv.d, mv.c);
      // saldo bertanda dalam arah debit: akun debit-normal => ending; kredit-normal => -ending
      const asDebitMinusCredit = a.nb === "debit" ? ending : -ending;
      if (asDebitMinusCredit !== 0 || mv.n > 0) out[a.code] = asDebitMinusCredit;
      if (FLOW.has(a.type)) {
        const s = await this.sum(a, null, start, false);
        bridge += PROFIT_SIGN[a.type] * this.canonSign(a, this.signed(a, s.d, s.c));
      }
    }
    return { signed: out, bridge };
  }
  async cash(from: string, to: string) {
    let beginning = 0, ending = 0;
    for (const a of this.accounts.filter((x) => x.isCash)) {
      const b = await this.sum(a, null, from, false); const e = await this.sum(a, null, to, true);
      beginning += this.signed(a, b.d, b.c); ending += this.signed(a, e.d, e.c);
    }
    return { beginning, ending, net: ending - beginning };
  }
  async ledger(a: Acc, from: string, to: string) {
    const o = FLOW.has(a.type) ? 0 : await this.sum(a, null, from, false).then((s) => this.signed(a, s.d, s.c));
    const s = await this.sum(a, from, to);
    return { opening: o, ending: o + this.signed(a, s.d, s.c), lines: s.n };
  }
}

describe("Phase 5.0: golden master laporan (deterministik) + oracle sumber transaksi + hasil yang diharapkan per cakupan", () => {
  let db: Knex;
  let accounts: Acc[];
  let byCode: Record<string, Acc>;
  let branchIds: { hq: string; metro: string; bl: string };
  let periods: Array<{ id: string; label: string; start: string; end: string }>;
  let vendorId: string;
  let customerId: string;
  const MAX = "2026-06-30";

  beforeAll(async () => {
    db = await freshCompanyDb();
    const types = Object.fromEntries((await db("account_types").select("id", "code", "normal_balance")).map((t: any) => [t.code, t]));
    const mk = async (code: string, name: string, type: string, nb: "debit" | "credit", extra: Record<string, unknown> = {}) => {
      const id = `acc-${code}`;
      await db("accounts").insert({ id, code, name, account_type_id: types[type].id, normal_balance: nb, ...extra });
      return { id, code, type, nb, tnb: types[type].normal_balance, isCash: Boolean(extra.is_cash) } as Acc;
    };
    accounts = [
      await mk("1100", "Kas", "ASSET", "debit", { is_cash: true }),
      await mk("1110", "Bank", "ASSET", "debit", { is_cash: true }),
      await mk("1200", "Piutang Usaha", "ASSET", "debit", { subledger_type: "receivable" }),
      await mk("1300", "Persediaan", "ASSET", "debit", { cash_flow_activity: "operating" }),
      await mk("1500", "Aset Tetap", "ASSET", "debit", { cash_flow_activity: "investing" }),
      await mk("1590", "Akumulasi Penyusutan", "ASSET", "credit"), // kontra-akun
      await mk("2100", "Hutang Usaha", "LIABILITY", "credit", { subledger_type: "payable" }),
      await mk("2500", "Hutang Bank", "LIABILITY", "credit", { cash_flow_activity: "financing" }),
      await mk("3100", "Modal Disetor", "EQUITY", "credit", { cash_flow_activity: "financing" }),
      await mk("3900", "Dividen", "EQUITY", "debit", { cash_flow_activity: "financing" }), // kontra-ekuitas
      await mk("4100", "Penjualan", "REVENUE", "credit"),
      await mk("4190", "Retur Penjualan", "REVENUE", "debit"), // kontra-pendapatan
      await mk("5100", "HPP", "COGS", "debit"),
      await mk("6100", "Beban Gaji", "EXPENSE", "debit"),
      await mk("6200", "Beban Penyusutan", "EXPENSE", "debit"),
      await mk("7100", "Pendapatan Lain", "OTHER_INCOME", "credit"),
      await mk("8100", "Beban Lain", "OTHER_EXPENSE", "debit"),
    ];
    byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
    const metro = await addBranch(db, "METRO", "Cabang Metro");
    const bl = await addBranch(db, "BL", "Bandar Lampung");
    branchIds = { hq: await headOfficeId(db), metro, bl };
    periods = [];
    for (let m = 1; m <= 6; m++) {
      const mm = String(m).padStart(2, "0");
      const end = new Date(Date.UTC(2026, m, 0)).getUTCDate();
      const id = `per-2026-${mm}`;
      await db("periods").insert({ id, label: `2026-${mm}`, start_date: `2026-${mm}-01`, end_date: `2026-${mm}-${end}`, period_type: "month", fiscal_year: 2026, status: "OPEN" });
      periods.push({ id, label: `2026-${mm}`, start: `2026-${mm}-01`, end: `2026-${mm}-${end}` });
    }
    vendorId = (await createCounterparty(db, { type: "vendor", code: "V1", name: "Vendor Satu" }, testActor)).id;
    customerId = (await createCounterparty(db, { type: "customer", code: "C1", name: "Pelanggan Satu" }, testActor)).id;

    // ---- jurnal deterministik
    const rand = rng(20260607);
    const branchList = [branchIds.hq, branchIds.metro, branchIds.bl];
    const A = (c: string) => byCode[c].id;
    let n = 0;
    const post = async (branchId: string, date: string, period: string, lines: Array<[string, number, number, string?]>) => {
      n += 1;
      const { id } = await createDraftJournalEntry(db, {
        entryDate: date, periodId: period, referenceNo: `GM-${String(n).padStart(4, "0")}`, branchId,
        lines: lines.map(([c, d, cr, cp]) => ({ accountId: A(c), debit: d, credit: cr, counterpartyId: cp ?? null })),
      }, testActor);
      await postJournalEntry(db, { journalEntryId: id }, testActor);
      return id;
    };
    // modal & pinjaman & dividen hanya di Pusat (CENTRAL), aset tetap di Pusat
    await post(branchIds.hq, "2026-01-02", "per-2026-01", [["1100", 50_000_000, 0], ["1110", 150_000_000, 0], ["3100", 0, 200_000_000]]);
    await post(branchIds.hq, "2026-01-05", "per-2026-01", [["1500", 60_000_000, 0], ["2500", 0, 60_000_000]]);
    for (const b of [branchIds.metro, branchIds.bl]) await post(b, "2026-01-06", "per-2026-01", [["1100", 5_000_000, 0], ["1300", 20_000_000, 0], ["2100", 0, 25_000_000, vendorId]]);
    const reversible: string[] = [];
    for (let i = 0; i < 100; i++) {
      const p = periods[Math.min(5, Math.floor(i / 17))];
      const day = String(1 + Math.floor(rand() * 27)).padStart(2, "0");
      const date = `${p.start.slice(0, 8)}${day}`;
      const b = branchList[Math.floor(rand() * 3)];
      const amt = (1 + Math.floor(rand() * 90)) * 100_000;
      const kind = Math.floor(rand() * 9);
      let id: string;
      if (kind === 0) id = await post(b, date, p.id, [["1100", amt, 0], ["4100", 0, amt]]);
      else if (kind === 1) id = await post(b, date, p.id, [["1200", amt, 0, customerId], ["4100", 0, amt]]);
      else if (kind === 2) id = await post(b, date, p.id, [["1110", amt, 0], ["1200", 0, amt, customerId]]);
      else if (kind === 3) id = await post(b, date, p.id, [["5100", amt, 0], ["1300", 0, amt]]);
      else if (kind === 4) id = await post(b, date, p.id, [["6100", amt, 0], ["1110", 0, amt]]);
      else if (kind === 5) id = await post(b, date, p.id, [["2100", amt, 0, vendorId], ["1110", 0, amt]]);
      else if (kind === 6) id = await post(b, date, p.id, [["6200", amt / 10, 0], ["1590", 0, amt / 10]]);
      else if (kind === 7) id = await post(b, date, p.id, [["4190", amt / 5, 0], ["1100", 0, amt / 5]]);
      else id = await post(b, date, p.id, [["8100", amt / 4, 0], ["7100", 0, amt / 4 + 100_000], ["1110", 0, 0]]).catch(async () => post(b, date, p.id, [["8100", amt / 4, 0], ["1100", 0, amt / 4]]));
      if (i % 23 === 0) reversible.push(id);
    }
    await post(branchIds.hq, "2026-05-20", "per-2026-05", [["3900", 3_000_000, 0], ["1110", 0, 3_000_000]]);
    await post(branchIds.hq, "2026-06-10", "per-2026-06", [["1500", 12_000_000, 0], ["1110", 0, 12_000_000]]);
    for (const [i, jid] of reversible.entries()) await reverseJournalEntry(db, { journalEntryId: jid, reversalReferenceNo: `GM-REV-${i}`, reason: "golden master" }, testActor);
  });

  afterAll(async () => {
    await db.destroy();
  });

  const scopes = () => ({ company: null as string[] | null, hq: [branchIds.hq], metro: [branchIds.metro], bl: [branchIds.bl], "metro+bl": [branchIds.metro, branchIds.bl] });

  it("dataset memuat variasi yang dibutuhkan (≥100 jurnal, 3 cabang, REVERSED, kontra-akun, kas, counterparty)", async () => {
    const total = Number(((await db("journal_entries").count({ c: "*" }).first()) as any).c);
    expect(total).toBeGreaterThanOrEqual(100);
    expect(Number(((await db("journal_entries").where({ status: "REVERSED" }).count({ c: "*" }).first()) as any).c)).toBeGreaterThan(0);
    expect(new Set((await db("journal_entries").select("branch_id")).map((r: any) => r.branch_id)).size).toBe(3);
  });

  it("SUMBER -> ANGKA: Neraca, Laba Rugi, Neraca Saldo, Buku Besar, Arus Kas, Counterparty = oracle (perusahaan)", async () => {
    const o = new Oracle(db, accounts, null);
    const bs = await getBalanceSheet(db, "2026-01-01", MAX);
    const ob = await o.balanceSheet(MAX);
    expect([bs.totalAssets, bs.totalLiabilities, bs.totalEquity, bs.balanceDifference]).toEqual([ob.assets, ob.liabilities, ob.equity, 0]);
    for (const [key, type] of [["assets", "ASSET"], ["liabilities", "LIABILITY"], ["equity", "EQUITY"]] as const) {
      const got = Object.fromEntries(bs[key].lines.filter((l) => l.accountCode !== "RE-BRIDGE").map((l) => [l.accountCode, l.amount]));
      expect(got).toEqual(ob.per[type]);
    }
    const is = await getIncomeStatement(db, "2026-01-01", MAX);
    const oi = await o.incomeStatement("2026-01-01", MAX);
    expect([is.netProfit, is.grossProfit, is.operatingProfit]).toEqual([oi.net, oi.gross, oi.op]);
    for (const p of periods) {
      const tb = await getTrialBalance(db, p.id);
      const ot = await o.trialBalanceSigned(p.id, p.start);
      const got: Record<string, number> = {};
      for (const r of tb.rows) if (!r.isBridge) got[r.code] = r.debit - r.credit;
      expect(got).toEqual(ot.signed);
      expect(tb.isBalanced).toBe(true);
    }
    const cf = await getCashFlowStatement(db, "2026-02-01", MAX);
    const oc = await o.cash("2026-02-01", MAX);
    expect([cf.beginningCash, cf.endingCash, cf.netChangeInCash]).toEqual([oc.beginning, oc.ending, oc.net]);
    expect(Math.round((cf.operating.amount + cf.investing.amount + cf.financing.amount + cf.unclassifiedAmount) * 100)).toBe(Math.round(cf.netChangeInCash * 100));
    const led = await getAccountLedgerByRange(db, byCode["1100"].id, "2026-02-01", MAX);
    const ol = await o.ledger(byCode["1100"], "2026-02-01", MAX);
    expect([led.openingBalance, led.endingBalance, led.lines.length]).toEqual([ol.opening, ol.ending, ol.lines]);
    for (const t of ["vendor", "customer"] as const) {
      const bal = await getCounterpartyBalances(db, t);
      const sub = t === "vendor" ? "2100" : "1200";
      const a = byCode[sub];
      const s = await new Oracle(db, accounts, null).sum(a, null, null);
      expect(bal.reduce((x, r) => x + r.balance, 0)).toBe(new Oracle(db, accounts, null).signed(a, s.d, s.c));
    }
  });

  it("HASIL YANG DIHARAPKAN PER CAKUPAN: Σ cabang = perusahaan; tiap neraca cabang seimbang; gabungan terpilih = jumlah anggotanya", async () => {
    const S = scopes();
    const res: Record<string, Awaited<ReturnType<Oracle["balanceSheet"]>>> = {};
    for (const [k, ids] of Object.entries(S)) res[k] = await new Oracle(db, accounts, ids).balanceSheet(MAX);
    for (const [k, v] of Object.entries(res)) expect(v.difference, `neraca ${k} seimbang`).toBe(0);
    const sum = (f: (x: (typeof res)[string]) => number) => f(res.hq) + f(res.metro) + f(res.bl);
    expect(sum((x) => x.assets)).toBe(res.company.assets);
    expect(sum((x) => x.liabilities)).toBe(res.company.liabilities);
    expect(sum((x) => x.equity)).toBe(res.company.equity);
    expect(res["metro+bl"].assets).toBe(res.metro.assets + res.bl.assets);
    const isum = async (from: string, to: string) => {
      const parts = await Promise.all([branchIds.hq, branchIds.metro, branchIds.bl].map((b) => new Oracle(db, accounts, [b]).incomeStatement(from, to)));
      return parts.reduce((t, x) => t + x.net, 0);
    };
    expect(await isum("2026-01-01", MAX)).toBe((await new Oracle(db, accounts, null).incomeStatement("2026-01-01", MAX)).net);
    for (const p of periods) {
      const company = (await new Oracle(db, accounts, null).trialBalanceSigned(p.id, p.start)).signed;
      const parts = await Promise.all([branchIds.hq, branchIds.metro, branchIds.bl].map((b) => new Oracle(db, accounts, [b]).trialBalanceSigned(p.id, p.start)));
      for (const code of Object.keys(company)) expect(parts.reduce((t, x) => t + (x.signed[code] ?? 0), 0), `TB ${p.label} ${code}`).toBe(company[code]);
    }
    const cashParts = await Promise.all([branchIds.hq, branchIds.metro, branchIds.bl].map((b) => new Oracle(db, accounts, [b]).cash("2026-02-01", MAX)));
    expect(cashParts.reduce((t, x) => t + x.net, 0)).toBe((await new Oracle(db, accounts, null).cash("2026-02-01", MAX)).net);
  });

  it("ANGGARAN QUERY: jumlah query per laporan tidak boleh NAIK dari golden (turun boleh -- perbarui golden secara sadar)", async () => {
    let counter = 0;
    const onQuery = () => { counter += 1; };
    db.on("query", onQuery);
    const count = async (fn: () => Promise<unknown>) => { counter = 0; await fn(); return counter; };
    const counts: Record<string, number> = {
      balanceSheet: await count(() => getBalanceSheet(db, "2026-01-01", MAX)),
      incomeStatement: await count(() => getIncomeStatement(db, "2026-01-01", MAX)),
      equity: await count(() => getEquityStatement(db, "2026-01-01", MAX)),
      cashFlow: await count(() => getCashFlowStatement(db, "2026-01-01", MAX)),
      trialBalance: await count(() => getTrialBalance(db, periods[5].id)),
      ledger: await count(() => getAccountLedgerByRange(db, byCode["1100"].id, "2026-01-01", MAX)),
      counterparties: await count(() => getCounterpartyBalances(db, "vendor")),
      dashboard: await count(() => getDashboardSummary(db, "2026-01-01", MAX)),
    };
    db.removeListener("query", onQuery);
    const file = SNAP.replace("snapshot", "querycounts");
    if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(file, JSON.stringify({ phase: "5.0", note: "Batas atas jumlah query pada dataset golden (17 akun, 3 cabang). 5A tidak boleh menaikkan; 5B boleh menurunkan.", counts }, null, 1));
    const stored = JSON.parse(fs.readFileSync(file, "utf8")).counts as Record<string, number>;
    const over = Object.keys(stored).filter((k) => counts[k] > stored[k]).map((k) => `${k}: ${counts[k]} > ${stored[k]}`);
    expect(over, `jumlah query naik (regresi kinerja): ${over.join("; ")}`).toEqual([]);
    expect(Object.keys(counts).sort()).toEqual(Object.keys(stored).sort());
  });

  it("SNAPSHOT: keluaran laporan perusahaan-penuh identik dengan golden tersimpan (dikunci untuk 5A/5B)", async () => {
    const out: Record<string, unknown> = {};
    out["bs:Jun"] = stable(await getBalanceSheet(db, "2026-01-01", MAX));
    out["bs:Mar"] = stable(await getBalanceSheet(db, "2026-01-01", "2026-03-31"));
    out["is:H1"] = stable(await getIncomeStatement(db, "2026-01-01", MAX));
    out["is:Q1"] = stable(await getIncomeStatement(db, "2026-01-01", "2026-03-31"));
    out["eq:H1"] = stable(await getEquityStatement(db, "2026-01-01", MAX));
    out["cf:H1"] = stable(await getCashFlowStatement(db, "2026-01-01", MAX));
    out["cf:Q2"] = stable(await getCashFlowStatement(db, "2026-04-01", MAX));
    for (const p of periods) out[`tb:${p.label}`] = stable(await getTrialBalance(db, p.id));
    for (const code of ["1100", "1200", "2100", "4100"]) out[`ledger:${code}`] = stable(await getAccountLedgerByRange(db, byCode[code].id, "2026-01-01", MAX));
    out["cp:vendor"] = stable(await getCounterpartyBalances(db, "vendor"));
    out["cp:customer"] = stable(await getCounterpartyBalances(db, "customer"));
    const dash = await getDashboardSummary(db, "2026-01-01", MAX);
    out["dashboard"] = stable({ kpis: dash.kpis, trend: dash.trend, expenseComposition: dash.expenseComposition, financialPosition: dash.financialPosition, ytd: dash.ytd });
    const hashes = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, sha(canon(v))]));
    const summary = {
      assetsJun: (out["bs:Jun"] as any).totalAssets, netProfitH1: (out["is:H1"] as any).netProfit, endingCashH1: (out["cf:H1"] as any).endingCash,
      dashboardNetProfit: (dash.kpis.netProfit as any).value,
    };
    const snapshot = { phase: "5.0", note: "Dikunci untuk Phase 5A/5B. Perbarui hanya dengan UPDATE_GOLDEN=1 dan persetujuan.", summary, hashes };
    if (process.env.UPDATE_GOLDEN === "1") {
      fs.mkdirSync(path.dirname(SNAP), { recursive: true });
      fs.writeFileSync(SNAP, JSON.stringify(snapshot, null, 1));
    }
    expect(fs.existsSync(SNAP), "snapshot golden belum ada (jalankan sekali dengan UPDATE_GOLDEN=1)").toBe(true);
    const stored = JSON.parse(fs.readFileSync(SNAP, "utf8"));
    expect(snapshot.summary).toEqual(stored.summary);
    const diff = Object.keys(stored.hashes).filter((k) => stored.hashes[k] !== hashes[k]);
    expect(diff, `keluaran berubah dari golden: ${diff.join(", ")}`).toEqual([]);
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(stored.hashes).sort());
  });
});
