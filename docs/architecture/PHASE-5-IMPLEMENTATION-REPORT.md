# PHASE 5A/5B: LAPORAN PER CABANG DAN AKSES PENGGUNA LIMITED. LAPORAN IMPLEMENTASI

Tanggal: 2026-10-09 · Dasar: `PHASE-5-ARCHITECTURE-AND-IMPLEMENTATION-PLAN.md` (keputusan D1-D10 disetujui; BC-1 dan BC-2 disetujui) · Workspace: `TERRA-FINANCE-CLEAN`
Tidak ada kode yang diambil dari `TERRA-Finance-Offline` atau dari 5A WIP yang diparkir. `multi_branch_enabled` tidak diaktifkan pada perusahaan nyata. Phase 7 (eliminasi), Phase 5C, installer, dan batas laju tidak disentuh.

**Keputusan ringkas:** implementasi 5A/5B **selesai dan lulus seluruh pengujian**. Stabilisasi dan gerbang kesiapan UAT ada di bagian 11 (angka terbaru: `pnpm test` 999/999). Kesiapan **UAT pengguna bisnis: READY** (dengan keterbatasan di bagian 7). **Aktivasi di perusahaan nyata: tetap NOT READY** (bagian 9).

## 1. Fitur yang selesai

| Fitur | Status |
|---|---|
| Cakupan laporan dihitung server (`resolveReportScope`, tipe bermerek `AuthorizedScope`): satu cabang, gabungan cabang terpilih, gabungan seluruh cabang, komparasi per cabang | selesai |
| Pengguna **LIMITED** dapat membuka Neraca, Laba Rugi, Ekuitas, Arus Kas, Neraca Saldo, Buku Besar, Dashboard, Hutang & Piutang (saldo), Buku Kas/Bank, pencarian jurnal, dan ekspor XLSX/PDF, **hanya untuk cabang dalam aksesnya** | selesai |
| Default tanpa parameter = cabang kerja aktif (D1); perusahaan dengan multi-cabang OFF tidak berubah (SQL identik) | selesai |
| Label wajib untuk gabungan di layar, XLSX, PDF, dan nama file; blok posisi antar-kantor "belum dieliminasi" | selesai |
| Komparasi: Neraca, Laba Rugi, Ekuitas, Neraca Saldo (kolom per cabang + Gabungan; rekonsiliasi server Σ kolom = Gabungan, selisih menjadi galat integritas) | selesai |
| UI: pemilih cakupan, banner cakupan dari respons server, tabel komparasi; cabang aktif disimpan **per tab** (BC-1) | selesai |
| Registry fail-closed: route baca-keuangan baru wajib terklasifikasi dan menurunkan cakupan di server | selesai |

Tidak dikerjakan (sesuai instruksi dan rencana): Phase 5C (pembanding periode), Report Group (D5), **eliminasi antar-kantor** (Phase 7), komparasi **Arus Kas dan Dashboard** (menunggu optimasi, D8), optimasi set-based, analisis/proyeksi/pajak per cabang (D3: tetap level perusahaan, LIMITED ditolak), audit log per cabang (D9).

## 2. Aturan otorisasi (ditegakkan di backend)

Urutan: autentikasi → akses perusahaan → (flag) → akses cabang saat ini → permission efektif (`report.read`, `report.consolidated`) → aturan cakupan. Semua masukan hak berasal dari `request.companyAccess` (System DB, dibaca tiap request, tanpa cache); satu-satunya masukan klien adalah string `scope`.

| Kondisi | Hasil |
|---|---|
| Flag OFF | cakupan = seluruh perusahaan, SQL tanpa filter; `scope` selain kosong/`all` → 400; LIMITED tanpa akses Kantor Pusat → 404 |
| Tanpa `scope` (flag ON) | cabang kerja aktif tervalidasi; tanpa cabang aktif → 403 `REPORT_SCOPE_NO_BRANCH` |
| `branch:X` | X dalam akses (INACTIVE/CLOSED boleh, historis) → 200; selain itu **404 identik** dengan id yang tidak ada |
| `selected:`/`branches:`/`all` | tanpa `report.consolidated` → 403 (tidak bergantung pada id, tanpa oracle); dengan izin tetapi ada id di luar akses → 404 seragam; `all` tanpa akses ke seluruh cabang → 403 |
| DENY `report.consolidated` | mengalahkan role; GRANT membuka untuk STAFF |
| Delegasi `view_branch_reports` | tidak pernah memperluas cakupan |
| Parameter rusak, duplikat, >50 id, array berulang | 400 / dinormalkan; tidak pernah melebarkan cakupan |
| Header `X-Branch-Context` ke cabang di luar akses | 403 (sudah ada sejak Phase 3) |
| Ekspor | cakupan dievaluasi ulang di awal request; komparasi ekspor → 400 |
| Pencabutan akses | berlaku pada request berikutnya (diuji) |
| Route level perusahaan (analisis, proyeksi, pajak, audit log) | tetap 403 untuk LIMITED |

## 3. Perubahan backend

Baru: `db/company/report-scope.ts` (resolver murni + tipe bermerek + `applyBranchScope`), `middleware/report-scope.ts` (integrasi request), `db/company/reporting/report-comparison.ts` (komparasi + rekonsiliasi), `db/company/reporting/inter-branch-position.ts` (posisi antar-kantor informatif).
Diubah (parameter `scope` opsional, tanpa nilai berarti SQL identik): `ledger-service`, `reporting-utils`, `balance-sheet/income-statement/equity-statement/cash-flow-service`, `trial-balance-service`, `counterparty-service`, `dashboard-service` (draft, aktivitas terbaru, saldo awal per cabang).
Route: `company-reports` (4 laporan + ekspor), `company-ledger` (Neraca Saldo + Buku Besar), `company-dashboard`, `company-counterparties` (saldo), `company-search` (LIMITED difilter dari akses server). Respons memuat `scope`; gabungan memuat `interBranch`.
Ekspor: `ReportDocument.scopeLabel` (wajib, null untuk seluruh perusahaan), baris "Cakupan/Catatan" di XLSX dan PDF, akhiran nama file `-Cabang-<nama>` / `-Gabungan-...-Belum-Dieliminasi`.
`branch-context` menambah `capabilities.viewConsolidatedReports` dan `allBranchesAccessible` (kenyamanan UI; bukan penegakan).

Catatan desain: parameter `scope` bersifat opsional pada fungsi layanan (tidak wajib seperti rencana awal) agar ratusan pemanggil dan tes lama tidak berubah. Keamanan tidak bergantung pada kewajiban kompilator: route yang lupa cakupan tetap **ditolak untuk LIMITED** oleh `BRANCH_AWARE_ROUTES` (deny by default), dan tes arsitektur memaksa (a) setiap route baca-keuangan terklasifikasi, (b) setiap route yang sadar-cabang memakai `resolveRequestReportScope`, (c) setiap berkas pembaca angka keuangan memfilter cakupan.

## 4. Perubahan frontend

`features/workspace/report-scope.ts` (tipe, penyimpanan per tab, `useReportScope`), `routes/workspace/report-scope/{report-scope-picker,scope-banner,comparison-view}.tsx`, hook laporan/Neraca Saldo/Buku Besar/Dashboard/Hutang-Piutang membawa `scope` dan kunci cache memuat cakupan + cabang aktif. Halaman: Laporan (4 tab + komparasi), Trial Balance (+ komparasi), Ledger, Dashboard, Hutang & Piutang, Buku Kas/Bank. **BC-1**: cabang aktif di `sessionStorage` (per tab). Pemilih dan banner tidak tampil pada perusahaan tanpa multi-cabang. UI menampilkan `scope` dari **respons server**, bukan pilihan lokal.
Ekspor komparasi dinonaktifkan dengan penjelasan; tab Arus Kas pada komparasi menampilkan "belum tersedia" (bukan angka palsu).

## 5. Penyesuaian terhadap aturan frontend (`TERRA-Finance-Offline/rules`)

Lima berkas aturan membaca "landing page, portofolio, redesign; bukan dashboard" (bagian 13: dashboard/tabel data di luar cakupan). Yang diterapkan adalah bagian yang berlaku umum dan biner:
- **Larangan em-dash/en-dash pada teks yang terlihat pengguna** (bagian 9.G): 34 kemunculan di 18 berkas web dibersihkan (placeholder `-`, judul memakai `:`, kode akun `kode - nama`, rentang memakai `-`). Label cakupan server memakai `:` (mis. "Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi"). Skrip uji yang memilih opsi berlabel `1112 — Kas...` disesuaikan menjadi `1112 - Kas...`.
- Label di atas input, tanpa placeholder-sebagai-label, kontras tombol/teks, tombol satu baris, status loading/kosong/galat, tanpa animasi baru (reduced-motion tidak relevan), tanpa avatar/angka palsu: dipenuhi pada komponen baru.
- **Sengaja tidak diubah**: struktur navigasi, label menu, slug rute, dan alur (bagian 11.F "tidak berubah diam-diam"), serta dial desain landing (tidak berlaku untuk dashboard keuangan). Satu pengecualian terdokumentasi: judul periode ekspor XLSX/PDF memakai en dash (`01 Januari 2026 – 31 Januari 2026`, `document.ts`); mengubahnya mengubah hash dokumen pada golden master ekspor sehingga perlu persetujuan (golden direkam ulang).
- Konflik yang dicatat: keputusan D2 menulis label dengan em dash; aturan terbaru melarangnya. Dipakai versi bertanda baca `:` dengan makna identik ("belum dieliminasi" tetap eksplisit).

## 6. Hasil pengujian (aktual)

| Pemeriksaan | Hasil |
|---|---|
| Typecheck api / web / shared | 0 / 0 / 0 galat |
| `pnpm test` | **996/996** (77 berkas; sebelumnya 968; +28: 9 resolver, 16 HTTP otorisasi laporan, 2 arsitektur, 1 balapan idempotensi) |
| Tes HTTP otorisasi laporan per cabang (`report-scope-http.test.ts`, DB nyata, 13 persona/override) | 16/16: angka dihitung tangan per cabang, 404 identik tanpa oracle, 403 izin tanpa bergantung id, DENY/GRANT, header palsu, IDOR, lintas perusahaan, pencabutan seketika, pencarian/ledger/dashboard/counterparty/ekspor (isi XLSX dan nama file), flag OFF identik |
| **Uji mutasi** (13 mutan: id di luar akses diterima, `report.consolidated` diabaikan, filter cabang hilang, middleware selalu izinkan, flag OFF tanpa cek Pusat, pencarian tak difilter, label ekspor hilang, saldo counterparty/aktivitas dashboard/saldo awal buku besar tak difilter, Gabungan salah hitung, default = seluruh perusahaan, akses dilebarkan) | **13/13 terdeteksi** (dua mutan lolos pada putaran pertama, tes ditambah, lalu terdeteksi) |
| Golden master (flag OFF; `scope`/`scopeLabel` dikecualikan eksplisit) | small **43/43**, uat-1 **126/126** identik byte-per-byte |
| Golden dataset multi-cabang, `scope=all` vs golden perusahaan-penuh | uat-3 **125/125**; uat-7 119/125 (6 dashboard berbeda hanya karena peringatan "saldo awal" milik dataset uat-7, terbukti ada juga tanpa cakupan; semua laporan identik) |
| **Per cabang vs oracle SQL independen** (tiap cabang, subset dua cabang, seluruh cabang: aset/kewajiban/ekuitas, laba, kas, Neraca Saldo bertanda per akun, Buku Besar; komparasi terekonsiliasi) | uat-3 **39/39**, uat-7 (7 cabang) **67/67** |
| E2E keamanan (data bersih) | **39/39** (37 sebelumnya; satu pemeriksaan "LIMITED ditolak di laporan" diperbarui sesuai perilaku baru dan dipecah menjadi dua: level perusahaan tetap ditolak; laporan hanya cabang sendiri, cabang lain 404, `scope=all` 403) |
| UI E2E Chrome Antar Cabang | **29/29** |
| UI E2E Chrome Phase 5 (`scripts/phase5-ui-e2e/ui-scope.cjs`) | **23/23**: LIMITED satu cabang, akses langsung API dari sesi LIMITED, banner, gabungan berlabel + posisi antar-kantor, komparasi, VIEWER tanpa opsi gabungan, dua tab dua cabang, flag OFF tanpa pemilih |
| UAT HTTP Antar Cabang (skenario S14 kini memverifikasi laporan LIMITED dengan data transaksi nyata) | **19/19 PASS** (sebelumnya 18 PASS + 1 BLOCKED) |
| Waktu respons (uat5 12k jurnal) | Neraca cabang tunggal ≈ 60 ms; gabungan ≈ 140 ms; Arus Kas gabungan ≈ 1 dtk; Dashboard gabungan ≈ 2,4 dtk (sama dengan baseline Phase 5.0), cabang tunggal ≈ 0,2 dtk; komparasi 2 cabang ≈ 0,2 dtk; **7 cabang + Gabungan: Neraca 1,9 dtk, Neraca Saldo 2,3 dtk (sedikit di atas anggaran 2 dtk)** |

Tidak dijalankan: harness Phase 3 (`e2e-phase3.mjs`) karena ROOT-nya menunjuk `TERRA-Finance-Offline` (workspace lama; dilarang), serta uji jendela Electron untuk layar Phase 5 (installer sengaja tidak dibangun ulang pada tahap ini; bundel web yang diuji di Chrome sama dengan yang dimuat Electron).

## 7. Keterbatasan laporan gabungan sebelum eliminasi

Lihat `CONSOLIDATION-ELIMINATION-REQUIREMENTS.md`. Ringkas: gabungan menjumlahkan cabang apa adanya; total aset dan liabilitas **bruto** selama ada saldo antar-kantor terbuka (transfer kas menaikkan keduanya sebesar nominal; pembebanan menaikkan liabilitas dan menurunkan laba tanpa mengurangi aset gabungan). Neraca dan Neraca Saldo tetap seimbang; pembalikan mengembalikan semuanya. Setiap tampilan, ekspor, dan nama file gabungan menyatakan "belum dieliminasi" dan "bukan laporan konsolidasi final"; laporan tidak pernah disebut konsolidasi. Tidak ada jurnal eliminasi dibuat dan jurnal sumber tidak diubah.
Keterbatasan lain: Arus Kas per cabang menampilkan transfer antar-cabang sebagai "Belum Terklasifikasi" (akun antar-kantor belum diklasifikasikan); akun yang hanya dikelola Kantor Pusat (mis. Modal) tidak ada di Neraca cabang non-Pusat (diberi catatan di banner).

## 8. Perubahan terhadap berkas baseline Phase 3 (log)

Baseline Phase 3 dan manifestnya tidak diedit. Berkas bermanifest yang kini berbeda dari manifest (71 dari 435; sebagian dari Antar Cabang IB-1…IB-6 pada 2026-10-08) dan yang berubah pada Phase 5:
- **BC-2 (disetujui)**: `middleware/branch-authority.ts` (+10 entri `BRANCH_AWARE_ROUTES`), `modules/company-branches/routes.ts` (dua capability tambahan, aditif).
- **BC-1 (disetujui)**: `web/src/lib/active-branch.ts` (localStorage → sessionStorage).
- **Cakupan laporan (aditif, parameter opsional)**: layanan laporan/ledger/Neraca Saldo/counterparty/dashboard, route laporan/ledger/dashboard/counterparty/pencarian, `report-export/{build,document,pdf,xlsx}`, hook web laporan dan halaman terkait.
- **Penyesuaian aturan frontend (teks saja)**: 18 berkas web (tanda pisah), `scripts/inter-branch-ui-e2e/*.cjs` (label opsi).
- Tes: `scope-readiness.test.ts` (registri dan daftar berkas diperbarui sesuai mekanisme yang dirancang untuk itu), `company-branches/routes.test.ts` (route yang kini sadar-cabang keluar dari daftar "ditolak"; tiga route level perusahaan ditambahkan ke daftar itu), `report-export/document.test.ts` (satu bidang `scopeLabel: null`), `company-inter-branch/routes.test.ts` (tes flag OFF + input tidak valid). **Tidak ada tes yang dilonggarkan atau dihapus.**
- Harness: `docs/uat/harness/phase5/golden.mjs` (`stripScope`, `GOLDEN_SCOPE`, mode `scoped`), `docs/uat/harness/multibranch/e2e.mjs` (pemeriksaan LIMITED diperbarui).
- Perbaikan Antar Cabang dari UAT (validasi setelah cek flag, modal via portal, galat terlihat) tercatat di `INTER-BRANCH-UAT-REPORT.md`.
- **Cacat Antar Cabang ditemukan saat regresi dan diperbaiki** (`inter-branch-service.ts`): pengajuan serempak dari beberapa proses dengan kunci idempotensi yang sama dapat membuat proses yang kalah menerima galat mentah `SQLITE_CONSTRAINT_UNIQUE` (HTTP 500) karena pra-cek idempotensi dijalankan di luar transaksi. Data tidak pernah rusak (indeks UNIQUE menolak duplikat; transaksi yang kalah di-rollback penuh), tetapi pemanggil seharusnya menerima replay idempoten. Muncul sebagai kegagalan sesekali tes balapan lintas-proses pada beban penuh (2 dari 5 putaran `pnpm test`; selalu lulus bila dijalankan sendiri). Akar penyebab: balapan pra-cek vs insert. Perbaikan minimal: pelanggaran UNIQUE pada `(proposed_by, idempotency_key)` diterjemahkan menjadi replay pemenang (atau konflik bila isi berbeda). Tes deterministik baru memakai pra-cek yang "buta" sekali; mutan tanpa perbaikan terdeteksi; tes balapan lintas-proses 4 putaran berturut-turut lulus; regresi penuh 996/996.

## 9. Risiko yang belum selesai

1. **Laporan gabungan bruto** (bagian 7) sampai Phase 7; pengguna harus membaca label.
2. Komparasi belum set-based: 7 cabang + Gabungan ≈ 2 dtk (Neraca Saldo 2,3 dtk); batas komparasi 12 cabang. Komparasi Arus Kas/Dashboard belum ada.
3. Dashboard gabungan seluruh cabang ≈ 2,4 dtk (tidak lebih lambat dari baseline; optimasi belum dikerjakan).
4. `scope` opsional pada layanan (bagian 3): disiplin dijaga tes arsitektur dan deny-by-default, bukan kompilator.
5. Analisis, proyeksi, pajak, audit log tetap level perusahaan (LIMITED ditolak): akuntan cabang belum punya rasio/pajak per cabang.
6. Perubahan perilaku ALL-scope saat flag ON: tanpa parameter laporan = cabang aktif; pengguna tanpa `report.consolidated` (STAFF, VIEWER) tidak lagi melihat total perusahaan (D1, disetujui; relevan saat aktivasi).
7. Layar Phase 5 belum diverifikasi di jendela Electron (installer perlu dibangun ulang); batas laju per IP (temuan UAT) tidak diubah.
8. Judul periode ekspor memakai en dash (bagian 5); perlu persetujuan karena memengaruhi golden master ekspor.
9. Aktivasi nyata tetap menunggu: UAT bisnis dengan data klien, eliminasi (atau penerimaan tertulis atas label bruto), uji instalasi NSIS, tinjauan batas laju, dan backup terverifikasi.

## 10. Kesiapan UAT pengguna bisnis

**READY** dengan perusahaan uji yang multi-cabangnya dinyalakan OWNER secara sadar. Skenario yang layak diuji bisnis: akuntan cabang membuka laporan/ledger/dashboard cabangnya dan mencocokkan dengan transaksi Antar Cabang; akuntan dua cabang memakai gabungan terpilih dan komparasi; OWNER memakai gabungan seluruh cabang dan membaca label "belum dieliminasi"; memeriksa dua tab dengan cabang berbeda; ekspor XLSX/PDF per cabang dan gabungan. Harap perhatikan keterbatasan bagian 7 dan 9.

Berhenti di sini: tidak ada aktivasi di perusahaan nyata dan tidak ada fase lain yang dimulai.

## 11. Stabilisasi dan gerbang kesiapan UAT (2026-10-09, sesi kedua)

Tujuan: membuktikan Phase 5A/5B stabil sebelum UAT bisnis. Tidak ada kode dari workspace lama atau 5A WIP; Phase 7, batas laju, autentikasi, dan izin tidak diubah; multi-cabang tidak diaktifkan pada perusahaan nyata.

### 11.1 Integritas baseline Phase 3 (audit isi, bukan hanya hash)
Detail dan daftar berkas: [`docs/baseline/PHASE-5-BASELINE-CHANGE-AUDIT.md`](../baseline/PHASE-5-BASELINE-CHANGE-AUDIT.md) (dihasilkan otomatis).
- Pembanding: salinan P-1 yang cocok manifest (433 dari 435 berkas tersedia; 2 berkas dokumen tidak ada di salinan dan masih cocok manifest). **72 dari 435 berkas** berbeda dari manifest, **0 hilang**. Kategori: Antar Cabang IB-1..IB-6 dan perbaikan UAT (18), Phase 5A/5B cakupan laporan (36), IB + Phase 5 (3), aturan frontend/tanda pisah (15). Manifest dan dokumen baseline tidak diedit.
- Setiap diff ditinjau: tidak ada perubahan di luar kategori yang disetujui; tidak ada perubahan pada `authorization.ts`, `rbac.ts`, `company-access-guard.ts`, migrasi lama, atau logika delegasi/override.
- Perubahan perilaku global pada kode baseline yang harus diketahui: `recursive_triggers = ON` pada semua koneksi company.db; penutupan periode diblokir oleh pengajuan antar-cabang menunggu; awalan `IB-` dicadangkan; penonaktifan multi-cabang atau cabang membatalkan/memblokir pengajuan menunggu. Semuanya dari Antar Cabang yang disetujui; tanpa data antar-cabang efeknya nol.
- **Bukti kompatibilitas dengan tes ASLI baseline**: versi asli 5 berkas tes baseline yang berubah dijalankan terhadap kode saat ini: 72 lulus, **5 gagal**; kelimanya persis ekspektasi yang digantikan keputusan yang disetujui (K-1 tautan `inter_branch_*`, asal `inter_branch`, status cabang tertutup, LIMITED membaca laporan, registrasi route Antar Cabang). Seluruh tes baseline lain lulus tanpa perubahan.
- Satu perubahan yang sebelumnya tidak didokumentasikan ditemukan: `workspace-shell.tsx` footer tanpa `z-10` (kosmetik). Tidak ada perubahan baseline yang perlu dihentikan atau dipulihkan.

### 11.2 Golden Master uat-7: enam perbedaan dashboard
- **Apa yang berbeda**: enam respons dashboard (tahun 2021 sampai 2026) saat uat-7 dibandingkan dengan golden **uat-1**. Selisihnya tepat satu item: `alerts[1]` = `opening_balance_missing` ("Saldo awal perusahaan ini belum diisi") yang hanya ada di uat-7; seluruh angka, KPI, tren, dan aktivitas identik (diff per-field, in-process, enam tahun).
- **Akar penyebab**: dataset uat-7 menaruh satu-satunya jurnal saldo awal di cabang **Kotabumi** (non-pusat), sedangkan `getOpeningBalance(db)` tanpa cabang mencari saldo awal **Kantor Pusat** (perilaku Phase 2, tidak berubah). Pada uat-1 jurnal saldo awal ada di Pusat. Jadi perbedaan berasal dari dataset yang berbeda, bukan dari Phase 5.
- **Bukti sebelum/sesudah pada dataset yang sama**: `GOLDEN_SCOPE=all node golden.mjs verify uat-7` terhadap golden uat-7 sendiri (direkam sebelum satu baris pun Phase 5) = **126/126 identik** (termasuk enam dashboard); uat-3 juga 126/126. Pembandingan ke golden uat-1 pada sesi sebelumnya (119/125) adalah pembanding yang keliru untuk dashboard, bukan regresi. Golden **tidak** direkam ulang untuk menyembunyikan apa pun.
- Catatan perilaku: pada cakupan satu cabang, peringatan saldo awal memakai saldo awal cabang itu; cabang tanpa saldo awal menampilkan "Saldo awal perusahaan ini belum diisi" (teks lama, kurang tepat untuk cabang). Risiko kosmetik, dicatat di 11.7.

### 11.3 Idempotensi pengajuan Antar Cabang
- Perbaikan sebelumnya (UNIQUE `(proposed_by, idempotency_key)` diterjemahkan menjadi replay pemenang) diverifikasi ulang.
- Tes baru: (1) deterministik: pra-cek "buta" sekali memaksa jalur UNIQUE; pecundang menerima replay yang sama, isi berbeda = konflik, satu transaksi/persetujuan, integritas bersih; penerjemah hanya mengenali UNIQUE idempotensi (UNIQUE `transaction_no` atau galat lain tidak diterjemahkan); (2) lintas-proses nyata: 6 putaran x 4 proses (stres `RACE_PROCS=10 RACE_ROUNDS=8`): semua hasil `ok` atau 503; paling banyak satu pembuatan; semua `ok` memuat id pemenang yang sama; ulang setelah 503 menghasilkan replay; tepat 1 transaksi, 1 persetujuan, audit hanya `CREATED`+`SUBMITTED`, **0 jurnal** per kunci; (3) dua pengguna dengan kunci sama tidak saling me-replay; (4) HTTP dua proses server (UAT S17): 5 putaran x 8 permintaan serempak: satu 201, sisanya 200 replay, tanpa 500, tanpa efek ganda; kunci sama isi berbeda 409; kegagalan validasi tetap 422.
- **Kejujuran tentang deteksi**: tanpa perbaikan, tes lintas-proses konfigurasi biasa (4 proses) **tidak** menangkap cacat saat dijalankan sendirian (balapan jarang terjadi tanpa beban); cacat asli muncul 2 dari 5 kali pada `pnpm test` penuh. Mutan tanpa perbaikan **terdeteksi** oleh tes deterministik dan oleh tes lintas-proses pada konfigurasi stres 10x8. Dengan perbaikan: stres 10x8 dua kali lulus; `pnpm test` penuh 3 putaran berturut-turut 999/999.

### 11.4 Format ekspor
- En dash pada rentang tanggal ekspor diganti hyphen ("01 Januari 2026 - 31 Desember 2026"; `report-export/document.ts`). Pencarian seluruh teks ekspor yang terlihat (judul, perusahaan, periode, label cakupan, baris, nama file): tidak ada em/en dash tersisa (satu-satunya karakter en dash di `pdf.ts` adalah pembersih data pengguna yang memetakannya ke `-`).
- **Diff output diperiksa sebelum golden diubah**: 28 dokumen ekspor (uat-1 tanpa cakupan; uat-3 cabang tunggal, terpilih, seluruh cabang; semua jenis laporan, buku besar rentang dan periode) dibandingkan sebelum/sesudah: **28/28 hanya berbeda pada pemisah `periodLabel`**; judul, perusahaan, `fileBase`, kolom, baris, angka, dan label cakupan identik.
- Golden diperbarui **hanya** bagian `exportDocuments` lewat mode `reexport`: pada keempat dataset, `requests` dan `aggregateSha256` identik, hanya 6 hash ekspor per dataset berubah. Setelahnya small 43/43, uat-1 126/126, uat-3 126/126, uat-7 126/126.
- Tes: tiga ekspektasi string periode diperbarui (alasan: aturan frontend); tes baru memverifikasi label gabungan di PDF dan XLSX serta ketiadaan em/en dash; di Electron isi XLSX diperiksa (periode, label cakupan, label bruto, nama file).
- Tidak diubah: pesan aplikasi yang memakai " -- " (dua hyphen) sebagai pemisah (ratusan pesan lama; bukan karakter terlarang secara harfiah, tetapi sejalan dengan semangat aturan). Disarankan sebagai pekerjaan teks tersendiri.

### 11.5 Validasi UI di Electron
- Build **terisolasi**: `prepare-deploy` + `electron-builder --dir` ke direktori keluaran scratch (installer resmi di `apps/desktop/dist` tidak disentuh; ABI native workspace dipulihkan). Isi bundel dibandingkan dengan `apps/web/dist` dan `apps/api/dist` (SHA-256: 15/15 dan 577/577 identik; yang "hilang" hanya `*.test.js`). Data: `--user-data-dir` terpisah, salinan UAT; `%APPDATA%\TERRA FINANCE` diperiksa tidak berubah.
- `scripts/phase5-ui-e2e/electron-scope.cjs` (login sungguhan): **22/22 PASS**: LIMITED Metro (banner, tanpa opsi gabungan, API langsung ke cabang lain 404 identik dengan id palsu, `scope=all` 403), cabang aktif bertahan saat muat ulang pada tab yang sama, Dashboard/Hutang-Piutang/Ledger/Trial Balance LIMITED terbuka, OWNER: gabungan seluruh cabang berlabel + posisi antar-kantor bruto, komparasi (kolom + Gabungan + rekonsiliasi), ekspor dinonaktifkan pada komparasi, ekspor XLSX cabang tunggal dan gabungan (isi dan nama file), **dua tab (window.open) dengan cabang berbeda tidak saling memengaruhi**, VIEWER tanpa opsi gabungan dan `scope=all` 403, perusahaan flag OFF tanpa pemilih/banner, `diagnostic.log` tanpa galat. Tangkapan layar diperiksa; satu temuan visual (teks pemilih terpotong) diperbaiki (lebar `w-80`) dan build terisolasi dibangun ulang sebelum putaran akhir.
- Regresi Electron Antar Cabang (`electron-flow.cjs`, `UAT_EXTRA=1`) pada build yang sama: **26/26**; satu HTTP 500 adalah kegagalan posting yang disuntik sengaja. Verifikasi akuntansi pasca-uji 19/19; `integrity_check` ok dan `foreign_key_check` 0 pada seluruh database.
- Batas: tab kedua di Electron hanya dapat dibuka lewat `window.open` (aplikasi satu jendela); CDP `newPage` tidak didukung.

### 11.6 Hasil pengujian akhir (aktual)
| Pemeriksaan | Hasil |
|---|---|
| Typecheck api / web / shared | 0 / 0 / 0 |
| `pnpm test` (3 putaran penuh berturut-turut) | **999/999** x3 (77 berkas) |
| Tes HTTP otorisasi laporan (DB nyata) + resolver | 16/16 + 9/9; uji mutasi 13/13 terdeteksi |
| Golden master | small 43/43; uat-1 126/126; uat-3 126/126; uat-7 126/126 (flag ON dengan `scope=all`) |
| Oracle SQL independen per cabang | uat-3 39/39; uat-7 67/67 |
| E2E keamanan (data bersih) | 39/39 |
| UI Chrome Antar Cabang / Phase 5 | 29/29 / 23/23 |
| Electron Phase 5 / Antar Cabang | 22/22 / 26/26 |
| UAT HTTP Antar Cabang (+S17 idempotensi lintas proses server) | 20/20 |
| Integritas DB (`integrity_check`, `foreign_key_check`, `verifyInterBranchIntegrity`, saldo/jurnal seimbang) | bersih |

### 11.7 Risiko dan keterbatasan yang belum selesai
1. Laporan gabungan **bruto** (eliminasi = Phase 7); label wajib sudah ada, tetapi pengguna harus membacanya.
2. Komparasi belum set-based: 7 cabang + Gabungan: Neraca 1,9 dtk, Neraca Saldo 2,3 dtk (anggaran 2 dtk); Arus Kas/Dashboard tidak punya komparasi.
3. Peringatan saldo awal pada cakupan cabang memakai teks "perusahaan" (kosmetik).
4. Tes lintas-proses konfigurasi biasa tidak menangkap cacat idempotensi tanpa beban; perlindungan utama adalah tes deterministik (dan konfigurasi stres opsional).
5. Installer resmi belum dibangun ulang dengan Phase 5; Electron diuji pada build terisolasi. Distribusi UAT memerlukan build resmi dari pohon ini, uji wizard NSIS di mesin uji, dan keputusan penandatanganan.
6. Harness Phase 3 historis menunjuk workspace lama dan tidak dijalankan.
7. Pesan aplikasi lama memakai " -- " sebagai pemisah (teks, bukan karakter terlarang).
8. Data UAT sintetis; perilaku pada data klien nyata belum terbukti. Batas laju per IP dan perilaku multi-perangkat tidak diubah (temuan UAT Antar Cabang tetap berlaku).
9. Perubahan perilaku default ALL-scope saat flag ON (cabang aktif) memerlukan komunikasi ke pengguna.

### 11.8 Keputusan
**Phase 5A/5B LAYAK memasuki UAT bisnis yang terkontrol**, dengan syarat: perusahaan uji (bukan perusahaan nyata) yang multi-cabangnya dinyalakan sadar oleh OWNER; build UAT diambil dari pohon ini; pengguna diberi tahu bahwa gabungan bersifat bruto dan perilaku default per cabang; data nyata tidak dipakai. **Tidak ada blocker teknis tersisa untuk UAT.** Ini **bukan** pernyataan kesiapan produksi: aktivasi di perusahaan nyata tetap menunggu hasil UAT bisnis, keputusan eliminasi (atau penerimaan tertulis atas laporan bruto), build/instalasi resmi yang diuji, tinjauan batas laju, dan backup terverifikasi.
