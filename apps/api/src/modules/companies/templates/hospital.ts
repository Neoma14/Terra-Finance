import type { ChartOfAccountsTemplate } from "./types.js";

/** Template rumah sakit (dimodelkan sebagai RS swasta berbadan PT). */
export const hospitalTemplate: ChartOfAccountsTemplate = {
  key: "hospital",
  balancingAccountCode: "3100",
  retainedEarningsAccountCode: "3200",
  accounts: [
    { code: "1100", name: "Kas & Bank", accountType: "asset", accountSubtype: "cash", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_cash", lineLabel: "Kas & Bank", isCash: true },
    { code: "1200", name: "Piutang Pasien & BPJS/Asuransi", accountType: "asset", accountSubtype: "current_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_receivable", lineLabel: "Piutang Pasien & BPJS/Asuransi", cashFlowActivity: "operating", subledgerType: "receivable" },
    { code: "1300", name: "Persediaan Obat & BHP", accountType: "asset", accountSubtype: "current_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_inventory", lineLabel: "Persediaan Obat & Bahan Habis Pakai", cashFlowActivity: "operating" },
    { code: "1400", name: "PPh Pasal 25 Dibayar Dimuka", accountType: "asset", accountSubtype: "prepaid_tax", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_prepaid_tax", lineLabel: "PPh Pasal 25 Dibayar Dimuka", cashFlowActivity: "operating" },
    { code: "1500", name: "Aset Tetap (Gedung & Peralatan Medis)", accountType: "asset", accountSubtype: "fixed_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "fa_fixed", lineLabel: "Aset Tetap (Gedung & Peralatan Medis)", cashFlowActivity: "investing" },
    { code: "2100", name: "Utang Usaha (Obat & Alkes)", accountType: "liability", accountSubtype: "current_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_payable", lineLabel: "Utang Usaha (Obat & Alat Kesehatan)", cashFlowActivity: "operating", subledgerType: "payable" },
    { code: "2200", name: "Utang Jasa Medis & Dokter", accountType: "liability", accountSubtype: "current_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_medicalfee", lineLabel: "Utang Jasa Medis & Dokter", cashFlowActivity: "operating" },
    { code: "2500", name: "Utang Bank Jangka Panjang", accountType: "liability", accountSubtype: "long_term_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "ll_loan", lineLabel: "Utang Bank Jangka Panjang", cashFlowActivity: "financing" },
    { code: "2810", name: "Utang PPh Pasal 21", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_pph21", lineLabel: "Utang PPh Pasal 21", cashFlowActivity: "operating" },
    { code: "2820", name: "Utang PPN (Penjualan Obat Rawat Jalan)", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_vat", lineLabel: "Utang PPN (Penjualan Obat Rawat Jalan)", cashFlowActivity: "operating" },
    { code: "2830", name: "Utang PPh Pasal 29", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_pph29", lineLabel: "Utang PPh Pasal 29", cashFlowActivity: "operating" },
    { code: "3100", name: "Modal Pemilik", accountType: "equity", accountSubtype: "equity", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_capital", lineLabel: "Modal Pemilik", cashFlowActivity: "financing" },
    { code: "3200", name: "Laba Ditahan", accountType: "equity", accountSubtype: "equity_retained", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_retained", lineLabel: "Laba Ditahan" },
    { code: "4100", name: "Pendapatan Jasa Layanan Medis", accountType: "revenue", accountSubtype: "operating_revenue", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue_medical", lineLabel: "Pendapatan Jasa Layanan Medis" },
    { code: "4200", name: "Pendapatan Farmasi", accountType: "revenue", accountSubtype: "operating_revenue", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue_pharmacy", lineLabel: "Pendapatan Farmasi" },
    { code: "5100", name: "Beban Pelayanan Medis & Jasa Dokter", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_medical", lineLabel: "Beban Pelayanan Medis & Jasa Dokter" },
    { code: "5200", name: "Beban Farmasi & BHP", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_pharmacy", lineLabel: "Beban Farmasi & Bahan Habis Pakai" },
    { code: "6100", name: "Beban Umum & Administrasi", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_admin", lineLabel: "Beban Umum & Administrasi" },
  ],
};
