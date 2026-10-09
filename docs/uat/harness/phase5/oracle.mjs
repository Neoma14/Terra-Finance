// PHASE 5.0 -- ORACLE independen: menghitung angka laporan LANGSUNG dari baris jurnal dengan SQL biasa, TANPA memanggil layanan laporan.
// Dipakai untuk (a) memverifikasi layanan saat ini (sumber transaksi -> angka), (b) menghasilkan "expected result per cakupan cabang"
// untuk 5A/5B. Aturan akuntansi yang ditiru berasal dari definisi laporan (bukan dari kode layanan):
//   status POSTED/REVERSED saja; saldo akun bukan-aliran = kumulatif sampai tanggal; akun aliran (pendapatan/beban) = gerakan rentang;
//   tanda kanonik kontra-akun; Laba (Rugi) belum ditutup (RE-BRIDGE) = kumulatif seluruh akun aliran.
import crypto from "node:crypto";

export const FLOW = new Set(["REVENUE", "EXPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"]);
const PROFIT_SIGN = { REVENUE: 1, OTHER_INCOME: 1, COGS: -1, EXPENSE: -1, OTHER_EXPENSE: -1 };
const STATUS = "('POSTED','REVERSED')";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export class Oracle {
  /** @param db instance better-sqlite3 (read-only) @param branchIds null = seluruh perusahaan; array = cakupan cabang */
  constructor(db, branchIds = null) {
    this.db = db;
    this.branchIds = branchIds;
    this.accounts = db.prepare("SELECT a.id, a.code, a.name, a.normal_balance nb, t.code type, t.normal_balance tnb, a.is_cash isCash, a.subledger_type sub FROM accounts a JOIN account_types t ON t.id = a.account_type_id ORDER BY a.code").all();
  }
  scopeSql() { return this.branchIds ? ` AND je.branch_id IN (${this.branchIds.map(() => "?").join(",")})` : ""; }
  scopeArgs() { return this.branchIds ?? []; }
  signed(a, d, c) { return a.nb === "debit" ? d - c : c - d; }
  canon(a, own) { return a.nb === a.tnb ? own : -own; }

  /** jumlah + sidik jari baris sumber untuk satu akun, rentang tanggal [from, to] (from null = tanpa batas bawah), op batas atas */
  lines(accountId, from, to, toInclusive = true, extra = "", extraArgs = []) {
    return this.db.prepare(
      `SELECT jel.id lid, jel.journal_entry_id jid, jel.debit d, jel.credit c FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.account_id = ? AND je.status IN ${STATUS}${from ? " AND je.entry_date >= ?" : ""}${to ? ` AND je.entry_date ${toInclusive ? "<=" : "<"} ?` : ""}${this.scopeSql()}${extra} ORDER BY jel.id`,
    ).all(accountId, ...(from ? [from] : []), ...(to ? [to] : []), ...this.scopeArgs(), ...extraArgs);
  }
  sum(accountId, from, to, toInclusive = true, extra = "", extraArgs = []) {
    const ls = this.lines(accountId, from, to, toInclusive, extra, extraArgs);
    let d = 0, c = 0;
    for (const l of ls) { d += l.d; c += l.c; }
    return { d, c, n: ls.length, fp: sha(ls.map((l) => `${l.lid}|${l.d}|${l.c}`).join("\n")), journals: new Set(ls.map((l) => l.jid)).size };
  }

  balanceSheet(toDate) {
    const sections = { ASSET: [], LIABILITY: [], EQUITY: [] };
    const totals = { ASSET: 0, LIABILITY: 0, EQUITY: 0 };
    for (const a of this.accounts) {
      if (!(a.type in sections)) continue;
      const s = this.sum(a.id, null, toDate);
      const own = this.signed(a, s.d, s.c);
      if (own === 0) continue;
      const amount = this.canon(a, own);
      sections[a.type].push({ code: a.code, amount, lines: s.n, journals: s.journals, fp: s.fp });
      totals[a.type] += amount;
    }
    let bridge = 0;
    for (const a of this.accounts) {
      if (!FLOW.has(a.type)) continue;
      const s = this.sum(a.id, null, toDate);
      bridge += PROFIT_SIGN[a.type] * this.canon(a, this.signed(a, s.d, s.c));
    }
    const equityTotal = totals.EQUITY + bridge;
    return { sections, totalAssets: totals.ASSET, totalLiabilities: totals.LIABILITY, totalEquity: equityTotal, bridge, difference: totals.ASSET - (totals.LIABILITY + equityTotal) };
  }

  incomeStatement(from, to) {
    const out = {};
    const tot = {};
    for (const a of this.accounts) {
      if (!FLOW.has(a.type)) continue;
      const s = this.sum(a.id, from, to);
      const own = this.signed(a, s.d, s.c);
      if (own === 0) continue;
      const amount = this.canon(a, own);
      (out[a.type] ??= []).push({ code: a.code, amount, lines: s.n, journals: s.journals, fp: s.fp });
      tot[a.type] = (tot[a.type] ?? 0) + amount;
    }
    const g = (k) => tot[k] ?? 0;
    const gross = g("REVENUE") - g("COGS");
    const op = gross - g("EXPENSE");
    return { sections: out, totals: tot, grossProfit: gross, operatingProfit: op, netProfit: op + g("OTHER_INCOME") - g("OTHER_EXPENSE") };
  }

  trialBalance(periodId) {
    const p = this.db.prepare("SELECT start_date s, end_date e FROM periods WHERE id=?").get(periodId);
    const start = String(p.s).slice(0, 10);
    const rows = [];
    let td = 0, tc = 0;
    for (const a of this.accounts) {
      const mv = this.sum(a.id, null, null, true, " AND je.period_id = ?", [periodId]);
      const opening = FLOW.has(a.type) ? 0 : this.signed(a, ...(({ d, c }) => [d, c])(this.sum(a.id, null, start, false)));
      const ending = opening + this.signed(a, mv.d, mv.c);
      let dc = 0, cc = 0;
      if (a.nb === "debit") { if (ending >= 0) dc = ending; else cc = -ending; } else if (ending >= 0) cc = ending; else dc = -ending;
      if (dc === 0 && cc === 0 && mv.n === 0) continue;
      rows.push({ code: a.code, debit: dc, credit: cc, lines: mv.n, fp: mv.fp });
      td += dc; tc += cc;
    }
    let bridge = 0;
    for (const a of this.accounts) {
      if (!FLOW.has(a.type)) continue;
      const s = this.sum(a.id, null, start, false);
      bridge += PROFIT_SIGN[a.type] * this.canon(a, this.signed(a, s.d, s.c));
    }
    if (bridge !== 0) { td += bridge < 0 ? -bridge : 0; tc += bridge > 0 ? bridge : 0; }
    return { rows, totalDebit: td, totalCredit: tc, bridge, difference: td - tc };
  }

  ledger(accountId, from, to) {
    const a = this.accounts.find((x) => x.id === accountId);
    const opening = FLOW.has(a.type) ? 0 : (() => { const s = this.sum(accountId, null, from, false); return this.signed(a, s.d, s.c); })();
    const ls = this.db.prepare(
      `SELECT jel.id lid, jel.debit d, jel.credit c FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.account_id = ? AND je.status IN ${STATUS} AND je.entry_date >= ? AND je.entry_date <= ?${this.scopeSql()}
       ORDER BY je.entry_date, je.created_at, je.reference_no, je.id, jel.line_order`,
    ).all(accountId, from, to, ...this.scopeArgs());
    let run = opening;
    for (const l of ls) run += this.signed(a, l.d, l.c);
    return { opening, ending: run, lines: ls.length, fp: sha(ls.map((l) => `${l.lid}|${l.d}|${l.c}`).join("\n")) };
  }

  cash(from, to) {
    let beginning = 0, ending = 0;
    for (const a of this.accounts.filter((x) => x.isCash)) {
      const b = this.sum(a.id, null, from, false);
      const e = this.sum(a.id, null, to, true);
      beginning += this.signed(a, b.d, b.c);
      ending += this.signed(a, e.d, e.c);
    }
    return { beginning, ending, net: ending - beginning };
  }

  counterparties(type) {
    const sub = type === "vendor" ? "payable" : "receivable";
    const rows = this.db.prepare(
      `SELECT jel.counterparty_id cp, a.normal_balance nb, COALESCE(SUM(jel.debit),0) d, COALESCE(SUM(jel.credit),0) c FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id JOIN accounts a ON a.id = jel.account_id
       WHERE a.subledger_type = ? AND je.status IN ${STATUS} AND jel.counterparty_id IS NOT NULL${this.scopeSql()} GROUP BY jel.counterparty_id, a.normal_balance`,
    ).all(sub, ...this.scopeArgs());
    const m = new Map();
    for (const r of rows) m.set(r.cp, (m.get(r.cp) ?? 0) + (r.nb === "debit" ? r.d - r.c : r.c - r.d));
    return m;
  }
}
