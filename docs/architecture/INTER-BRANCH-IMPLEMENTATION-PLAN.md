# INTER-BRANCH — IMPLEMENTATION PLAN (BELUM DIMULAI)

**Status:** FINAL DESIGN GATE — menunggu review manusia sebelum IB-1 · 2026-10-07 · mengacu `INTER-BRANCH-TRANSACTION-SPECIFICATION.md` (selanjutnya "Spek").
Aturan berlaku untuk semua fase: `multi_branch_enabled` tetap OFF; tidak ada perubahan fondasi Phase 3 di luar daftar Spek §23 (masing-masing dicatat di `PHASE-3-AUTHORIZATION-BASELINE.md` §8 dengan tes); tidak ada Phase 5B/5C/6/7; tidak ada indeks tanpa `EXPLAIN`; data produksi dan port 4000 tidak disentuh (uji pada salinan); tes existing tidak dilemahkan; setiap fase **berhenti di gerbang** dan menunggu persetujuan. Backlog hardening H-1/H-2/H-3 tetap.

Pembagian disesuaikan dengan hasil audit (bukan templat): refactor `…InTransaction` **dihapus** karena terbukti tidak perlu; otorisasi tidak butuh fase sendiri yang besar karena gerbangnya sudah ada; yang berisiko tinggi (posting atomik) diberi fase dan gerbang sendiri.

## Ringkasan

| Fase | Isi | Risiko | Estimasi tes baru |
|---|---|---|---|
| **IB-0** | Keputusan (D-0…D-13), spike terbukti, pencatatan baseline | rendah | ±5 |
| **IB-1** | Migration `C0019`, model domain, `verifyInterBranchIntegrity` | sedang | ±25 |
| **IB-2** | Otorisasi, ajukan, daftar, detail (tanpa jurnal) | sedang | ±35 |
| **IB-3** | Persetujuan + posting atomik dua sisi | **tinggi** | ±40 |
| **IB-4** | Tolak/batal/kedaluwarsa + integrasi periode & siklus hidup cabang | sedang | ±25 |
| **IB-5** | Reversal berpasangan | **tinggi** | ±25 |
| **IB-6** | UI | sedang | uji UI ±20 |
| **IB-7** | Keamanan, konkurensi, mutasi, injeksi kegagalan, performa | sedang | ±30 |
| **IB-8** | UAT, build installer, gerbang aktivasi | rendah | — |

---

## IB-0 — Keputusan & prasyarat
1. Keputusan D-0…D-13 **FINAL** (Spek §32). D-0: Phase 5A WIP dibekukan (`docs/wip/`), bukan dependensi, tidak disentuh.
   **P-1 (prasyarat lingkungan, bukan desain):** pohon kerja saat ini tidak kompilasi dan tidak punya baseline tes hijau karena WIP 5A. Sebelum IB-1, manusia memutuskan cara menyediakan **baseline bersih** untuk Inter-Branch (mis. salinan kerja terpisah yang direkonstruksi dari baseline, atau penyelesaian WIP lewat jalur persetujuan 5A sendiri). Fase IB **tidak boleh** dimulai di atas WIP 5A dan tidak boleh mengambil kodenya.
2. Catat prasyarat teknis dalam bentuk tes karakterisasi kecil (bukan kode produk): (a) fungsi jurnal dipanggil dengan `trx` tetap atomik (percobaan awal sudah dilakukan di luar repositori — dijadikan tes permanen); (b) kegagalan yang ditangkap di dalam transaksi luar menyisakan efek sebagian (dasar aturan "jangan menangkap").
3. Daftar berkas baseline yang akan diubah dikunci dan didaftarkan sebelumnya di baseline §8 (status "direncanakan").
**Gerbang:** P-1 terjawab dan terbukti: `tsc` bersih dan 827 tes hijau pada **baseline bersih** yang akan dipakai IB (bukan pada pohon WIP).

## IB-1 — Skema & model domain
**Status 2026-10-08: DIIMPLEMENTASIKAN** (lihat `IB-1-IMPLEMENTATION-REPORT.md`; perubahan cakupan di `IB-1-SPEC-CHANGELOG.md`). **IB-2…IB-6 juga diimplementasikan dan diuji** — lihat `INTER-BRANCH-IMPLEMENTATION-REPORT.md` (otorisasi/ajukan, posting atomik, tolak/batal/kedaluwarsa/integrasi, reversal, UI, uji keamanan/konkurensi/mutasi). IB-7 (performa dataset 7 cabang) dan IB-8 (UAT klien, installer) belum.
- `C0019_inter_branch`: dua tabel (`status` bisnis 5 nilai + `reversal_state` 3 nilai; accounting event diturunkan dari jurnal, tidak disimpan), kolom `company_profile.inter_branch_expiry_days`, trigger (immutabilitas, no-delete, transisi status, penjaga induk jurnal). Idempoten, `down` tersedia.
- Modul domain `inter-branch-service` (tanpa HTTP): tipe, tabel transisi (fungsi murni), penomoran, penghitung `expires_at`, `resolveInterBranchAccounts`, `verifyInterBranchIntegrity`.
- Tes: migrasi (atas salinan UAT 5 tahun: jumlah jurnal/baris/akun identik, integrity_check, foreign_key_check, restore pre-upgrade), constraint/trigger, tabel transisi, pemilihan akun.
**Gerbang:** migrasi 84/84 + golden master Phase 5.0 identik (flag OFF); tak ada perubahan perilaku.

## IB-2 — Otorisasi, ajukan, daftar, detail
- Rute `inter-branch` (GET list/summary/detail, POST ajukan), guard flag ON (404 saat OFF), `BRANCH_AWARE_ROUTES` (BC-2) + registry klasifikasi route (tes arsitektur fail-closed Phase 5.0), DTO per sisi, 404 seragam.
- Validasi ajukan penuh (cabang, akun, jenis, tanggal, jumlah, idempotensi); **tidak ada jurnal**.
- Audit `PROPOSED`.
**Gerbang:** matriks keamanan (role × akses × permission × DENY/GRANT × delegasi tidak memperluas), tampering, IDOR, flag OFF = 404, pengajuan tidak mengubah laporan.

## IB-3 — Persetujuan & posting atomik (inti risiko)
- Perubahan terkecil pada `journal-service.ts` (menerima tautan IB; pengecualian reversal internal disiapkan) dan `branch-service.ts` (matriks `inter_branch` ACTIVE↔ACTIVE); pencadangan awalan referensi `IB-`.
- `executeInterBranchPosting`; aturan "tidak menangkap error"; pasca-kondisi; audit `APPROVED` (memuat `actorRole`/`makerEqualsApprover`) dan `ACCOUNT_CONFIRMED`; `assertCanDecide` satu titik dengan business rule OWNER (Spek §8.1).
- Tes: golden Metro→BL; **injeksi kegagalan di setiap titik tulis**; setujui ganda/bersamaan; pengaju≠penyetuju untuk non-OWNER; blok tes OWNER (buat→setujui→selesaikan sendiri, audit lengkap, tanpa delegasi) dan non-OWNER (Spek §25); validasi ulang (periode, cabang, akun, backdate, kedaluwarsa); `verifyInterBranchIntegrity` = 0.
**Gerbang:** semua tes atomisitas & konkurensi hijau; uji mutasi (hapus cek akses TO, lewati pasca-kondisi, tangkap error) semuanya terdeteksi.

## IB-4 — Tolak/batal/kedaluwarsa + integrasi
- Reject (alasan), cancel, kedaluwarsa (virtual saat dibaca + penulisan saat diterapkan), ajukan-ulang (hanya UI/DTO).
- `period-closing-service`: pengajuan WAITING memblokir penutupan; `branch-service`: pembatalan otomatis saat cabang INACTIVE/CLOSED + blocker penutupan cabang.
**Gerbang:** skenario UAT-15/16/17 lolos; tes siklus hidup cabang & periode lama tidak berubah.

## IB-5 — Reversal berpasangan
- Permintaan reversal, persetujuan lawan, 2 jurnal reversal atomik via `reverseJournalEntry(trx)` dengan pengecualian internal; kembali ke `COMPLETED` bila ditolak/dibatalkan/kedaluwarsa; endpoint jurnal biasa tetap menolak.
**Gerbang:** 4 jurnal 1 identifier; injeksi kegagalan; periode asal ditutup ⇒ ditolak jelas; reversal ganda bersamaan satu pemenang.

## IB-6 — UI
- Menu Antar Cabang + lencana (polling `summary`), Masuk/Keluar/Semua, filter, Transaksi Baru (pratinjau jurnal sisi sendiri), Detail, dialog Setujui/Tolak/Batalkan/Reversal, Ajukan ulang, label peran/status. Query key memuat cabang aktif; BC-1 (sessionStorage per tab) adalah bagian Phase 5A yang belum disetujui dan **bukan** dependensi: IB-6 memakai mekanisme cabang aktif Phase 3 apa adanya, dengan server memvalidasi `X-Branch-Context` tiap request.
- Uji UI di Chrome terhadap server hasil build; **H-3 (uji jendela Electron) disarankan dimajukan**.
**Gerbang:** UI teruji terhadap database; tombol hanya kenyamanan (server menolak jalur langsung).

## IB-7 — Keamanan, konkurensi, performa
- Seluruh daftar tes keamanan Spek §25, DTO tidak membocorkan, timing kasar, mutasi lengkap, konkurensi, regresi penuh (827+ tes, migrasi, e2e Phase 3, UI).
- Performa pada dataset UAT 5 tahun + 7 cabang; indeks sekunder **hanya bila EXPLAIN membuktikan**.
**Gerbang:** nol Critical/High; anggaran: posting < 100 ms, daftar < 50 ms.

## IB-8 — UAT & aktivasi
- UAT-01…23, build installer, pemindaian isi installer, e2e dari runtime Electron, laporan fase, pembaruan baseline.
- Aktivasi **bukan bagian fase**: tetap butuh gerbang backlog B (Phase 5 untuk laporan cabang, UAT data menyerupai klien, panduan klien, persetujuan tertulis). `multi_branch_enabled` tetap OFF.

## Dependensi & urutan terhadap Phase 5
IB tidak bergantung pada 5A/5B/5C untuk **dikembangkan** (jurnalnya jurnal biasa). Ia bergantung pada 5A untuk **dipakai** oleh pengguna LIMITED (mereka tidak dapat melihat laporan cabang sebelum 5A). Berkas yang tumpang tindih dengan WIP 5A: `period-closing-service.ts` (WIP sudah mengubahnya), `middleware/branch-authority.ts`, registry route — itulah sebabnya P-1 (baseline bersih) wajib sebelum IB-1; kode WIP tidak dipakai.
