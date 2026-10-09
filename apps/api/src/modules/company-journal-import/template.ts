import ExcelJS from "exceljs";

export interface TemplateAccountRow {
  code: string;
  name: string;
}

/**
 * Template upload jurnal (TASK-DB-ARCH-014 §8) -- Company DB scope. Header
 * SENGAJA sama persis dgn yang dikenali `HEADER_ALIASES` di
 * `modules/journal/parser.ts` (Kode Akun/Tgl/No Jurnal/Akun Buku
 * Besar/Keterangan/Debet/Kredit) supaya parser yang SAMA (TIDAK diubah)
 * bisa langsung membaca file ini -- lihat journal-import-service.ts.
 *
 * BEDA dari template shared-DB lama (`modules/journal/template.ts`):
 * TIDAK ADA kolom "Vendor/Pelanggan" -- counterparty/subledger auto-
 * tagging via import BUKAN scope TASK-DB-ARCH-014 (§9 instruksi: "jangan
 * over-engineer"), didokumentasikan sbg limitation, bukan diam-diam
 * dihapus tanpa alasan.
 */
export async function buildCompanyJournalImportTemplate(companyName: string, accounts: TemplateAccountRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const jurnal = workbook.addWorksheet("Jurnal");

  jurnal.getCell("A1").value = "TEMPLATE UPLOAD JURNAL";
  jurnal.getCell("A1").font = { bold: true };
  jurnal.getCell("A2").value = companyName;
  jurnal.getCell("A3").value = "PETUNJUK PENGGUNAAN:";
  jurnal.getCell("A3").font = { bold: true };
  const instructions = [
    '1. Satu transaksi/jurnal = satu blok baris berurutan. Pisahkan antar transaksi dengan SATU BARIS KOSONG. Tanpa kolom "No Jurnal", baris berurutan yang tanggalnya sama dijadikan satu transaksi; tanggal berbeda otomatis menjadi transaksi terpisah.',
    '2. Kolom "No Jurnal" boleh dikosongkan (nomor dibuat otomatis saat commit) -- isi hanya jika ingin nomor tertentu.',
    '3. Setiap baris HANYA boleh isi salah satu: Debet ATAU Kredit (tidak boleh keduanya).',
    '4. Setiap transaksi WAJIB balance: total Debet = total Kredit, dan minimal punya 1 baris debit + 1 baris kredit.',
    '5. Format tanggal: YYYY-MM-DD (mis. 2026-01-15). Kode Akun harus sesuai sheet "Daftar Akun".',
    '6. Hapus baris CONTOH di bawah sebelum mengisi data asli.',
  ];
  instructions.forEach((text, i) => {
    jurnal.getCell(`A${4 + i}`).value = text;
  });

  const headerRowNumber = 4 + instructions.length + 1;
  const headerRow = jurnal.getRow(headerRowNumber);
  headerRow.values = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"];
  headerRow.font = { bold: true };

  const sample = accounts.slice(0, 2);
  const today = new Date().toISOString().slice(0, 10);
  if (sample.length === 2) {
    jurnal.getRow(headerRowNumber + 1).values = [sample[0].code, today, "", sample[0].name, "CONTOH -- hapus baris ini", 1000000, null];
    jurnal.getRow(headerRowNumber + 2).values = [sample[1].code, today, "", sample[1].name, "CONTOH -- hapus baris ini", null, 1000000];
  }

  jurnal.columns = [{ width: 12 }, { width: 12 }, { width: 14 }, { width: 28 }, { width: 28 }, { width: 16 }, { width: 16 }];

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
