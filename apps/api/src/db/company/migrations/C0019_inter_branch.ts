import type { Knex } from "knex";

/**
 * Inter-Branch (IB-1) -- skema transaksi antar-cabang.
 *
 * Dua tabel (`inter_branch_transactions`, `inter_branch_approvals`), satu kolom
 * pengaturan (`company_profile.inter_branch_expiry_days`), dan penjaga integritas
 * di level database. Tidak ada backfill dan tidak ada data yang diubah.
 *
 * Tiga jalur status yang TIDAK boleh dicampur (Spek §7):
 *   - `status`          : Business Transaction (WAITING_APPROVAL -> COMPLETED | REJECTED | CANCELLED | EXPIRED)
 *   - accounting event  : diturunkan dari jurnal (NOT_POSTED/POSTED) -- sengaja TIDAK disimpan
 *   - `reversal_state`  : NOT_REVERSED -> REVERSAL_WAITING -> REVERSED (hanya sah bila status = COMPLETED)
 *
 * Penjaga di sini adalah lapisan TERAKHIR; aturan bisnis yang ramah-pengguna ada di service.
 * Semua DDL idempoten (IF NOT EXISTS / cek PRAGMA) dengan pola yang sama seperti C0015-C0017.
 *
 * K-1  tautan IB pada jurnal dijaga ketat (INSERT dan UPDATE) tanpa melemahkan jurnal biasa.
 * K-2  keunikan akun INTER_BRANCH per (cabang lawan, tipe akun).
 * K-3  multi-cabang tidak dapat dimatikan selama ada transaksi IB yang masih menunggu.
 * F-2  awalan referensi `IB-` dicadangkan untuk jurnal IB (case/spasi dinormalkan).
 * F-7  akun INTER_BRANCH bukan akun kas dan tidak berklasifikasi arus kas.
 */

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS inter_branch_transactions (
    id TEXT PRIMARY KEY,
    transaction_no TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    transaction_date TEXT NOT NULL,
    from_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    to_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    amount DECIMAL(18,2) NOT NULL CHECK (amount > 0),
    description TEXT NOT NULL,
    reference_text TEXT,
    from_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    to_account_suggested_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    from_counterparty_id TEXT REFERENCES counterparties(id) ON DELETE RESTRICT,
    to_counterparty_id TEXT REFERENCES counterparties(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('WAITING_APPROVAL','COMPLETED','REJECTED','CANCELLED','EXPIRED')),
    reversal_state TEXT NOT NULL DEFAULT 'NOT_REVERSED' CHECK (reversal_state IN ('NOT_REVERSED','REVERSAL_WAITING','REVERSED')),
    proposed_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (from_branch_id <> to_branch_id),
    CHECK (reversal_state = 'NOT_REVERSED' OR status = 'COMPLETED'),
    UNIQUE (proposed_by, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS inter_branch_approvals (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES inter_branch_transactions(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('POST','REVERSE')),
    status TEXT NOT NULL CHECK (status IN ('WAITING','APPROVED','REJECTED','CANCELLED','EXPIRED')),
    requested_by TEXT NOT NULL,
    requested_by_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    requested_at TEXT NOT NULL,
    request_reason TEXT,
    expires_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    decision_reason TEXT,
    self_approved INTEGER NOT NULL DEFAULT 0 CHECK (self_approved IN (0,1)),
    confirmed_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
    CHECK (kind = 'POST' OR length(trim(coalesce(request_reason,''))) > 0),
    CHECK (status <> 'REJECTED' OR length(trim(coalesce(decision_reason,''))) > 0),
    CHECK (status NOT IN ('APPROVED','REJECTED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CHECK (self_approved = 0 OR (status = 'APPROVED' AND decided_by = requested_by))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_inter_branch_approvals_one_waiting
     ON inter_branch_approvals(transaction_id) WHERE status = 'WAITING'`,

  // ---- transaksi: kolom bisnis tidak berubah, hanya transisi sah, tidak ada DELETE --------------------
  `CREATE TRIGGER IF NOT EXISTS inter_branch_transactions_initial_state
   BEFORE INSERT ON inter_branch_transactions
   WHEN NEW.status <> 'WAITING_APPROVAL' OR NEW.reversal_state <> 'NOT_REVERSED'
   BEGIN SELECT RAISE(ABORT, 'IB: transaksi baru harus WAITING_APPROVAL dan NOT_REVERSED'); END`,
  `CREATE TRIGGER IF NOT EXISTS inter_branch_transactions_no_delete
   BEFORE DELETE ON inter_branch_transactions
   BEGIN SELECT RAISE(ABORT, 'IB: transaksi antar-cabang tidak dapat dihapus'); END`,
  `CREATE TRIGGER IF NOT EXISTS inter_branch_transactions_immutable
   BEFORE UPDATE ON inter_branch_transactions
   WHEN NEW.id IS NOT OLD.id OR NEW.transaction_no IS NOT OLD.transaction_no OR NEW.type IS NOT OLD.type
     OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.from_branch_id IS NOT OLD.from_branch_id
     OR NEW.to_branch_id IS NOT OLD.to_branch_id OR NEW.amount IS NOT OLD.amount OR NEW.description IS NOT OLD.description
     OR NEW.reference_text IS NOT OLD.reference_text OR NEW.from_account_id IS NOT OLD.from_account_id
     OR NEW.to_account_suggested_id IS NOT OLD.to_account_suggested_id OR NEW.from_counterparty_id IS NOT OLD.from_counterparty_id
     OR NEW.to_counterparty_id IS NOT OLD.to_counterparty_id OR NEW.proposed_by IS NOT OLD.proposed_by
     OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
   BEGIN SELECT RAISE(ABORT, 'IB: kolom bisnis transaksi antar-cabang tidak dapat diubah'); END`,
  `CREATE TRIGGER IF NOT EXISTS inter_branch_transactions_status_transition
   BEFORE UPDATE OF status ON inter_branch_transactions
   WHEN NEW.status <> OLD.status AND NOT (OLD.status = 'WAITING_APPROVAL' AND NEW.status IN ('COMPLETED','REJECTED','CANCELLED','EXPIRED'))
   BEGIN SELECT RAISE(ABORT, 'IB: transisi status transaksi tidak sah'); END`,
  `CREATE TRIGGER IF NOT EXISTS inter_branch_transactions_reversal_transition
   BEFORE UPDATE OF reversal_state ON inter_branch_transactions
   WHEN NEW.reversal_state <> OLD.reversal_state AND NOT (
        (OLD.reversal_state = 'NOT_REVERSED' AND NEW.reversal_state = 'REVERSAL_WAITING')
     OR (OLD.reversal_state = 'REVERSAL_WAITING' AND NEW.reversal_state IN ('REVERSED','NOT_REVERSED')))
   BEGIN SELECT RAISE(ABORT, 'IB: transisi reversal_state tidak sah'); END`,

  // ---- persetujuan: tidak ada DELETE, kolom permintaan tetap, final tidak berubah ----------------------
  `CREATE TRIGGER IF NOT EXISTS inter_branch_approvals_no_delete
   BEFORE DELETE ON inter_branch_approvals
   BEGIN SELECT RAISE(ABORT, 'IB: persetujuan antar-cabang tidak dapat dihapus'); END`,
  `CREATE TRIGGER IF NOT EXISTS inter_branch_approvals_request_immutable
   BEFORE UPDATE ON inter_branch_approvals
   WHEN NEW.id IS NOT OLD.id OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.kind IS NOT OLD.kind
     OR NEW.requested_by IS NOT OLD.requested_by OR NEW.requested_by_branch_id IS NOT OLD.requested_by_branch_id
     OR NEW.requested_at IS NOT OLD.requested_at OR NEW.request_reason IS NOT OLD.request_reason OR NEW.expires_at IS NOT OLD.expires_at
   BEGIN SELECT RAISE(ABORT, 'IB: data permintaan persetujuan tidak dapat diubah'); END`,
  `CREATE TRIGGER IF NOT EXISTS inter_branch_approvals_final_immutable
   BEFORE UPDATE ON inter_branch_approvals
   WHEN OLD.status <> 'WAITING'
   BEGIN SELECT RAISE(ABORT, 'IB: persetujuan yang sudah final tidak dapat diubah'); END`,

  // ---- K-1: tautan IB pada jurnal ---------------------------------------------------------------------
  `CREATE TRIGGER IF NOT EXISTS journal_entries_ib_link_ins
   BEFORE INSERT ON journal_entries
   WHEN NEW.inter_branch_transaction_id IS NOT NULL OR NEW.origin = 'inter_branch'
   BEGIN
     SELECT RAISE(ABORT, 'IB: origin inter_branch hanya untuk jurnal bertaut transaksi antar-cabang')
       WHERE NEW.inter_branch_transaction_id IS NULL;
     SELECT RAISE(ABORT, 'IB: jurnal bertaut transaksi antar-cabang harus berasal inter_branch')
       WHERE NEW.origin <> 'inter_branch';
     SELECT RAISE(ABORT, 'IB: referensi jurnal antar-cabang harus berawalan IB-')
       WHERE NEW.reference_no IS NULL OR NEW.reference_no NOT GLOB 'IB-*';
     SELECT RAISE(ABORT, 'IB: transaksi antar-cabang induk tidak ada')
       WHERE NOT EXISTS (SELECT 1 FROM inter_branch_transactions t WHERE t.id = NEW.inter_branch_transaction_id);
     SELECT RAISE(ABORT, 'IB: cabang jurnal tidak sesuai dengan sisi transaksi antar-cabang')
       WHERE NOT EXISTS (
         SELECT 1 FROM inter_branch_transactions t
          WHERE t.id = NEW.inter_branch_transaction_id
            AND ((NEW.inter_branch_side = 'FROM' AND t.from_branch_id = NEW.branch_id)
              OR (NEW.inter_branch_side = 'TO' AND t.to_branch_id = NEW.branch_id)));
     SELECT RAISE(ABORT, 'IB: status transaksi antar-cabang tidak sah untuk jurnal ini')
       WHERE NOT EXISTS (
         SELECT 1 FROM inter_branch_transactions t
          WHERE t.id = NEW.inter_branch_transaction_id AND t.status = 'COMPLETED'
            AND (NEW.inter_branch_leg = 'ORIGINAL' OR (NEW.inter_branch_leg = 'REVERSAL' AND t.reversal_state = 'REVERSED')));
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entries_ib_link_upd
   BEFORE UPDATE OF inter_branch_transaction_id, inter_branch_leg, inter_branch_side, origin ON journal_entries
   WHEN OLD.inter_branch_transaction_id IS NOT NEW.inter_branch_transaction_id
     OR OLD.inter_branch_leg IS NOT NEW.inter_branch_leg
     OR OLD.inter_branch_side IS NOT NEW.inter_branch_side
     OR (OLD.origin = 'inter_branch') <> (NEW.origin = 'inter_branch')
   BEGIN SELECT RAISE(ABORT, 'IB: tautan dan asal antar-cabang pada jurnal tidak dapat diubah lewat UPDATE'); END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entries_ib_core_upd
   BEFORE UPDATE ON journal_entries
   WHEN OLD.inter_branch_transaction_id IS NOT NULL AND OLD.status IN ('POSTED','REVERSED')
     AND (NEW.entry_date IS NOT OLD.entry_date OR NEW.period_id IS NOT OLD.period_id
       OR NEW.reference_no IS NOT OLD.reference_no OR NEW.branch_id IS NOT OLD.branch_id)
   BEGIN SELECT RAISE(ABORT, 'IB: kolom inti jurnal antar-cabang yang sudah diposting tidak dapat diubah'); END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entries_ib_status_upd
   BEFORE UPDATE OF status ON journal_entries
   WHEN OLD.inter_branch_transaction_id IS NOT NULL
     AND ((OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED','REVERSED')) OR (OLD.status = 'REVERSED' AND NEW.status <> 'REVERSED'))
   BEGIN SELECT RAISE(ABORT, 'IB: transisi status jurnal antar-cabang tidak sah'); END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entries_ib_no_delete
   BEFORE DELETE ON journal_entries
   WHEN OLD.inter_branch_transaction_id IS NOT NULL
   BEGIN SELECT RAISE(ABORT, 'IB: jurnal antar-cabang tidak dapat dihapus'); END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entry_lines_ib_upd
   BEFORE UPDATE ON journal_entry_lines
   WHEN EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = OLD.journal_entry_id
                 AND j.inter_branch_transaction_id IS NOT NULL AND j.status IN ('POSTED','REVERSED'))
   BEGIN SELECT RAISE(ABORT, 'IB: baris jurnal antar-cabang yang sudah diposting tidak dapat diubah'); END`,
  `CREATE TRIGGER IF NOT EXISTS journal_entry_lines_ib_del
   BEFORE DELETE ON journal_entry_lines
   WHEN EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = OLD.journal_entry_id
                 AND j.inter_branch_transaction_id IS NOT NULL AND j.status IN ('POSTED','REVERSED'))
   BEGIN SELECT RAISE(ABORT, 'IB: baris jurnal antar-cabang yang sudah diposting tidak dapat dihapus'); END`,
  // Jurnal REVERSAL dibuat sebagai header POSTED lebih dulu lalu barisnya (urutan reverseJournalEntry), jadi hanya ORIGINAL yang dijaga pada INSERT.
  `CREATE TRIGGER IF NOT EXISTS journal_entry_lines_ib_ins
   BEFORE INSERT ON journal_entry_lines
   WHEN EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id
                 AND j.inter_branch_transaction_id IS NOT NULL AND j.inter_branch_leg = 'ORIGINAL' AND j.status <> 'DRAFT')
   BEGIN SELECT RAISE(ABORT, 'IB: tidak dapat menambah baris ke jurnal antar-cabang yang sudah diposting'); END`,

  // ---- F-2: awalan referensi IB- dicadangkan (case dan spasi dinormalkan) ----------------------------
  `CREATE TRIGGER IF NOT EXISTS journal_entries_ib_ref_reserved
   BEFORE INSERT ON journal_entries
   WHEN upper(trim(NEW.reference_no)) LIKE 'IB-%' AND NEW.origin <> 'inter_branch'
   BEGIN SELECT RAISE(ABORT, 'IB: awalan referensi IB- dicadangkan untuk transaksi antar-cabang'); END`,

  // ---- K-3: multi-cabang tidak dapat dimatikan selama ada transaksi IB yang menunggu -------------------
  `CREATE TRIGGER IF NOT EXISTS company_profile_ib_flag_off
   BEFORE UPDATE OF multi_branch_enabled ON company_profile
   WHEN OLD.multi_branch_enabled = 1 AND NEW.multi_branch_enabled = 0
     AND EXISTS (SELECT 1 FROM inter_branch_transactions WHERE status = 'WAITING_APPROVAL' OR reversal_state = 'REVERSAL_WAITING')
   BEGIN SELECT RAISE(ABORT, 'IB: multi-cabang tidak dapat dimatikan selama masih ada transaksi antar-cabang yang menunggu'); END`,

  // ---- K-2: satu akun INTER_BRANCH per (cabang lawan, tipe akun) -------------------------------------
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_inter_branch_pair
     ON accounts(counterpart_branch_id, account_type_id) WHERE branch_policy = 'INTER_BRANCH'`,

  // ---- F-7: akun INTER_BRANCH bukan akun kas dan tidak berklasifikasi arus kas ---------------------
  `CREATE TRIGGER IF NOT EXISTS accounts_ib_cash_ins
   BEFORE INSERT ON accounts
   WHEN NEW.branch_policy = 'INTER_BRANCH' AND (NEW.is_cash <> 0 OR NEW.cash_flow_activity IS NOT NULL)
   BEGIN SELECT RAISE(ABORT, 'IB: akun antar-cabang tidak boleh akun kas atau berklasifikasi arus kas'); END`,
  `CREATE TRIGGER IF NOT EXISTS accounts_ib_cash_upd
   BEFORE UPDATE OF branch_policy, is_cash, cash_flow_activity ON accounts
   WHEN NEW.branch_policy = 'INTER_BRANCH' AND (NEW.is_cash <> 0 OR NEW.cash_flow_activity IS NOT NULL)
   BEGIN SELECT RAISE(ABORT, 'IB: akun antar-cabang tidak boleh akun kas atau berklasifikasi arus kas'); END`,
];

const TRIGGERS = [
  "accounts_ib_cash_upd",
  "accounts_ib_cash_ins",
  "company_profile_ib_flag_off",
  "journal_entries_ib_ref_reserved",
  "journal_entry_lines_ib_ins",
  "journal_entry_lines_ib_del",
  "journal_entry_lines_ib_upd",
  "journal_entries_ib_no_delete",
  "journal_entries_ib_status_upd",
  "journal_entries_ib_core_upd",
  "journal_entries_ib_link_upd",
  "journal_entries_ib_link_ins",
  "inter_branch_approvals_final_immutable",
  "inter_branch_approvals_request_immutable",
  "inter_branch_approvals_no_delete",
  "inter_branch_transactions_reversal_transition",
  "inter_branch_transactions_status_transition",
  "inter_branch_transactions_immutable",
  "inter_branch_transactions_no_delete",
  "inter_branch_transactions_initial_state",
];

export async function up(knex: Knex): Promise<void> {
  const profileColumns = new Set((await knex.raw("PRAGMA table_info(company_profile)")).map((r: { name: string }) => r.name));
  if (!profileColumns.has("inter_branch_expiry_days")) {
    await knex.raw("ALTER TABLE company_profile ADD COLUMN inter_branch_expiry_days INTEGER NOT NULL DEFAULT 14 CHECK (inter_branch_expiry_days BETWEEN 1 AND 90)");
  }
  for (const statement of STATEMENTS) await knex.raw(statement);
}

export async function down(knex: Knex): Promise<void> {
  for (const trigger of TRIGGERS) await knex.raw(`DROP TRIGGER IF EXISTS ${trigger}`);
  await knex.raw("DROP INDEX IF EXISTS uq_accounts_inter_branch_pair");
  await knex.raw("DROP INDEX IF EXISTS uq_inter_branch_approvals_one_waiting");
  await knex.raw("DROP TABLE IF EXISTS inter_branch_approvals");
  await knex.raw("DROP TABLE IF EXISTS inter_branch_transactions");
  const profileColumns = new Set((await knex.raw("PRAGMA table_info(company_profile)")).map((r: { name: string }) => r.name));
  if (profileColumns.has("inter_branch_expiry_days")) await knex.raw("ALTER TABLE company_profile DROP COLUMN inter_branch_expiry_days");
}
