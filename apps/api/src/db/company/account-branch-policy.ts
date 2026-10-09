import type { Knex } from "knex";
import type { BranchRow, JournalOrigin } from "./branch-service.js";

/**
 * Kebijakan cabang per AKUN (Multi-Branch Phase 2).
 *
 * Kebijakan adalah data eksplisit di baris akun (`accounts.branch_policy`),
 * BUKAN diturunkan dari tipe/kategori/nama akun. Modul ini sengaja tidak
 * mengimpor atau memeriksa `account_type`: tidak ada logika "kalau Equity".
 *
 *   ALL_BRANCH   boleh dipakai jurnal cabang mana pun (yang diizinkan siklus hidupnya)
 *   CENTRAL_ONLY hanya jurnal milik Kantor Pusat
 *   SYSTEM_ONLY  hanya proses sistem terdaftar (origin = system)
 *   INTER_BRANCH akun antar-cabang: tidak boleh jurnal manual/impor; boleh
 *                lewat saldo awal dan (Phase 6) layanan antar-cabang;
 *                cabang lawan HARUS bukan cabang jurnal itu sendiri
 */

export const BRANCH_POLICIES = ["ALL_BRANCH", "CENTRAL_ONLY", "SYSTEM_ONLY", "INTER_BRANCH"] as const;
export type BranchPolicy = (typeof BRANCH_POLICIES)[number];

export class AccountPolicyViolationError extends Error {
  readonly code = "ACCOUNT_POLICY_VIOLATION" as const;
  constructor(
    message: string,
    public readonly accountCode: string,
    public readonly policy: BranchPolicy,
  ) {
    super(message);
  }
}

export interface PolicyAccount {
  id: string;
  code: string;
  name: string;
  branchPolicy: BranchPolicy;
  counterpartBranchId: string | null;
}

const ORIGIN_LABEL: Record<JournalOrigin, string> = {
  manual: "jurnal manual",
  import: "import jurnal",
  opening_balance: "saldo awal",
  system: "proses sistem",
  inter_branch: "transaksi antar-cabang",
  head_office_effect: "dampak transaksi pusat",
};

/** Fungsi murni: mengembalikan pesan pelanggaran, atau null bila diizinkan. */
export function describePolicyViolation(account: PolicyAccount, branch: Pick<BranchRow, "id" | "name" | "isHeadOffice">, origin: JournalOrigin): string | null {
  const label = `${account.code} - ${account.name}`;
  switch (account.branchPolicy) {
    case "ALL_BRANCH":
      return null;
    case "CENTRAL_ONLY":
      return branch.isHeadOffice
        ? null
        : `Akun "${label}" hanya boleh dipakai pada jurnal Kantor Pusat (kebijakan CENTRAL_ONLY), bukan cabang "${branch.name}".`;
    case "SYSTEM_ONLY":
      return origin === "system" ? null : `Akun "${label}" hanya boleh diposting oleh proses sistem (kebijakan SYSTEM_ONLY); tidak dapat dipakai pada ${ORIGIN_LABEL[origin]}.`;
    case "INTER_BRANCH": {
      if (account.counterpartBranchId === branch.id) {
        return `Akun antar-cabang "${label}" menunjuk cabang "${branch.name}" sebagai cabang lawan, sehingga tidak dapat dipakai oleh cabang itu sendiri.`;
      }
      const allowed: JournalOrigin[] = ["opening_balance", "inter_branch", "head_office_effect"];
      return allowed.includes(origin)
        ? null
        : `Akun antar-cabang "${label}" tidak dapat dipakai pada ${ORIGIN_LABEL[origin]}; gunakan transaksi antar-cabang.`;
    }
    default:
      return `Kebijakan cabang akun "${label}" tidak dikenal.`;
  }
}

export async function loadPolicyAccounts(db: Knex, accountIds: string[]): Promise<PolicyAccount[]> {
  if (accountIds.length === 0) return [];
  const rows = await db("accounts")
    .whereIn("id", accountIds)
    .select("id", "code", "name", "branch_policy as branchPolicy", "counterpart_branch_id as counterpartBranchId");
  return rows as PolicyAccount[];
}

/** Melempar AccountPolicyViolationError pada pelanggaran pertama. Dipanggil saat buat draft DAN saat posting. */
export async function assertAccountsAllowedForJournal(
  db: Knex,
  accountIds: string[],
  branch: Pick<BranchRow, "id" | "name" | "isHeadOffice">,
  origin: JournalOrigin,
): Promise<void> {
  const accounts = await loadPolicyAccounts(db, [...new Set(accountIds)]);
  for (const account of accounts) {
    const message = describePolicyViolation(account, branch, origin);
    if (message) throw new AccountPolicyViolationError(message, account.code, account.branchPolicy);
  }
}
