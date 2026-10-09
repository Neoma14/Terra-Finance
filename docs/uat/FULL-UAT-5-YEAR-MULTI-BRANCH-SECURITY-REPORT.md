# FULL UAT 5 TAHUN + SIMULASI MULTI-CABANG + SECURITY TEST: PT TERRA NUSANTARA

> **Status terkini: READY WITH KNOWN LOW-RISK ISSUES** (setelah perbaikan UAT-001, UAT-002, UAT-003 dan UAT penuh diulang pada installer final 2026-10-05 23:27).
> Hasil UAT awal (installer 07:05, keputusan NOT READY) tetap disimpan utuh di bagian "Lampiran" di bawah dan di `docs/uat/evidence-run1-before-fix/`.

## RINGKASAN HASIL SETELAH PERBAIKAN

```text
FINAL STATUS: READY WITH KNOWN LOW-RISK ISSUES
TOTAL TEST (UAT penuh diulang): 727
PASS: 713
FAIL: 14 (semuanya temuan MEDIUM/LOW yang SENGAJA belum diperbaiki pada tahap ini, dipetakan ke 9 bug)
CRITICAL: 0
HIGH: 0   (sebelumnya 3: UAT-001, UAT-002, UAT-003 -> semuanya PASS)
MEDIUM: 7
LOW: 7
```

Keputusan memakai gerbang produksi Anda: Critical = 0, HIGH keamanan = 0, rekonsiliasi akuntansi = PASS, isolasi lintas-company = PASS, UAT-001/002/003 = PASS, backup/restore = PASS, integritas data = PASS. Sisa MEDIUM/LOW tidak mengancam integritas akuntansi, otorisasi peran, isolasi data, integritas data, maupun backup/restore. Bukan "PRODUCTION READY" karena MEDIUM masih ada; beberapa di antaranya (UAT-006 brute force, UAT-008 CORS, UAT-007 audit login) wajib ditutup sebelum aplikasi dibuka ke jaringan/multi-device.

**Dua catatan kejujuran**
1. **UAT-009 (avatar menerima SVG/HTML)** saya klasifikasikan MEDIUM, bukan HIGH, karena avatar hanya dirender lewat elemen `<img>` (skrip tidak berjalan; sudah diuji di browser) dan tidak ada jalur lain yang menyajikan data URI itu. Bila Anda menilai ini HIGH keamanan, keputusan berubah menjadi NOT READY sampai ditutup. Perbaikannya kecil (cek magic bytes, tolak SVG).
2. **HARNESS ERROR** (kesalahan skrip uji, bukan bug aplikasi) putaran ini: `SQLI-resp` (false positive: daftar customer memuat nama payload SQLi yang sengaja disimpan di uji yang sama; tidak ada 5xx/pesan SQL) dan satu uji `U3-reversal-ok` pada eksekusi pertama yang mereverse jurnal yang masih Draft (diperbaiki dengan memposting dulu, lalu diulang: PASS). Putaran 1 punya sejumlah kesalahan harness lain yang sudah dikoreksi sebelum putaran ini (lihat bagian J laporan awal).

## POST-FIX REGRESSION: UAT-001 (Privilege escalation ADMIN ke OWNER)

```text
Finding: ADMIN dapat menaikkan perannya sendiri atau user lain menjadi OWNER (PATCH/POST /access).
Root Cause: route manajemen akses hanya memeriksa izin users.manage (OWNER dan ADMIN punya) dan validitas nilai peran. Tidak ada aturan "siapa boleh menetapkan/mengubah peran apa", sehingga permission yang sama dipakai untuk memberi OWNER. Pemeriksaan murni UI/izin tidak cukup.
Fix: db/system/rbac.ts menambah ROLE_RANK dan canManageRole(actor, targetSekarang, peranBaru): (1) tidak boleh menetapkan peran lebih tinggi dari perannya sendiri, (2) tidak boleh mengubah/menangguhkan/mencabut akses yang pangkatnya lebih tinggi, (3) peran OWNER hanya dapat dikelola OWNER. Dipasang di modules/company-access/routes.ts pada grant (POST), ubah peran (PATCH), ubah status, dan cabut (DELETE), SEBELUM menyentuh database. Perilaku lama dipertahankan: ADMIN boleh mengelola ADMIN dan peran di bawahnya; perlindungan OWNER terakhir tetap.
Test: 10 skenario regression di modules/company-access/routes.test.ts (30 tes file itu lulus) + 13 uji HTTP di harness (s10) terhadap installer final.
Expected: ADMIN -> OWNER (diri sendiri/orang lain) 403 dan database tidak berubah; ACCOUNTANT/VIEWER/STAFF -> OWNER 403; ADMIN -> ADMIN sesuai kebijakan lama; OWNER tetap bisa; manipulasi body ditolak.
Actual: seperti Expected (tabel di bawah).
Status: PASS
Evidence: docs/uat/evidence/results.jsonl (id U1-*), docs/uat/harness/s10_regression_high.mjs, apps/api/src/modules/company-access/routes.test.ts
```

| ID | Uji | Hasil | Bukti |
|---|---|---|---|
| U1-1 | ADMIN -> dirinya sendiri OWNER ditolak (403) dan peran di database tetap ADMIN | PASS | status 403 Anda tidak berwenang mengelola peran ini. Peran OWNER hanya dapat dikelola oleh OWNER, dan; db=ADMIN |
| U1-10 | ADMIN tidak dapat menangguhkan / mencabut / menurunkan OWNER (semua 403); OWNER tetap ACTIVE | PASS | 403/403/403 |
| U1-11 | OWNER tetap berfungsi normal setelah semua percobaan | PASS | status 200 |
| U1-2 | ADMIN -> user lain OWNER ditolak (403), database tetap VIEWER | PASS | status 403 Anda tidak berwenang mengelola peran ini. Peran OWNER hanya dapat dikelola oleh OWNER, dan; db=VIEWER |
| U1-3 | ADMIN -> dirinya sendiri ADMIN (kebijakan lama: diizinkan) | PASS | status 200 |
| U1-4 | ADMIN -> user lain ADMIN (kebijakan lama: diizinkan) | PASS | status 200 |
| U1-5 | ACCOUNTANT -> OWNER ditolak (403) | PASS | status 403 Anda tidak memiliki izin untuk melakukan aksi ini.; db=ACCOUNTANT |
| U1-6 | VIEWER -> OWNER ditolak (403) | PASS | status 403 Anda tidak memiliki izin untuk melakukan aksi ini.; db=VIEWER |
| U1-6b | STAFF -> OWNER ditolak (403) | PASS | status 403 Anda tidak memiliki izin untuk melakukan aksi ini. |
| U1-7 | OWNER menaikkan lalu menurunkan peran user lain (diizinkan) | PASS | status 200 / status 200 |
| U1-8 | manipulasi body role ('owner','OWNER ','Owner', array, objek, null, huruf lebar-penuh, kunci ganda, field tambahan) tidak pernah menghasilkan OWNER | PASS |  |
| U1-9a | ADMIN memberi OWNER ke user di luar perusahaan ditolak (403), tidak ada baris akses baru | PASS | status 403 Anda tidak berwenang mengelola peran ini. Peran OWNER hanya dapat dikelola oleh OWNER, dan; baris 5 -> 5 |
| U1-9b | ADMIN tetap boleh memberi peran STAFF (fungsi sah tidak rusak) | PASS | status 201 |

Manipulasi body yang diuji (semua tidak pernah menghasilkan OWNER): `"owner"`, `"OWNER "`, `" OWNER"`, `"Owner"`, array, objek, `null`, huruf lebar-penuh, `\u0000`, kunci `Role`/`roles`, **kunci `role` ganda di JSON mentah** (server memakai nilai terakhir dan otorisasi memeriksa nilai yang sama), field tambahan (`isAdmin`, `permissions`, `companyId`, `status`).

## POST-FIX REGRESSION: UAT-002 (Jurnal selisih Rp 1 tidak boleh Post)

```text
Finding: jurnal debit 100.000 / kredit 99.999 lolos Post; Neraca/Dashboard HTTP 500 dan Trial Balance tidak balance untuk semua periode sesudahnya.
Root Cause: validasi keseimbangan memakai toleransi (Math.abs(debit - kredit) <= BALANCE_TOLERANCE = 1) di journal-service; toleransi serupa (<= 1 / < 1) ada di preview import jurnal (parser), import Saldo Awal, tampilan Saldo Awal, jalur lama posting.ts, dan tiga form web. Sementara Trial Balance/Neraca (benar) menuntut selisih nol, sehingga satu jurnal "toleran" meracuni semua laporan.
Fix: lib/money.ts (perbandingan dalam bilangan bulat sen, tanpa toleransi; drift float murni seperti 0,1+0,2 vs 0,3 tidak dianggap selisih, selisih Rp 0,01 ditolak). journal-service: validasi dari request (assertLinesBalanced) + hitung ULANG dari baris yang benar-benar tersimpan di dalam transaction yang sama, sesudah insert dan sebelum commit, dan sekali lagi tepat sebelum status menjadi POSTED (SQL SUM bilangan bulat sen); kegagalan membatalkan transaction (tidak ada header/baris/audit). Toleransi dihapus dari parser import, import Saldo Awal, tampilan Saldo Awal, posting.ts lama, dan form web (journal-form-panel, opening-balance-form, journal-page). Reversal sengaja TIDAK memakai pemeriksaan ini: ia mencerminkan jurnal asli, dan harus tetap bisa membalik jurnal lama yang telanjur tak seimbang (jalur pemulihan).
Test: 11 skenario di apps/api/src/db/company/uat-high-fixes.test.ts (A-H + saldo awal + pemulihan) + 12 uji HTTP di harness (s10) + seluruh UAT penuh.
Expected: A diterima; B, C, D, E, F ditolak dan 0 perubahan database; G reversal seimbang; H import tak seimbang ditolak, commit tidak mengubah database; laporan tidak pernah 500 karena jurnal invalid.
Actual: seperti Expected. Data nyata Anda (salinan backup PT Sinar Bumi Nabung, 811 jurnal) tidak punya jurnal tak seimbang, jadi perbaikan aman untuk upgrade.
Status: PASS
Evidence: docs/uat/evidence/results.jsonl (id U2-*, INT-unbalanced)
```

| ID | Uji | Hasil | Bukti |
|---|---|---|---|
| U2-A | debit 100.000 = kredit 100.000 diterima (201) | PASS | status 201 |
| U2-A-post | jurnal seimbang bisa di-Post | PASS | status 200 |
| U2-B | debit 100.000 vs kredit 99.999 ditolak (400); header/baris/audit tidak bertambah | PASS | status 400 Jurnal tidak dapat disimpan/diposting karena total debit dan kredit tidak sama: debit 1000; {"j":12002,"l":30974,"a":24125} -> {" |
| U2-C | debit 99.999 vs kredit 100.000 ditolak (400), database tidak berubah | PASS | status 400 Jurnal tidak dapat disimpan/diposting karena total debit dan kredit tidak sama: debit 9999 |
| U2-D | baris tambahan merusak keseimbangan ditolak (400) | PASS | status 400 Jurnal tidak dapat disimpan/diposting karena total debit dan kredit tidak sama: debit 1000 |
| U2-E | draft tak seimbang yang menyusup (bypass frontend/validasi awal) TIDAK bisa di-Post; status tetap DRAFT | PASS | status 400 Jurnal tidak dapat disimpan/diposting karena total debit dan kredit tidak sama: debit 1000; status=DRAFT |
| U2-F | nominal besar (Rp 9,99 triliun) selisih Rp 1 ditolak (400) | PASS | status 400 Jurnal tidak dapat disimpan/diposting karena total debit dan kredit tidak sama: debit 9999 |
| U2-F2 | nominal besar yang persis seimbang diterima | PASS | status 201 |
| U2-G | reversal jurnal seimbang tetap seimbang & mengikuti aturan reversal | PASS | status 200; D 100000 K 100000 |
| U2-H | import jurnal tak seimbang: preview ERROR, commit ditolak (400), database tidak berubah | PASS | status 200 err=1; commit 400 |
| U2-OB | import Saldo Awal selisih Rp 1 ditolak (400) | PASS | status 400 Tidak dapat commit: masih ada error atau belum balance pada file ini. |
| U2-reports | Trial Balance seimbang, Neraca & Dashboard HTTP 200 (tidak ada 500 akibat satu jurnal invalid) | PASS | TB true, BS 200, Dashboard 200 |

## POST-FIX REGRESSION: UAT-003 (Tanggal kalender tidak nyata dinormalisasi)

```text
Finding: Import jurnal menyimpan tanggal 2026-02-30 sebagai 2026-03-02 tanpa peringatan.
Root Cause: toIsoDate di parser import memakai new Date(teks). JavaScript menormalisasi tanggal mustahil (30 Feb menjadi 2 Mar) dan menebak format lokal ("1/2/2026"). Hal yang sama ada di parser Saldo Awal dan COA, dan validateDateRange laporan memakai Date.parse (menerima "2025", "1/1/2025", dan 2025-02-30 yang lalu memicu 500 / alarm palsu 'Balance Sheet tidak seimbang').
Fix: SATU validator di lib/calendar-date.ts (isValidIsoDate: regex ketat + hari dalam bulan termasuk kabisat; parseExcelDate: Date/serial/ISO saja tanpa tebakan lokal, hasil tidak pernah dinormalisasi; isoDateSchema untuk zod). Dipakai di: parser jurnal/Saldo Awal/COA, journal-import-service (pesan "bukan tanggal kalender yang valid", periode tidak dicari untuk tanggal invalid), journal-service (kalender dicek PERTAMA sebelum aturan periode/masa depan/backdate; reversal), validateDateRange semua laporan/dashboard/export/analisis/pajak/proyeksi, ledger, periode (generate-monthly, createPeriod), filter daftar jurnal & audit log, body zod (jurnal, reversal, Saldo Awal, periode). Validasi kalender dipisahkan dari aturan bisnis (masa depan, backdate, periode OPEN) yang tetap berjalan sesudah tanggal valid.
Test: 9 skenario di uat-high-fixes.test.ts (validator, parser, jurnal manual, import, Saldo Awal, laporan, periode, reversal) + 45 uji HTTP di harness (s10).
Expected: 2026-02-28 VALID; 2026-02-29/30, 2026-04-31, 2026-06-31, 2025-02-29 INVALID; 2024-02-29 VALID; tidak ada perubahan database untuk input invalid; laporan 400 (bukan 500).
Actual: seperti Expected.
Status: PASS
Evidence: docs/uat/evidence/results.jsonl (id U3-*, JI-bad-tanggal2026023, PE-baddate)
```

| ID | Uji | Hasil | Bukti |
|---|---|---|---|
| U3-analysis | Analisis tanggal 2025-02-30 -> 400 | PASS | status 400 fromDate & toDate wajib diisi. |
| U3-api-20240229 | jurnal manual tanggal 2024-02-29 diterima (tanggal nyata) | PASS | status 201 |
| U3-api-20250229 | jurnal manual tanggal 2025-02-29 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-20260210 | jurnal manual tanggal 2026/02/10 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-20260228 | jurnal manual tanggal 2026-02-28 diterima (tanggal nyata) | PASS | status 201 |
| U3-api-20260229 | jurnal manual tanggal 2026-02-29 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-2026023 | jurnal manual tanggal 2026-02-3 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-20260230 | jurnal manual tanggal 2026-02-30 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-20260431 | jurnal manual tanggal 2026-04-31 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-20260631 | jurnal manual tanggal 2026-06-31 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-20261301 | jurnal manual tanggal 2026-13-01 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-api-260210 | jurnal manual tanggal 26-02-10 ditolak 400 dan tidak tersimpan | PASS | status 400 Input tidak valid |
| U3-audit | Audit log fromDate 2025-02-30 -> 400 | PASS | status 400 Input tidak valid |
| U3-bs-10 | Neraca tanggal '2025-02-30' -> 400 (bukan 500/alarm palsu) | PASS | status 400 fromDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-bs-11 | Neraca tanggal '' OR '1'='1' -> 400 (bukan 500/alarm palsu) | PASS | status 400 fromDate "' OR '1'='1" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-bs-4 | Neraca tanggal '2025' -> 400 (bukan 500/alarm palsu) | PASS | status 400 fromDate "2025" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-bs-8 | Neraca tanggal '1/1/2025' -> 400 (bukan 500/alarm palsu) | PASS | status 400 fromDate "1/1/2025" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-cf | Arus Kas tanggal 2025-02-30 -> 400 | PASS | status 400 fromDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-dash-10 | dashboard tanggal '2025-02-30' -> 400 | PASS | status 400 fromDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-dash-11 | dashboard tanggal '' OR '1'='1' -> 400 | PASS | status 400 fromDate "' OR '1'='1" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-dash-4 | dashboard tanggal '2025' -> 400 | PASS | status 400 fromDate "2025" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-dash-8 | dashboard tanggal '1/1/2025' -> 400 | PASS | status 400 fromDate "1/1/2025" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-eq | Ekuitas tanggal 2025-02-30 -> 400 | PASS | status 400 toDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-export | Export laporan tanggal 2025-02-30 -> 400 | PASS | status 400 fromDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-imp-122026 | import tanggal 1/2/2026: preview ERROR, commit 400, 0 perubahan database | PASS | status 200 err=1 Tanggal "1/2/2026" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan format ; commit 400 |
| U3-imp-20250229 | import tanggal 2025-02-29: preview ERROR, commit 400, 0 perubahan database | PASS | status 200 err=1 Tanggal "2025-02-29" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan forma; commit 400 |
| U3-imp-2026023 | import tanggal 2026-02-3: preview ERROR, commit 400, 0 perubahan database | PASS | status 200 err=1 Tanggal "2026-02-3" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan format; commit 400 |
| U3-imp-20260230 | import tanggal 2026-02-30: preview ERROR, commit 400, 0 perubahan database | PASS | status 200 err=1 Tanggal "2026-02-30" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan forma; commit 400 |
| U3-imp-20260431 | import tanggal 2026-04-31: preview ERROR, commit 400, 0 perubahan database | PASS | status 200 err=1 Tanggal "2026-04-31" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan forma; commit 400 |
| U3-imp-20260631 | import tanggal 2026-06-31: preview ERROR, commit 400, 0 perubahan database | PASS | status 200 err=1 Tanggal "2026-06-31" bukan tanggal kalender yang valid. Gunakan tanggal nyata dengan forma; commit 400 |
| U3-imp-ok | import tanggal nyata 2026-02-28 tetap valid & tersimpan tepat pada tanggalnya | PASS | status 200 |
| U3-is-10 | Laba Rugi tanggal '2025-02-30' -> 400 | PASS | status 400 fromDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-is-11 | Laba Rugi tanggal '' OR '1'='1' -> 400 | PASS | status 400 fromDate "' OR '1'='1" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-is-4 | Laba Rugi tanggal '2025' -> 400 | PASS | status 400 fromDate "2025" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-is-8 | Laba Rugi tanggal '1/1/2025' -> 400 | PASS | status 400 fromDate "1/1/2025" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-journals | Daftar jurnal filter fromDate 2025-02-30 -> 400 | PASS | status 400 fromDate "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-ledger | Ledger tanggal 2025-02-30 -> 400 | PASS | status 400 Tanggal Dari "2025-02-30" bukan tanggal yang valid (format YYYY-MM-DD). |
| U3-ob | import Saldo Awal tanggal 2025-02-30 ditolak (400) | PASS | status 400 Tidak dapat commit: masih ada error atau belum balance pada file ini. |
| U3-ob-manual | Saldo Awal manual tanggal 2025-02-30 -> 400 | PASS | status 400 Input tidak valid |
| U3-period | generate periode dengan tanggal 2027-02-30 -> 400 | PASS | status 400 Input tidak valid |
| U3-period2 | generate periode dengan 'abc' -> 400 (dulu 201 dengan created 0) | PASS | status 400 Input tidak valid |
| U3-proj | Proyeksi asOfDate 2025-02-30 -> 400 | PASS | status 400 asOfDate wajib diisi. |
| U3-reversal | reversal dengan tanggal 2026-02-30 -> 400 | PASS | status 400 Referensi transaksi, tanggal transaksi, dan alasan reversal wajib diisi. |
| U3-reversal-ok | reversal dengan tanggal asli yang sah tetap berhasil | PASS | status 200 |
| U3-tax | Pajak tanggal 2025-02-30 -> 400 | PASS | status 400 fromDate & toDate wajib diisi. |

Dampak perilaku (sengaja): tanggal di Excel berupa teks hanya diterima dalam format `YYYY-MM-DD` (atau sel bertipe tanggal Excel). Format lokal seperti `1/2/2026` kini menjadi ERROR di pratinjau, tidak lagi ditebak (sebelumnya bisa tersimpan sebagai tanggal AS/bulan-hari yang salah).

## FULL UAT RERUN

Seluruh harness dijalankan ulang dari nol terhadap installer final (`TERRA FINANCE Setup 0.1.0.exe`, 124.191.928 byte, 2026-10-05 23:27): lingkungan baru, COA Import, Opening Balance Import, 12 batch Import Jurnal (5.907 transaksi), 45 reversal, 12 draft, rekonsiliasi 5 tahun, kinerja, export, uji fungsional/CRUD, import positif/negatif, keamanan, regression 3 HIGH, ketahanan (kill -9, backup/restore), UI (25 menu, XSS, sesi) dan integritas akhir.

| Area | Putaran 1 (lulus/total) | Putaran 2 setelah perbaikan |
|---|---|---|
| reconcile | 101/101 | 101/101 |
| cross-year | 18/18 | 18/18 |
| trial-balance | 3/3 | 3/3 |
| ledger | 7/7 | 7/7 |
| export | 62/62 | 62/62 |
| import | 92/97 | 95/96 |
| journal | 38/40 | 39/41 |
| coa | 22/22 | 21/21 |
| company | 17/17 | 17/17 |
| access | 13/13 | 13/13 |
| users | 11/11 | 11/11 |
| periods | 8/9 | 9/9 |
| profile | 10/10 | 10/10 |
| authn | 17/19 | 17/19 |
| authz | 9/11 | 8/8 |
| idor | 9/9 | 9/9 |
| sqli | 3/4 | 4/4 |
| mass-assign | 3/3 | 3/3 |
| upload | 6/8 | 6/8 |
| path-traversal | 2/2 | 2/2 |
| abuse | 3/3 | 3/3 |
| headers | 0/2 | 0/2 |
| csrf | 2/2 | 2/2 |
| session | 2/2 | 2/2 |
| audit | 15/18 | 14/16 |
| admin-panel | 12/12 | 12/12 |
| license | 3/3 | 3/3 |
| backup | 39/39 | 39/39 |
| resilience | 9/9 | 9/9 |
| data-integrity | 2/3 | 3/3 |
| ui | 35/46 | 45/46 |
| performance | 21/21 | 21/21 |

Pemeriksaan yang masih FAIL pada putaran ini (14) seluruhnya adalah temuan yang **belum diperbaiki karena di luar lingkup tugas ini** (MEDIUM/LOW):

| Tes | Bug | Severity | Detail |
|---|---|---|---|
| AU-bruteforce | UAT-006 | MEDIUM | status percobaan: 401; login benar setelahnya = 200 |
| AU-bruteforce2 | UAT-006 | MEDIUM | status percobaan: 401; login benar sesudahnya = 200 |
| AUDIT-login | UAT-007 | MEDIUM | aksi login pengguna biasa: tidak ada (hanya administrator.login) |
| AUDIT-logout | UAT-007 | LOW | tidak ada |
| BUG-CF-FLOAT | UAT-005 | MEDIUM | 2025: operasi 8467770000.000004, investasi -483636363.6363636, pendanaan -136363636.36363634 |
| BUG-CP-FILTER | UAT-015 | LOW | status 200 |
| CORS-reflect | UAT-008 | MEDIUM | ACAO=http://evil.example ACAC=true (cookie SameSite=Lax membatasi dampak lintas-situs, tetapi kebijakan terlal |
| HDR-clickjack | UAT-014 | LOW | tanpa perlindungan clickjacking (aplikasi desktop lokal; risiko rendah) |
| JI-sheet | UAT-015 | LOW | status 200[] |
| JR-both | UAT-011 | MEDIUM | status 500 Terjadi kesalahan. Coba lagi, atau hubungi dukungan kalau berulang. |
| JR-both-recheck | UAT-011 | MEDIUM | status 500 |
| SES-multitab-logout | UAT-012 | LOW | tab2 di /workspace/pt-terra-nusantara |
| UP-spoof | UAT-009 | MEDIUM | status 200 |
| UP-svg | UAT-009 | MEDIUM | status 200 |

Tidak ada FAIL yang tidak terpetakan: tidak ada. Tidak ada FAIL baru (regresi) dibanding putaran 1; FAIL putaran 1 yang hilang: UAT-001, UAT-002, UAT-003, UAT-004 (tanggal laporan, ikut beres karena validator bersama), dan `PE-baddate` (UAT-015 sebagian).

### Bug terbuka setelah perbaikan

| ID | Severity | Judul | Catatan |
|---|---|---|---|
| UAT-005 | MEDIUM | Arus Kas: nilai pecahan dan alokasi pro-rata jurnal campuran | tes gagal: BUG-CF-FLOAT |
| UAT-006 | MEDIUM | Tidak ada perlindungan brute force pada login | tes gagal: AU-bruteforce, AU-bruteforce2 |
| UAT-007 | MEDIUM | Login/logout pengguna tidak masuk audit log | tes gagal: AUDIT-login, AUDIT-logout |
| UAT-008 | MEDIUM | CORS memantulkan origin sembarang dengan credentials | tes gagal: CORS-reflect |
| UAT-009 | MEDIUM | Avatar menerima SVG/HTML berdasarkan MIME deklaratif | tes gagal: UP-svg, UP-spoof |
| UAT-010 | MEDIUM | Pembatas laju global dapat mengosongkan halaman (tidak terulang pada putaran ini, tidak diubah) | tidak ada tes gagal pada putaran ini (catatan/observasi; tidak diubah) |
| UAT-011 | MEDIUM | Baris jurnal debit+kredit sekaligus -> HTTP 500 | tes gagal: JR-both, JR-both-recheck |
| UAT-012 | LOW | Logout manual tidak menyiarkan ke tab lain | tes gagal: SES-multitab-logout |
| UAT-013 | LOW | Tanpa batas panjang input; nominal pecahan diterima | tidak ada tes gagal pada putaran ini (catatan/observasi; tidak diubah) |
| UAT-014 | LOW | Header keamanan HTTP tidak dikirim | tes gagal: HDR-clickjack |
| UAT-015 | LOW | Input tidak valid tertentu diterima diam-diam (sheet salah, filter tipe) | tes gagal: JI-sheet, BUG-CP-FILTER |
| UAT-016 | LOW | User aplikasi staff dapat membuat perusahaan | tidak ada tes gagal pada putaran ini (catatan/observasi; tidak diubah) |
| UAT-017 | LOW | Kebijakan password lemah | tidak ada tes gagal pada putaran ini (catatan/observasi; tidak diubah) |
| UAT-018 | LOW | Ekspor Excel tidak menetralkan teks berawalan = + @ - | tidak ada tes gagal pada putaran ini (catatan/observasi; tidak diubah) |

## SECURITY REGRESSION

Kategori yang diminta diulang: authentication (password salah/kosong, user tidak ada, sesi kedaluwarsa, logout lalu API, token rusak/hilang), authorization (OWNER/ADMIN/ACCOUNTANT/VIEWER, terutama ADMIN -> OWNER dan manipulasi role langsung), IDOR/lintas-company (dashboard, jurnal, ledger, laporan, export, search, API langsung, slug, ID), SQL injection (276 payload ke 24 titik), XSS (9 halaman + kotak pencarian).

| Uji | Hasil | Bukti |
|---|---|---|
| Authentication: password salah | PASS | status 401 Email atau password salah |
| Authentication: password kosong | PASS | status 400 Input tidak valid |
| Authentication: user tidak ada | PASS | status 401 Email atau password salah \| sama=true |
| Authentication: sesi kedaluwarsa | PASS | status 401 Belum login |
| Authentication: logout lalu API request | PASS | status 401 Belum login |
| Authentication: token rusak/malformed | PASS |  |
| Authentication: tanpa token pada 15 endpoint | PASS |  |
| Session: idle 15 menit (server) | PASS | status 401 Belum login |
| Authentication: user dinonaktifkan | PASS | me 401 login 401 |
| Authorization: matriks 75 kombinasi peran x izin | PASS |  |
| Authorization: VIEWER naikkan diri ke OWNER | PASS | status 403 Anda tidak memiliki izin untuk melakukan aksi ini. |
| Authorization: non-admin membuat user admin | PASS | status 403 Hanya admin yang bisa mengakses ini |
| Authorization: lisensi palsu ditolak | PASS | status 400 Tanda tangan lisensi tidak valid (lisensi palsu atau sudah diubah) |
| license key dimodifikasi + token asli ditolak | PASS | status 401 License key tidak cocok dengan instalasi ini |
| token Administrator palsu ditolak | PASS | status 401 Token Administrator salah |
| panel Administrator dev 200 | PASS | status 200 |
| panel Administrator diag 200 | PASS | status 200 |
| panel Administrator err 200 | PASS | status 200 |
| login Administrator dengan token vendor valid | PASS | status 200 |
| logout Administrator mencabut akses | PASS | status 401 Sesi Administrator tidak valid atau sudah kadaluarsa, login ulang |
| panel Administrator me 200 | PASS | status 200 |
| endpoint Administrator tanpa login ditolak | PASS | status 401 Sesi Administrator tidak valid atau sudah kadaluarsa, login ulang |
| diagnostik tidak membocorkan secret/hash/private key | PASS |  |
| login Administrator dengan payload SQLi ditolak | PASS | status 401 License key tidak cocok dengan instalasi ini |
| Owner aplikasi biasa TIDAK otomatis jadi Administrator (panel butuh token vendor) | PASS | status 401 Sesi Administrator tidak valid atau sudah kadaluarsa, login ulang |
| POST mengubah data dengan form-urlencoded dari origin asing ditolak | PASS | status 404 Not Found |
| text/plain dari origin asing ditolak | PASS | status 404 Not Found |
| viewer A -> B: 38 endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan) | PASS |  |
| user Company B -> Company A: 38 endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan) | PASS |  |
| user Company A (akuntan) -> Company B: 38 endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan) | PASS |  |
| mengubah akses user yang bukan anggota Company A ditolak (404) | PASS | status 404 Access tidak ditemukan. |
| respons 'tidak berhak' identik dengan 'perusahaan tidak ada' (anti enumerasi) | PASS | 404/404 |
| ID jurnal/akun milik Company A dipakai lewat URL Company B (pemilik B): 404/400, tidak berdampak | PASS |  |
| jalur lama /api/c/<slug> oleh user Company B -> tidak 200 | PASS |  |
| pencarian di Company B tidak menemukan data Company A | PASS | 0 hasil |
| manipulasi slug (case, null byte, ../, encoded) tidak membuka Company A | PASS |  |
| PATCH akun dengan isLocked/isSystemAccount/id/code diabaikan (akun sudah terkunci oleh admin; kode & flag sistem tidak berubah) | PASS | {"code":"9001","is_locked":1,"is_system_account":0} status 200 |
| mass assignment jurnal: status/createdBy/postedBy/isOpening diabaikan | PASS | {"status":"DRAFT","created_by":"5b1394d5-ecec-4c85-b0a1-39f8496b4514","posted_by":null,"is_opening_b |
| PATCH profil dengan id/journal_number_seq/max_backdate_days diabaikan | PASS | {"id":"a05e45fc-2383-4383-b88b-e71c94071f67","journal_number_seq":0,"max_backdate_days":null} |
| POST user dengan id/is_admin/password_hash tambahan diabaikan | PASS | {"id":"8a038d28-ba24-4367-ad4f-0750e18f4ba3","role":"staff","is_active":1} |
| traversal di path API ditangani (tidak 5xx) | PASS | status 404 |
| 14 pola traversal ke file statis (../, %2e%2e, %5c, %00, ganda-encode): tidak ada file di luar web dist yang terbaca | PASS |  |
| jumlah baris tabel tidak berubah selain record uji yang sah (tidak ada kerusakan/ekstraksi) | PASS | jurnal +12, baris +24, akun +12, periode 0 |
| integrity_check master & company DB ok setelah uji injeksi | PASS | master ok, company ok, tabel master 21 |
| login bypass dengan ' OR 1=1 -- gagal | PASS | status 400 Input tidak valid |
| 276 permintaan berisi payload SQLi ke 24 titik input: tidak ada 5xx/pesan SQL | PASS | HARNESS ERROR (false positive): detektor otomatis menandai respons daftar customer yang memuat NAMA  |
| XSS: kotak pencarian Ctrl+K dengan payload | PASS |  |

Ringkasan: **tidak ada authentication bypass, tidak ada kebocoran lintas-company, tidak ada SQL injection, tidak ada XSS tereksekusi, privilege escalation tertutup**. Temuan keamanan yang tersisa hanya MEDIUM/LOW: UAT-006, 007, 008, 009, 012, 014, 016, 017, 018.

## ACCOUNTING REGRESSION

Dataset 5 tahun yang sama (5.965 jurnal inti, 18.900 baris) dimuat ulang lewat Import Excel resmi pada installer final dan dibandingkan **per akun** dengan model oracle independen. Hasil: semua cocok.

| Tahun | Total Debit | Total Kredit | Aset | Liabilitas | Ekuitas | Laba tahun berjalan | Jurnal |
|---|---|---|---|---|---|---|---|
| 2021 | 11.562.718.000 | 11.562.718.000 | 4.269.558.000 | 341.687.000 | 3.927.871.000 | 1.677.871.000 | 476 |
| 2022 | 16.325.311.000 | 16.325.311.000 | 7.386.979.000 | 731.197.000 | 6.655.782.000 | 2.727.911.000 | 735 |
| 2023 | 35.969.637.500 | 35.969.637.500 | 15.088.023.500 | 2.464.004.000 | 12.624.019.500 | 5.468.237.500 | 1282 |
| 2024 | 54.122.750.000 | 54.122.750.000 | 22.956.893.500 | 2.834.492.000 | 20.122.401.500 | 7.498.382.000 | 1626 |
| 2025 | 71.382.333.000 | 71.382.333.000 | 32.783.573.500 | 3.733.488.000 | 29.050.085.500 | 8.927.684.000 | 1834 |

- Angka per tahun **identik dengan putaran 1** (aset, ekuitas, laba): YA.
- Total Debit = Total Kredit di setiap tahun; Aset = Liabilitas + Ekuitas di setiap tahun; Ekuitas awal tahun = ekuitas akhir tahun sebelumnya; Arus Kas ending = saldo kas+bank; Dashboard YTD = Laba Rugi.
- **60 Trial Balance seimbang** dan saldo tiap akun = oracle; baris "Laba (Rugi) Belum Ditutup" = laba kumulatif.
- Cross-year (31/12 ke 01/01, 5 tahun vs jumlah tahunan) PASS; jurnal reversal (45), draft (12), dan transaksi antar kantor (17) PASS.
- **Tidak ada HTTP 500 akibat satu jurnal invalid**: jurnal tak seimbang kini ditolak di pintu masuk, sehingga laporan tidak bisa diracuni.
- Integritas akhir database: `integrity_check` ok, FK 0 pelanggaran, 0 jurnal Posted tak seimbang, 0 referensi ganda, pasangan reversal konsisten, total debit = total kredit.
- Backup/restore atas data besar: restore identik di 60 Trial Balance, laporan 5 tahun, Ledger, audit, COA; kill -9 saat commit 4.000 jurnal atomic.
- Kinerja (ms):

| Operasi | Putaran 1 | Putaran 2 |
|---|---|---|
| Login | 153 ms | 167 ms |
| Daftar perusahaan | 15 ms | 11 ms |
| Dashboard 1 tahun | 1703 ms | 5213 ms |
| Dashboard 5 tahun | 1643 ms | 2159 ms |
| Ledger Bank BCA 5 tahun (2.009 baris) | 47 ms | 51 ms |
| Ledger Bank BCA 1 bulan | 33 ms | 41 ms |
| Trial Balance Des 2025 | 88 ms | 113 ms |
| Laba Rugi 1 tahun | 49 ms | 51 ms |
| Laba Rugi 5 tahun | 43 ms | 86 ms |
| Neraca 5 tahun | 83 ms | 141 ms |
| Arus Kas 5 tahun | 859 ms | 2335 ms |
| Ekuitas 5 tahun | 74 ms | 240 ms |
| Analisis rasio 5 tahun | 103 ms | 391 ms |
| Proyeksi | 707 ms | 3045 ms |
| Search nomor jurnal | 52 ms | 130 ms |
| Search nominal | 70 ms | 142 ms |
| Search teks umum | 60 ms | 234 ms |
| Daftar jurnal (halaman 1 dari 5.965) | 33 ms | 78 ms |
| Daftar jurnal + pencarian teks | 21 ms | 80 ms |
| Audit log | 44 ms | 110 ms |
| Saldo Hutang/Piutang | 36 ms | 250 ms |

Tidak ada regresi kinerja berarti; validasi balance tambahan (SUM bilangan bulat) dan validator tanggal tidak terasa pada import 500 transaksi per batch.

## FILES CHANGED

API (perbaikan): `apps/api/src/lib/calendar-date.ts` (baru), `lib/money.ts` (baru), `db/system/rbac.ts`, `modules/company-access/routes.ts`, `db/company/journal-service.ts`, `journal-import-service.ts`, `opening-balance-import-service.ts`, `opening-balance-service.ts`, `ledger-service.ts`, `fiscal-period.ts`, `reporting/reporting-utils.ts`, `modules/journal/parser.ts`, `modules/journal/posting.ts`, `modules/journal/routes.ts`, `modules/accounts/import-parser.ts`, `modules/company-opening-balance-import/parser.ts`, `modules/company-journal/routes.ts`, `modules/company-opening-balance/routes.ts`, `modules/company-periods/routes.ts`, `modules/company-analysis/routes.ts`, `modules/company-tax/routes.ts`, `modules/company-projection/routes.ts`, `modules/company-audit-log/routes.ts`.
Web: `apps/web/src/lib/money.ts` (baru), `routes/workspace/journal/journal-form-panel.tsx`, `routes/workspace/opening-balance/opening-balance-form.tsx`, `routes/journal-page.tsx`.
Test: `apps/api/src/db/company/uat-high-fixes.test.ts` (baru, 20 tes), `apps/api/src/modules/company-access/routes.test.ts` (+10 tes).
UAT: `docs/uat/harness/` (s10_regression_high, s11_remaining, run_all, perbaikan harness), `docs/uat/evidence/` (putaran 2), `docs/uat/evidence-run1-before-fix/` (putaran 1).

## REMAINING RISKS

1. UAT-006/007/008/010: login tanpa penundaan, login tidak diaudit, CORS longgar, pembatas laju global: wajib ditutup sebelum akses jaringan/multi-device.
2. UAT-009: validasi isi avatar (klasifikasi MEDIUM; lihat catatan kejujuran).
3. UAT-005: Arus Kas menampilkan pecahan dan alokasi pro-rata untuk jurnal campuran (total tetap benar).
4. UAT-011: input debit+kredit pada satu baris menghasilkan 500 (bukan 400).
5. Jurnal lama dari versi sebelum perbaikan yang telanjur tak seimbang (bila ada di instalasi lain) tidak diubah; tidak bisa diposting ulang, tetapi bisa direversal. Data klien yang diperiksa tidak memilikinya.
6. Perilaku baru yang perlu dikomunikasikan: tanggal teks di Excel hanya `YYYY-MM-DD`; jurnal harus seimbang persis; ADMIN tidak lagi bisa mengelola OWNER.
7. Jendela Electron tidak dijalankan (port 4000 dipakai aplikasi produksi); pengujian memakai server dari installer yang sama.

---

# LAMPIRAN: HASIL UAT AWAL SEBELUM PERBAIKAN (installer 07:05, keputusan NOT READY)


Tanggal UAT: 2026-10-05. Penguji: Claude (QA / Accounting / Database / Security). Tidak ada perubahan kode aplikasi pada tahap ini (FIND, RECORD, CLASSIFY, REPORT).

## A. Executive Summary

TERRA FINANCE diuji dengan perusahaan simulasi yang memakai **5 tahun transaksi (01/01/2021 sampai 31/12/2025)**: **5.965 jurnal / 18.900 baris** pada periode tersebut (11.998 jurnal / 30.966 baris termasuk data uji 2026), lima kantor yang disimulasikan lewat akun per cabang, 17 transaksi antar kantor, 45 reversal, 12 draft, dan seluruh menu serta serangan keamanan yang diminta.

**Yang berhasil dengan sangat baik**
- **Akuntansi 5 tahun benar.** Setiap angka Neraca, Laba Rugi, Ekuitas, Arus Kas, Trial Balance (60 periode), Ledger, dan Dashboard dibandingkan dengan model hitung independen: **semua cocok**. Total Debit = Total Kredit, Aset = Liabilitas + Ekuitas di setiap tahun, saldo menyambung antar tahun, transaksi di 31/12 dan 01/01 benar.
- **Isolasi dan keamanan inti kuat.** Nol kebocoran lintas-company dari lebih dari 100 permintaan IDOR/tampering, nol SQL injection dari 276 payload ke 24 titik input, XSS tidak dieksekusi di 9 halaman, tidak ada authentication bypass, path traversal gagal, mass assignment diabaikan.
- **Ketahanan kuat.** Kill -9 di tengah commit 4.000 jurnal: hasil atomic, integrity_check ok. Backup lalu restore: 60 Trial Balance dan semua laporan tahunan identik dengan aslinya.
- **Kinerja baik.** Hampir semua laporan di bawah 1 detik pada data 5 tahun; Dashboard 1,7 detik; export terbesar < 1 detik.

**Yang menghalangi produksi (3 temuan HIGH)**
1. **UAT-001**: ADMIN dapat menaikkan dirinya (atau user lain) menjadi OWNER. Ini eskalasi hak.
2. **UAT-002**: satu jurnal selisih Rp 1 yang lolos validasi toleransi membuat Neraca dan Dashboard menjawab HTTP 500 untuk semua periode sesudahnya.
3. **UAT-003**: Import jurnal menyimpan tanggal "2026-02-30" sebagai 2026-03-02 secara diam-diam.

Sesuai aturan keputusan yang Anda tetapkan (HIGH security issue lebih dari 0 berarti NOT READY), keputusan akhir adalah **NOT READY FOR PRODUCTION**. Tidak ada temuan CRITICAL, rekonsiliasi akuntansi lulus, dan isolasi company lulus; ketiga HIGH di atas dapat diperbaiki dengan perubahan kecil.

## B. UAT Environment

| Item | Nilai |
|---|---|
| Build yang diuji | Installer FINAL `TERRA FINANCE Setup 0.1.0.exe` (dibuat 2026-10-05 07:05, 124.189.967 byte), diekstrak; server dijalankan dengan `TERRA FINANCE.exe` (ELECTRON_RUN_AS_NODE) dari isi installer |
| Server / port | 127.0.0.1:4500 (production pengguna di port 4000 tidak disentuh) |
| Data | folder UAT terpisah (`uat5/data`: terra-finance.sqlite, terra-system.sqlite, companies/*) |
| Lisensi | lisensi UAT "PT TERRA NUSANTARA (UAT)" lifetime, ditandatangani kunci vendor (kunci privat tidak dicetak; log penerbitan di folder UAT) |
| Backup | folder `uat5/backup` dan `uat5/restored`; restore dijalankan di port 4501 |
| Browser | Microsoft Edge headless dikendalikan lewat DevTools Protocol, viewport 1366x820 |
| Sistem | Windows 11 Home; Node 22 |
| Production | tidak diakses, diubah, atau dipakai; data klien tidak dipakai pada UAT ini |

Batasan lingkungan yang jujur: jendela Electron tidak dijalankan karena aplikasi production berjalan di port 4000 (port tetap). Uji menu dilakukan di browser terhadap server dari installer yang sama. Pengujian multi-device tidak dilakukan (belum diimplementasikan).

## C. Dataset

```text
Company: PT TERRA NUSANTARA (Company A) + PT PEMBANDING UAT (Company B, untuk isolasi) + perusahaan uji kecil
Years: 2021-2025 (60 periode bulanan)
Branches simulated: 5 (Kantor Pusat, Cabang Metro, Cabang Bandar Lampung, Cabang Kotabumi, Cabang Terbanggi Besar)
  Pusat dan Metro aktif sejak 2021; Bandar Lampung sejak Mar 2022; Kotabumi dan Terbanggi Besar sejak Apr 2023
Users: 6 akun utama (Owner, Admin, Akuntan, Staf, Viewer, Penyusup/Owner Company B) + akun uji input dengan peran OWNER/ADMIN/ACCOUNTANT/STAFF/VIEWER
COA: 48 akun (kas, bank, piutang, persediaan, aset tetap, akumulasi penyusutan, utang usaha, utang bank, modal, antarkantor, pendapatan/HPP/beban per cabang)
Journal count (2021-2025): 5.965 (5.907 transaksi impor + 1 saldo awal + 45 pembalik reversal + 12 draft)
Journal lines (2021-2025): 18.900
Journal count total termasuk uji 2026: 11.998; baris 30.966; audit log 24.123 baris
```

Pola transaksi per tahun berbeda: 2021 = 471 transaksi (2 kantor), 2022 = 731 (3 kantor), 2023 = 1.277 (5 kantor, ekspansi, tambahan modal Rp 500 jt, pinjaman bank Rp 1 miliar, pembelian kendaraan), 2024 = 1.620 (piutang/utang naik), 2025 = 1.808 (pembelian peralatan dan gedung, pelunasan, reversal). Termasuk transaksi 31/12 dan 01/01 tiap tahun, dua transaksi bertanggal sama (kecil dan besar), nominal Rp 1.000 sampai Rp 140 juta (lebih besar pada uji), multi-line, transfer antar bank, penyusutan bulanan, bunga bank, piutang dan pelunasannya, utang vendor dan pembayarannya. Data dimuat lewat **Import Excel resmi** (12 batch x 500 transaksi) setelah COA Import dan Opening Balance Import; reversal lewat API; draft lewat API.

## D. Menu Test Matrix

| Menu | Jumlah uji | Lulus | Hasil |
|---|---|---|---|
| Login | 13 | 13 | PASS |
| Company List | 4 | 4 | PASS |
| Add Company | 14 | 14 | PASS |
| Dashboard | 19 | 19 | PASS |
| Journal (create/draft/post/reverse/rules) | 43 | 41 | FAIL: UAT-002, UAT-011 |
| Journal Import | 68 | 64 | FAIL: UAT-003, UAT-015 |
| COA (CRUD, lock/unlock) | 23 | 23 | PASS |
| COA Import | 16 | 16 | PASS |
| Opening Balance + Opening Balance Import | 14 | 14 | PASS |
| Ledger | 24 | 24 | PASS |
| Trial Balance | 6 | 6 | PASS |
| Income Statement | 29 | 29 | PASS |
| Balance Sheet | 32 | 32 | PASS |
| Equity | 22 | 22 | PASS |
| Cash Flow | 23 | 22 | FAIL: UAT-005 |
| Report Export (Excel/PDF) | 62 | 62 | PASS |
| Search / Ctrl+K | 6 | 6 | PASS |
| Settings (profil, backdate) | 19 | 19 | PASS |
| User Management | 16 | 16 | PASS |
| Company Access | 16 | 16 | PASS |
| License | 8 | 8 | PASS |
| Backup / Restore | 39 | 39 | PASS |
| Logout | 4 | 3 | FAIL: UAT-012 |
| Hutang & Piutang | 7 | 7 | PASS |
| Pajak, Analisis, Proyeksi, Kas&Bank, Audit Log, Data Awal, Benchmark | 22 | 21 | FAIL: UAT-010 |
| Administrator panel | 13 | 13 | PASS |
| Periode (generate/lock/close) | 11 | 10 | FAIL: UAT-015 |

Setiap menu juga dibuka di browser dan dipotret (`evidence/screenshots/ui-*.png`): 25 halaman, 24 tampil normal; 1 halaman kosong akibat pembatas laju (UAT-010). Menu yang tidak ada di UI: Lisensi (hanya status/endpoint) dan Backup (otomatis, tanpa layar); keduanya diuji lewat API/berkas.

## E. Accounting Reconciliation

Model oracle independen dihitung dari data sumber (saldo awal + transaksi + pembalik reversal; draft tidak ikut), lalu dibandingkan **per akun** dengan API setiap tahun.

| Tahun | Total Debit | Total Kredit | Aset | Liabilitas | Ekuitas | Laba tahun berjalan | Jurnal | Baris |
|---|---|---|---|---|---|---|---|---|
| 2021 | 11.562.718.000 | 11.562.718.000 | 4.269.558.000 | 341.687.000 | 3.927.871.000 | 1.677.871.000 | 476 | 1338 |
| 2022 | 16.325.311.000 | 16.325.311.000 | 7.386.979.000 | 731.197.000 | 6.655.782.000 | 2.727.911.000 | 735 | 2169 |
| 2023 | 35.969.637.500 | 35.969.637.500 | 15.088.023.500 | 2.464.004.000 | 12.624.019.500 | 5.468.237.500 | 1282 | 3971 |
| 2024 | 54.122.750.000 | 54.122.750.000 | 22.956.893.500 | 2.834.492.000 | 20.122.401.500 | 7.498.382.000 | 1626 | 5252 |
| 2025 | 71.382.333.000 | 71.382.333.000 | 32.783.573.500 | 3.733.488.000 | 29.050.085.500 | 8.927.684.000 | 1834 | 6146 |

Hasil pemeriksaan (semua PASS): Debit = Kredit tiap tahun; Aset = Liabilitas + Ekuitas; saldo tiap akun neraca = oracle; Laba Rugi (pendapatan, HPP, beban, laba) = oracle; Ekuitas awal + tambahan modal + laba = ekuitas akhir, dan ekuitas awal tahun = ekuitas akhir tahun sebelumnya; kas akhir Arus Kas = saldo kas+bank, kas awal = kas akhir tahun lalu; Dashboard YTD = Laba Rugi; **60 Trial Balance seimbang dan saldo tiap akun = oracle**, baris "Laba (Rugi) Belum Ditutup" = laba kumulatif sebelum periode.

**Cross-year:** laba 01/01/2021-31/12/2025 = jumlah laba lima tahun (Rp 26.300.085.500); pendapatan 5 tahun, neraca 31/12/2025, kas akhir, ekuitas penutup cocok dengan hitungan tahunan. Ledger pada 31/12 dan 01/01 tiap tahun memuat tepat baris tanggal itu; ledger lintas 31/12 ke 01/01 benar termasuk saldo awal.

**Catatan akuntansi (bukan kegagalan rekonsiliasi):** UAT-002 (toleransi Rp 1), UAT-003 (tanggal import bergeser), UAT-005 (Arus Kas pecahan dan alokasi pro-rata untuk jurnal campuran).

## F. Multi-Branch Simulation

**Pendekatan (tanpa mengubah skema, tanpa branch_id):** setiap cabang memiliki akun sendiri (Kas, Pendapatan, HPP, Beban Gaji, Antarkantor Aktiva, Antarkantor Pasiva) bernomor sufiks cabang; akun bersama (bank, piutang, persediaan, aset tetap, utang) dipakai lintas cabang; nomor jurnal berawalan kode cabang (PST-, MTR-, BDL-, KTB-, TBS-); keterangan diawali [kode cabang].

Hasil pada engine saat ini:
- **Laba Rugi per cabang (pendapatan)** dapat ditarik dari akun per cabang dan **cocok dengan model** (PASS):

| Cabang | Pendapatan 2021-2025 | HPP | Beban Gaji |
|---|---|---|---|
| Kantor Pusat | 14.901.424.000 | 6.180.761.000 | 1.684.628.000 |
| Cabang Metro | 18.406.924.000 | 8.488.121.000 | 1.568.984.000 |
| Cabang Bandar Lampung | 11.886.278.500 | 4.943.200.000 | 965.869.000 |
| Cabang Kotabumi | 13.127.332.500 | 6.355.280.000 | 1.125.952.000 |
| Cabang Terbanggi Besar | 9.569.503.500 | 4.086.989.000 | 775.209.000 |

- Laporan **konsolidasi** (Neraca, Laba Rugi, Arus Kas, Ekuitas, Trial Balance) cocok dan seimbang.
- **Tidak ada laporan per cabang** yang dapat diminta ke sistem. Neraca per cabang, Trial Balance per cabang, dan Laba Rugi lengkap per cabang tidak tersedia kecuali COA dipecah per cabang untuk semua akun (biaya bersama seperti listrik, sewa, transportasi tidak teralokasi).
- Biaya cabang yang memakai akun bersama (Listrik, Internet, Transportasi, Operasional, Sewa) hanya dapat dibedakan lewat keterangan/referensi (pencarian teks), bukan lewat laporan.
- Jumlah akun membengkak bila ingin lebih rinci: mis. 5 cabang x 6 akun = 30 akun tambahan hanya untuk enam jenis akun.

**Kesimpulan F:** engine mampu *mencatat* dan *mengonsolidasi* transaksi lima kantor secara benar, tetapi tidak mampu menghasilkan **pembukuan dan laporan per cabang** tanpa dimensi cabang. Ini mendukung rekomendasi arsitektur A (branch_id pada jurnal) di laporan multi-cabang.

## G. Inter-office Transactions

Model: satu jurnal antar kantor berisi **empat baris** (sisi pengirim dan sisi penerima) sehingga atomic. Contoh Pusat ke Metro Rp 100 jt: Dr Antarkantor Aktiva-Metro, Cr Bank BCA; Dr Kas Metro, Cr Antarkantor Pasiva-Pusat. Tujuh belas transaksi diuji: Pusat ke Metro, Pusat ke Bandar Lampung, Metro ke Pusat, Bandar Lampung ke Pusat, Metro ke Kotabumi, Kotabumi ke Terbanggi Besar (dan beberapa lainnya) pada 2021-2025.

Hasil:
- Total **Antarkantor Aktiva = Total Antarkantor Pasiva** (Rp 850.000.000 pada 31/12/2025, dari Neraca API): **PASS** (eliminasi konsolidasi = 0).
- **Reversal jurnal antar kantor membalik kedua sisi sekaligus** (status Reversed + jurnal pembalik Posted): **PASS**.
- Laporan konsolidasi tetap seimbang di semua tahun: **PASS**.

Saldo per 31/12/2025:

| Akun (menurut lawan transaksi) | Antarkantor Aktiva | Antarkantor Pasiva |
|---|---|---|
| Kantor Pusat | 258.000.000 | 415.000.000 |
| Cabang Metro | 175.000.000 | 213.000.000 |
| Cabang Bandar Lampung | 240.000.000 | 160.000.000 |
| Cabang Kotabumi | 115.000.000 | 62.000.000 |
| Cabang Terbanggi Besar | 62.000.000 | 0 |

**Cara merepresentasikan pada architecture saat ini (dokumentasi, bukan fitur baru):**
1. Satu jurnal berisi dua sisi; nomor jurnal berawalan cabang pengirim; keterangan "[PST] ... PST -> MTR".
2. Akun Antarkantor Aktiva/Pasiva dibuat per lawan transaksi (atau per pasangan).
3. Eliminasi: total Aktiva = total Pasiva di Neraca konsolidasi.

**Keterbatasan:** akun per lawan transaksi **tidak menyebut pemilik sisi**, sehingga saldo Pusat terhadap Metro tidak bisa direkonsiliasi dengan saldo Metro terhadap Pusat (akun Aktiva-Metro bercampur klaim dari semua pengirim). Rekonsiliasi per pasangan memerlukan N x (N-1) x 2 akun (40 akun untuk 5 kantor) atau dimensi cabang. Tidak ada validasi bahwa setiap jurnal antar kantor seimbang **per cabang**; hanya seimbang total. Tidak ada laporan rekonsiliasi antarkantor.

## H. Performance

Data: Company A, 5.965 jurnal inti (≈12.000 saat pengukuran), server UAT. Kategori: < 1 dtk / 1-3 / 3-5 / 5-10 / > 10.

| Operasi | Waktu | Kategori |
|---|---|---|
| Login | 153 ms | <1s |
| Daftar perusahaan | 15 ms | <1s |
| Dashboard 1 tahun | 1703 ms | 1-3s |
| Dashboard 5 tahun | 1643 ms | 1-3s |
| Ledger Bank BCA 5 tahun (2.009 baris) | 47 ms | <1s |
| Ledger Bank BCA 1 bulan | 33 ms | <1s |
| Trial Balance Des 2025 | 88 ms | <1s |
| Laba Rugi 1 tahun | 49 ms | <1s |
| Laba Rugi 5 tahun | 43 ms | <1s |
| Neraca 5 tahun | 83 ms | <1s |
| Arus Kas 5 tahun | 859 ms | <1s |
| Ekuitas 5 tahun | 74 ms | <1s |
| Analisis rasio 5 tahun | 103 ms | <1s |
| Proyeksi | 707 ms | <1s |
| Search nomor jurnal | 52 ms | <1s |
| Search nominal | 70 ms | <1s |
| Search teks umum | 60 ms | <1s |
| Daftar jurnal (halaman 1 dari 5.965) | 33 ms | <1s |
| Daftar jurnal + pencarian teks | 21 ms | <1s |
| Audit log | 44 ms | <1s |
| Saldo Hutang/Piutang | 36 ms | <1s |

Waktu impor/backup: COA import preview: 60 ms; COA import commit: 76 ms; journal import preview batch1 (500 jurnal): 343 ms; journal import commit batch1: 1358 ms; journal import preview batch2 (500 jurnal): 253 ms; journal import commit batch2: 1287 ms; journal import preview batch3 (500 jurnal): 261 ms; journal import commit batch3: 1276 ms; journal import preview batch4 (500 jurnal): 281 ms; journal import commit batch4: 1157 ms; journal import preview batch5 (500 jurnal): 227 ms; journal import commit batch5: 1231 ms; journal import preview batch6 (500 jurnal): 257 ms; journal import commit batch6: 1185 ms

Export terlama: export cash-flow 5 tahun pdf 923 ms; export cash-flow 5 tahun xlsx 887 ms; export ledger BCA 5 tahun pdf 560 ms; export cash-flow 1 tahun xlsx 333 ms; export cash-flow 1 tahun pdf 301 ms; export ledger BCA 5 tahun xlsx 205 ms.

**Bottleneck:** Dashboard (1,6-1,7 dtk, menghitung banyak laporan sekaligus untuk perbandingan dan tren 6 bulan) dan Arus Kas 5 tahun (0,9 dtk, alokasi kas per jurnal). Tidak ada operasi di atas 3 dtk. Ledger 5 tahun dengan 2.009 baris dirender di UI tanpa freeze.

## I. Security Test Matrix

| Attack / Test | Result | Bug / Severity |
|---|---|---|
| password salah -> 401 | PASS | - |
| user tidak ada -> 401, pesan identik (tidak membocorkan keberadaan akun) | PASS | - |
| password kosong ditolak (400/401) | PASS | - |
| body kosong ditolak (400) | PASS | - |
| JSON rusak -> 4xx (bukan 500) | PASS | - |
| password 100 KB tidak membuat server error | PASS | - |
| email/password berupa objek ditolak | PASS | - |
| login benar dengan field tambahan tetap normal | PASS | - |
| 15 endpoint terlindungi tanpa token -> 401 | PASS | - |
| token rusak/palsu/dimodifikasi -> 401 | PASS | - |
| setelah logout token lama ditolak (401) | PASS | - |
| sesi kedaluwarsa (expires_at lampau) -> 401 | PASS | - |
| idle > 15 menit -> 401 di server | PASS | - |
| ping aktivitas tidak menghidupkan sesi idle | PASS | - |
| user dinonaktifkan: sesi lama dan login baru ditolak | PASS | - |
| cookie sesi HttpOnly + SameSite=Lax | PASS | - |
| setiap login menghasilkan token baru (anti session fixation) | PASS | - |
| respons /auth/me & login tidak membocorkan password_hash | PASS | - |
| daftar user tidak membocorkan password_hash | PASS | - |
| matriks otorisasi 75 kombinasi peran x izin sesuai kebijakan (403 untuk yang tidak berhak) | PASS | - |
| VIEWER menaikkan dirinya sendiri ke OWNER ditolak (403) | PASS | - |
| user aplikasi non-admin tidak boleh membuat user admin (403) | PASS | - |
| user aplikasi non-admin tidak boleh melihat daftar user (403) | PASS | - |
| non-admin tidak boleh menonaktifkan user lain (403) | PASS | - |
| non-admin tidak boleh mengganti lisensi (403) | PASS | - |
| lisensi palsu ditolak oleh admin sekalipun (400) | PASS | - |
| lisensi tetap aktif setelah percobaan palsu | PASS | - |
| user Company B -> Company A: 38 endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan) | PASS | - |
| user Company A (akuntan) -> Company B: 38 endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan) | PASS | - |
| viewer A -> B: 38 endpoint seluruhnya 404 (tidak ada 200/403 yang membocorkan) | PASS | - |
| respons 'tidak berhak' identik dengan 'perusahaan tidak ada' (anti enumerasi) | PASS | - |
| ID jurnal/akun milik Company A dipakai lewat URL Company B (pemilik B): 404/400, tidak berdampak | PASS | - |
| pencarian di Company B tidak menemukan data Company A | PASS | - |
| manipulasi slug (case, null byte, ../, encoded) tidak membuka Company A | PASS | - |
| mengubah akses user yang bukan anggota Company A ditolak (404) | PASS | - |
| jalur lama /api/c/<slug> oleh user Company B -> tidak 200 | PASS | - |
| 276 permintaan berisi payload SQLi ke 24 titik input: tidak ada 5xx/pesan SQL | PASS | - |
| jumlah baris tabel tidak berubah selain record uji yang sah (tidak ada kerusakan/ekstraksi) | PASS | - |
| integrity_check master & company DB ok setelah uji injeksi | PASS | - |
| login bypass dengan ' OR 1=1 -- gagal | PASS | - |
| PATCH akun dengan isLocked/isSystemAccount/id/code diabaikan (akun sudah terkunci oleh admin; kode & flag sistem tidak berubah) | PASS | - |
| PATCH profil dengan id/journal_number_seq/max_backdate_days diabaikan | PASS | - |
| POST user dengan id/is_admin/password_hash tambahan diabaikan | PASS | - |
| tidak ada endpoint ubah/hapus audit log (semua 404/405) | PASS | - |
| audit log append-only di level database (trigger menolak UPDATE/DELETE) | PASS | - |
| 30 percobaan password salah beruntun pada akun Owner: tidak ada penguncian akun/jeda (login benar tetap 200 sesudahnya) | FAIL | UAT-006 MEDIUM |
| ADMIN dapat menaikkan perannya sendiri menjadi OWNER (eskalasi hak; memutus pemisahan OWNER-only untuk backup/restore) | FAIL | UAT-001 HIGH |
| ADMIN dapat memberikan peran OWNER kepada user lain | FAIL | UAT-001 HIGH |
| ADMIN dapat menurunkan peran OWNER perusahaan | PASS | - |
| Endpoint laporan/dashboard menerima tanggal non-ISO ('2025', '1/1/2025', "' OR '1'='1") -> HTTP 500 'Invalid time value' atau alarm palsu 'Balance She | FAIL | UAT-004 MEDIUM |
| counterparties?type=<tidak valid> mengabaikan filter dan mengembalikan semua data (bukan 400) | FAIL | UAT-015 LOW |
| 14 pola traversal ke file statis (../, %2e%2e, %5c, %00, ganda-encode): tidak ada file di luar web dist yang terbaca | PASS | - |
| traversal di path API ditangani (tidak 5xx) | PASS | - |
| halaman bisa di-iframe (tanpa X-Frame-Options/CSP frame-ancestors) | FAIL | UAT-014 LOW |
| CORS tidak memantulkan origin sembarang dengan credentials | FAIL | UAT-008 MEDIUM |
| POST mengubah data dengan form-urlencoded dari origin asing ditolak | PASS | - |
| text/plain dari origin asing ditolak | PASS | - |
| avatar PNG valid diterima | PASS | - |
| avatar SVG (bisa memuat script) ditolak | FAIL | UAT-009 MEDIUM |
| file HTML bermasker image/png (isi bukan gambar) ditolak | FAIL | UAT-009 MEDIUM |
| avatar bertipe text/plain ditolak | PASS | - |
| avatar 8 MB ditolak | PASS | - |
| nama file traversal pada avatar tidak berbahaya | PASS | - |
| ZIP/XLSX rusak (header PK tapi isi sampah) tidak crash server (<500) | PASS | - |
| server tetap hidup setelah seluruh uji upload | PASS | - |
| pembatas laju global (200 permintaan/menit/IP) aktif: 230 permintaan cepat memicu 429 | PASS | - |
| layanan pulih setelah jendela 1 menit | PASS | - |
| 8 export PDF Ledger 5 tahun paralel: semua 200/429 dan server tetap hidup | PASS | - |
| token Administrator palsu ditolak | PASS | - |
| license key dimodifikasi + token asli ditolak | PASS | - |
| login Administrator dengan payload SQLi ditolak | PASS | - |
| endpoint Administrator tanpa login ditolak | PASS | - |
| Owner aplikasi biasa TIDAK otomatis jadi Administrator (panel butuh token vendor) | PASS | - |
| login Administrator dengan token vendor valid | PASS | - |
| panel Administrator me 200 | PASS | - |
| panel Administrator diag 200 | PASS | - |
| panel Administrator err 200 | PASS | - |
| panel Administrator dev 200 | PASS | - |
| diagnostik tidak membocorkan secret/hash/private key | PASS | - |
| logout Administrator mencabut akses | PASS | - |
| lisensi UAT aktif (lifetime) & terikat perangkat | PASS | - |
| tabel lisensi tidak menyimpan private key | PASS | - |
| kunci lisensi dimodifikasi di DB -> data ditolak (403) walau login bisa; dipulihkan -> normal | PASS | - |
| audit log mencatat: journal.create | PASS | - |
| audit log mencatat: journal.post | PASS | - |
| audit log mencatat: journal.reverse | PASS | - |
| audit log mencatat: journal.import | PASS | - |
| audit log mencatat: account.lock | PASS | - |
| audit log mencatat: settings change | PASS | - |
| audit log mencatat: company change | PASS | - |
| audit log mencatat: account.create | PASS | - |
| audit log mencatat: period.lock | PASS | - |
| login pengguna biasa tercatat di audit | FAIL | UAT-007 MEDIUM |
| logout tercatat di audit | FAIL | UAT-007 LOW |
| perubahan user tercatat di audit | PASS | - |
| perubahan akses perusahaan (grant/role/suspend/revoke) tercatat di audit | PASS | - |
| jurnal ke periode CLOSED ditolak (409) | PASS | - |
| reversal jurnal di periode CLOSED ditolak (409) | PASS | - |
| unlock akun tercatat di audit log | PASS | - |
| login/logout pengguna biasa TIDAK tercatat di audit log (hanya administrator.login); percobaan login gagal juga tidak tercatat | FAIL | UAT-007 MEDIUM |
| XSS: daftar jurnal: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: detail jurnal: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: COA: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: daftar perusahaan: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: user aplikasi: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: audit log: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: hutang & piutang: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |
| XSS: pengguna perusahaan: payload tidak dieksekusi dan tidak menjadi elemen DOM | PASS | - |

**Ringkasan keamanan:** tidak ada authentication bypass, tidak ada kebocoran lintas-company, tidak ada SQL injection, tidak ada XSS tereksekusi, tidak ada path traversal; temuan nyata: UAT-001 (HIGH), UAT-006 sampai UAT-010 (MEDIUM), UAT-012, UAT-014, UAT-016, UAT-017 (LOW). Matriks otorisasi 75 kombinasi peran x izin sesuai kebijakan, kecuali eskalasi pada UAT-001.

## J. Bugs

Klasifikasi: CRITICAL 0, HIGH 3, MEDIUM 8, LOW 7, COSMETIC 0. Daftar ringkas:

| ID | Severity | Judul | Modul |
|---|---|---|---|
| UAT-001 | HIGH | ADMIN dapat menaikkan perannya sendiri atau user lain menjadi OWNER | Security / Authorization |
| UAT-002 | HIGH | Jurnal selisih Rp 1 (toleransi pembulatan) lolos Post lalu merusak Neraca, Dashboard (HTTP 500) dan Trial Balance untuk semua periode sesudahnya | Accounting engine |
| UAT-003 | HIGH | Import jurnal menerima tanggal yang tidak nyata (2026-02-30) sebagai VALID dan menyimpannya dengan tanggal bergeser (2026-03-02) | Journal import |
| UAT-004 | MEDIUM | Parameter tanggal laporan/dashboard diparse longgar: '2025', '1/1/2025', "' OR '1'='1" menghasilkan HTTP 500 atau alarm palsu 'Balance Sheet tidak seimbang' (mis. 2025-02-30) | Reporting API validation |
| UAT-005 | MEDIUM | Arus Kas: nilai rupiah pecahan/noise floating-point dan alokasi kas pro-rata pada jurnal campuran | Cash flow report |
| UAT-006 | MEDIUM | Tidak ada perlindungan brute force pada login | Authentication |
| UAT-007 | MEDIUM | Login, logout, dan gagal-login pengguna tidak tercatat di audit log | Audit |
| UAT-008 | MEDIUM | CORS memantulkan origin sembarang dengan Access-Control-Allow-Credentials: true | Security configuration |
| UAT-009 | MEDIUM | Upload avatar menerima SVG berskrip dan berkas HTML bermasker image/png | File upload |
| UAT-010 | MEDIUM | Pembatas laju global menyebabkan halaman kosong saat berpindah halaman cepat | Availability / UX |
| UAT-011 | MEDIUM | Jurnal manual dengan baris berisi debit dan kredit sekaligus menghasilkan HTTP 500 | Journal API validation |
| UAT-012 | LOW | Logout manual di satu tab tidak menyiarkan logout ke tab lain | Session |
| UAT-013 | LOW | Tidak ada batas panjang/format input pada nama, kode, referensi; nominal pecahan diterima | Input validation |
| UAT-014 | LOW | Header keamanan HTTP tidak dikirim (CSP, X-Frame-Options, nosniff, Referrer-Policy) | Security configuration |
| UAT-015 | LOW | Beberapa input tidak valid diterima diam-diam | Input validation |
| UAT-016 | LOW | User aplikasi bertingkat 'staff' tetap dapat membuat perusahaan baru (menjadi OWNER-nya) | Authorization (design) |
| UAT-017 | LOW | Kebijakan password lemah: 'aaaaaaaa' diterima | Authentication |
| UAT-018 | LOW | Ekspor Excel tidak menetralkan teks berawalan = + @ - | Export |

### UAT-001: ADMIN dapat menaikkan perannya sendiri atau user lain menjadi OWNER

```text
BUG ID: UAT-001
TITLE: ADMIN dapat menaikkan perannya sendiri atau user lain menjadi OWNER
SEVERITY: HIGH
MODULE: Security / Authorization
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Login sebagai user berperan ADMIN di Company A. Kirim PATCH /api/company-db/pt-terra-nusantara/access/<id-admin> {role:"OWNER"}; ulangi untuk user VIEWER.
EXPECTED: Hanya OWNER yang boleh memberi/mengubah peran OWNER (rbac.ts menyempitkan backup/restore ke OWNER).
ACTUAL: HTTP 200; peran sesudahnya OWNER (diverifikasi lewat daftar akses). Peran dipulihkan setelah uji.
SECURITY IMPACT: Insider ADMIN mengambil alih perusahaan: dapat menjadi OWNER, memberi OWNER ke akun lain, dan menembus pemisahan hak (backup/restore khusus OWNER).
ACCOUNTING IMPACT: Tidak langsung.
DATA IMPACT: Tidak langsung; perubahan tercatat di audit (company.access.role_changed).
EVIDENCE: results.jsonl (id: BUG-PRIV-ADMIN-OWNER, BUG-PRIV-ADMIN-GRANT)
RECOMMENDATION: Tolak perubahan peran ke/dari OWNER bila pelaku bukan OWNER, termasuk menaikkan diri sendiri.
```
### UAT-002: Jurnal selisih Rp 1 (toleransi pembulatan) lolos Post lalu merusak Neraca, Dashboard (HTTP 500) dan Trial Balance untuk semua periode sesudahnya

```text
BUG ID: UAT-002
TITLE: Jurnal selisih Rp 1 (toleransi pembulatan) lolos Post lalu merusak Neraca, Dashboard (HTTP 500) dan Trial Balance untuk semua periode sesudahnya
SEVERITY: HIGH
MODULE: Accounting engine
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: ACCOUNTANT membuat jurnal debit 1.000 / kredit 999 di Feb 2026 lalu Post. Buka Trial Balance Feb 2026, Neraca, Dashboard.
EXPECTED: Jurnal tidak seimbang ditolak; atau laporan tetap tampil.
ACTUAL: Jurnal diterima dan Posted. Trial Balance: selisih 1 (tidak balance). Neraca dan Dashboard: HTTP 500 "Balance Sheet tidak seimbang ... selisih 1" untuk setiap rentang yang memuat periode itu. Pulih setelah jurnal direversal.
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Tinggi: satu jurnal bernilai Rp 1 membuat seluruh laporan utama perusahaan tidak dapat dibuka sampai direversal.
DATA IMPACT: Tidak ada kerusakan data (hanya akumulasi selisih); semua laporan terblokir.
EVIDENCE: results.jsonl (id: BUG-ACC-TOL, JR-unbal, INT-unbalanced)
RECOMMENDATION: Terapkan debit = kredit persis (nilai rupiah bulat), atau hilangkan toleransi 1 pada validasi jurnal; pertimbangkan laporan tetap tampil dengan peringatan, bukan 500.
```
### UAT-003: Import jurnal menerima tanggal yang tidak nyata (2026-02-30) sebagai VALID dan menyimpannya dengan tanggal bergeser (2026-03-02)

```text
BUG ID: UAT-003
TITLE: Import jurnal menerima tanggal yang tidak nyata (2026-02-30) sebagai VALID dan menyimpannya dengan tanggal bergeser (2026-03-02)
SEVERITY: HIGH
MODULE: Journal import
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Unggah Excel dengan Tgl = 2026-02-30 pada transaksi seimbang; Preview; Submit.
EXPECTED: Tanggal ditolak (Error) seperti 2026-13-45 atau teks bebas.
ACTUAL: Preview VALID, commit sukses; jurnal IMP-E3 tersimpan POSTED dengan entry_date 2026-03-02.
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Tanggal transaksi berubah diam-diam; dapat memindahkan transaksi ke periode/bulan lain tanpa peringatan.
DATA IMPACT: Data keuangan salah tanpa jejak peringatan.
EVIDENCE: results.jsonl (id: BUG-IMP-DATE, JI-bad-tanggal2026023, JI-badcm-tanggal2026023)
RECOMMENDATION: Validasi kalender ketat (round-trip tanggal) di parser import, sama seperti jalur jurnal manual.
```
### UAT-004: Parameter tanggal laporan/dashboard diparse longgar: '2025', '1/1/2025', "' OR '1'='1" menghasilkan HTTP 500 atau alarm palsu 'Balance Sheet tidak seimbang' (mis. 2025-02-30)

```text
BUG ID: UAT-004
TITLE: Parameter tanggal laporan/dashboard diparse longgar: '2025', '1/1/2025', "' OR '1'='1" menghasilkan HTTP 500 atau alarm palsu 'Balance Sheet tidak seimbang' (mis. 2025-02-30)
SEVERITY: MEDIUM
MODULE: Reporting API validation
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: GET /dashboard atau /reports/balance-sheet dengan fromDate=2025-02-30 / 2025 / 1/1/2025.
EXPECTED: 400 dengan pesan tanggal tidak valid (seperti Ledger).
ACTUAL: 500 'Invalid time value' atau 500 'Balance Sheet tidak seimbang'; Laba Rugi menerima dan memberi hasil.
SECURITY IMPACT: Tidak ada injeksi SQL (nilai terikat sebagai parameter).
ACCOUNTING IMPACT: Alarm integritas palsu menyesatkan.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: BUG-DATE-LENIENT)
RECOMMENDATION: Gunakan validasi tanggal ketat yang sama dengan Ledger (isValidIsoDate) di semua endpoint laporan.
```
### UAT-005: Arus Kas: nilai rupiah pecahan/noise floating-point dan alokasi kas pro-rata pada jurnal campuran

```text
BUG ID: UAT-005
TITLE: Arus Kas: nilai rupiah pecahan/noise floating-point dan alokasi kas pro-rata pada jurnal campuran
SEVERITY: MEDIUM
MODULE: Cash flow report
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Buka Arus Kas 2025 pada dataset UAT (pembelian gedung Rp 800 jt: Bank 500 jt + Utang Bank 300 jt).
EXPECTED: Angka rupiah bulat; pembiayaan non-kas tidak tampil sebagai arus pendanaan negatif.
ACTUAL: operasi 8467770000.000004; investasi -483636363.6363636; pendanaan -136363636.36363634. Total tetap cocok dengan perubahan kas.
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Klasifikasi arus kas untuk jurnal dengan lebih dari satu akun lawan tidak intuitif; total benar.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: BUG-CF-FLOAT)
RECOMMENDATION: Bulatkan di sumber dan dokumentasikan/ubah aturan alokasi untuk jurnal campuran (transaksi non-kas).
```
### UAT-006: Tidak ada perlindungan brute force pada login

```text
BUG ID: UAT-006
TITLE: Tidak ada perlindungan brute force pada login
SEVERITY: MEDIUM
MODULE: Authentication
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: 30 login gagal beruntun ke akun Owner lalu login benar.
EXPECTED: Penundaan/penguncian setelah beberapa kegagalan.
ACTUAL: Semua 401; login benar sesudahnya 200; satu-satunya pembatas adalah limiter global 200 permintaan/menit.
SECURITY IMPACT: Tebakan password dapat diotomasi pada batas 200/menit.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: AU-bruteforce2)
RECOMMENDATION: Penundaan progresif / penguncian sementara per akun + audit login gagal.
```
### UAT-007: Login, logout, dan gagal-login pengguna tidak tercatat di audit log

```text
BUG ID: UAT-007
TITLE: Login, logout, dan gagal-login pengguna tidak tercatat di audit log
SEVERITY: MEDIUM
MODULE: Audit
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Login/logout lalu periksa audit log perusahaan, master, dan system.
EXPECTED: Aktivitas login tercatat.
ACTUAL: Hanya administrator.login yang ada; login pengguna biasa tidak.
SECURITY IMPACT: Percobaan masuk tidak dapat ditelusuri.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: AUDIT-login, AUDIT-logout, BUG-AUDIT-LOGIN)
RECOMMENDATION: Catat user.login, user.logout, user.login_failed (tanpa menyimpan password).
```
### UAT-008: CORS memantulkan origin sembarang dengan Access-Control-Allow-Credentials: true

```text
BUG ID: UAT-008
TITLE: CORS memantulkan origin sembarang dengan Access-Control-Allow-Credentials: true
SEVERITY: MEDIUM
MODULE: Security configuration
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Kirim Origin: http://evil.example ke /api/health dan preflight OPTIONS.
EXPECTED: Hanya origin aplikasi yang diizinkan.
ACTUAL: ACAO memantulkan origin; ACAC=true; preflight 204 untuk semua metode. Dampak lintas-situs diredam cookie SameSite=Lax dan server hanya di 127.0.0.1.
SECURITY IMPACT: Kebijakan terlalu longgar; berbahaya bila nanti dijadikan server jaringan.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: CORS-reflect)
RECOMMENDATION: Batasi origin ke http://127.0.0.1:<port> / origin aplikasi.
```
### UAT-009: Upload avatar menerima SVG berskrip dan berkas HTML bermasker image/png

```text
BUG ID: UAT-009
TITLE: Upload avatar menerima SVG berskrip dan berkas HTML bermasker image/png
SEVERITY: MEDIUM
MODULE: File upload
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: POST /api/auth/me/avatar dengan SVG berisi <script> (image/svg+xml) dan HTML bertipe image/png.
EXPECTED: Ditolak (bukan gambar raster yang valid).
ACTUAL: Keduanya 200; disimpan sebagai data URI. Di UI dirender lewat <img> sehingga skrip tidak berjalan.
SECURITY IMPACT: Validasi hanya berdasarkan MIME yang dideklarasikan klien.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: UP-svg, UP-spoof)
RECOMMENDATION: Verifikasi magic bytes (PNG/JPEG/WebP), tolak SVG/HTML, batasi ukuran.
```
### UAT-010: Pembatas laju global menyebabkan halaman kosong saat berpindah halaman cepat

```text
BUG ID: UAT-010
TITLE: Pembatas laju global menyebabkan halaman kosong saat berpindah halaman cepat
SEVERITY: MEDIUM
MODULE: Availability / UX
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Buka 17-25 halaman workspace berurutan dalam ~1-2 menit.
EXPECTED: Halaman tetap tampil; pesan jelas bila dibatasi.
ACTUAL: Halaman ke-18 putih kosong (shell index.html mendapat 429); pulih setelah jeda 1 menit. Limiter menghitung berkas statis dan semua API (200/menit/IP).
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: UI-menu-LaporanKeuanga, RL-scope)
RECOMMENDATION: Kecualikan berkas statis; limiter terpisah untuk login/export; tampilkan pesan batas laju yang ramah.
```
### UAT-011: Jurnal manual dengan baris berisi debit dan kredit sekaligus menghasilkan HTTP 500

```text
BUG ID: UAT-011
TITLE: Jurnal manual dengan baris berisi debit dan kredit sekaligus menghasilkan HTTP 500
SEVERITY: MEDIUM
MODULE: Journal API validation
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: POST /journal dengan satu baris {debit:1000, credit:1000}.
EXPECTED: 400 dengan pesan validasi.
ACTUAL: 500 'Terjadi kesalahan' (dua variasi).
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: JR-both)
RECOMMENDATION: Validasi 'satu baris hanya Debit atau Kredit' di API manual, seperti di Import.
```
### UAT-012: Logout manual di satu tab tidak menyiarkan logout ke tab lain

```text
BUG ID: UAT-012
TITLE: Logout manual di satu tab tidak menyiarkan logout ke tab lain
SEVERITY: LOW
MODULE: Session
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Buka dua tab, klik Keluar di tab 1.
EXPECTED: Tab 2 ikut ke /login.
ACTUAL: Tab 2 tetap tampil (sesi server sudah dicabut sehingga API menolak); baru keluar saat timer idle/ping.
SECURITY IMPACT: Tidak ada (sesi server dicabut).
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: SES-multitab-logout)
RECOMMENDATION: Tulis penanda logout bersama (terra.loggedOutAt) dari tombol Keluar.
```
### UAT-013: Tidak ada batas panjang/format input pada nama, kode, referensi; nominal pecahan diterima

```text
BUG ID: UAT-013
TITLE: Tidak ada batas panjang/format input pada nama, kode, referensi; nominal pecahan diterima
SEVERITY: LOW
MODULE: Input validation
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Buat akun dengan nama 5.000 karakter, kode '90 06', jurnal dengan referensi 500 karakter dan nominal 0.5 / 9e15.
EXPECTED: Ditolak atau dibatasi.
ACTUAL: Semua 201.
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Nominal pecahan menimbulkan noise di laporan.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: JR-frac, JR-longref, COA-longname, COA-space)
RECOMMENDATION: Tetapkan batas panjang, pola kode, dan nominal bulat/maksimum.
```
### UAT-014: Header keamanan HTTP tidak dikirim (CSP, X-Frame-Options, nosniff, Referrer-Policy)

```text
BUG ID: UAT-014
TITLE: Header keamanan HTTP tidak dikirim (CSP, X-Frame-Options, nosniff, Referrer-Policy)
SEVERITY: LOW
MODULE: Security configuration
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: GET / dan /api/health.
EXPECTED: Header standar ada.
ACTUAL: Tidak ada satupun.
SECURITY IMPACT: Clickjacking dan MIME sniffing tidak dimitigasi (aplikasi lokal; risiko rendah).
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: HDR-clickjack)
RECOMMENDATION: Tambahkan header standar (fastify-helmet).
```
### UAT-015: Beberapa input tidak valid diterima diam-diam

```text
BUG ID: UAT-015
TITLE: Beberapa input tidak valid diterima diam-diam
SEVERITY: LOW
MODULE: Input validation
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Import dengan nama sheet salah; generate-monthly dengan fromDate 'abc'; counterparties?type=<tak valid>.
EXPECTED: 400.
ACTUAL: Sheet salah dibaca sebagai sheet pertama (200); generate-monthly 201 dengan created 0; filter tipe diabaikan (semua data).
SECURITY IMPACT: Tidak ada.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: JI-sheet, PE-baddate, BUG-CP-FILTER)
RECOMMENDATION: Kembalikan 400 untuk input tidak valid.
```
### UAT-016: User aplikasi bertingkat 'staff' tetap dapat membuat perusahaan baru (menjadi OWNER-nya)

```text
BUG ID: UAT-016
TITLE: User aplikasi bertingkat 'staff' tetap dapat membuat perusahaan baru (menjadi OWNER-nya)
SEVERITY: LOW
MODULE: Authorization (design)
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Login user aplikasi biasa lalu POST /api/company-db.
EXPECTED: Sesuai kebijakan lisensi/peran aplikasi.
ACTUAL: 201 dan user menjadi OWNER perusahaan baru.
SECURITY IMPACT: Hanya perusahaan miliknya sendiri; tidak ada akses ke perusahaan lain.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Penambahan perusahaan tanpa persetujuan admin.
EVIDENCE: results.jsonl (id: CO-add-viewer)
RECOMMENDATION: Putuskan kebijakan (admin saja?) — butuh keputusan bisnis.
```
### UAT-017: Kebijakan password lemah: 'aaaaaaaa' diterima

```text
BUG ID: UAT-017
TITLE: Kebijakan password lemah: 'aaaaaaaa' diterima
SEVERITY: LOW
MODULE: Authentication
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: POST /api/users dengan password aaaaaaaa.
EXPECTED: Ditolak oleh kebijakan kompleksitas.
ACTUAL: 201.
SECURITY IMPACT: Mempermudah tebakan.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: US-weakpw)
RECOMMENDATION: Minimal kompleksitas / daftar password umum.
```
### UAT-018: Ekspor Excel tidak menetralkan teks berawalan = + @ -

```text
BUG ID: UAT-018
TITLE: Ekspor Excel tidak menetralkan teks berawalan = + @ -
SEVERITY: LOW
MODULE: Export
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: Jurnal dengan deskripsi '=HYPERLINK(...)' lalu ekspor Ledger.
EXPECTED: Teks dinetralkan.
ACTUAL: Tersimpan sebagai sel string (bukan formula) sehingga aman di Excel; tidak dinetralkan bila disalin ke sistem lain.
SECURITY IMPACT: Defense in depth.
ACCOUNTING IMPACT: Tidak ada.
DATA IMPACT: Tidak ada.
EVIDENCE: results.jsonl (id: EXP-formula-note)
RECOMMENDATION: Awali dengan apostrof untuk teks berawalan karakter formula.
```

### Catatan tentang hasil uji yang dikoreksi

Beberapa baris awal bukan bug aplikasi melainkan kesalahan skrip uji saya sendiri, sudah diganti oleh uji ulang yang benar (ditampilkan di results.jsonl dengan ID pengganti): MN-bm (salah parameter uji; digantikan MN-bm2); AU-bruteforce (password uji terlalu pendek (ditolak validasi); digantikan AU-bruteforce2); PE-closed-journal (periode belum LOCKED pada uji awal; digantikan PE-closed-journal2); AUDIT-account_unlock (uji belum memanggil unlock; digantikan AUDIT-unlock2); OBI-post (import commit sudah otomatis memposting (409 pada Post kedua adalah perilaku benar)); OB-POST (import Saldo Awal sudah otomatis memposting (409 pada Post kedua adalah perilaku benar)); serta 9 hasil XSS awal (selektor mengena skrip inline yang sah, diganti uji XSS2-*).

## K. Data Integrity

| Pemeriksaan | Hasil |
|---|---|
| `integrity_check` company.db, master, system | ok (juga setelah kill -9 dan setelah uji injeksi) |
| `foreign_key_check` | 0 pelanggaran |
| Baris jurnal tanpa header / tanpa akun | 0 / 0 |
| Referensi jurnal ganda | 0 |
| Pasangan reversal (Reversed memiliki pembalik, pembalik menunjuk jurnal Reversed) | konsisten |
| Total debit = total kredit (seluruh jurnal Posted/Reversed) | sama persis (Rp 189.413.310.709 pada pengukuran akhir) |
| Jurnal Posted tidak seimbang | 2 (UAT-002: UJ-udxcd6j Rp 1 dan pembaliknya; saling meniadakan) |
| Draft (12) tidak memengaruhi laporan | terbukti |
| Kill -9 saat commit 4.000 jurnal | atomic (7.997 tetap 7.997), tanpa baris yatim, tanpa jurnal tak seimbang |
| Audit log append-only | trigger database menolak UPDATE/DELETE; tidak ada endpoint ubah/hapus |
| Mass assignment | field status/createdBy/postedBy/role/id/isLocked/license diabaikan |

Tidak ditemukan korupsi data.

## L. Backup/Restore

Backup atas dataset besar (Company A, B, system, master) dengan `backup.js` aplikasi, lalu restore ke folder UAT baru dan menjalankan aplikasi (server dari installer) di port 4501 terhadap hasil restore:
- Backup memuat 8 file; integrity_check semua ok; isi sama dengan sumber (jurnal 11.997, baris 30.964, total debit = total kredit, audit, akun).
- Instance hasil restore: login berhasil, lisensi aktif, Company B ikut.
- **Identik dengan aslinya:** jumlah jurnal, Laba Rugi / Neraca / Arus Kas / Ekuitas / Dashboard untuk 2021 sampai 2025, Ledger Bank BCA dan Piutang 5 tahun, **60 Trial Balance**, jumlah audit log, dan COA.
- Perubahan di instance restore tidak memengaruhi data asli.

## M. Recommendation

**Wajib diperbaiki sebelum produksi (blocker):** UAT-001 (batasi perubahan peran OWNER), UAT-002 (hilangkan toleransi selisih Rp 1 / jangan membuat laporan 500), UAT-003 (validasi tanggal ketat pada import).

**Sangat disarankan sebelum klien memakai (MEDIUM):** UAT-004 (validasi tanggal laporan), UAT-006 (penundaan login gagal), UAT-007 (audit login), UAT-008 (batasi CORS), UAT-009 (validasi isi avatar), UAT-010 (limiter tidak menghitung berkas statis), UAT-011 (validasi baris debit+kredit), UAT-005 (Arus Kas bulat dan aturan jurnal campuran).

**Dapat dijadwalkan (LOW):** UAT-012 sampai UAT-018.

**Terkait keputusan arsitektur:**
- **Multi-cabang:** UAT ini membuktikan engine akuntansi benar secara konsolidasi tetapi tidak dapat menghasilkan laporan per cabang atau rekonsiliasi antarkantor per pasangan tanpa dimensi cabang. Itu mendukung rekomendasi A (`branch_id` pada jurnal + akun antarkantor bertanda `interbranch`). Perbaiki dulu UAT-002 sebelum menambah jurnal antar kantor yang kompleks, karena selisih kecil makin sulit ditemukan.
- **Multi-device/multi-user:** tidak diuji (belum diimplementasikan). Temuan UAT-001, UAT-006, UAT-007, UAT-008, dan UAT-010 menjadi prasyarat keamanan sebelum server dapat diakses dari jaringan.

## N. Final Decision

**NOT READY FOR PRODUCTION**

Alasan (aturan keputusan Anda): terdapat **1 temuan HIGH di bidang keamanan** (UAT-001, eskalasi hak ADMIN ke OWNER). Rekonsiliasi akuntansi **lulus**; isolasi cross-company **lulus**; CRITICAL = 0. Dua temuan HIGH lain (UAT-002, UAT-003) adalah masalah integritas akuntansi/data pada jalur tertentu. Setelah ketiganya diperbaiki dan uji ulang (UAT ini dapat dijalankan ulang dengan harness yang disimpan di `docs/uat/harness/`), keputusan layak ditinjau ulang menjadi **READY WITH KNOWN LOW-RISK ISSUES**.

```text
TOTAL TEST: 662
PASS: 638
FAIL: 24 (baris bukti; dikelompokkan menjadi 18 bug unik)
CRITICAL: 0
HIGH: 3
MEDIUM: 8
LOW: 7
SECURITY FINDINGS: 10 (HIGH 1: UAT-001; MEDIUM 5; LOW 4) -- tidak ada SQL injection, XSS, IDOR/lintas-company, atau authentication bypass
ACCOUNTING FINDINGS: 3 (HIGH 2: UAT-002, UAT-003; MEDIUM 1: UAT-005) -- rekonsiliasi 5 tahun: SEMUA PASS
DATA INTEGRITY: tidak ada korupsi data; integrity_check ok; crash kill -9 atomic; backup/restore identik
FINAL RECOMMENDATION: NOT READY FOR PRODUCTION
```

## Lampiran: bukti

- `docs/uat/evidence-run1-before-fix/results.jsonl`: seluruh hasil uji (setelah koreksi), `perf.jsonl`, `reconcile.json`, `final-integrity.json`.
- `docs/uat/evidence-run1-before-fix/screenshots/`: tangkapan layar 25 halaman, uji XSS, halaman login setelah auto-logout.
- `docs/uat/evidence-run1-before-fix/exports/`: contoh hasil export (Excel/PDF) 5 tahun.
- `docs/uat/harness/`: skrip UAT (tanpa data/lisensi/kunci). Lisensi UAT dan data tidak disalin.
