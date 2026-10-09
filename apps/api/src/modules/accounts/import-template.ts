import ExcelJS from "exceljs";

/**
 * Template import Chart of Accounts + Saldo Awal -- fitur BARU (tidak ada
 * di versi online), dibuat khusus supaya konsultan yang pindah dari
 * software lama bisa impor daftar akun+saldo lengkap sekaligus lewat
 * Excel, bukan input manual satu-satu lewat modal "Tambah Akun". Header
 * teks di sini HARUS sama dengan yang dicari import-parser.ts.
 */
export async function buildAccountsImportTemplate(companyName: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Akun");

  sheet.getCell("A1").value = "TEMPLATE IMPORT AKUN + SALDO AWAL";
  sheet.getCell("A1").font = { bold: true };
  sheet.getCell("A2").value = companyName;
  sheet.getCell("A3").value = "Tanggal Saldo Awal:";
  sheet.getCell("A3").font = { bold: true };
  sheet.getCell("B3").value = new Date().toISOString().slice(0, 10);
  sheet.getCell("B3").numFmt = "yyyy-mm-dd";
  sheet.getCell("A4").value =
    'Kolom "Saldo Awal" boleh dikosongkan/0 kalau akun belum punya saldo. Isi "Tanggal Saldo Awal" di atas SEKALI (berlaku utk semua baris yang saldo awalnya diisi). Kode yang SUDAH ADA di aplikasi akan dilewati otomatis (tidak menimpa). WAJIB ada TEPAT SATU baris dengan Sub Tipe "equity_retained" (Laba Ditahan) supaya penutupan laba/rugi periode berjalan otomatis.';
  sheet.getCell("A4").alignment = { wrapText: true };
  sheet.mergeCells("A4:I4");
  sheet.getRow(4).height = 45;

  const headerRow = sheet.getRow(6);
  headerRow.values = [
    "Kode",
    "Nama Akun",
    "Tipe",
    "Sub Tipe",
    "Saldo Normal",
    "Kas (Ya/Tidak)",
    "Aktivitas Arus Kas",
    "Kartu (Hutang/Piutang)",
    "Saldo Awal",
  ];
  headerRow.font = { bold: true };

  const sample = [
    ["1100", "Kas & Setara Kas", "Aset", "cash", "Debit", "Ya", "", "", 5000000],
    ["1200", "Piutang Usaha", "Aset", "current_asset", "Debit", "Tidak", "Operasi", "Piutang", 0],
    ["2100", "Utang Usaha", "Liabilitas", "current_liability", "Kredit", "Tidak", "Operasi", "Hutang", 0],
    ["3100", "Modal Pemilik", "Ekuitas", "equity", "Kredit", "Tidak", "Pendanaan", "", 5000000],
    ["3200", "Laba Ditahan", "Ekuitas", "equity_retained", "Kredit", "Tidak", "", "", 0],
    ["4100", "Pendapatan Penjualan", "Pendapatan", "operating_revenue", "Kredit", "Tidak", "", "", 0],
    ["6100", "Beban Operasional", "Beban", "operating_expense", "Debit", "Tidak", "", "", 0],
  ];
  sample.forEach((row, i) => {
    sheet.getRow(7 + i).values = row;
  });

  sheet.columns = [
    { width: 12 },
    { width: 28 },
    { width: 14 },
    { width: 20 },
    { width: 14 },
    { width: 14 },
    { width: 18 },
    { width: 20 },
    { width: 16 },
  ];

  const ref = workbook.addWorksheet("Referensi");
  ref.getCell("A1").value = "Nilai yang diterima kolom \"Tipe\":";
  ref.getCell("A1").font = { bold: true };
  ["Aset", "Liabilitas", "Ekuitas", "Pendapatan", "Beban"].forEach((v, i) => (ref.getCell(2 + i, 1).value = v));

  ref.getCell("C1").value = 'Nilai yang diterima kolom "Aktivitas Arus Kas" (boleh kosong):';
  ref.getCell("C1").font = { bold: true };
  ["Operasi", "Investasi", "Pendanaan"].forEach((v, i) => (ref.getCell(2 + i, 3).value = v));

  ref.getCell("E1").value = 'Nilai yang diterima kolom "Kartu" (boleh kosong):';
  ref.getCell("E1").font = { bold: true };
  ["Hutang", "Piutang"].forEach((v, i) => (ref.getCell(2 + i, 5).value = v));

  ref.getCell("A9").value = 'Kolom "Sub Tipe" bebas teks (maks 50 karakter) -- contoh yang dipakai template bawaan aplikasi:';
  ref.getCell("A9").font = { bold: true };
  ref.mergeCells("A9:F9");
  const subtypes = [
    "cash",
    "current_asset",
    "prepaid_tax",
    "fixed_asset",
    "current_liability",
    "long_term_liability",
    "tax_payable",
    "equity",
    "equity_retained (WAJIB tepat 1 akun)",
    "operating_revenue",
    "cogs",
    "operating_expense",
  ];
  subtypes.forEach((v, i) => (ref.getCell(10 + i, 1).value = v));

  ref.columns = [{ width: 34 }, { width: 14 }, { width: 40 }, { width: 14 }, { width: 34 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
