import ExcelJS from "exceljs";

export interface TemplateAccountRow {
  code: string;
  name: string;
}

/**
 * Template import Opening Balance (TASK-DB-ARCH-016 §11). SATU tanggal
 * ("Tanggal Saldo Awal") utk SELURUH baris -- lihat alasan di
 * parser.ts header comment. Sheet "Daftar Akun" (kode+nama akun
 * perusahaan ini) disertakan sbg referensi, pola sama dgn template Journal
 * Import (TASK-DB-ARCH-014) -- supaya user tidak perlu buka menu Akun
 * terpisah saat mengisi kode.
 */
export async function buildOpeningBalanceImportTemplate(companyName: string, accounts: TemplateAccountRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Saldo Awal");

  sheet.getCell("A1").value = "TEMPLATE IMPORT OPENING BALANCE / SALDO AWAL";
  sheet.getCell("A1").font = { bold: true };
  sheet.getCell("A2").value = companyName;
  sheet.getCell("A3").value = "Tanggal Saldo Awal:";
  sheet.getCell("A3").font = { bold: true };
  sheet.getCell("B3").value = new Date().toISOString().slice(0, 10);
  sheet.getCell("B3").numFmt = "yyyy-mm-dd";

  const instructions = [
    '1. "Tanggal Saldo Awal" di atas berlaku utk SELURUH baris di bawah -- opening balance adalah SATU jurnal per perusahaan, bukan per baris.',
    '2. Setiap baris HANYA boleh isi salah satu: Debet ATAU Kredit (tidak boleh keduanya), nilai tidak boleh negatif.',
    '3. Satu Kode Akun TIDAK BOLEH muncul lebih dari sekali di file ini (akan DITOLAK sbg error, bukan digabung otomatis).',
    '4. SELURUH baris harus balance: Total Debet = Total Kredit.',
    '5. Opening balance HANYA dapat dibuat SATU KALI per perusahaan (selama belum ada yang aktif/belum di-reversal).',
    '6. Hapus baris CONTOH di bawah sebelum mengisi data asli.',
    '7. Import TIDAK langsung masuk database -- akan ada tahap PREVIEW & VALIDASI, Anda WAJIB konfirmasi sebelum data benar-benar tersimpan.',
  ];
  instructions.forEach((text, i) => {
    sheet.getCell(`A${4 + i}`).value = text;
  });

  const headerRowNumber = 4 + instructions.length + 1;
  const headerRow = sheet.getRow(headerRowNumber);
  headerRow.values = ["Kode Akun", "Nama Akun", "Debet", "Kredit", "Keterangan"];
  headerRow.font = { bold: true };

  const sample = accounts.slice(0, 2);
  if (sample.length === 2) {
    sheet.getRow(headerRowNumber + 1).values = [sample[0].code, sample[0].name, 1000000, null, "CONTOH -- hapus baris ini"];
    sheet.getRow(headerRowNumber + 2).values = [sample[1].code, sample[1].name, null, 1000000, "CONTOH -- hapus baris ini"];
  }

  sheet.columns = [{ width: 12 }, { width: 28 }, { width: 16 }, { width: 16 }, { width: 28 }];

  const daftarAkun = workbook.addWorksheet("Daftar Akun");
  daftarAkun.getRow(1).values = ["Kode", "Nama Akun"];
  daftarAkun.getRow(1).font = { bold: true };
  accounts.forEach((acc, i) => {
    daftarAkun.getRow(2 + i).values = [acc.code, acc.name];
  });
  daftarAkun.columns = [{ width: 12 }, { width: 34 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
