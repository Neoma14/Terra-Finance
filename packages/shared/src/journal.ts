export interface Counterparty {
  id: string;
  type: "vendor" | "customer";
  code: string;
  name: string;
  isActive: boolean;
}

export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string;
  counterpartyId?: string | null;
}

export interface JournalEntrySummary {
  id: string;
  entryDate: string;
  periodId: string;
  referenceNo: string | null;
  description: string | null;
  source: "manual" | "import";
  isReversed: boolean;
  reversalOfId: string | null;
  totalDebit: number;
  totalCredit: number;
  lineCount: number;
  createdAt: string;
}

/** Satu baris di tabel Riwayat Jurnal -- SATU BARIS PER journal_entry_line
 * (bukan diringkas per entry), meniru persis layout template upload jurnal
 * (Kode Akun, Tgl, No Jurnal, Akun Buku Besar, Keterangan, Debet, Kredit)
 * supaya konsultan bisa langsung cocokkan dengan Excel yang mereka kenal. */
export interface JournalHistoryLine {
  journalEntryId: string;
  accountCode: string;
  accountName: string;
  entryDate: string;
  referenceNo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  isReversed: boolean;
  reversalOfId: string | null;
}

export interface JournalEntryDetail extends JournalEntrySummary {
  lines: {
    id: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    debit: number;
    credit: number;
    memo: string | null;
    counterpartyId: string | null;
    counterpartyName: string | null;
  }[];
}

// ---- Excel journal upload ----

export interface ParsedJournalLine {
  rowNumber: number;
  code: string;
  accountName: string;
  keterangan: string;
  debit: number;
  credit: number;
  /** Nama vendor/pelanggan dari kolom "Vendor/Pelanggan" template (kosong
   * kalau tidak diisi/tidak relevan) -- HANYA dipakai kalau akun baris ini
   * ditandai subledger_type payable/receivable; kalau nama belum terdaftar
   * di Kartu Hutang/Piutang, dibuat otomatis saat commit. */
  counterpartyName: string;
}

export interface ParsedJournalEntry {
  referenceNo: string | null;
  date: string;
  lines: ParsedJournalLine[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
  /** Kode akun di lines yang tidak ditemukan di chart of accounts perusahaan ini. */
  unknownAccountCodes: string[];
  /** true kalau referenceNo entry ini SUDAH ada di jurnal perusahaan
   * (sudah pernah di-commit sebelumnya) -- BUKAN error, entry ini otomatis
   * DILEWATI (tidak dicoba di-commit lagi) saat tombol Commit ditekan,
   * supaya upload ulang file yang sebagian datanya sudah lama diinput
   * tidak perlu diedit manual dulu. */
  alreadyExists: boolean;
}

export interface JournalPreviewResult {
  entries: ParsedJournalEntry[];
  fileErrors: string[];
  /** true kalau SEMUA entry BARU (belum ada di jurnal) balance & kode
   * akunnya dikenal -- entry yang alreadyExists TIDAK dihitung di sini
   * karena toh akan dilewati otomatis, bukan menghalangi commit. */
  allBalanced: boolean;
}

export interface JournalCommitLineInput {
  /** Kode akun (bukan UUID) -- hasil parsing Excel cuma punya kode, backend
   * yang resolve ke account_id sambil validasi ulang kode itu ada. */
  code: string;
  debit: number;
  credit: number;
  memo?: string;
  /** Nama vendor/pelanggan (opsional) -- dicari-atau-dibuat otomatis oleh
   * backend saat commit, lihat ParsedJournalLine.counterpartyName. */
  counterpartyName?: string;
}

export interface JournalCommitEntryInput {
  referenceNo?: string | null;
  date: string;
  lines: JournalCommitLineInput[];
  description?: string;
}

// ---- Buku Besar / Detail Akun ----

export interface LedgerLine {
  journalEntryId: string;
  entryDate: string;
  referenceNo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
  isReversed: boolean;
}

export interface LedgerResult {
  accountId: string;
  accountCode: string;
  accountName: string;
  normalBalance: "debit" | "credit";
  periodId: string;
  periodLabel: string;
  beginningBalance: number;
  endingBalance: number;
  lines: LedgerLine[];
}

export interface AccountBalanceSummary {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  beginningBalance: number;
  debitTotal: number;
  creditTotal: number;
  endingBalance: number;
}
