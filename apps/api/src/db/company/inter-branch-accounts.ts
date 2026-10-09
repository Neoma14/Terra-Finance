import type { Knex } from "knex";

/**
 * Pemilihan akun antar-cabang oleh SISTEM (Spek §5) -- pengguna tidak pernah memilih akun antar-cabang
 * maupun arah debit/kredit. Nilai mengalir dari pemberi (FROM) ke penerima (TO):
 *   FROM: D akun INTER_BRANCH [lawan = TO]   -- diutamakan ASSET, cadangan LIABILITY (model netto)
 *   TO  : K akun INTER_BRANCH [lawan = FROM] -- diutamakan LIABILITY, cadangan ASSET
 * Akun dicari dari `branch_policy` + `counterpart_branch_id`; tidak ada nomor akun maupun id cabang yang ditulis di kode.
 */

export class InterBranchAccountMissingError extends Error {
  readonly code = "INTER_BRANCH_ACCOUNT_MISSING" as const;
}
export class InterBranchAccountAmbiguousError extends Error {
  readonly code = "INTER_BRANCH_ACCOUNT_AMBIGUOUS" as const;
}
export class InterBranchAccountUnusableError extends Error {
  readonly code = "INTER_BRANCH_ACCOUNT_UNUSABLE" as const;
}

export interface ResolvedInterBranchAccount {
  id: string;
  code: string;
  name: string;
  accountType: "ASSET" | "LIABILITY";
  /** Cabang lawan yang ditunjuk akun ini. */
  counterpartBranchId: string;
}

export interface ResolvedInterBranchAccounts {
  /** Sisi FROM: akun yang didebit. */
  fromDebit: ResolvedInterBranchAccount;
  /** Sisi TO: akun yang dikredit. */
  toCredit: ResolvedInterBranchAccount;
}

type Candidate = ResolvedInterBranchAccount & { isActive: boolean; isLocked: boolean; isCash: boolean; cashFlowActivity: string | null };

async function loadCandidates(db: Knex, counterpartBranchId: string): Promise<Candidate[]> {
  const rows = await db("accounts as a")
    .join("account_types as t", "t.id", "a.account_type_id")
    .where({ "a.branch_policy": "INTER_BRANCH", "a.counterpart_branch_id": counterpartBranchId })
    .select(
      "a.id as id",
      "a.code as code",
      "a.name as name",
      "t.code as accountType",
      "a.counterpart_branch_id as counterpartBranchId",
      "a.is_active as isActive",
      "a.is_locked as isLocked",
      "a.is_cash as isCash",
      "a.cash_flow_activity as cashFlowActivity",
    );
  return rows.map((r: any) => ({ ...r, isActive: Boolean(r.isActive), isLocked: Boolean(r.isLocked), isCash: Boolean(r.isCash) }));
}

function assertUsable(account: Candidate): void {
  const label = `${account.code} - ${account.name}`;
  if (!account.isActive) throw new InterBranchAccountUnusableError(`Akun antarkantor "${label}" tidak aktif.`);
  if (account.isLocked) throw new InterBranchAccountUnusableError(`Akun antarkantor "${label}" sedang dikunci.`);
  if (account.isCash || account.cashFlowActivity !== null) {
    throw new InterBranchAccountUnusableError(`Akun antarkantor "${label}" melanggar aturan: akun antar-cabang tidak boleh akun kas atau berklasifikasi arus kas.`);
  }
}

async function pick(db: Knex, counterpartBranchId: string, preferred: "ASSET" | "LIABILITY", fallback: "ASSET" | "LIABILITY", guidance: string): Promise<ResolvedInterBranchAccount> {
  const candidates = await loadCandidates(db, counterpartBranchId);
  for (const type of [preferred, fallback]) {
    const ofType = candidates.filter((c) => c.accountType === type);
    if (ofType.length === 0) continue;
    if (ofType.length > 1) {
      throw new InterBranchAccountAmbiguousError(`Ada lebih dari satu akun antarkantor ${type} untuk pasangan cabang ini. Hubungi pemilik perusahaan.`);
    }
    assertUsable(ofType[0]);
    const { id, code, name, accountType, counterpartBranchId: counterpart } = ofType[0];
    return { id, code, name, accountType, counterpartBranchId: counterpart };
  }
  throw new InterBranchAccountMissingError(guidance);
}

export async function resolveInterBranchAccounts(db: Knex, input: { fromBranchId: string; toBranchId: string }): Promise<ResolvedInterBranchAccounts> {
  if (input.fromBranchId === input.toBranchId) throw new InterBranchAccountMissingError("Cabang asal dan tujuan harus berbeda.");
  const guidance = "Akun antarkantor untuk pasangan cabang ini belum dibuat. Minta pemilik perusahaan membuatnya melalui menu akun antar-cabang terpandu.";
  return {
    fromDebit: await pick(db, input.toBranchId, "ASSET", "LIABILITY", guidance),
    toCredit: await pick(db, input.fromBranchId, "LIABILITY", "ASSET", guidance),
  };
}
