import type { IndustryTemplate, TaxReference } from "@konsultan/shared";

/**
 * Rujukan pajak per industri -- copy verbatim dari versi online
 * (modules/tax/reference.ts), sumber diverifikasi lewat web search
 * 2026-09-07 (DJP/pajak.go.id, DDTC, JDIH Kemenkeu). Kalau ada perubahan
 * regulasi, update di sini (satu tempat) -- dipakai baik oleh kalkulator
 * maupun panel referensi UI.
 */
const GENERAL: TaxReference = {
  umkmFacilityYears: 3,
  legalFormNote: "Perseroan Terbatas (PT) -- fasilitas PPh Final UMKM (PP 55/2022) berlaku maksimal 3 tahun pajak sejak terdaftar/pertama kali memenuhi syarat.",
  vat: {
    status: "kena_pajak",
    description: "Penyerahan barang/jasa kena pajak (BKP/JKP) dikenai PPN tarif umum 12%. Tidak ada pengecualian khusus untuk korporat/dagang/manufaktur umum.",
    legalBasis: "Pasal 7 UU PPN sebagaimana diubah UU HPP",
  },
  withholdingNotes: [],
  generalNotes: [
    "PPh Badan tarif umum 22% (UU HPP), dengan fasilitas Pasal 31E (diskon 50% tarif efektif) untuk omzet sampai dengan Rp50 miliar/tahun.",
    "Untuk korporat migas (mis. kontraktor Kontrak Kerja Sama/PSC), berlaku rezim pajak migas tersendiri (cost recovery, PPh migas) yang BELUM dimodelkan aplikasi ini -- estimasi di sini memakai perlakuan PPh Badan umum.",
  ],
};

const HOSPITAL: TaxReference = {
  umkmFacilityYears: 3,
  legalFormNote: "Rumah sakit swasta berbadan PT -- fasilitas PPh Final UMKM berlaku maksimal 3 tahun pajak. Rumah sakit berbentuk Yayasan atau BLUD (milik pemerintah) punya perlakuan berbeda yang belum dimodelkan di sini.",
  vat: {
    status: "campuran",
    description:
      "Jasa pelayanan kesehatan medis (jasa dokter, rumah sakit, klinik, laboratorium kesehatan, dll) BUKAN objek PPN -- tidak dipungut PPN atas jasa ini, tapi konsekuensinya PPN Masukan terkait TIDAK BISA dikreditkan. Namun, penjualan obat ke pasien RAWAT JALAN oleh instalasi farmasi tetap dikenai PPN 12% karena dianggap penyerahan barang terpisah dari jasa medis.",
    legalBasis: "Pasal 4A ayat (3) huruf a UU PPN sebagaimana diubah UU Cipta Kerja/UU HPP",
  },
  withholdingNotes: [],
  generalNotes: [
    "PPh Badan tetap tarif umum 22% dengan fasilitas Pasal 31E seperti korporat lain -- status non-objek PPN tidak berarti bebas PPh Badan atas laba.",
    "Karena PPN Masukan atas pengadaan obat/alkes untuk jasa medis tidak bisa dikreditkan, biaya tsb efektif menjadi lebih tinggi (PPN masukan jadi bagian dari harga pokok) -- perlu diperhitungkan konsultan saat menilai margin.",
  ],
};

const BANKING: TaxReference = {
  umkmFacilityYears: 3,
  legalFormNote: "Bank umum berbadan PT -- dalam praktiknya omzet bank jauh di atas ambang batas UMKM, sehingga PPh Final UMKM biasanya tidak relevan/tidak berlaku.",
  vat: {
    status: "dibebaskan",
    description:
      "Sejak UU HPP, jasa keuangan (menghimpun dana lewat giro/tabungan/deposito, menyalurkan kredit, dll) tidak lagi masuk daftar 'bukan objek PPN', tapi dipindah menjadi 'terutang PPN namun DIBEBASKAN'. Secara praktis tetap tidak dipungut PPN atas jasa keuangan inti. Jasa non-inti (fee-based, mis. jasa kustodian/agen tertentu) bisa tetap kena PPN normal.",
    legalBasis: "Pasal 16B ayat (1a) huruf j UU PPN hasil perubahan UU HPP (sebelumnya Pasal 4A ayat 3 UU PPN lama)",
  },
  withholdingNotes: [
    {
      title: "Kewajiban memotong PPh Final Pasal 4(2) atas bunga nasabah",
      description:
        "Bank wajib memotong PPh Final atas bunga deposito, tabungan, dan diskonto SBI yang dibayarkan ke nasabah (dikecualikan kalau saldo bunga <= Rp7.500.000 dan bukan pecahan). Ini kewajiban PEMOTONGAN bank sebagai pihak ketiga, BUKAN pajak penghasilan bank itu sendiri -- jangan dicampur dengan estimasi PPh Badan bank.",
      legalBasis: "PP 131/2000 jo. PP 123/2000, PMK 212/PMK.03/2018, PER-03/PJ/2020",
    },
  ],
  generalNotes: [
    "PPh Badan bank tetap tarif umum 22% atas laba bank sendiri -- pembebasan PPN di atas hanya untuk PPN, bukan PPh.",
    "CAR (Capital Adequacy Ratio) sesungguhnya adalah rasio permodalan OJK/Basel berbasis ATMR (aset tertimbang menurut risiko), BUKAN aturan pajak -- rasio 'Modal terhadap Aset' di modul Rasio Keuangan aplikasi ini hanya proksi sederhana, bukan CAR resmi.",
  ],
};

const COOPERATIVE: TaxReference = {
  umkmFacilityYears: 4,
  legalFormNote: "Koperasi -- fasilitas PPh Final UMKM (PP 55/2022) berlaku maksimal 4 TAHUN PAJAK (lebih panjang dari PT yang 3 tahun), sejak terdaftar/pertama kali memenuhi syarat.",
  vat: {
    status: "campuran",
    description:
      "Unit simpan-pinjam koperasi (penyaluran pinjaman ke anggota) mengikuti perlakuan jasa keuangan (dibebaskan dari PPN, sama seperti bank). Unit usaha dagang/konsumsi (penjualan barang ke anggota/umum) tetap kena PPN normal 12% seperti usaha dagang biasa.",
    legalBasis: "Pasal 16B ayat (1a) huruf j UU PPN (untuk unit simpan-pinjam); Pasal 7 UU PPN (untuk unit dagang)",
  },
  withholdingNotes: [
    {
      title: "Kewajiban memotong PPh Final Pasal 4(2) atas bunga simpanan anggota",
      description:
        "Koperasi wajib memotong PPh Final 10% atas bunga simpanan yang dibayarkan ke ANGGOTA ORANG PRIBADI untuk bagian bunga di atas Rp240.000/bulan (0% untuk bagian sampai Rp240.000/bulan). Ini kewajiban PEMOTONGAN koperasi sebagai pihak ketiga, BUKAN pajak penghasilan koperasi itu sendiri.",
      legalBasis: "PP 15/2009 jo. PMK-112/PMK.03/2010",
    },
  ],
  generalNotes: [
    "SHU (Sisa Hasil Usaha) adalah padanan 'Net Income' koperasi -- dasar perhitungan PPh Badan/PPh Final UMKM koperasi memakai SHU sebelum pembagian ke anggota.",
    "Setelah masa fasilitas PPh Final UMKM 4 tahun habis, koperasi kembali ke PPh Badan normal 22% dengan fasilitas Pasal 31E kalau omzet masih memenuhi syarat.",
  ],
};

export const TAX_REFERENCES: Record<IndustryTemplate, TaxReference> = {
  general: GENERAL,
  hospital: HOSPITAL,
  banking: BANKING,
  cooperative: COOPERATIVE,
};

export function getTaxReference(key: IndustryTemplate): TaxReference {
  return TAX_REFERENCES[key];
}
