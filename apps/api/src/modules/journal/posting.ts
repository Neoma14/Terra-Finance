import { totalsEqual } from "../../lib/money.js";
import crypto from "node:crypto";
import type { Knex } from "knex";
import type { JournalLineInput } from "@konsultan/shared";


export interface CreateJournalEntryInput {
  companyId: string;
  entryDate: string;
  periodId: string;
  referenceNo?: string | null;
  description?: string | null;
  source: "manual" | "import";
  createdBy?: string | null;
  lines: JournalLineInput[];
  skipRecompute?: boolean;
}

/** Cari periode perusahaan ini yang mencakup tanggal tsb -- sama persis
 * logikanya dgn versi online, scoped `company_id`. */
export async function findPeriodForDate(masterDb: Knex, companyId: string, date: string): Promise<{ id: string; label: string } | null> {
  const period = await masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("start_date", "<=", date)
    .andWhere("end_date", ">=", date)
    .first();
  return period ?? null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** Sama seperti findPeriodForDate, tapi OTOMATIS BUAT periode BULANAN kalau
 * belum ada -- sama persis logikanya dgn versi online (lihat komentar di
 * sana), scoped `company_id`, id dibuat eksplisit via crypto.randomUUID(). */
export async function findOrCreatePeriodForDate(masterDb: Knex, companyId: string, date: string): Promise<{ id: string; label: string }> {
  const existing = await findPeriodForDate(masterDb, companyId, date);
  if (existing) return existing;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)); // 1-12
  const label = `${MONTH_LABELS[month - 1]} ${year}`;
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;

  const existingByLabel = await masterDb("periods").where({ company_id: companyId, label }).first();
  if (existingByLabel) return existingByLabel;

  const id = crypto.randomUUID();
  await masterDb("periods").insert({
    id,
    company_id: companyId,
    label,
    start_date: startDate,
    end_date: endDate,
    period_type: "month",
    fiscal_year: year,
  });
  return { id, label };
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

/** Nomor jurnal otomatis dari counter `companies.journal_number_seq` --
 * pengganti `CREATE SEQUENCE` Postgres (SQLite tidak punya sequence).
 * Gap pada nomor kalau ada entry yang gagal di tengah jalan itu NORMAL &
 * diterima (sama seperti karakteristik sequence Postgres di versi online). */
async function nextAutoReferenceNo(masterDb: Knex, companyId: string): Promise<string> {
  await masterDb("companies").where({ id: companyId }).increment("journal_number_seq", 1);
  const row = await masterDb("companies").where({ id: companyId }).select("journal_number_seq").first();
  const n = Number(row?.journal_number_seq ?? 1);
  return `JRN-${String(n).padStart(6, "0")}`;
}

/** Posting satu jurnal -- sama persis logikanya dgn versi online (lihat
 * komentar di sana), scoped `company_id`. */
export async function createJournalEntry(masterDb: Knex, input: CreateJournalEntryInput): Promise<{ id: string; referenceNo: string }> {
  const totalDebit = sumBy(input.lines, (l) => l.debit);
  const totalCredit = sumBy(input.lines, (l) => l.credit);
  if (!totalsEqual(totalDebit, totalCredit)) {
    throw new Error(`Jurnal tidak balance: debit ${totalDebit} vs kredit ${totalCredit}`);
  }
  if (input.lines.length === 0) {
    throw new Error("Jurnal harus punya minimal 1 baris");
  }

  const referenceNo = input.referenceNo?.trim() || (await nextAutoReferenceNo(masterDb, input.companyId));

  const existing = await masterDb("journal_entries").where({ company_id: input.companyId, reference_no: referenceNo }).first();
  if (existing) {
    throw new Error(`Nomor jurnal "${referenceNo}" sudah dipakai`);
  }

  const entryId = crypto.randomUUID();
  await masterDb.transaction(async (trx) => {
    await trx("journal_entries").insert({
      id: entryId,
      company_id: input.companyId,
      entry_date: input.entryDate,
      period_id: input.periodId,
      reference_no: referenceNo,
      description: input.description ?? null,
      source: input.source,
      created_by: input.createdBy ?? null,
    });

    // Insert per BATCH kecil (bukan satu .insert() dgn semua baris sekaligus)
    // -- SQLite (better-sqlite3) punya batas jumlah bound parameter per
    // statement (SQLITE_MAX_VARIABLE_NUMBER, defaultnya 999). Jurnal dgn
    // BANYAK baris (mis. import trial balance awal berisi puluhan/ratusan
    // akun sbg SATU entry) gampang melewati batas itu (7 kolom x N baris),
    // menghasilkan error SQLite mentah yang membingungkan user kalau tidak
    // di-chunk. 100 baris x 7 kolom = 700 parameter, aman di bawah 999.
    const LINE_INSERT_BATCH_SIZE = 100;
    const linesToInsert = input.lines.map((l) => ({
      id: crypto.randomUUID(),
      journal_entry_id: entryId,
      account_id: l.accountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? null,
      counterparty_id: l.counterpartyId ?? null,
    }));
    for (let i = 0; i < linesToInsert.length; i += LINE_INSERT_BATCH_SIZE) {
      await trx("journal_entry_lines").insert(linesToInsert.slice(i, i + LINE_INSERT_BATCH_SIZE));
    }

    // Auto-tandai akun sbg Kartu Piutang/Hutang begitu SATU SAJA baris
    // vendor/pelanggan ditulis ke akun itu -- sama persis dgn versi online.
    const accountIdsWithCounterparty = [...new Set(input.lines.filter((l) => l.counterpartyId).map((l) => l.accountId))];
    if (accountIdsWithCounterparty.length > 0) {
      const untaggedAccounts = await trx("accounts")
        .whereIn("id", accountIdsWithCounterparty)
        .whereNull("subledger_type")
        .select("id", "account_type");
      for (const a of untaggedAccounts as any[]) {
        const inferred = a.account_type === "asset" ? "receivable" : a.account_type === "liability" ? "payable" : null;
        if (inferred) {
          await trx("accounts").where({ id: a.id }).update({ subledger_type: inferred });
        }
      }
    }
  });

  if (!input.skipRecompute) {
    await recomputeTrialBalanceForPeriod(masterDb, input.companyId, input.periodId);
  }
  return { id: entryId, referenceNo };
}

/** Carry-forward SATU AKUN SAJA -- sama persis logikanya & alasannya dgn
 * versi online (lihat komentar panjang di sana kenapa ini WAJIB per-akun,
 * TIDAK BOLEH pakai recompute per-periode-semua-akun), scoped `company_id`. */
export async function carryAccountForward(masterDb: Knex, companyId: string, accountId: string, fromPeriodId: string): Promise<void> {
  const account = await masterDb("accounts").where({ id: accountId, company_id: companyId }).first();
  if (!account) throw new Error("Akun tidak ditemukan");
  const fromPeriod = await masterDb("periods").where({ id: fromPeriodId, company_id: companyId }).first();
  if (!fromPeriod) throw new Error("Periode tidak ditemukan");

  const isFlow = account.account_type === "revenue" || account.account_type === "expense";
  let priorEnding = 0;
  if (!isFlow) {
    const priorPeriod = await masterDb("periods")
      .where({ company_id: companyId })
      .andWhere("end_date", "<", fromPeriod.start_date)
      .orderBy("end_date", "desc")
      .first();
    if (priorPeriod) {
      const priorSnapshot = await masterDb("trial_balance_snapshots").where({ period_id: priorPeriod.id, account_id: accountId }).first();
      priorEnding = priorSnapshot ? Number(priorSnapshot.ending_balance) : 0;
    }
  }

  const periods = await masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("start_date", ">=", fromPeriod.start_date)
    .orderBy("start_date", "asc")
    .select("id");

  await masterDb.transaction(async (trx) => {
    for (const period of periods as any[]) {
      const activity = await trx("journal_entry_lines as jel")
        .join("journal_entries as je", "je.id", "jel.journal_entry_id")
        .where("je.period_id", period.id)
        .andWhere("jel.account_id", accountId)
        .select(trx.raw("COALESCE(SUM(jel.debit), 0) as debit_total"), trx.raw("COALESCE(SUM(jel.credit), 0) as credit_total"))
        .first();
      const debit = Number((activity as any)?.debit_total ?? 0);
      const credit = Number((activity as any)?.credit_total ?? 0);
      const beginning = isFlow ? 0 : priorEnding;
      const ending = account.normal_balance === "debit" ? beginning + debit - credit : beginning + credit - debit;
      const row = { beginning_balance: beginning, debit_total: debit, credit_total: credit, ending_balance: ending };

      const existingSnapshot = await trx("trial_balance_snapshots").where({ period_id: period.id, account_id: accountId }).first();
      if (existingSnapshot) {
        await trx("trial_balance_snapshots").where({ id: existingSnapshot.id }).update(row);
      } else {
        await trx("trial_balance_snapshots").insert({ id: crypto.randomUUID(), period_id: period.id, account_id: accountId, ...row });
      }
      priorEnding = ending;
    }
  });
}

/** Hitung ulang trial_balance_snapshots SATU periode dari nol -- sama
 * persis logikanya dgn versi online (lihat komentar panjang di sana ttg
 * closing entry Laba Ditahan/SHU), scoped `company_id`. */
export async function recomputeTrialBalanceForPeriod(masterDb: Knex, companyId: string, periodId: string): Promise<void> {
  const period = await masterDb("periods").where({ id: periodId, company_id: companyId }).first();
  if (!period) throw new Error("Periode tidak ditemukan");

  const priorPeriod = await masterDb("periods")
    .where({ company_id: companyId })
    .andWhere("end_date", "<", period.start_date)
    .orderBy("end_date", "desc")
    .first();

  const [accounts, priorBalances, activity] = await Promise.all([
    masterDb("accounts").where({ company_id: companyId }).select("id", "account_type", "account_subtype", "normal_balance"),
    priorPeriod
      ? masterDb("trial_balance_snapshots").where({ period_id: priorPeriod.id }).select("account_id", "ending_balance")
      : Promise.resolve([]),
    masterDb("journal_entry_lines as jel")
      .join("journal_entries as je", "je.id", "jel.journal_entry_id")
      .where("je.period_id", periodId)
      .groupBy("jel.account_id")
      .select("jel.account_id", masterDb.raw("SUM(jel.debit) as debit_total"), masterDb.raw("SUM(jel.credit) as credit_total")),
  ]);

  const priorByAccount = new Map(priorBalances.map((r: any) => [r.account_id, Number(r.ending_balance)]));
  const activityByAccount = new Map(activity.map((r: any) => [r.account_id, { debit: Number(r.debit_total), credit: Number(r.credit_total) }]));

  let netIncome = 0;
  const computed = new Map<string, { beginning: number; debit: number; credit: number; ending: number }>();

  for (const account of accounts as any[]) {
    const isFlow = account.account_type === "revenue" || account.account_type === "expense";
    const beginning = isFlow ? 0 : (priorByAccount.get(account.id) ?? 0);
    const act = activityByAccount.get(account.id) ?? { debit: 0, credit: 0 };
    const ending = account.normal_balance === "debit" ? beginning + act.debit - act.credit : beginning + act.credit - act.debit;
    computed.set(account.id, { beginning, debit: act.debit, credit: act.credit, ending });

    if (account.account_type === "revenue") netIncome += ending;
    if (account.account_type === "expense") netIncome -= ending;
  }

  const retainedAccount = (accounts as any[]).find((a) => a.account_subtype === "equity_retained");
  if (retainedAccount) {
    const c = computed.get(retainedAccount.id)!;
    c.ending += netIncome;
  }

  await masterDb.transaction(async (trx) => {
    for (const [accountId, values] of computed) {
      const row = { beginning_balance: values.beginning, debit_total: values.debit, credit_total: values.credit, ending_balance: values.ending };
      const existingSnapshot = await trx("trial_balance_snapshots").where({ period_id: periodId, account_id: accountId }).first();
      if (existingSnapshot) {
        await trx("trial_balance_snapshots").where({ id: existingSnapshot.id }).update(row);
      } else {
        await trx("trial_balance_snapshots").insert({ id: crypto.randomUUID(), period_id: periodId, account_id: accountId, ...row });
      }
    }
  });
}

export interface ReverseJournalEntryInput {
  companyId: string;
  reversalDate: string;
  referenceNo: string;
  createdBy?: string | null;
}

function toDateOnly(value: string | Date): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/** Reversal = jurnal BARU dgn baris debit<->kredit ditukar -- sama persis
 * logikanya dgn versi online, scoped `company_id`. */
export async function reverseJournalEntry(masterDb: Knex, input: ReverseJournalEntryInput): Promise<{ id: string; referenceNo: string }> {
  const original = await masterDb("journal_entries").where({ company_id: input.companyId, reference_no: input.referenceNo }).first();
  if (!original) throw new Error(`Jurnal dengan nomor referensi "${input.referenceNo}" tidak ditemukan`);
  if (original.is_reversed) throw new Error(`Jurnal "${input.referenceNo}" sudah pernah di-reversal sebelumnya`);
  if (toDateOnly(input.reversalDate) !== toDateOnly(original.entry_date)) {
    throw new Error(
      `Tanggal tidak sesuai -- jurnal "${input.referenceNo}" tercatat pada tanggal ${toDateOnly(original.entry_date)}, bukan ${toDateOnly(input.reversalDate)}`,
    );
  }

  const reversalPeriod = await findPeriodForDate(masterDb, input.companyId, input.reversalDate);
  if (!reversalPeriod) throw new Error("Tidak ada periode yang mencakup tanggal reversal tsb -- buat periodenya dulu");

  const originalLines = await masterDb("journal_entry_lines").where({ journal_entry_id: original.id });

  const reversalReferenceNo = `${original.reference_no}-REV`;
  const result = await createJournalEntry(masterDb, {
    companyId: input.companyId,
    entryDate: input.reversalDate,
    periodId: reversalPeriod.id,
    referenceNo: reversalReferenceNo,
    description: `Reversal dari ${original.reference_no}`,
    source: "manual",
    createdBy: input.createdBy,
    lines: originalLines.map((l: any) => ({
      accountId: l.account_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
      memo: l.memo,
      counterpartyId: l.counterparty_id,
    })),
  });

  await masterDb("journal_entries").where({ id: original.id }).update({ is_reversed: true });
  await masterDb("journal_entries").where({ id: result.id }).update({ reversal_of_id: original.id });

  if (reversalPeriod.id !== original.period_id) {
    await recomputeTrialBalanceForPeriod(masterDb, input.companyId, original.period_id);
  }

  return result;
}
