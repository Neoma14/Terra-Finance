import type { ChartOfAccountsTemplate } from "./types.js";

/**
 * Template umum untuk korporat/perusahaan dagang, manufaktur, migas, dll --
 * struktur Neraca klasik "aset lancar/tetap, liabilitas jangka pendek/
 * panjang". Cocok untuk klien seperti Pertamina (korporat migas besar)
 * secara struktur laporan, meskipun akun detail migas (eksplorasi, deplesi,
 * dll) belum dimodelkan -- bisa ditambah lewat modul chart-of-accounts.
 */
export const generalTemplate: ChartOfAccountsTemplate = {
  key: "general",
  balancingAccountCode: "3100",
  retainedEarningsAccountCode: "3200",
  accounts: [
    { code: "1100", name: "Kas & Setara Kas", accountType: "asset", accountSubtype: "cash", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_cash", lineLabel: "Kas & Setara Kas", isCash: true },
    { code: "1200", name: "Piutang Usaha", accountType: "asset", accountSubtype: "current_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_receivable", lineLabel: "Piutang Usaha", cashFlowActivity: "operating", subledgerType: "receivable" },
    { code: "1300", name: "Persediaan", accountType: "asset", accountSubtype: "current_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_inventory", lineLabel: "Persediaan", cashFlowActivity: "operating" },
    { code: "1400", name: "PPh Pasal 25 Dibayar Dimuka", accountType: "asset", accountSubtype: "prepaid_tax", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_prepaid_tax", lineLabel: "PPh Pasal 25 Dibayar Dimuka", cashFlowActivity: "operating" },
    { code: "1500", name: "Aset Tetap", accountType: "asset", accountSubtype: "fixed_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "fa_fixed", lineLabel: "Aset Tetap (neto)", cashFlowActivity: "investing" },
    { code: "2100", name: "Utang Usaha", accountType: "liability", accountSubtype: "current_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_payable", lineLabel: "Utang Usaha", cashFlowActivity: "operating", subledgerType: "payable" },
    { code: "2200", name: "Utang Bank Jangka Pendek", accountType: "liability", accountSubtype: "current_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_short_loan", lineLabel: "Utang Bank Jangka Pendek", cashFlowActivity: "financing" },
    { code: "2500", name: "Utang Jangka Panjang", accountType: "liability", accountSubtype: "long_term_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "ll_long_loan", lineLabel: "Utang Jangka Panjang", cashFlowActivity: "financing" },
    { code: "2810", name: "Utang PPh Pasal 21", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_pph21", lineLabel: "Utang PPh Pasal 21", cashFlowActivity: "operating" },
    { code: "2820", name: "Utang PPh Pasal 23", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_pph23", lineLabel: "Utang PPh Pasal 23", cashFlowActivity: "operating" },
    { code: "2830", name: "Utang PPN", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_vat", lineLabel: "Utang PPN", cashFlowActivity: "operating" },
    { code: "2840", name: "Utang PPh Pasal 29", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_pph29", lineLabel: "Utang PPh Pasal 29", cashFlowActivity: "operating" },
    { code: "3100", name: "Modal Pemilik", accountType: "equity", accountSubtype: "equity", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_capital", lineLabel: "Modal Pemilik", cashFlowActivity: "financing" },
    { code: "3200", name: "Laba Ditahan", accountType: "equity", accountSubtype: "equity_retained", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_retained", lineLabel: "Laba Ditahan" },
    { code: "4100", name: "Pendapatan Penjualan", accountType: "revenue", accountSubtype: "operating_revenue", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue", lineLabel: "Pendapatan" },
    { code: "5100", name: "Harga Pokok Penjualan", accountType: "expense", accountSubtype: "cogs", normalBalance: "debit", statementType: "income_statement", lineCode: "is_cogs", lineLabel: "Harga Pokok Penjualan" },
    { code: "6100", name: "Beban Operasional", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_opex", lineLabel: "Beban Operasional" },
  ],
};
