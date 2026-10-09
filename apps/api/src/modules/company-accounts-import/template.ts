import ExcelJS from "exceljs";

/**
 * Template import COA (TASK-DB-ARCH-015 §11). Kolom HANYA yang benar2
 * dipakai schema `accounts` existing (C0003) -- SENGAJA TIDAK ADA kolom
 * "Description" (tabel `accounts` tidak punya kolom itu sama sekali,
 * instruksi §11 eksplisit: "jangan memaksakan field yang tidak tersedia")
 * dan TIDAK ADA "Saldo Awal" (workflow saldo awal di luar scope, sama
 * alasannya dgn account-service.ts §15).
 */
export async function buildAccountsImportTemplate(companyName: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Akun");

  sheet.getCell("A1").value = "TEMPLATE IMPORT CHART OF ACCOUNTS";
  sheet.getCell("A1").font = { bold: true };
  sheet.getCell("A2").value = companyName;
  sheet.getCell("A3").value = "PETUNJUK PENGGUNAAN:";
  sheet.getCell("A3").font = { bold: true };
  const instructions = [
    '1. Kolom "Kode" & "Nama Akun" WAJIB diisi. Kode TIDAK BOLEH sama dengan akun yang sudah ada -- kode yang sudah ada akan OTOMATIS DILEWATI (tidak menimpa), bukan error.',
    '2. Kolom "Tipe" WAJIB -- lihat sheet "Referensi" utk nilai yang diterima.',
    '3. Kolom "Kode Induk" (opsional) harus mengacu ke akun lain yang SUDAH ADA di database ATAU akun lain DI FILE INI -- akun tidak boleh menjadi induk bagi dirinya sendiri, dan tidak boleh membentuk struktur melingkar (A induk B, B induk A).',
    '4. Kolom "Saldo Normal" boleh dikosongkan -- akan otomatis memakai default resmi sesuai Tipe (lihat sheet "Referensi"). Isi manual HANYA utk kasus khusus (mis. akun kontra).',
    '5. Kolom "Aktif" boleh dikosongkan (default: Ya). Kolom "Kas" & "Kartu" opsional.',
    '6. Hapus baris CONTOH di bawah sebelum mengisi data asli.',
    '7. Import TIDAK langsung masuk database -- akan ada tahap PREVIEW & VALIDASI, Anda WAJIB konfirmasi sebelum data benar-benar tersimpan.',
  ];
  instructions.forEach((text, i) => {
    sheet.getCell(`A${4 + i}`).value = text;
  });

  const headerRowNumber = 4 + instructions.length + 1;
  const headerRow = sheet.getRow(headerRowNumber);
  headerRow.values = ["Kode", "Nama Akun", "Tipe", "Kode Induk", "Saldo Normal", "Aktif", "Kas", "Aktivitas Arus Kas", "Kartu"];
  headerRow.font = { bold: true };

  const sample = [
    ["1000", "Kas & Setara Kas", "Aset", "", "", "Ya", "Ya", "", ""],
    ["1100", "Kas Kecil", "Aset", "1000", "", "Ya", "Ya", "", ""],
    ["1200", "Piutang Usaha", "Aset", "", "", "Ya", "Tidak", "Operasi", "Piutang"],
    ["2100", "Utang Usaha", "Liabilitas", "", "", "Ya", "Tidak", "Operasi", "Hutang"],
    ["3100", "Modal Pemilik", "Ekuitas", "", "", "Ya", "Tidak", "Pendanaan", ""],
    ["4100", "Pendapatan Penjualan", "Pendapatan", "", "", "Ya", "Tidak", "", ""],
    ["6100", "Beban Operasional", "Beban", "", "", "Ya", "Tidak", "", ""],
  ];
  sample.forEach((row, i) => {
    const r = sheet.getRow(headerRowNumber + 1 + i);
    r.values = row;
  });

  sheet.columns = [{ width: 12 }, { width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 18 }, { width: 16 }];

  const ref = workbook.addWorksheet("Referensi");
  ref.getCell("A1").value = 'Nilai yang diterima kolom "Tipe" (dan default "Saldo Normal"-nya):';
  ref.getCell("A1").font = { bold: true };
  const typeRef: [string, string][] = [
    ["Aset", "Debit"],
    ["Liabilitas", "Kredit"],
    ["Ekuitas", "Kredit"],
    ["Pendapatan", "Kredit"],
    ["HPP", "Debit"],
    ["Beban", "Debit"],
    ["Pendapatan Lain", "Kredit"],
    ["Beban Lain", "Debit"],
    ["Pajak", "Kredit"],
  ];
  typeRef.forEach(([type, balance], i) => {
    ref.getCell(2 + i, 1).value = type;
    ref.getCell(2 + i, 2).value = `default: ${balance}`;
  });

  ref.getCell("D1").value = 'Nilai "Aktivitas Arus Kas" (boleh kosong):';
  ref.getCell("D1").font = { bold: true };
  ["Operasi", "Investasi", "Pendanaan"].forEach((v, i) => (ref.getCell(2 + i, 4).value = v));

  ref.getCell("F1").value = 'Nilai "Kartu" (boleh kosong):';
  ref.getCell("F1").font = { bold: true };
  ["Hutang", "Piutang"].forEach((v, i) => (ref.getCell(2 + i, 6).value = v));

  ref.columns = [{ width: 16 }, { width: 14 }, { width: 4 }, { width: 16 }, { width: 4 }, { width: 14 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
