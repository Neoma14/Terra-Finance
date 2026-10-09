import type { ChartOfAccountsTemplate } from "./types.js";

/**
 * Template koperasi serba usaha (simpan-pinjam + konsumsi). Perbedaan
 * paling penting dari korporat biasa: ekuitas terdiri dari 3 komponen
 * (Simpanan Pokok, Simpanan Wajib, SHU Ditahan) bukan modal saham + laba
 * ditahan, dan sisa hasil usaha (SHU) berperan seperti "laba ditahan".
 * Simpanan Wajib dijadikan akun "plug" penyeimbang neraca di data contoh
 * karena besarnya lazim berfluktuasi mengikuti jumlah & iuran anggota.
 */
export const cooperativeTemplate: ChartOfAccountsTemplate = {
  key: "cooperative",
  balancingAccountCode: "3200",
  retainedEarningsAccountCode: "3300",
  accounts: [
    { code: "1100", name: "Kas & Bank", accountType: "asset", accountSubtype: "cash", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_cash", lineLabel: "Kas & Bank", isCash: true },
    { code: "1200", name: "Piutang Pinjaman Anggota", accountType: "asset", accountSubtype: "member_loans", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_member_loans", lineLabel: "Piutang Pinjaman Anggota", cashFlowActivity: "operating", subledgerType: "receivable" },
    { code: "1300", name: "Persediaan Barang (Unit Konsumsi)", accountType: "asset", accountSubtype: "current_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_inventory", lineLabel: "Persediaan Barang (Unit Konsumsi)", cashFlowActivity: "operating" },
    { code: "1400", name: "PPh Pasal 25/Final Dibayar Dimuka", accountType: "asset", accountSubtype: "prepaid_tax", normalBalance: "debit", statementType: "balance_sheet", lineCode: "ca_prepaid_tax", lineLabel: "PPh Pasal 25/Final Dibayar Dimuka", cashFlowActivity: "operating" },
    { code: "1500", name: "Aset Tetap", accountType: "asset", accountSubtype: "fixed_asset", normalBalance: "debit", statementType: "balance_sheet", lineCode: "fa_fixed", lineLabel: "Aset Tetap (neto)", cashFlowActivity: "investing" },
    { code: "2100", name: "Utang Usaha", accountType: "liability", accountSubtype: "current_liability", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_payable", lineLabel: "Utang Usaha", cashFlowActivity: "operating", subledgerType: "payable" },
    { code: "2200", name: "Simpanan Sukarela Anggota", accountType: "liability", accountSubtype: "member_deposits", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_voluntary_deposit", lineLabel: "Simpanan Sukarela Anggota", cashFlowActivity: "financing" },
    { code: "2610", name: "Utang PPh Final Ps. 4(2) atas Bunga Simpanan Anggota", accountType: "liability", accountSubtype: "tax_withholding_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_wht_member_interest", lineLabel: "Utang PPh Final Ps. 4(2) atas Bunga Simpanan Anggota (Pemotongan)", cashFlowActivity: "operating" },
    { code: "2820", name: "Utang PPh Badan/Final UMKM", accountType: "liability", accountSubtype: "tax_payable", normalBalance: "credit", statementType: "balance_sheet", lineCode: "cl_tax_pph", lineLabel: "Utang PPh Badan/Final UMKM", cashFlowActivity: "operating" },
    { code: "3100", name: "Simpanan Pokok Anggota", accountType: "equity", accountSubtype: "member_equity", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_principal", lineLabel: "Simpanan Pokok Anggota", cashFlowActivity: "financing" },
    { code: "3200", name: "Simpanan Wajib Anggota", accountType: "equity", accountSubtype: "member_equity", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_mandatory", lineLabel: "Simpanan Wajib Anggota", cashFlowActivity: "financing" },
    { code: "3300", name: "SHU Ditahan", accountType: "equity", accountSubtype: "equity_retained", normalBalance: "credit", statementType: "balance_sheet", lineCode: "eq_shu", lineLabel: "SHU Ditahan" },
    { code: "4100", name: "Pendapatan Jasa Pinjaman Anggota", accountType: "revenue", accountSubtype: "operating_revenue", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue_interest", lineLabel: "Pendapatan Jasa Pinjaman Anggota" },
    { code: "4200", name: "Pendapatan Penjualan (Unit Konsumsi)", accountType: "revenue", accountSubtype: "operating_revenue", normalBalance: "credit", statementType: "income_statement", lineCode: "is_revenue_sales", lineLabel: "Pendapatan Penjualan (Unit Konsumsi)" },
    { code: "5100", name: "Beban Bagi Hasil/Bunga Simpanan Anggota", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_member", lineLabel: "Beban Bagi Hasil/Bunga Simpanan Anggota" },
    { code: "6100", name: "Beban Operasional Koperasi", accountType: "expense", accountSubtype: "operating_expense", normalBalance: "debit", statementType: "income_statement", lineCode: "is_expense_opex", lineLabel: "Beban Operasional Koperasi" },
  ],
};
