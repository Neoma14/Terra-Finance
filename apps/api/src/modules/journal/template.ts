import ExcelJS from "exceljs";

export interface TemplateAccountRow {
  code: string;
  name: string;
  subledgerType?: string | null;
}

/**
 * Template upload jurnal: sheet "Jurnal" pakai header teks yang sama
 * dengan yang dicari parser.ts (lihat HEADER_ALIASES di sana) supaya file
 * ini pasti langsung terbaca, plus 1 contoh transaksi 2-baris yang balance
 * (ditandai jelas "CONTOH" di kolom Keterangan) sebagai panduan format.
 * Kolom "Vendor/Pelanggan" opsional -- HANYA dipakai backend kalau baris
 * itu memakai akun yang ditandai subledger_type payable/receivable (lihat
 * sheet "Daftar Akun" kolom "Kartu"); nama yang belum terdaftar akan
 * otomatis dibuatkan Kartu Hutang/Piutang baru saat commit. Sheet "Daftar
 * Akun" berisi kode+nama akun perusahaan ini sebagai referensi supaya user
 * tidak perlu buka menu Akun terpisah saat mengisi kolom Kode Akun. Copy
 * verbatim dari versi online -- fungsi murni, tanpa akses DB.
 */
export async function buildJournalTemplate(companyName: string, accounts: TemplateAccountRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const jurnal = workbook.addWorksheet("Jurnal");

  jurnal.getCell("A1").value = "TEMPLATE UPLOAD JURNAL";
  jurnal.getCell("A1").font = { bold: true };
  jurnal.getCell("A2").value = companyName;
  jurnal.getCell("A3").value =
    'Kolom "No Jurnal" boleh dikosongkan (nomor otomatis). Kolom "Vendor/Pelanggan" isi HANYA untuk baris akun Kartu Hutang/Piutang (lihat sheet Daftar Akun) -- nama baru otomatis terdaftar. Hapus baris CONTOH sebelum isi data asli.';

  const headerRow = jurnal.getRow(5);
  headerRow.values = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit", "Vendor/Pelanggan"];
  headerRow.font = { bold: true };

  const sample = accounts.slice(0, 2);
  const today = new Date().toISOString().slice(0, 10);
  if (sample.length === 2) {
    jurnal.getRow(6).values = [sample[0].code, today, "", sample[0].name, "CONTOH -- hapus baris ini", 1000000, null, ""];
    jurnal.getRow(7).values = [sample[1].code, today, "", sample[1].name, "CONTOH -- hapus baris ini", null, 1000000, ""];
  }

  jurnal.columns = [
    { width: 12 },
    { width: 12 },
    { width: 14 },
    { width: 28 },
    { width: 28 },
    { width: 16 },
    { width: 16 },
    { width: 22 },
  ];

  const daftarAkun = workbook.addWorksheet("Daftar Akun");
  daftarAkun.getRow(1).values = ["Kode", "Nama Akun", "Kartu"];
  daftarAkun.getRow(1).font = { bold: true };
  accounts.forEach((acc, i) => {
    const kartu = acc.subledgerType === "payable" ? "Hutang" : acc.subledgerType === "receivable" ? "Piutang" : "";
    daftarAkun.getRow(2 + i).values = [acc.code, acc.name, kartu];
  });
  daftarAkun.columns = [{ width: 12 }, { width: 34 }, { width: 12 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
