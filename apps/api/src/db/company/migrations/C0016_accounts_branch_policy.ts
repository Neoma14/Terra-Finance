import type { Knex } from "knex";

/**
 * Multi-Branch Phase 2 -- kebijakan cabang per AKUN.
 *
 * `branch_policy` adalah atribut eksplisit pada baris akun (pola yang sama
 * dengan cash_flow_activity/subledger_type/is_locked). TIDAK diturunkan dari
 * tipe, kategori, atau nama akun -- semua akun lama seragam `ALL_BRANCH`.
 * Satu-satunya nilai non-default otomatis: akun yang ditandai sistem untuk
 * penyeimbang saldo awal (is_system_account = 1 DAN account_subtype =
 * 'opening_balance_adjustment') -> SYSTEM_ONLY. Pada company.db yang ada
 * tidak ada akun seperti itu (penanda hanya dipakai jalur legacy), sehingga
 * backfill ini tidak mengubah akun apa pun; OWNER tetap dapat mengubahnya.
 *
 * `counterpart_branch_id`: cabang lawan untuk akun INTER_BRANCH. Terisi
 * <=> policy = INTER_BRANCH (trigger dua arah, insert dan update); cabang
 * lawan harus ada dan belum di-soft-delete. Cabang lawan TIDAK PERNAH
 * dibaca dari nama akun.
 */
export async function up(knex: Knex): Promise<void> {
  const existing = new Set((await knex.raw("PRAGMA table_info(accounts)")).map((r: { name: string }) => r.name));
  if (!existing.has("branch_policy")) {
    await knex.raw(
      "ALTER TABLE accounts ADD COLUMN branch_policy TEXT NOT NULL DEFAULT 'ALL_BRANCH' CHECK (branch_policy IN ('ALL_BRANCH','CENTRAL_ONLY','SYSTEM_ONLY','INTER_BRANCH'))",
    );
  }
  if (!existing.has("counterpart_branch_id")) {
    await knex.raw("ALTER TABLE accounts ADD COLUMN counterpart_branch_id TEXT REFERENCES branches(id) ON DELETE RESTRICT");
  }

  await knex.raw(
    "UPDATE accounts SET branch_policy = 'SYSTEM_ONLY' WHERE is_system_account = 1 AND account_subtype = 'opening_balance_adjustment' AND branch_policy = 'ALL_BRANCH'",
  );
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_accounts_counterpart_branch ON accounts(counterpart_branch_id)");

  const pairingCondition = `(NEW.branch_policy = 'INTER_BRANCH') <> (NEW.counterpart_branch_id IS NOT NULL)`;
  const counterpartValid = `NEW.counterpart_branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.counterpart_branch_id AND deleted_at IS NULL)`;
  for (const [suffix, event] of [
    ["ins", "BEFORE INSERT ON accounts"],
    ["upd", "BEFORE UPDATE OF branch_policy, counterpart_branch_id ON accounts"],
  ] as const) {
    await knex.raw(`
      CREATE TRIGGER accounts_branch_policy_pairing_${suffix}
      ${event}
      WHEN ${pairingCondition}
      BEGIN
        SELECT RAISE(ABORT, 'counterpart_branch_id wajib terisi untuk akun INTER_BRANCH dan wajib kosong untuk kebijakan lain');
      END;
    `);
    await knex.raw(`
      CREATE TRIGGER accounts_branch_policy_counterpart_valid_${suffix}
      ${event}
      WHEN ${counterpartValid}
      BEGIN
        SELECT RAISE(ABORT, 'Cabang lawan tidak ditemukan atau sudah dihapus');
      END;
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const trg of [
    "accounts_branch_policy_counterpart_valid_upd",
    "accounts_branch_policy_counterpart_valid_ins",
    "accounts_branch_policy_pairing_upd",
    "accounts_branch_policy_pairing_ins",
  ]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${trg}`);
  }
  await knex.raw("DROP INDEX IF EXISTS idx_accounts_counterpart_branch");
  await knex.raw("ALTER TABLE accounts DROP COLUMN counterpart_branch_id");
  await knex.raw("ALTER TABLE accounts DROP COLUMN branch_policy");
}
