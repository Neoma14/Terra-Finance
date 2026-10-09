import crypto from "node:crypto";
import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { applyBranchScope, type AuthorizedScope } from "./report-scope.js";

/**
 * Hutang & Piutang (TASK-023 §6) -- tabel `counterparties` sudah ada
 * sejak C0005 (master vendor/customer), `journal_entry_lines.counterparty_id`
 * sudah didukung end-to-end sejak journal-service.ts (TASK-DB-ARCH-014,
 * BUKAN ditambah di task ini). Yang TIDAK ADA sebelumnya: route/service
 * utk membaca/menulis counterparty itu sendiri, dan utk menghitung saldo
 * per counterparty.
 *
 * Saldo dihitung LANGSUNG dari `journal_entry_lines` (status POSTED/
 * REVERSED, pola SAMA dgn ledger-service.ts `signedMovement`) -- BUKAN
 * tabel saldo terpisah, BUKAN accounting engine kedua. Tidak ada "flow
 * pembayaran" baru (§6 instruksi): melunasi hutang/piutang = posting
 * jurnal baru lewat Journal module existing (debit/kredit akun subledger
 * ini + counterparty_id yang sama) -- SAMA PERSIS prinsip Transaction ->
 * Journal -> Ledger -> Reports, tidak boleh mengubah saldo manual.
 *
 * Due date / termin pembayaran TIDAK ditampilkan -- skema counterparties
 * (C0005) sengaja TIDAK py kolom itu (lihat komentar migration: "di luar
 * scope AR/AP yang sudah disetujui"), didokumentasikan sbg keterbatasan,
 * bukan dikosongkan diam-diam atau ditebak.
 */

export type CounterpartyType = "vendor" | "customer";

export class CounterpartyCodeRequiredError extends Error {
  readonly code = "COUNTERPARTY_CODE_REQUIRED" as const;
}
export class CounterpartyNameRequiredError extends Error {
  readonly code = "COUNTERPARTY_NAME_REQUIRED" as const;
}
export class CounterpartyCodeAlreadyExistsError extends Error {
  readonly code = "COUNTERPARTY_CODE_ALREADY_EXISTS" as const;
}

export interface CounterpartyRow {
  id: string;
  type: CounterpartyType;
  code: string;
  name: string;
  isActive: boolean;
}

const COLUMNS = ["id", "type", "code", "name", "is_active as isActive"];

export async function listCounterparties(db: Knex, type?: CounterpartyType): Promise<CounterpartyRow[]> {
  let query = db("counterparties").select(COLUMNS).orderBy("code");
  if (type) query = query.where({ type });
  return query;
}

export interface CreateCounterpartyInput {
  type: CounterpartyType;
  code: string;
  name: string;
}

export async function createCounterparty(db: Knex, input: CreateCounterpartyInput, actor: ActorContext): Promise<{ id: string }> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new CounterpartyCodeRequiredError("Kode vendor/customer tidak boleh kosong.");
  if (!name) throw new CounterpartyNameRequiredError("Nama vendor/customer tidak boleh kosong.");

  const id = crypto.randomUUID();
  await db.transaction(async (trx) => {
    const existing = await trx("counterparties").where({ type: input.type, code }).first();
    if (existing) throw new CounterpartyCodeAlreadyExistsError(`Kode "${code}" sudah dipakai untuk ${input.type === "vendor" ? "vendor" : "customer"} lain.`);

    await trx("counterparties").insert({ id, type: input.type, code, name });
    await appendCompanyAudit(trx, {
      actor,
      action: "counterparty.create",
      entityType: "counterparty",
      entityId: id,
      after: { type: input.type, code, name },
    });
  });
  return { id };
}

export interface CounterpartyBalanceRow {
  counterpartyId: string;
  code: string;
  name: string;
  isActive: boolean;
  balance: number;
}

/** Saldo per counterparty, dihitung dari seluruh journal line POSTED/
 * REVERSED yang menyentuh akun subledger `payable` (utk vendor) atau
 * `receivable` (utk customer) DAN punya `counterparty_id` terisi.
 * Counterparty tanpa transaksi apa pun tetap muncul dgn balance 0 (nilai
 * nyata -- lunas/belum pernah transaksi -- bukan "belum tersedia"). */
export async function getCounterpartyBalances(db: Knex, type: CounterpartyType, scope?: AuthorizedScope): Promise<CounterpartyBalanceRow[]> {
  const subledgerType = type === "vendor" ? "payable" : "receivable";
  const counterparties = await listCounterparties(db, type);

  const movementQuery = db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .join("accounts as a", "a.id", "jel.account_id")
    .where("a.subledger_type", subledgerType)
    .whereIn("je.status", ["POSTED", "REVERSED"])
    .whereNotNull("jel.counterparty_id");
  const movements = await applyBranchScope(movementQuery, scope) // Phase 5: hanya SALDO yang mengikuti cakupan; master counterparty tetap bersama (D4)
    .groupBy("jel.counterparty_id", "a.normal_balance")
    .select(
      "jel.counterparty_id as counterpartyId",
      "a.normal_balance as normalBalance",
      db.raw("COALESCE(SUM(jel.debit), 0) as debitTotal"),
      db.raw("COALESCE(SUM(jel.credit), 0) as creditTotal"),
    );

  const balanceByCounterparty = new Map<string, number>();
  for (const m of movements as any[]) {
    const debit = Number(m.debitTotal);
    const credit = Number(m.creditTotal);
    const signed = m.normalBalance === "debit" ? debit - credit : credit - debit;
    balanceByCounterparty.set(m.counterpartyId, (balanceByCounterparty.get(m.counterpartyId) ?? 0) + signed);
  }

  return counterparties.map((c) => ({
    counterpartyId: c.id,
    code: c.code,
    name: c.name,
    isActive: c.isActive,
    balance: balanceByCounterparty.get(c.id) ?? 0,
  }));
}
