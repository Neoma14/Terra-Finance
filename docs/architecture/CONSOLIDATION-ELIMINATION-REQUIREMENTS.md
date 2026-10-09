# KONSOLIDASI DAN ELIMINASI ANTAR-KANTOR: PERSYARATAN PEKERJAAN BERIKUTNYA

Status: **belum dikerjakan** (Phase 7). Dokumen ini hanya mencatat persyaratan agar pekerjaan konsolidasi tidak dimulai dari nol dan agar laporan Phase 5 tidak menjanjikan lebih dari yang ada. Tidak ada kode eliminasi, tidak ada jurnal eliminasi otomatis, dan tidak ada perubahan pada jurnal sumber pada tahap Phase 5A/5B.

## 1. Keadaan sekarang (Phase 5A/5B)

- Laporan per cabang menampilkan akun antar-kantor (`branch_policy = INTER_BRANCH`) **apa adanya**: sisi cabang itu saja.
- Laporan **Gabungan** (cabang terpilih, seluruh cabang, kolom Gabungan pada komparasi) menjumlahkan semua cabang dalam cakupan **tanpa eliminasi**. Akibatnya total aset dan total liabilitas gabungan **bruto**: setiap transfer kas antar-cabang yang sudah selesai menaikkan aset dan liabilitas gabungan sebesar nominalnya; pembebanan antar-cabang menaikkan liabilitas gabungan dan menurunkan laba, sedangkan aset gabungan tidak berkurang meski kas pemberi berkurang.
- Pembalikan (reversal) mengembalikan semuanya. Neraca dan Neraca Saldo tetap seimbang (setiap jurnal seimbang dan milik satu cabang).
- Pelabelan wajib (server, diteruskan ke layar, XLSX, PDF, dan nama file):
  - Gabungan seluruh cabang: **"Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi"**
  - Gabungan terpilih: **"GABUNGAN CABANG TERPILIH: bukan laporan konsolidasi perusahaan"**
  - Peringatan tetap: "Ini bukan laporan konsolidasi final; eliminasi akun antar-kantor belum tersedia."
  - Nama file memuat `Belum-Dieliminasi`.
- Blok `interBranch` pada respons gabungan menampilkan posisi antar-kantor dalam cakupan: `receivableGross`, `payableGross`, `netDifference`, dan `eliminated: false`. `netDifference = 0` berarti seluruh pasangan lengkap berada dalam cakupan; selisih tidak nol berarti ada pasangan yang sisi lawannya di luar cakupan.
- Istilah "Konsolidasi Perusahaan" **tidak boleh** dipakai untuk laporan ini sampai eliminasi selesai.

## 2. Persyaratan untuk Phase 7 (konsolidasi)

1. **Keputusan akuntansi tertulis** (oleh pemilik produk/konsultan) sebelum kode: perlakuan akun antar-kantor yang dieliminasi, perlakuan selisih, laba belum terealisasi untuk transaksi bermargin (Pendapatan Antar-Cabang, ditunda di spesifikasi Antar Cabang), mata uang (hanya IDR saat ini).
2. **Eliminasi sebagai lapisan laporan, bukan jurnal sumber**: baris/kolom eliminasi dihitung saat laporan dibangun dari pasangan transaksi (`inter_branch_transaction_id`, `leg`, `side`) dan akun `INTER_BRANCH` berpenanda `counterpart_branch_id`. Jurnal sumber tidak diubah. Bila kelak diperlukan jurnal eliminasi tersimpan, itu keputusan terpisah dengan persetujuan, audit, periode, dan pembalikan sendiri.
3. **Hanya pasangan lengkap dieliminasi**: pasangan yang kedua sisinya berada dalam cakupan. Sisa (sisi lawan di luar cakupan) ditampilkan sebagai "tidak dieliminasi" dengan nilainya; laporan tidak boleh menyebut dirinya terkonsolidasi bila ada sisa.
4. **Rekonsiliasi pasangan**: Σ(D-K) akun antar-cabang pasangan = 0 (invarian yang sudah diperiksa oleh `verifyInterBranchIntegrity`); selisih ≠ 0 ditampilkan sebagai "selisih eliminasi", tidak disembunyikan.
5. **Hak akses**: tetap `report.consolidated` dan akses ke seluruh cabang dalam cakupan, divalidasi server setiap request (sudah berlaku di `resolveReportScope`). Konsolidasi seluruh perusahaan hanya untuk pengguna yang mengakses semua cabang.
6. **Arus Kas**: akun antar-kantor belum punya `cash_flow_activity`, sehingga transfer antar-cabang muncul sebagai "Belum Terklasifikasi" pada Arus Kas per cabang. Eliminasi pada Arus Kas gabungan memerlukan aturan klasifikasi yang disetujui (Phase 6/7).
7. **Periode dan tanggal**: eliminasi memakai `transaction_date`; transaksi berstatus selesai dan sudah dibalik dieliminasi sebesar saldo bersih (nol).
8. **Pengujian wajib** sebelum rilis: golden master (flag OFF identik), Σ cabang = gabungan, pasangan lengkap/tidak lengkap, transaksi dibalik, pembebanan dan transfer, data UAT multi-cabang, mutasi (menghapus eliminasi harus terdeteksi), dan UI (label berubah hanya bila eliminasi benar-benar lengkap).
9. **Pelabelan**: judul "Konsolidasi Perusahaan" hanya muncul bila `eliminationStatus = ELIMINATED` dan tidak ada sisa; selain itu label Phase 5 tetap.
10. **Migrasi data**: tidak ada perubahan skema yang diperlukan untuk lapisan laporan; bila jurnal eliminasi tersimpan dipilih, butuh skema/kebijakan baru dan jalur upgrade ber-backup.

## 3. Yang sengaja tidak dilakukan pada Phase 5A/5B

Tidak ada: jurnal eliminasi otomatis, perubahan jurnal sumber, penghapusan akun antar-kantor dari laporan, penamaan "konsolidasi", atau perubahan pada Phase 7.
