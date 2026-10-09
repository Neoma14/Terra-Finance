# INTER-BRANCH — IMPLEMENTATION REPORT (IB-1 s.d. IB-6)

**Tanggal:** 2026-10-08 · **Workspace:** `D:\ABDI\Proyek Aplikasi\Codex\TERRA-FINANCE-CLEAN` · **Dasar:** Spek, Plan, `IB-1-SPEC-CHANGELOG.md`, `IB-1-PREFLIGHT-REPORT.md`, `IB-1-IMPLEMENTATION-REPORT.md`.
**Status akhir:** **Fitur Antar Cabang berfungsi end-to-end dan teruji di backend, database, dan browser (Chrome) terhadap server hasil build.** Yang belum dilakukan: membangun ulang installer Electron dan menjalankan uji di jendela Electron (lihat §12). `multi_branch_enabled` tetap OFF secara default; baseline Phase 3 historis, manifestnya, `TERRA-Finance-Offline`, dan Phase 5A WIP tidak disentuh. Phase 5A/6 tidak dikerjakan.

## 1. Fitur yang benar-benar selesai

| Kemampuan | Status | Bukti |
|---|---|---|
| Ajukan transaksi (Transfer Kas, Pembebanan) — create = submit, tanpa jurnal, nomor `IB-YYYY-NNNNNN`, idempoten | ✅ | tes service, HTTP, UI |
| Setujui = terima = posting dua jurnal **atomik** (FROM & TO), akun pasangan dari `counterpart_branch_id`, konfirmasi akun penerima | ✅ | golden Metro→BL, injeksi kegagalan di 5 titik tulis, UI |
| Tolak (alasan wajib), batalkan (pengaju/OWNER), kedaluwarsa (virtual saat dibaca, ditulis saat diterapkan) | ✅ | tes service/HTTP/UI |
| Pembalikan berpasangan (minta → lawan menyetujui → 2 jurnal REVERSAL; tolak/batal/kedaluwarsa) | ✅ | tes service/HTTP/UI, atomik teruji |
| OWNER: buat/setujui/selesaikan/balik milik sendiri tanpa user lain & tanpa delegasi; non-OWNER maker ≠ approver (403 `SELF_APPROVAL_NOT_ALLOWED`); delegasi tidak memberi hak | ✅ | tes service + HTTP + UI |
| Otorisasi: permission efektif ∩ akses cabang (`canActOnBranch`), DENY/GRANT, IDOR 404 seragam, lintas perusahaan, flag OFF → 404 seragam | ✅ | 14 tes HTTP + 45 tes service |
| K-3: OWNER tidak dapat mematikan multi-cabang saat `WAITING_APPROVAL`/`REVERSAL_WAITING` — pesan jelas (409) | ✅ | tes service + HTTP; trigger DB sebagai penjaga akhir |
| Penutupan periode diblokir selama ada pengajuan/pembalikan menunggu; cabang INACTIVE/CLOSED membatalkan otomatis | ✅ | tes service |
| Audit per cabang untuk semua peristiwa (§10) | ✅ | tes |
| Integritas: `verifyInterBranchIntegrity` (jurnal yatim, tautan tidak valid, pasangan hilang, nominal/arah, status, persetujuan) dipakai sebagai **pasca-kondisi posting** dan sebagai diagnostik | ✅ | 12 tes + pasca-kondisi |
| UI: menu bersyarat + lencana, daftar Masuk/Keluar/Semua, filter & pencarian, form, detail, persetujuan/penolakan/pembatalan/pembalikan, riwayat, jurnal terkait, pengaturan masa berlaku (OWNER) | ✅ | 29 pemeriksaan di Chrome |
| F-1: SQLite concurrency — antrean tulis per perusahaan + `SQLITE_BUSY` → 503 aman diulang | ✅ | tes dua koneksi, mutan terdeteksi |
| `INSERT OR REPLACE`/UPSERT tidak lagi jalan pintas (`recursive_triggers=ON` pada koneksi aplikasi) | ✅ | tes baru + mutan terdeteksi |

## 2. Perubahan migration
**Tidak ada migration baru** setelah `C0019_inter_branch` (IB-1) — skema C0019 sudah mencukupi seluruh alur. Penjaga database (20 trigger, 2 indeks unik parsial, CHECK) tidak diubah; yang ditambah di sisi koneksi: `PRAGMA recursive_triggers = ON` pada `createCompanyDb`.

## 3. Perubahan backend
**Berkas baru** (`apps/api/src`): `db/company/inter-branch-service.ts` (alur tulis), `inter-branch-queries.ts` (daftar/detail/ringkasan/pilihan formulir), `inter-branch-lifecycle.ts` (kedaluwarsa, K-3, pembatalan otomatis, blocker periode), `company-write-queue.ts` (antrean tulis), `modules/company-inter-branch/routes.ts` (14 rute). Dari IB-1: `inter-branch-domain.ts`, `inter-branch-accounts.ts`, `inter-branch-integrity.ts`, `migrations/C0019_inter_branch.ts`.
**Berkas baseline yang diubah** (catatan perubahan; baseline historis tidak ditulis ulang): `journal-service.ts` (tautan IB pada `createDraftJournalEntry`; reversal internal IB; guard referensi `IB-`), `branch-service.ts` (origin `inter_branch` didukung; guard K-3 di `setMultiBranchEnabled`; pembatalan otomatis & peringatan pada status cabang), `period-closing-service.ts` (blocker), `db/company/index.ts` (`recursive_triggers`), `account-service.ts`, `account-policy-service.ts`, `journal-import-service.ts`, `middleware/branch-authority.ts` (`BRANCH_AWARE_ROUTES` + pemetaan K-3), `server.ts`, tiga route (`company-accounts`, `company-branches`, `company-journal`).
**Rute** (`/api/company-db/:slug/inter-branch`, semua `requireAuth → requireCompanyAccess → flag → permission → wewenang per-cabang di service`): `GET /`, `GET /summary`, `GET /options`, `GET|PUT /settings`, `GET /:id`, `POST /`, `POST /:id/{approve,reject,cancel,reverse}`, `POST /:id/reverse/:approvalId/{approve,reject,cancel}`. Tidak ada PUT/PATCH/DELETE atas transaksi.

## 4. Perubahan frontend
Baru: `features/workspace/{inter-branch-types,use-inter-branch}.ts`, `routes/workspace/inter-branch/{inter-branch-page,inter-branch-form-modal,inter-branch-detail-modal,inter-branch-status-badge}.tsx`. Diubah: `nav-config.ts` (`requires: "inter-branch"`), `workspace-shell.tsx` (filter menu + lencana), `App.tsx`, `use-journal.ts` (tipe `isCash/branchPolicy`), `company-api-client.ts` (membawa `code` galat server).
**Perbaikan akar masalah yang ditemukan lewat uji browser:** footer "Powered by…" (`relative z-10`) berada di atas konten `<main>` (`relative z-10`, lebih awal di DOM) sehingga **menutupi dan mencegat klik pada modal mana pun** yang kontennya melintasi area footer (terbukti: tombol "Setujui & Posting" tidak dapat diklik). Footer diubah menjadi `relative` (tanpa z-index) di `workspace-shell.tsx`; berlaku untuk semua modal.

## 5. Alur transaksi dan pembentukan jurnal
1. **Ajukan** (cabang asal = cabang kerja aktif tervalidasi server): validasi jenis/nominal/tanggal/akun/cabang/periode/kebijakan akun/akun antarkantor pasangan → baris `WAITING_APPROVAL` + persetujuan `POST` + audit `CREATED`,`SUBMITTED`. **Tidak ada jurnal.** `expires_at` = min(+N hari, akhir hari tanggal+batas backdate).
2. **Setujui** (antrean tulis → satu `db.transaction`): kedaluwarsa ditandai dulu; izin `interbranch.approve` di cabang tujuan; `assertCanDecide` (OWNER lolos; lainnya maker ≠ approver); validasi ulang (cabang ACTIVE, periode, akun, aturan jenis); **klaim bersyarat status** (`WHERE status='WAITING_APPROVAL'`); resolusi akun antarkantor; dua kali `createDraftJournalEntry`+`postJournalEntry` (fungsi jurnal yang ada, savepoint, galat tidak ditangkap); pasca-kondisi `verifyInterBranchIntegrity`; audit `APPROVED`,`ACCOUNT_CONFIRMED`,`POSTED`,`COMPLETED`.
   Jurnal (Metro → BL Rp1.000.000, transfer kas): **FROM** D Antarkantor [lawan = BL] / K Kas Metro; **TO** D Kas BL / K Antarkantor [lawan = Metro]. Referensi `IB-…-F` dan `IB-…-T`; pembuat = pengaju, pemosting = penyetuju. Pembebanan: sama, akun penerima = beban/hutang yang dikonfirmasi.
3. **Tolak / Batalkan / Kedaluwarsa** → status terminal tanpa jurnal.
4. **Pembalikan**: minta (alasan ≥10 karakter, periode asal harus OPEN, kedua cabang ACTIVE) → `REVERSAL_WAITING`; cabang lawan menyetujui → klaim `REVERSED` → `reverseJournalEntry` untuk kedua jurnal asal (pengecualian internal; jurnal asal hanya berubah status `POSTED→REVERSED`) → 4 jurnal, satu identifier.

## 6. Otorisasi dan keamanan
Server satu-satunya penentu; UI hanya menyembunyikan tombol. Tidak ada permission baru; model Phase 3 tidak diubah. Delegasi `inter_branch` tidak memberi hak (teruji lewat HTTP: DENY + delegasi tetap 403). Peran OWNER hanya dari `request.companyAccess.role`; body/query/header `role`, `selfApproved`, `status`, `userId`, `companyId` diabaikan (teruji). Transaksi tak terlihat = 404 identik dengan tak ada; perusahaan lain/tak ada = 404 identik; flag OFF = 404 identik termasuk untuk OWNER. DTO per sisi: akun & isi jurnal sisi lawan tidak dibuka.

## 7. Audit
`company_audit_log` (append-only, dalam transaksi yang sama, `branch_id` cabang pelaku): `INTER_BRANCH_CREATED/SUBMITTED/APPROVED` (+`actorRole`,`makerEqualsApprover`,`self_approved`)`/ACCOUNT_CONFIRMED/POSTED/COMPLETED/REJECTED/CANCELLED/EXPIRED/REVERSAL_REQUESTED/APPROVED/POSTED/REJECTED/CANCELLED/EXPIRED/SETTINGS_CHANGED`. Kedaluwarsa dan pembatalan otomatis memakai aktor sistem/aktor perubah cabang. Riwayat ditampilkan di detail.

## 8. Hasil pengujian (aktual, dijalankan di workspace ini)

| Pemeriksaan | Hasil |
|---|---|
| Typecheck api / web / shared | **0 / 0 / 0 error** |
| `pnpm test` | **967/967 lulus, 75 berkas, 0 gagal** (baseline P-1: 827/67; +4 tes balapan lintas-proses, §15) |
| Tes Antar Cabang khusus | migrasi 4 · trigger/penjaga 34 · domain 14 · akun 12 · integritas 12 · **alur service 45** · **HTTP 14** = **135** (+1 tes import) |
| Tes arsitektur fail-closed (padanan `check:boundaries`; skripnya tidak ada di repo) | **8/8** — semua rute baru terklasifikasi |
| Build api / web | OK / OK |
| Golden Master Phase 5.0 (flag OFF) | small **43/43**; uat-1, uat-3, uat-7 **126/126** identik |
| E2E keamanan Multi-Branch (padanan `test:e2e`) | **37/37** |
| **UI E2E di Chrome** (`scripts/inter-branch-ui-e2e`, data UAT 5 tahun) | **29/29**, 0 galat konsol/jaringan (alur ajukan → setujui → pembalikan, SoD, OWNER, VIEWER/STAF/tanpa cabang/flag OFF, filter) |
| Migrasi atas salinan UAT 5 tahun (6 company, server build) | 19 migrasi; `integrity_check` ok; `foreign_key_check` 0; `multi_branch_enabled` tetap 0 pada perusahaan yang tidak diaktifkan (hanya `pt-terra-nusantara` dinyalakan, di salinan uji UI); data hasil uji UI: `verifyInterBranchIntegrity` = **[]**, saldo bersih akun antarkantor = **0** |
| Konkurensi (dua koneksi ke satu file) | setuju ganda, setuju vs batal, minta/setuju reversal ganda, pengajuan ganda (idempotensi), nomor transaksi paralel: **selalu satu pemenang, tanpa `SQLITE_BUSY`, tanpa jurnal ganda**; lewat HTTP: `[200, 409]` |
| Injeksi kegagalan | 5 titik tulis posting + reversal sisi TO: **semua-atau-tidak**; ulang setelah pulih → tepat 2 (atau 4) jurnal |
| Uji mutasi tambahan (12 mutan: SoD, OWNER, IDOR, izin cabang tujuan, antrean tulis, flag OFF, `recursive_triggers`, kedaluwarsa, K-3, blocker periode, pembatalan otomatis, klaim status) | **11 terdeteksi**; 1 lolos — lihat §11 (2) |

## 9. Temuan keamanan dan bagaimana ditangani
1. **Modal tertutup footer (UI)** → klik terblokir; diperbaiki di akar (z-index footer).
2. **API mengirim boolean SQLite sebagai 0/1** (`isCash`, `isActive`) → penyaringan akun di UI awalnya kosong; UI memakai `Boolean(...)`.
3. **Konkurensi**: diredam antrean tulis + pemetaan `SQLITE_BUSY`; **`INSERT OR REPLACE`** sebelumnya melewati trigger (`recursive_triggers=0`) → kini ditolak.
4. Tidak ditemukan: bypass otorisasi, IDOR, kebocoran lintas perusahaan, atau posting ganda pada seluruh uji di atas.
5. Temuan insidental di data uji (bukan dari Inter-Branch): salinan UAT 5 tahun memiliki **1 jurnal tidak seimbang di dataset skala-besar ("BIG")**, ada juga pada backup aslinya — artefak data uji yang sudah ada.

## 10. Risiko yang masih tersisa
- Antrean tulis hanya per proses; bila kelak banyak proses/perangkat, penjaga kebenaran tetap klaim status + kunci SQLite + trigger; konflik menjadi 503 (aman diulang). Penulis non-IB yang bersamaan dapat membuat aksi IB menerima 503.
- Imutabilitas jurnal POSTED **non-IB** tetap penjagaan aplikasi (tidak diubah).
- Penutupan periode memblokir pengajuan menunggu, tetapi **penguncian** (LOCK) tidak: persetujuan setelah LOCK ditolak jelas (sesuai desain).
- Waktu kedaluwarsa memakai jam komputer lokal (risiko manipulasi jam diterima, Spek R-9).
- Delegasi `inter_branch` tetap inert (D-5).

## 11. Yang belum selesai / batasan
1. Installer Electron: **SELESAI dibangun dan diuji di jendela Electron — lihat §15**.
2. (Diselesaikan di §15 dengan tes balapan lintas-proses.) **Klaim bersyarat status** pada persetujuan adalah pertahanan berlapis (di balik pra-cek status + antrean + kunci SQLite); mutan yang menghapus kondisi itu tidak terdeteksi tes karena jalur balapan lintas-proses tidak dapat disimulasikan di satu proses. Tetap dipertahankan sebagai penjaga kebenaran lintas-proses.
3. UI tidak menyediakan: tombol mengubah flag multi-cabang (memang tidak ada UI untuk itu sejak Phase 1; pesan K-3 muncul di respons API), pemilihan counterparty (API mendukung), multi-baris, lampiran, ambang persetujuan (di luar MVP).
4. Cabang asal pengajuan = cabang kerja aktif (sesuai Spek); pengguna yang berwenang di beberapa cabang berpindah cabang aktif untuk mengajukan dari cabang lain. **Menyetujui/menolak/membatalkan/membalik tidak memerlukan berpindah cabang.**
5. Tes UI E2E berupa skrip (`scripts/inter-branch-ui-e2e`) yang memerlukan Chrome dan `playwright-core`; tidak berjalan dalam `pnpm test`.
6. ESLint belum terkonfigurasi (backlog H-1) sehingga tidak dijalankan. Phase 5A/5B/5C dan laporan per cabang untuk pengguna LIMITED tetap belum ada (syarat aktivasi di perusahaan nyata, bukan syarat fitur).

## 12. Deviasi dari spesifikasi
- Ditambahkan di luar Spek §17: `GET /options` (pilihan formulir), `GET|PUT /settings` (masa berlaku OWNER).
- `previewBranchClosure`: pengajuan menunggu menjadi **peringatan** + pembatalan otomatis saat nonaktif/tutup (bukan blocker keras, karena item itu tidak menimbulkan efek akuntansi).
- `recursive_triggers=ON` pada koneksi aplikasi (menutup residu `INSERT OR REPLACE` yang dicatat di laporan IB-1).
- Guard referensi `IB-` pada service (dari IB-3 ke IB-1) dan pesan ramah K-3 (IB-2), sesuai changelog.
- Pemohon reversal yang berwenang di kedua cabang dicatat sebagai sisi FROM; penyetuju = pihak berwenang di sisi lawan.

## 13. Cara menjalankan dan menguji
```bash
# 1. Pemasangan & pemeriksaan otomatis
pnpm install --frozen-lockfile
pnpm -C apps/api exec tsc --noEmit && pnpm -C apps/web run typecheck && pnpm -C packages/shared exec tsc --noEmit
pnpm test                                    # 963 tes (termasuk 135 tes Antar Cabang + arsitektur)
pnpm -C apps/api run build && pnpm -C apps/web run build

# 2. Uji di aplikasi (browser sungguhan, data UAT salinan; port 4531)
npm i playwright-core --prefix $WORK
bash scripts/inter-branch-ui-e2e/reset.sh $WORK /path/backup-uat
node scripts/inter-branch-ui-e2e/ui-flow.cjs $WORK

# 3. Memakai sendiri
#   a. OWNER menyalakan multi-cabang (PUT /api/company-db/:slug/multi-branch {"enabled":true}), membuat cabang,
#      lalu "akun antar-cabang terpandu" (ASSET dan LIABILITY) untuk tiap pasangan cabang.
#   b. Beri pengguna akses cabang (LIMITED) dengan peran ACCOUNTANT/STAFF; menu "Antar Cabang" muncul di sidebar.
#   c. Cabang asal: Transaksi Baru → pilih tujuan → setujui oleh pengguna cabang tujuan (atau OWNER).
```

## 14. Kesimpulan
Seluruh MVP Antar Cabang (IB-1…IB-6) selesai dan lulus semua validasi yang dijalankan. Installer Electron sudah dibangun dan diuji (§15). Belum siap aktivasi nyata: UAT dengan data menyerupai klien serta Phase 5A (laporan per cabang untuk pengguna LIMITED) tetap menjadi gerbang aktivasi di perusahaan nyata.

## 15. Release Readiness Antar Cabang (verifikasi lanjutan, 2026-10-08)

Tidak ada fitur baru. Yang ditambahkan hanya tes, skrip uji, dan perbaikan skrip uji. **Tidak ada perubahan kode aplikasi pada tahap ini**; baseline historis Phase 3 dan manifestnya tidak disentuh; `multi_branch_enabled` tidak dinyalakan pada perusahaan nyata; semua uji memakai salinan data terisolasi (bukan port 4000 aplikasi nyata; `%APPDATA%\TERRA FINANCE` diperiksa tidak berubah).

### 15.1 Integritas, keamanan, konkurensi
- **Mutan yang lolos (klaim status persetujuan)**: bukan celah. Itu pertahanan berlapis (pra-cek status + antrean tulis + kunci SQLite + klaim bersyarat + indeks UNIQUE slot + trigger); satu proses tidak dapat mensimulasikan balapan nyata sehingga tes lama tidak membedakannya. Ditambahkan **4 tes balapan lintas-proses sungguhan** (`inter-branch-race.test.ts` + `__fixtures__/inter-branch-race.worker.ts`; proses anak terpisah, koneksi terpisah, waktu mulai serempak): 3 proses menyetujui transaksi yang sama (3 putaran); setuju vs batal (3 putaran); minta/setuju pembalikan serempak; pengajuan idempoten dari 3 proses. Hasil: **tepat satu pemenang; pecundang hanya `InterBranchStateChangedError`/`InterBranchBusyError` (503, aman diulang)**; jurnal tepat 2 (atau 4); `verifyInterBranchIntegrity` = 0 pelanggaran. Uji mutasi ulang: menghapus klaim + pra-cek **terdeteksi**.
- Batas klaim: konkurensi teruji untuk beberapa proses pada **satu file SQLite di satu mesin**. Tidak diklaim untuk banyak perangkat/jaringan (belum didukung).
- **`recursive_triggers=ON`**: hanya trigger `branch_default` yang menulis tabel lain; tidak ada rekursi diri; migrasi tidak terpengaruh; satu-satunya efek nyata: `INSERT OR REPLACE` kini memicu trigger DELETE sehingga penggantian baris terjaga (tujuan perubahan). 967 tes dan migrasi UAT 5 tahun lulus dengan pengaturan ini.
- Posting dua sisi atomik dalam satu transaksi; injeksi kegagalan 5 titik: semua-atau-tidak (lihat §8).

### 15.2 Jurnal tidak seimbang pada data UAT — pra-ada, bukan akibat Antar Cabang
Satu jurnal **DRAFT** `U2-E-nv4o` (selisih Rp1, tanpa jejak audit) sudah ada di backup UAT sebelum fitur ini. **0 jurnal POSTED/REVERSED tidak seimbang**; selisih "besar" pada total adalah artefak float JS saat dijumlahkan (diverifikasi dalam sen bulat). Tidak diubah/dihapus. Dampak: jurnal DRAFT tidak ikut Trial Balance/laporan; harus diperbaiki atau dihapus oleh pengguna saat UAT, dan tidak dapat diposting selama tidak seimbang (validasi yang sudah ada).

### 15.3 Build dan runtime Electron
- Installer: `apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe` (124.349.767 B, **tidak ditandatangani**), dibangun lewat prosedur resmi (`pnpm -C apps/desktop dist`); ABI native dipulihkan ke workspace sesudahnya (tes sesudahnya lulus).
- **Isi installer = kode terbaru**: hasil ekstrak installer (9.568 berkas) dibandingkan SHA-256 dengan `win-unpacked`: **0 beda, 0 hilang**; `win-unpacked` sebelumnya dibandingkan dengan `apps/api/dist` dan `apps/web/dist` terbaru: identik.
- **Instalasi senyap TIDAK dijalankan** di mesin ini: akan mendaftarkan aplikasi (uninstall/registry/shortcut) dan berisiko menimpa instalasi nyata yang berisi data klien. Sebagai gantinya aplikasi hasil ekstrak/`win-unpacked` dijalankan sebagai proses Electron 33.4.11 sungguhan dengan `--user-data-dir` terisolasi. **Wizard NSIS belum diuji manual** — sisa risiko.
- Uji jendela Electron (`scripts/inter-branch-ui-e2e/electron-flow.cjs`, login sungguhan, data UAT salinan): **23/23 PASS** — login maker; pilih perusahaan + cabang; menu Antar Cabang; ajukan (tanpa jurnal); lencana approver; setujui → "Selesai" + 2 jurnal; minta & setujui pembalikan → 4 jurnal "Sudah dibalik"; batalkan; tolak (alasan tampil); ADMIN dua cabang tidak dapat menyetujui (SoD); OWNER menyetujui sendiri; Dashboard, Jurnal (memuat jurnal IB-), COA, Trial Balance terbuka; VIEWER tanpa menu; perusahaan `multi_branch_enabled=OFF`: menu tersembunyi + URL langsung menampilkan penjelasan; `diagnostic.log` tanpa galat server/renderer/IPC dan server listening; `%APPDATA%\TERRA FINANCE` tidak berubah; proses tertutup bersih.
- Temuan: respons **429** pada logout saat uji. Akar: bucket `auth` 30/menit/IP dipakai bersama login+logout+ping aktivitas (`rate-limit-policy.ts`); uji berganti 7 persona dalam beberapa menit. Bukan cacat Antar Cabang dan tidak diubah di aplikasi; skrip uji kini menunggu 65 dtk lalu mengulang, dan melaporkan jumlah 429 terpisah (tidak disembunyikan; 4 respons 429 pada putaran terakhir). Catatan: satu pengguna tidak mendekati 30 permintaan auth/menit; pada kantor dengan banyak pengguna di satu IP (NAT) kebijakan per-IP perlu ditinjau sebelum penggunaan multi-perangkat.
- Verifikasi akuntansi pasca-uji (`verify-accounting.mjs`, 15/15): integritas IB 0 pelanggaran; semua jurnal POSTED/REVERSED seimbang (sen bulat); dua sisi konsisten; tanggal dan periode OPEN sama; pembalikan mengembalikan saldo ke 0; akun antarkantor saling meniadakan; Trial Balance seimbang (selisih 0); kas bersih Bandar Lampung +75.000 / Metro −75.000 sesuai transaksi selesai. `integrity_check` ok dan `foreign_key_check` 0 pada company.db (2 perusahaan), terra-system, dan terra-finance.

### 15.4 Regresi penuh (aktual)
Typecheck api/web/shared 0 error · `pnpm test` **967/967** (75 berkas; termasuk arsitektur 8/8 dan 4 tes balapan) · Golden Master small 43/43, uat-1/3/7 126/126 identik · E2E keamanan **37/37** (data bersih) · UI E2E Chrome **29/29** · Electron 23/23 · verifikasi akuntansi 15/15.

Catatan kejujuran: pada satu putaran UI Chrome, 1 pemeriksaan ("4 jurnal setelah pembalikan") gagal karena menghitung elemen sebelum detail dimuat ulang (balapan di tes, bukan di aplikasi; alur sama lulus di Electron). Tes diperbaiki dengan **menunggu kondisi yang sama** (4 jurnal, batas 15 dtk), bukan melonggarkan; putaran ulang 29/29. E2E keamanan pertama gagal (23/37) karena memakai data sisa putaran sebelumnya; dengan salinan data bersih 37/37. Setelah putaran Electron terakhir, skrip hanya diubah kosmetik (melaporkan 429 terpisah) dan tidak dijalankan ulang.

### 15.5 Keputusan rilis
| Aspek | Keputusan |
|---|---|
| Implementasi | **PASS** |
| Build + runtime Electron | **PASS** (installer dibangun, isi identik; aplikasi dijalankan di jendela Electron). Belum: wizard instalasi NSIS manual, penandatanganan kode |
| Integritas akuntansi | **PASS** |
| Keamanan + konkurensi | **PASS** untuk beberapa proses pada satu file SQLite; tidak diklaim multi-perangkat |
| UAT | **READY** — pada salinan/perusahaan uji yang dinyalakan sadar oleh OWNER; jurnal DRAFT tidak seimbang yang pra-ada dicatat |
| Aktivasi di perusahaan nyata | **NOT READY** — gerbang tersisa: (1) UAT dengan data menyerupai klien lulus; (2) Phase 5A/5B (laporan per cabang untuk pengguna LIMITED); (3) uji instalasi NSIS nyata + keputusan penandatanganan; (4) tinjauan kebijakan batas laju untuk banyak pengguna satu IP; (5) backup sebelum aktivasi |

`multi_branch_enabled` tetap OFF pada seluruh perusahaan nyata.

## 16. UAT menyeluruh (2026-10-09)
Laporan lengkap: [INTER-BRANCH-UAT-REPORT.md](INTER-BRANCH-UAT-REPORT.md). Ringkas: UAT HTTP 18 PASS / 1 BLOCKED (laporan LIMITED, Phase 5A) / 0 FAIL (224 pemeriksaan); Electron 26/26; tiga cacat Antar Cabang diperbaiki (validasi sebelum cek flag OFF, modal tertutup bilah atas, galat aksi tak terlihat); installer dibangun ulang; regresi: `pnpm test` **968/968**, Golden Master 43/43 + 3×126/126, E2E keamanan 37/37, UI Chrome 29/29. Keputusan: **READY untuk UAT bisnis, NOT READY untuk aktivasi di perusahaan nyata** (laporan gabungan belum mengeliminasi antarkantor, Phase 5A/5B, instalasi NSIS/penandatanganan, batas laju multi-perangkat).

## 17. Phase 5A/5B (2026-10-09)
Laporan per cabang dan akses LIMITED selesai (`PHASE-5-IMPLEMENTATION-REPORT.md`): `pnpm test` 996/996, golden master (flag OFF) identik, per cabang = oracle SQL (uat-3 39/39, uat-7 67/67), E2E keamanan 39/39, UI Chrome Antar Cabang 29/29 dan Phase 5 23/23. Laporan gabungan tetap bruto (antar-kantor belum dieliminasi) dan berlabel demikian.
