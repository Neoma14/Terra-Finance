# INTER-BRANCH — LAPORAN UAT (User Acceptance Testing)

Tanggal: 2026-10-09 · Cakupan: transaksi Antar Cabang (IB-1…IB-6) · Penguji: sesi otomatis (HTTP sungguhan, Electron sungguhan, pembacaan DB baca-saja)
**Keputusan ringkas:** UAT teknis **LULUS** (18 skenario PASS, 1 BLOCKED, 0 FAIL pada putaran akhir; Electron 26/26). **Aktivasi di perusahaan nyata: NOT READY** (lihat §11).

---

## 1. Lingkungan dan dataset

| Hal | Nilai |
|---|---|
| Aplikasi | build terbaru `apps/api/dist`, `apps/web/dist`; installer `apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe` (dibangun ulang 2026-10-09 setelah perbaikan §8; tidak ditandatangani); Electron 33.4.11 |
| Mesin | Windows 11, Node 22, Chrome 130 (jendela Electron) |
| Dataset | **salinan backup UAT 5 tahun** (`terra-finance` + `terra-system` + 6 company.db). Perusahaan uji `pt-terra-nusantara`: **12.003 jurnal, ±31 ribu baris jurnal, 72 periode**, kas gabungan ±Rp27,1 miliar, 5 cabang akun (Pusat, Metro, Bandar Lampung, Kotabumi, Terbanggi Besar). Data ini sintetis menyerupai klien — **bukan data klien nyata** |
| Penyiapan | `scripts/inter-branch-uat/reset-uat.sh`: salin backup → migrasi (C0019) → `seed-uat.mjs`: multi-cabang **ON hanya pada salinan**, cabang Metro/BL/Kotabumi, pasangan akun antarkantor Metro–BL (Metro–Kotabumi sengaja belum ada: uji UAT-18), 15 persona |
| Isolasi | server uji port 4540–4543 (bukan 4000); `--user-data-dir` terpisah untuk Electron; `%APPDATA%\TERRA FINANCE` diperiksa tidak berubah; tidak ada perusahaan nyata diaktifkan |
| Persona | OWNER; ADMIN (semua cabang); ADMIN LIMITED (Metro+BL) dan ADMIN LIMITED (BL); ACCOUNTANT Metro, BL, dua cabang, semua cabang; STAFF Metro dan BL; VIEWER; ACCOUNTANT tanpa cabang; ACCOUNTANT Kotabumi; penerima delegasi; OWNER perusahaan lain (flag OFF) |
| Metode | tiap skenario: **snapshot SEBELUM** (saldo bersih sen per akun×cabang, jumlah jurnal, audit, laporan Neraca/Laba Rugi/Arus Kas/Neraca Saldo) → aksi → **snapshot SESUDAH** → dibandingkan dengan delta yang **dihitung dari spesifikasi**, bukan sekadar HTTP 200 |
| Skrip | `scripts/inter-branch-uat/{uat.mjs,uat-lib.mjs,clock.mjs,seed-uat.mjs,reset-uat.sh}`; Electron: `scripts/inter-branch-ui-e2e/electron-flow.cjs` (mode `UAT_EXTRA=1`) |
| Jumlah pemeriksaan | HTTP UAT: **224 pemeriksaan** dalam 19 entri hasil; Electron: 26; Chrome UI: 29; verifikasi akuntansi: 19 |

## 2. Hasil skenario

Status: **PASS** lulus · **FAIL** gagal · **BLOCKED** tidak dapat diuji (alasan tertulis).

| # | Skenario wajib | ID | Hasil | Bukti utama |
|---|---|---|---|---|
| 1 | Transfer kas asal → tujuan | S01, S01b | **PASS** (17+3) | Rp2.500.000 Metro→BL: menunggu = 0 jurnal & laporan identik; setuju = 2 jurnal, seimbang sen, satu tanggal & periode (Okt 2026), delta persis 4 akun×cabang; konfirmasi akun sendiri (BCA) dipakai; audit CREATED/SUBMITTED/APPROVED/POSTED/COMPLETED + ACCOUNT_CONFIRMED |
| 2 | Pembebanan biaya antar-cabang | S02 | **PASS** (12) | Metro membayar beban gaji BL Rp1.750.000: laba bersih −X, liabilitas +X, aset gabungan tetap; validasi jenis (kas→kas sebagai pembebanan, kas→beban sebagai transfer kas, nominal 0/negatif, cabang sama, tanggal masa depan, idempotensi & konflik isi) |
| 3 | Setujui, tolak, batal, kedaluwarsa | S01, S03, S13 | **PASS** | tolak (alasan wajib ≥10 huruf), batal pengaju, batal OWNER atas milik orang lain, pembatalan oleh penerima ditolak; tanpa jurnal/delta/laporan berubah; kedaluwarsa diuji dengan **jam server digeser +3 hari** (tanpa mengutak-atik kolom DB): `409 INTER_BRANCH_EXPIRED`, status `EXPIRED`, audit EXPIRED, 0 jurnal; permintaan pembalikan kedaluwarsa juga tak dapat disetujui |
| 4 | Pembalikan transaksi selesai | S04 | **PASS** (16) | minta → ditolak → minta lagi → disetujui: 4 jurnal, 2 ORIGINAL `REVERSED`, 2 REVERSAL `POSTED`, saldo semua akun×cabang **kembali persis** ke sebelum transaksi, laporan & Neraca Saldo kembali; pembalikan ganda 409; pemohon tak bisa menyetujui sendiri; pembatalan permintaan |
| 5 | Gagal di berbagai titik posting, pulih, ulang | S05, Electron | **PASS** (33 + UI) | trigger kegagalan disuntik di 6 titik (jurnal FROM, jurnal TO, baris TO, posting TO, status COMPLETED, audit terakhir) + 1 titik reversal: **semua-atau-tidak** (jurnal, saldo, audit tak berubah; transaksi tetap WAITING), respons tanpa bocoran SQL; setelah trigger dibuang, ulang berhasil dengan tepat 2 (atau 4) jurnal. Di UI Electron: pesan galat generik terlihat, status tetap "Menunggu persetujuan", mencoba lagi berhasil |
| 6 | Pengajuan dan persetujuan oleh OWNER | S06 | **PASS** (7) | OWNER setuju sendiri: audit `makerEqualsApprover:true`, `actorRole:OWNER`, `self_approved=1`; reversal sendiri → 4 jurnal, saldo kembali; OWNER tetap tunduk validasi domain (akun antarkantor belum ada → 422 + arahan) |
| 7 | Self-approval non-OWNER (termasuk pemegang dua cabang) | S07 | **PASS** (13) | ACCOUNTANT dua cabang, ADMIN LIMITED dua cabang, ADMIN semua cabang: `403 SELF_APPROVAL_NOT_ALLOWED`; peran OWNER palsu di body/header diabaikan; pengguna lain menyetujui → berhasil; pemohon reversal non-OWNER tak bisa menyetujui sendiri |
| 8 | ADMIN, ADMIN LIMITED, ACCOUNTANT, STAFF | S08 | **PASS** (41) | matriks 13 persona × (daftar, ajukan dari Metro, setujui tujuan BL) sesuai spesifikasi §8; STAFF boleh mengajukan tidak boleh menyetujui; VIEWER ditolak; pengaturan masa berlaku hanya OWNER (ADMIN 403), 0 dan >90 ditolak |
| 9 | Lintas cabang, lintas perusahaan, delegasi | S09 | **PASS** (15) | pengguna cabang lain: detail = 404 identik dengan ID tak ada, tak muncul di daftar/pencarian nomor, semua aksi ditolak; spoof `fromBranchId`, header cabang tanpa akses, body ≠ konteks ditolak; pemilik perusahaan lain: 403/404; ID perusahaan A di path B = 404; spoof header perusahaan tak berpengaruh; **delegasi `inter_branch` tidak memberi hak** (tak bisa menyetujui di BL); tanpa sesi/token palsu = 401 |
| 10 | Fitur multi-cabang OFF | S10 | **PASS** (6) | semua endpoint 404 seragam, **termasuk body/query tidak valid** (lihat bug §8-1); jurnal & laporan lama berjalan, angka tak berubah |
| 11 | Dua penyetuju bersamaan, cegah jurnal ganda | S11 | **PASS** (6) | 6 penyetuju paralel → tepat satu 200, sisanya 409; klik ganda 3×; 3 permintaan reversal paralel → satu; **dua proses server** pada file DB yang sama (port 4540 & 4541, 6 persetujuan bergantian) → satu 200, 2 jurnal. (Balapan lintas-proses tingkat service: 4 tes di `inter-branch-race.test.ts`) |
| 12 | Jurnal seimbang, terhubung, periode benar | S01–S16 | **PASS** | lihat §3 |
| 13 | Saldo, audit, status, dampak laporan | S01–S04, S16 | **PASS** | lihat §3, §4 |
| 14 | Tampilan dan interaksi di Electron | Electron | **PASS** (26/26) | lihat §6 |

Tambahan dari katalog UAT spesifikasi §26: UAT-16 (menutup periode yang punya pengajuan menunggu **diblokir** dengan penjelasan), UAT-17/29 (cabang tujuan dinonaktifkan → pengajuan **dibatalkan otomatis**, alasan tercatat, 0 jurnal), UAT-18 (akun antarkantor belum ada → 422 dengan arahan; non-OWNER tak dapat membuat; OWNER membuat pasangan akun lalu transaksi berhasil), UAT-30 (periode dikunci setelah pengajuan → persetujuan ditolak, 0 jurnal, tetap WAITING, penyetuju masih dapat menolak), UAT-31 (akun tujuan terkunci → ditolak menyebut akun; penyetuju mengonfirmasi akun lain → berhasil). Semua **PASS** (S12, 16 pemeriksaan).

| ID | Hasil |
|---|---|
| S14-report — laporan per cabang untuk pengguna LIMITED | **BLOCKED** (fitur belum ada, lihat §7) |
| Skenario lain yang tidak diuji | lihat §9 |

## 3. Bukti keseimbangan jurnal dan konsistensi saldo

Verifikasi akhir (S16) setelah **55 transaksi** (23 selesai, 4 selesai-lalu-dibalik, 25 dibatalkan, 2 ditolak, 1 kedaluwarsa):
- `verifyInterBranchIntegrity` seluruh data = **0 pelanggaran**; semua jurnal Antar Cabang seimbang dalam **sen bulat**.
- Jumlah jurnal per status benar (0 / 2 / 4); tanggal jurnal sama dengan `transaction_date`; semua jurnal satu transaksi berada di **periode yang memuat tanggal itu** (Okt 2026, OPEN).
- **Selisih saldo akhir − awal (per akun×cabang) = jumlah delta transaksi selesai yang belum dibalik, tanpa sisa** (tidak ada efek tersembunyi); Σ debit = Σ kredit seluruh jurnal efektif.
- **Data historis tak berubah**: hash seluruh jurnal+baris non-Antar-Cabang identik sebelum/sesudah UAT (termasuk jurnal DRAFT tak seimbang `U2-E-nv4o` yang sudah ada; tidak diubah/dihapus).
- `integrity_check` ok, `foreign_key_check` 0 pada seluruh database; daftar trigger = baseline (tidak ada sisa suntikan kegagalan).
- Setelah UAT Electron, `verify-accounting.mjs` 19/19.

## 4. Dampak pada laporan (diukur dengan OWNER/ALL)

| Aksi | Aset | Liabilitas | Ekuitas | Laba bersih | Kas | Neraca Saldo |
|---|---|---|---|---|---|---|
| Transfer kas X (selesai) | **+X** | **+X** | 0 | 0 | 0 | +X debit/+X kredit, seimbang |
| Pembebanan X (selesai) | 0 | **+X** | −X | −X | −X | seimbang |
| Menunggu / ditolak / dibatalkan / kedaluwarsa | 0 | 0 | 0 | 0 | 0 | tak berubah |
| Pembalikan selesai | kembali | kembali | kembali | kembali | kembali | kembali |

**Temuan pelaporan (penting untuk aktivasi):** laporan **gabungan** perusahaan **belum mengeliminasi** akun antarkantor. Neraca gabungan menampilkan saldo antarkantor secara bruto: transfer kas menaikkan aset **dan** liabilitas sebesar X; pembebanan menaikkan liabilitas X padahal secara ekonomi aset berkurang X. Neraca tetap seimbang dan pembalikan mengembalikan semuanya, tetapi angka total aset/liabilitas gabungan menjadi lebih besar dari kondisi ekonomi sebenarnya selama ada saldo antarkantor terbuka. Ini sesuai desain (spesifikasi §22: eliminasi = Phase 7) namun **harus dikomunikasikan atau diselesaikan sebelum laporan gabungan dipakai dengan transaksi Antar Cabang nyata**. Pada pembebanan, kas cabang pemberi berkurang X sehingga kas gabungan (Arus Kas) turun X.

## 5. Hasil pengujian otorisasi dan akses cabang

Seluruh keputusan dibuat server (UI hanya kenyamanan). Hasil ringkas (S07–S09, S14): matriks permission × akses cabang sesuai spesifikasi untuk 13 persona; SoD non-OWNER mutlak (termasuk pemegang dua cabang) dan tak dapat dipalsukan lewat body/header; OWNER boleh menyelesaikan transaksinya sendiri dengan jejak audit lengkap; pengguna tanpa akses mendapat **404 identik** dengan ID tak ada (tak ada pembeda keberadaan); lintas perusahaan ditolak; delegasi tidak memperluas hak; flag OFF → 404 seragam. Pengguna **LIMITED** ditolak (403) pada semua laporan gabungan, ledger, dan dashboard (fail-closed), sementara pengguna ALL (OWNER, ADMIN, ACCOUNTANT, VIEWER) dapat membuka laporan.

## 6. Temuan UI Electron

Aplikasi hasil installer dijalankan sebagai proses Electron sungguhan (login nyata, `--user-data-dir` terisolasi, DevTools Protocol): **26/26 PASS** — login, pilih perusahaan+cabang, menu & lencana, ajukan transfer kas dan **pembebanan**, setujui/posting, 2 jurnal (sisi milik cabang lain tidak dibuka), pembalikan 4 jurnal, batal, tolak (alasan tampil), SoD ADMIN dua cabang, OWNER self-approve, kegagalan posting disuntik → pesan galat tampil, pulih & ulang berhasil, Dashboard/Jurnal/COA/Trial Balance, VIEWER tanpa menu, perusahaan flag OFF (menu hilang + penjelasan), `diagnostic.log` tanpa galat server/renderer/IPC, `%APPDATA%\TERRA FINANCE` tidak berubah, proses tertutup bersih.

Dua cacat UI ditemukan lewat pemeriksaan tangkapan layar, diperbaiki (§8): (a) modal Antar Cabang tertutup sebagian oleh bilah atas (pemilih perusahaan/cabang) karena modal dirender di dalam konteks tumpukan `main`; (b) galat aksi muncul di dasar modal yang dapat digulir sehingga **tidak terlihat** — pengguna mengira tidak terjadi apa-apa. Setelah perbaikan, tangkapan layar menunjukkan modal di atas seluruh antarmuka dan pesan galat "Terjadi kesalahan. Coba lagi, atau hubungi dukungan…" tampak tepat di bawah tombol.
Catatan: 1 respons **HTTP 500** pada Electron adalah **kegagalan yang disengaja** (suntikan trigger) dan bukan galat tak terduga; skrip melaporkannya sebagai "masalah konsol" sehingga kode keluarnya 1 — itu perilaku skrip, 0 FAIL dari 26.

## 7. Batas laju dan laporan pengguna LIMITED

**Batas laju.** Kebijakan: bucket `auth` 30 permintaan/menit/IP dipakai bersama oleh login, logout, dan ping aktivitas (`lib/rate-limit-policy.ts`); bucket baca 1.200, mutasi 120.
- Terukur (S15): dari satu IP, **login sah ke-31 dalam satu menit mendapat 429** dengan pesan Indonesia dan lama tunggu; pembacaan tetap 200 (bucket terpisah).
- Beban per pengguna aktif ≈ 1 ping/menit (interval 60 dtk) + 1 login + 1 logout. Jenuh pada **~25–30 pengguna aktif serempak dari satu IP**, atau ≥15 siklus login+logout/menit.
- Server **hanya mengikat 127.0.0.1**: tiap komputer kantor punya server sendiri; pengguna di mesin berbeda **tidak berbagi** bucket. Risiko nyata saat ini hanya pada pergantian akun cepat di satu mesin — itulah yang menimbulkan 4 respons 429 pada uji Electron (7 persona bergantian dalam beberapa menit); skrip uji menunggu lalu mengulang.
- **Kesimpulan:** tidak menghalangi UAT/pemakaian satu-mesin; **menjadi risiko bila multi-perangkat via LAN/NAT/reverse proxy diaktifkan** (seluruh kantor berbagi satu IP, 30/menit akan jenuh di awal hari). Rekomendasi (belum dikerjakan, di luar cakupan Antar Cabang): pisahkan login (per IP, ketat) dari logout/ping (per sesi/pengguna, longgar) sebelum multi-perangkat.

**Laporan per cabang untuk LIMITED — BLOCKED.** Phase 5A/5B **belum diimplementasikan**. Pengguna LIMITED (termasuk pembuat/penyetuju Antar Cabang) tidak dapat membuka laporan apa pun; mereka hanya melihat transaksi dan jurnal cabangnya sendiri. Dampak transaksi pada laporan diverifikasi melalui OWNER/ALL dan basis data. Ini **bukan** cacat, melainkan gerbang aktivasi yang sudah tercatat (spesifikasi §22).

## 8. Bug yang diperbaiki dan hasil regresinya

| # | Cacat aplikasi | Akar penyebab | Perbaikan minimal | Bukti |
|---|---|---|---|---|
| 1 | Flag OFF: body/query **tidak valid** ke endpoint Antar Cabang mengembalikan **400**, bukan 404 seragam (menyimpang dari UAT-28 dan komentar kode "404 sebelum validasi apa pun") | validasi zod dijalankan **sebelum** pengecekan flag di `routes.ts` (list, settings, create, aksi) | validasi dipindah ke dalam `withDb` setelah flag dicek | tes baru `routes.test.ts` (flag OFF + input tidak valid = 404 seragam); UAT S10 |
| 2 | Modal Antar Cabang tertutup sebagian oleh bilah atas | modal dirender di dalam `main` (konteks tumpukan z-10) sehingga pemilih (z-40) di atasnya | render modal lewat `createPortal` ke `document.body` (form & detail) | tangkapan layar Electron sebelum/sesudah; Electron 26/26 |
| 3 | Galat aksi tak terlihat di modal yang dapat digulir | pesan di dasar area gulir | `scrollIntoView` saat pesan galat muncul (form & detail) | tangkapan layar `uat-gagal-posting.png`; pemeriksaan UI |

Regresi setelah perbaikan dan pembangunan ulang installer: typecheck API/web/shared **0 galat** · `pnpm test` **968/968** (75 berkas; +1 tes baru) · Golden Master small **43/43**, uat-1/3/7 **126/126** identik · E2E keamanan **37/37** (data bersih) · UI E2E Chrome **29/29**, 0 galat konsol/jaringan · UAT HTTP **18 PASS/1 BLOCKED/0 FAIL** · Electron **26/26** pada installer baru (isi installer 9.568 berkas identik SHA-256 dengan `win-unpacked`; `web/dist` identik dengan build).

**Koreksi di sisi tes (bukan cacat aplikasi)** — dicatat agar jujur memisahkan penyebab: (a) putaran HTTP pertama: kesalahan ekspektasi saya — transfer kas menaikkan aset dan liabilitas gabungan X (bukan nol) karena belum ada eliminasi, dan Neraca Saldo (saldo bersih per akun) naik X (bukan 2X); alasan minimal 10 karakter; jenis persetujuan reversal bernama `REVERSE`; peran maksimum delegasi harus di bawah peran penerima; daftar pengguna tanpa akses mengembalikan 200 kosong (bukan ditolak) — semua ekspektasi dibetulkan **mengikuti spesifikasi/perilaku yang benar, bukan melonggarkan pemeriksaan**; (b) skrip: lookup `kind` salah (4 SCRIPT-ERROR), alias persona; (c) satu putaran awal skenario S12 dibuat lebih ketat (UAT-17 kini mewajibkan pembatalan otomatis + audit beralasan); (d) pada pertengahan, 1 reset data gagal sementara (server migrasi) dan diulang — tidak memengaruhi hasil. Tidak ada kegagalan yang disembunyikan; hasil akhir diperoleh dari data bersih.

## 9. Skenario yang tidak dapat diuji dan alasannya

| Skenario | Status | Alasan |
|---|---|---|
| Laporan per cabang untuk pengguna LIMITED | BLOCKED | Phase 5A/5B belum ada |
| Eliminasi antarkantor di laporan gabungan | BLOCKED | Phase 7, belum ada |
| Wizard instalasi NSIS (instalasi nyata) | tidak dijalankan | akan mendaftarkan aplikasi di mesin yang berisi instalasi/data klien nyata; isi installer diverifikasi lewat ekstraksi + hash dan dijalankan dari folder hasil ekstrak |
| Multi-perangkat / banyak komputer satu file data | tidak diuji | belum didukung; konkurensi hanya teruji untuk beberapa proses pada satu file SQLite di satu mesin |
| Data klien sungguhan, volume lebih besar, impor saldo awal antar-cabang & impor jurnal dari beberapa sumber | tidak diuji | tidak tersedia; dataset 12 ribu jurnal bersifat sintetis. Kinerja di bawah beban tidak diukur di UAT ini |
| Cabang berstatus CLOSED (hanya INACTIVE diuji) | sebagian | INACTIVE terbukti membatalkan otomatis; CLOSED memakai jalur validasi yang sama tetapi tidak dijalankan terpisah |
| ADMIN LIMITED / STAFF lewat jendela Electron | sebagian | diuji lewat HTTP (S07/S08) dan ADMIN dua cabang di Electron; persona lain tidak dilogin di Electron |
| Manipulasi jam sistem klien | tidak diuji | risiko diterima (spek R-9); kedaluwarsa diuji dengan jam server digeser |

## 10. Risiko yang belum terselesaikan

1. **Laporan gabungan bruto (tanpa eliminasi)** — total aset/liabilitas membesar selama ada saldo antarkantor terbuka (§4). Perlu eliminasi (Phase 7) atau peringatan di laporan sebelum dipakai nyata.
2. **LIMITED tak punya laporan** (§7): akuntan cabang tidak dapat memeriksa dampak transaksinya sendiri.
3. **Batas laju per IP** bila multi-perangkat diaktifkan (§7).
4. **Installer belum ditandatangani** dan wizard NSIS belum diuji manual (peringatan SmartScreen; uji upgrade di atas instalasi lama belum dilakukan).
5. **Multi-perangkat/jaringan**: konkurensi tidak diklaim di luar satu mesin; respons 503 (sibuk) aman diulang.
6. **Data UAT sintetis**: perilaku pada data klien nyata (akun, periode, saldo awal antar-cabang) belum terbukti.
7. Jurnal DRAFT tak seimbang pra-ada (`U2-E-nv4o`, selisih Rp1) harus ditangani pengguna; tidak ikut laporan; tidak diubah.
8. Pesan galat untuk kegagalan internal bersifat generik ("Terjadi kesalahan…") — aman, tetapi dukungan perlu merujuk ke log server.

## 11. Rekomendasi

| Keputusan | Status |
|---|---|
| Implementasi Antar Cabang | **PASS** |
| Akuntansi (jurnal, saldo, periode, reversal, audit) | **PASS** |
| Otorisasi, akses cabang, delegasi, SoD | **PASS** |
| Konkurensi & atomisitas (satu mesin) | **PASS** |
| Electron (build + runtime + UI) | **PASS** |
| UAT oleh pengguna bisnis memakai perusahaan uji | **READY** |
| **Aktivasi di perusahaan nyata** | **NOT READY** |

Syarat sebelum aktivasi nyata (urut prioritas): (1) UAT dengan data klien/menyerupai klien dan pengguna bisnis (bukan hanya skrip); (2) keputusan tentang laporan gabungan bruto — eliminasi atau peringatan; (3) Phase 5A/5B agar pengguna LIMITED dapat melihat dampak di laporan cabangnya; (4) uji instalasi NSIS nyata + keputusan penandatanganan; (5) tinjauan kebijakan batas laju sebelum multi-perangkat; (6) backup terverifikasi sebelum OWNER menyalakan fitur, dan penyalaan oleh OWNER secara sadar per perusahaan.

**Tidak ada aktivasi di perusahaan nyata dan tidak ada fase lain yang dimulai.** Berhenti sesuai instruksi.

## Pembaruan 2026-10-09 (Phase 5A/5B)
Temuan §7 "pengguna LIMITED belum dapat membuka laporan" **telah diselesaikan**: LIMITED kini melihat laporan, Neraca Saldo, Buku Besar, Dashboard, saldo Hutang/Piutang, pencarian, dan ekspor untuk cabang dalam aksesnya; gabungan/komparasi butuh `report.consolidated` dan selalu berlabel "belum dieliminasi". Skenario S14 pada UAT HTTP kini PASS (19/19). Risiko "laporan gabungan bruto" (§4, §10-1) **tetap berlaku** (eliminasi = Phase 7). Rincian: `PHASE-5-IMPLEMENTATION-REPORT.md`.
Stabilisasi 2026-10-09: skenario S17 (idempotensi pengajuan lintas proses server) ditambahkan; UAT HTTP 20/20. Lihat `PHASE-5-IMPLEMENTATION-REPORT.md` bagian 11.
