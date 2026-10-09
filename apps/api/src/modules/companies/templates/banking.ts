import type { ChartOfAccountsTemplate } from "./types.js";

/**
 * Template bank umum, disederhanakan untuk MVP. Perbedaan paling penting
 * dari template korporat biasa: Kredit yang Diberikan diklasifikasikan
 * sebagai "operating" (bukan investing) karena penyaluran kredit adalah
 * aktivitas usaha inti bank, dan Dana Pihak Ketiga (Giro/Tabungan/Deposito)
 * adalah LIABILITAS operating, bukan ekuitas. CKPN/penyisihan kerugian
 * belum dimodelkan sebagai akun kontra-aset terpisah (simplifikasi) --
 * bisa ditambahkan lewat modul chart-of-accounts kalau butuh presisi PSAK
 * 71 penuh.
 */
export const bankingTemplate: ChartOfAccountsTemplate = {
  key: "banking",
  balancingAccountCode: "3100",
  retainedEarningsAccountCode: "3200",
  accounts: [
    { code: "1100", name: "Kas", accountType: "asset", accountSubtype: "cash", normalBalance: "debit", statementType: "balance_sheet", lineCode: "a_cash", lineLabel: "Kas", isCash: true },
    { code: "1150", name: "Giro pada Bank Indonesia", accountType: "asset", accountSubtype: "cash", normalBalance: "debit", statementType: "balance_sheet", lineCode: "a_giro_bi", lineLabel: "Giro pada Bank Indonesia", isCash: true },
    { code: "1300", name: "Penempatan pada Bank Lain", accountType: "asset", accountSubtype: "interbank_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "a_interbank", lineLabel: "Penempatan pada Bank Lain", cashFlowActivity: "operating" },
    { code: "1400", name: "Kredit yang Diberikan (neto)", accountType: "asset", accountSubtype: "loans", normalBalance: "debit", statementType: "balance_sheet", lineCode: "a_loans", lineLabel: "Kredit yang Diberikan (neto)", cashFlowActivity: "operating" },
    { code: "1450", name: "PPh Pasal 25 Dibayar Dimuka", accountType: "asset", accountSubtype: "prepaid_tax", normalBalance: "debit", statementType: "balance_sheet", lineCode: "a_prepaid_tax", lineLabel: "PPh Pasal 25 Dibayar Dimuka", cashFlowActivity: "operating" },
    { code: "1500", name: "Aset Tetap", accountType: "asset", accountSubtype: "fixed_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "a_fixed", lineLabel: "Aset Tetap (neto)", cashFlowActivity: "investing" },
    { code: "2100", name: "Giro Nasabah", accountType: "liability", accountSubtype: "deposits", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_giro", lineLabel: "Giro Nasabah", cashFlowActivity: "operating" },
    { code: "2200", name: "Tabungan Nasabah", accountType: "liability", accountSubtype: "deposits", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_savings", lineLabel: "Tabungan Nasabah", cashFlowActivity: "operating" },
    { code: "2300", name: "Deposito Berjangka", accountType: "liability", accountSubtype: "deposits", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_deposits", lineLabel: "Deposito Berjangka", cashFlowActivity: "operating" },
    { code: "2500", name: "Pinjaman Diterima", accountType: "liability", accountSubtype: "borrowings", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_borrowing", lineLabel: "Pinjaman Diterima", cashFlowActivity: "financing" },
    { code: "2610", name: "Utang PPh Final Ps. 4(2) atas Bunga Nasabah", accountType: "liability", accountSubtype: "tax_withholding_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_tax_wht_interest", lineLabel: "Utang PPh Final Ps. 4(2) atas Bunga Nasabah (Pemotongan)", cashFlowActivity: "operating" },
    { code: "2810", name: "Utang PPh Pasal 21", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_tax_pph21", lineLabel: "Utang PPh Pasal 21", cashFlowActivity: "operating" },
    { code: "2820", name: "Utang PPh Pasal 29", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "l_tax_pph29", lineLabel: "Utang PPh Pasal 29", cashFlowActivity: "operating" },
    { code: "3100", name: "Modal Disetor", accountType: "equity", accountSubtype: "equity", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_capital", lineLabel: "Modal Disetor", cashFlowActivity: "financing" },
    { code: "3200", name: "Laba Ditahan", accountType: "equity", accountSubtype: "equity_retained", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_retained", lineLabel: "Laba Ditahan" },
    { code: "4100", name: "Pendapatan Bunga", accountType: "revenue", accountSubtype: "interest_income", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue_interest", lineLabel: "Pendapatan Bunga" },
    { code: "4200", name: "Pendapatan Operasional Lainnya", accountType: "revenue", accountSubtype: "fee_income", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue_fee", lineLabel: "Pendapatan Operasional Lainnya (Fee-Based)" },
    { code: "5100", name: "Beban Bunga", accountType: "expense", accountSubtype: "interest_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_interest", lineLabel: "Beban Bunga" },
    { code: "5200", name: "Beban Operasional Lainnya", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_opex", lineLabel: "Beban Operasional Lainnya" },
  ],
};
