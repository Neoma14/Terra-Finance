export interface SubledgerCounterpartySummary {
  counterpartyId: string;
  counterpartyName: string;
  counterpartyCode: string;
  beginningBalance: number;
  debitTotal: number;
  creditTotal: number;
  endingBalance: number;
}

export interface SubledgerTransaction {
  journalEntryId: string;
  entryDate: string;
  referenceNo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface SubledgerDetail {
  counterparty: { id: string; code: string; name: string };
  accountCode: string;
  accountName: string;
  beginningBalance: number;
  endingBalance: number;
  transactions: SubledgerTransaction[];
}

/** Bisa lebih dari satu akun -- akun mana pun yang punya baris ber-vendor/
 * pelanggan otomatis ditandai payable/receivable (lihat createJournalEntry
 * di posting.ts), jadi Kartu Hutang/Piutang MENGGABUNGKAN semua akun
 * dengan tag itu (bukan cuma satu akun tetap) supaya semua transaksi
 * ber-vendor/pelanggan pasti kehitung, dari akun manapun. */
export interface SubledgerOverview {
  type: "payable" | "receivable";
  accounts: { code: string; name: string }[];
  periodLabel: string;
  counterparties: SubledgerCounterpartySummary[];
  totalEndingBalance: number;
}

export interface CashFlowAccountContribution {
  accountId: string;
  code: string;
  name: string;
  beginningBalance: number;
  endingBalance: number;
  delta: number;
  contribution: number;
}

export interface CashFlowDetailResult {
  periodId: string;
  operating: CashFlowAccountContribution[];
  investing: CashFlowAccountContribution[];
  financing: CashFlowAccountContribution[];
}
