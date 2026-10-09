# PHASE 5.0 — BASELINE & PERFORMANCE — LAPORAN

Tanggal: 2026-10-07 · Cakupan: **hanya 5.0** (baseline, profiling, `EXPLAIN`, golden master, anggaran kinerja, tes regresi). **5A tidak dimulai.** `multi_branch_enabled` OFF; Phase 6 tidak disentuh; baseline Phase 3 beku.

---

## 1. Ringkasan & keputusan

| Pertanyaan | Jawaban |
|---|---|
| Kode produk diubah? | **Tidak.** Tidak ada berkas produk yang berubah; verifikasi hash terhadap manifest baseline: **0 berubah, 0 hilang**. Yang ditambah: 4 berkas tes/snapshot + harness + dokumen |
| Index ditambahkan? | **Tidak ada.** Bukti: tidak satu pun kandidat indeks memberi manfaat yang sebanding dengan biayanya (bagian 8) |
| Migrasi baru? | **Tidak ada** |
| Bottleneck nyata? | **Ya, tetapi bukan indeks** — pola **N+1 per entri jurnal** pada Arus Kas, Dashboard, dan Proyeksi (bagian 5) |
| Angka kinerja di rencana Phase 5? | **Salah ukur — dikoreksi** (bagian 2). Besarnya jauh lebih kecil |
| Golden master | 120 permintaan HTTP + 6 dokumen ekspor per dataset, deterministik (2× rekam identik), **241/241 angka cocok dengan oracle independen** dari baris jurnal |
| Tes | **827 / 827** (814 lama + 13 baru), tsc lulus |
| **5A aman dimulai?** | **YA, dengan syarat** (bagian 14) |

---

## 2. Koreksi atas temuan saya sebelumnya (jujur)

Rencana Phase 5 menyebut **Arus Kas 3,3–6,4 dtk dan Dashboard 9,8–18,4 dtk**. Itu berasal dari **satu rangkaian pengukuran** yang dilakukan saat ada pekerjaan latar berat di mesin (pemindaian disk `find` yang masih berjalan). Pada 5.0 saya mengukur ulang dengan disiplin (pemanasan, 9 ulangan, min/median/p95, beban CPU dicatat) dan **mengulang skrip yang identik**:

| | Rencana (salah ukur) | Terkontrol (5.0) |
|---|---|---|
| Arus Kas | 3.308 – 6.395 ms | **≈ 874 ms** (p95 977) |
| Dashboard | 9.835 – 18.406 ms | **≈ 2.392 ms** (p95 2.648) |
| Neraca | 218 – 320 ms | ≈ 120 ms |

Bukti: skrip `perf` yang sama, dijalankan ulang tanpa beban latar, menghasilkan 2,3 dtk untuk Dashboard. Penyebab pastinya tidak dapat saya buktikan 100% (hanya bahwa beban latar hilang ⇒ angka normal). **Pelajaran yang diterapkan:** baseline resmi selalu memuat sebaran dan beban CPU; ambang anggaran memberi toleransi kebisingan ±10–20% (terukur dari pengulangan kode yang sama). Erratum sudah ditambahkan di dokumen rencana.

Kesimpulan arsitektur **tetap berlaku** (N+1 adalah bottleneck dan komparasi butuh agregasi set-based), tetapi tidak segawat yang saya tulis.

---

## 3. Perubahan yang dilakukan

| Jenis | Berkas | Keterangan |
|---|---|---|
| Harness (baru, `docs/uat/harness/phase5/`) | `build-datasets.mjs`, `profile.mjs`, `prototypes.mjs`, `http-baseline.mjs`, `check-budget.mjs`, `golden.mjs`, `oracle.mjs`, `README.md` | seluruhnya pada salinan scratch |
| Tes (baru, masuk suite) | `src/architecture/scope-readiness.test.ts` (8 tes) | registri klasifikasi 167 route + daftar berkas yang menyentuh tabel jurnal; **fail-closed**; terbukti oleh mutasi (route baru tak terklasifikasi ⇒ 3 tes gagal; berkas baru menyentuh `journal_entries` ⇒ gagal) |
| Tes (baru) | `src/db/company/reporting/reporting-golden.test.ts` (5 tes) + `__golden__/reporting-small.snapshot.json`, `reporting-small.querycounts.json` | dataset sintetis deterministik 3 cabang; sumber→angka vs oracle; hasil diharapkan per cakupan; snapshot hash; anggaran jumlah query |
| Evidence | `docs/uat/phase5/*.json` (baseline HTTP, profil, prototipe), `docs/uat/golden-master/phase5/*.json` (golden per dataset, expected-by-scope) | |
| Dokumen | erratum di rencana Phase 5; log baseline §8; laporan ini | |
| **Kode produk / skema / migrasi** | **tidak ada** | |

---

## 4. Metodologi & dataset

Semua dari **salinan scratch** backup UAT 5 tahun (`pt-terra-nusantara`; bukan produksi, bukan port 4000), dimigrasi ke skema terkini.

| Dataset | Jurnal | Baris | Akun | Cabang | Catatan |
|---|---|---|---|---|---|
| `small` | 400 | 1.127 | 66 | 1 | 400 jurnal paling awal (himpunan jurnal seimbang konsisten) |
| `uat-1` | 12.003 | 30.976 | 66 | 1 | **= perusahaan single-branch hari ini** (acuan flag OFF) |
| `uat-3` | 12.003 | 30.976 | 66 | 3 | jurnal utuh disebar (Pusat ±50%) |
| `uat-7` | 12.003 | 30.976 | 66 | 7 | jurnal utuh disebar (Pusat ±25%) |

Semua dataset: `integrity_check` ok, `foreign_key_check` 0. Penyebaran memindahkan **jurnal utuh** (tiap jurnal tetap seimbang); trigger `branch_locked_after_post` dilepas hanya pada salinan scratch lalu dipasang kembali persis seperti aslinya. Dua mode ukur: **cold** (koneksi baru per panggilan = perilaku route produksi) dan **warm**. SQLite 3.49.2 (better-sqlite3 11.10), Node 22.

---

## 5. Baseline & profiling layanan saat ini (cold, median 3×; query dihitung lewat event knex)

| Layanan | small | uat-1 (12k jurnal) | uat-3 | uat-7 | Query (uat-1) |
|---|---|---|---|---|---|
| Neraca | 37 ms | 76 ms | 72 ms | 78 ms | 154 |
| Laba Rugi | 8 ms | 44 ms | 29 ms | 43 ms | 25 |
| Ekuitas | 16 ms | 85 ms | 58 ms | 51 ms | 54 |
| **Arus Kas** | 92 ms | **956 ms** | 855 ms | 851 ms | **6.059** |
| Neraca Saldo | 50 ms | 77 ms | 95 ms | 80 ms | 223 |
| Buku Besar (akun tersibuk) | 3 ms | 24 ms | 29 ms | 30 ms | 6 |
| **Dashboard** | 284 ms | **2.436 ms** | 2.339 ms | 2.386 ms | **13.381** |
| Saldo counterparty | 2 ms | 36 ms | 28 ms | 28 ms | 4 |
| Analisis rasio | 41 ms | 100 ms | 90 ms | 95 ms | 179 |
| **Proyeksi** | 220 ms | **1.399 ms** | 1.332 ms | 1.227 ms | **6.224** |

Pengamatan: (1) waktu **tidak bergantung pada jumlah cabang** (kode sekarang tidak mengenal cabang), sehingga angka 1/3/7 cabang adalah *kontrol*; (2) cold ≈ warm — cache SQLite bukan faktor; (3) waktu non-SQL (JS) kecil (≈ 10–25%).

Baseline HTTP end-to-end (server hasil build, 9 ulangan, setelah pemanasan; ms: min / median / p95), `uat-1`: Neraca 105/120/134 · Laba Rugi 46/60/74 · Ekuitas 72/86/104 · **Arus Kas 820/874/977** · Neraca Saldo 83/101/135 · Buku Besar 38/51/62 · **Dashboard 2.128/2.392/2.648** · Counterparty 31/40/53 · Pencarian 47/59/146 · Analisis 102/122/178 · **Proyeksi 1.274/1.384/1.577** · Pajak 39/51/64 · Daftar jurnal 14/20/30 · overhead dasar (`branch-context`) 8/13/35. Lengkap untuk `small`, `uat-1`, `uat-7` di `docs/uat/phase5/http-baseline.json`. Kebisingan antar-ulang kode yang sama: ±10–20%.

---

## 6. Analisis bottleneck (terbukti, bukan perkiraan)

Bentuk query teratas (uat-1, cold):

| Target | Bentuk query dominan | Jumlah | Waktu | Porsi |
|---|---|---|---|---|
| Arus Kas | `SELECT … FROM journal_entry_lines JOIN accounts WHERE journal_entry_id = ?` (baris tiap entri bergerak kas) | **6.015×** | 632 ms | ±66% |
| Dashboard | bentuk yang sama (Arus Kas dipanggil berulang untuk tren/KPI) | **12.489×** | 1.310 ms | ±54% |
| Dashboard | `SUM(debit/credit)` per akun (saldo/gerakan) | 405× | 420 ms | ±17% |
| Proyeksi | gabungan keduanya | 6.224 query | ±1.1 dtk SQL | — |
| Neraca / Neraca Saldo | `SUM` per akun + 2 baca akun/tipe per akun | 43–66× | 47–66 ms | seluruh waktu |

Prototipe (tanpa mengubah kode): mengambil baris Arus Kas **per 500 entri dalam satu kueri** menurunkan 6.015 query dari **≈ 400 ms menjadi ≈ 28–31 ms** (13×), pada skema dan indeks yang sama. Jadi bottleneck adalah **pola akses (N+1)**, bukan indeks — penanganannya adalah perubahan kode (5B) yang dijaga golden master, bukan migrasi.

---

## 7. `EXPLAIN QUERY PLAN` (bentuk query SAAT INI, skema terkini)

| Query | Rencana |
|---|---|
| Saldo/gerakan per akun (`SUM … jel JOIN je WHERE account_id=? AND status IN … AND entry_date …`) | `SEARCH jel USING INDEX journal_entry_lines_account_id_index (account_id=?)` → `SEARCH je USING INDEX sqlite_autoindex_journal_entries_1 (id=?)` — **SEARCH berindeks, tanpa SCAN** |
| Baris per entri kas | `SEARCH jel USING INDEX journal_entry_lines_journal_entry_id_index (journal_entry_id=?)` → `SEARCH a USING INDEX sqlite_autoindex_accounts_1` |
| Hitung draft | `SEARCH journal_entries USING COVERING INDEX journal_entries_status_index (status=?)` |
| Baca akun / tipe akun | `SEARCH … USING INDEX sqlite_autoindex_*` (PK) |
| Set-based tanpa cakupan (prototipe) | `SCAN jel USING INDEX journal_entry_lines_account_id_index` + `BLOOM FILTER ON je` + `SEARCH je … (id=?)` + `TEMP B-TREE FOR GROUP BY` |
| **Set-based dengan cakupan 1 cabang (prototipe)** | **`SEARCH je USING INDEX idx_journal_entries_branch_date (branch_id=? AND entry_date<?)`** → `SEARCH jel USING INDEX …journal_entry_id_index` → `TEMP B-TREE FOR GROUP BY` |

Temuan penting: **indeks `idx_journal_entries_branch_date` (Phase 2) sudah dipakai** oleh bentuk set-based bercakupan. Satu-satunya `SCAN` adalah pembacaan `account_types` (tabel ±11 baris) — tidak relevan. "Baris yang dipindai" tidak tersedia sebagai metrik langsung dari better-sqlite3 (tidak ada `stmt_scanstatus`); sebagai gantinya saya melaporkan jenis rencana (SEARCH/SCAN), indeks yang dipakai, jumlah baris yang dikembalikan per bentuk (di `profile-current-all-datasets.json`), dan waktu eksekusi.

---

## 7a. Query sebelum / sesudah (kandidat 5A/5B — diukur, belum diterapkan)

Neraca penuh (66 akun), `uat-7`, median 7 ulangan, SQL murni:

| Bentuk | Waktu | Catatan |
|---|---|---|
| A. N+1 per akun, tanpa cakupan (**sekarang**) | 37 ms | |
| B. N+1 per akun + `AND je.branch_id IN (…)` (perubahan minimal 5A), 1 dari 7 cabang | 47 ms | rencana tetap `account_id` index; filter cabang hanya menyaring |
| C. Set-based `GROUP BY akun`, tanpa cakupan | 34 ms | |
| **C. Set-based, 1 dari 7 cabang** | **9 ms** | memakai `idx_journal_entries_branch_date` |
| C. Set-based, 3 dari 7 cabang | 12 ms | |
| C. Set-based, 7 dari 7 cabang | 42 ms | |
| **D. Set-based `GROUP BY akun, cabang`, semua cabang (bentuk komparasi 5B)** | **53 ms** (satu query) | vs. 8 × N+1 ≈ 300+ ms |
| Arus Kas: baris per entri, N+1 (6.015 query) → per 500 entri | 390–409 ms → 28–31 ms | |

Artinya: komparasi 7 cabang + Gabungan untuk Neraca/Laba Rugi/Ekuitas/Neraca Saldo cukup ±50–100 ms dengan satu query agregat; hanya Arus Kas/Dashboard/Proyeksi yang memerlukan perbaikan N+1.

---

## 8. Keputusan indeks (tidak ada)

Kandidat diuji pada salinan `uat-1/3/7` (ANALYZE dijalankan), 7 ulangan:

| Kandidat | Ukuran tambah | Manfaat terukur | Keputusan |
|---|---|---|---|
| I1 `journal_entries(branch_id, status, entry_date)` | +0,66–0,83 MB | bentuk C 1-cabang 9 → 6 ms (≈3 ms) — **tidak material** | tidak |
| I2 `journal_entries(status, entry_date)` | +0,21–0,37 MB | tidak ada / dalam kebisingan | tidak |
| I3 `journal_entry_lines(account_id, journal_entry_id, debit, credit)` (covering) | **+2,6–2,8 MB (±10% ukuran DB)** | 37 → 33 ms (N+1), 34 → 22 ms (set-based); ≈ 10 ms per laporan | tidak |
| I4 = I1 + I3 | +3,4–3,5 MB | tidak lebih baik dari I3 | tidak |

Biaya tulis (3.000 jurnal × 3 baris, satu transaksi): 258 / 254 / 249 / 208 / 253 ms — **dalam kebisingan**, jadi tidak ada indikasi penalti tulis, tetapi **manfaat baca pun tidak cukup untuk dibenarkan**. Prinsip Anda ("jangan menambah indeks untuk berjaga-jaga") dipenuhi: **tidak ada migrasi indeks**. Jika setelah optimasi N+1 di 5B profiling menunjukkan kebutuhan baru, keputusan diulang dengan bukti.

**Konfigurasi koneksi (PRAGMA)** juga dievaluasi pada `uat-1`: `cache_size=64MB` dan `mmap_size=256MB` memberi selisih ≤ 10–15% dan tidak konsisten (mis. Dashboard 2.437 → 2.417/2.198 ms; Arus Kas 1.220 → 828/857 ms mencerminkan kebisingan pemanasan). **Tidak diubah.**

---

## 9. Golden master

**Dua lapis:**

1. **HTTP pada server hasil build** (`golden.mjs`): 120 permintaan (Neraca ×7 rentang, Laba Rugi ×7, Ekuitas ×6, Arus Kas ×6, Dashboard ×6, **Neraca Saldo semua periode berjurnal (≈ 70)**, Buku Besar 5 akun teratas × 2 rentang, saldo counterparty, analisis, proyeksi, pajak, pencarian ×3, daftar jurnal) + 6 dokumen ekspor (Neraca, Laba Rugi, Ekuitas, Arus Kas, Neraca Saldo, Buku Besar). Dua kali rekam menghasilkan hash **identik** pada semua dataset. Disimpan: status, ukuran, SHA-256 kanonik, ringkasan total.
2. **Sumber transaksi → angka (oracle independen, `oracle.mjs`)**: menghitung langsung dari `journal_entry_lines` + `journal_entries` dengan SQL biasa (tanpa memanggil layanan laporan). `uat-1`: **241 / 241 perbandingan sama persis** (total dan per-akun Neraca untuk 7 tanggal; Laba Rugi; Arus Kas kas awal/akhir/perubahan dan Σ aktivitas + tak-terklasifikasi = perubahan kas; Neraca Saldo semua periode; Buku Besar saldo awal/akhir/jumlah baris; saldo setiap counterparty). `small`: 55/55. Oracle juga mencatat **sidik jari baris sumber** (jumlah jurnal/baris dan SHA-256 baris pembentuk tiap angka) yang disimpan pada `expected-by-scope` agar 5A dapat membuktikan *jurnal mana* yang membentuk angka bercakupan.

**Kesetaraan lintas dataset** (bukti kode saat ini tidak bergantung cabang): laporan perusahaan-penuh `uat-3` **125/125 identik** dengan golden `uat-1`; `uat-7` 119/125 — enam yang berbeda adalah `dashboard:*` (lihat temuan G-2).

**Hasil yang diharapkan per cakupan** (`expected-by-scope.uat-3|uat-7.json`; 16 dan 20 invarian, semua lulus): angka tiap cabang (Neraca, Laba Rugi, Neraca Saldo, kas, Buku Besar akun teratas), subset terpilih, semua-cabang, dan perusahaan; **Σ cabang = perusahaan** (aset, kewajiban, ekuitas+RE-BRIDGE, laba, perubahan kas, saldo buku besar, jumlah jurnal); **neraca setiap cabang seimbang**; gabungan semua cabang = perusahaan.

**Golden dalam suite** (`reporting-golden.test.ts`, dataset sintetis 100+ jurnal, 3 cabang, REVERSED, kontra-akun, kas/hutang/piutang): sumber→angka vs oracle, Σ cabang = perusahaan (termasuk saldo bertanda Neraca Saldo per akun per periode), snapshot hash 20+ keluaran laporan, anggaran jumlah query. Mutasi (kontra-akun tidak dibalik) terdeteksi 2 tes.

### Temuan dari golden master (penting untuk 5A/5B)
- **G-1 (aturan rekonsiliasi Neraca Saldo).** Kolom debit/kredit Neraca Saldo per cabang **tidak boleh dijumlahkan kolom-demi-kolom**: kolom ditentukan oleh saldo bersih tiap akun, sehingga Σ kolom-debit cabang ≠ kolom-debit perusahaan walau datanya sama. Yang berlaku: **Σ saldo bertanda (debit − kredit) per akun**. Ini menjadi aturan "Σ cabang = Gabungan" untuk komparasi 5B (diverifikasi pada kedua dataset).
- **G-2 (alert Dashboard bergantung cabang).** Pada `uat-7`, Dashboard menampilkan peringatan tambahan karena `getOpeningBalance(db)` default **Kantor Pusat**: saat jurnal saldo awal berada di cabang lain, peringatan "saldo awal belum ada" salah/menyesatkan. 5A wajib mencakupkan peringatan ini ke cakupan (sudah ada di rencana Q11; kini terbukti).
- **G-3.** `GET /journal-import/history` (kelas `REVIEW_5A`) memuat riwayat batch impor seluruh perusahaan dan belum jelas dimiliki cabang mana; perlu keputusan sebelum LIMITED dibuka ke sana (saat ini ditolak).

---

## 10. Anggaran kinerja (berlaku sebagai gerbang)

`check-budget.mjs` membandingkan pengukuran baru dengan baseline HTTP (`docs/uat/phase5/http-baseline.json`).

**Gerbang 5A — tanpa regresi** (untuk setiap endpoint/dataset): median ≤ max(1,20 × baseline, baseline + 25 ms) dan p95 ≤ max(1,30 × baseline, baseline + 50 ms); status 200; endpoint yang hilang = gagal. Validasi anggaran: dijalankan pada kode yang **sama** dua kali ⇒ 42/42 dalam anggaran (ambang awal 15% menghasilkan 1 positif palsu pada kebisingan nyata, sehingga dilonggarkan).
Tambahan 5A: **jumlah query tidak boleh naik** (dikunci oleh `reporting-small.querycounts.json`); satu cabang (1 dari 7) tidak boleh lebih lambat dari laporan perusahaan-penuh.

**Target 5B** (diukur pada `uat-7`, HTTP, median): Neraca/Laba Rugi/Ekuitas/Neraca Saldo komparasi 7 cabang + Gabungan ≤ 1.000 ms; Arus Kas satu cakupan ≤ baseline (target ≤ 500 ms setelah batching) dan komparasi ≤ 1.500 ms; Dashboard satu cakupan ≤ baseline (target ≤ 1.500 ms); Dashboard/Proyeksi komparasi **dibuka hanya setelah** target satu-cakupan tercapai; jumlah query komparasi tidak bergantung pada banyaknya cabang (≤ 1,5 × satu-cabang + 10).

---

## 11. Hasil tes

| Pemeriksaan | Hasil |
|---|---|
| Tes backend | **827 / 827** (814 lama + 8 arsitektur + 5 golden/kinerja) |
| `tsc --noEmit` API | lulus |
| Mutasi tes baru | route baru tak terklasifikasi → 3 tes gagal; berkas baru menyentuh tabel jurnal → gagal; kontra-akun tak dibalik → 2 tes golden gagal (semua dikembalikan) |
| Guard company-scoped | **semua route ber-`:companySlug` (termasuk legacy `/api/c/…`) melewati `requireAuth` + `requireCompanyAccess`** (terverifikasi otomatis) |
| Integritas baseline | hash terhadap manifest: 0 berkas berubah |
| Golden master HTTP | `uat-1` 120 permintaan + 6 ekspor, determinisme OK, oracle 241/241 |
| Build/installer | tidak dibangun ulang — **tidak ada kode produk yang berubah** |

(Satu kendala yang ditemukan dan diperbaiki saat membuat tes: tes arsitektur mengimpor seluruh modul route dan melewati batas waktu 5 dtk saat suite berjalan paralel; kini hasilnya di-memoize dan batas waktunya 120 dtk.)

---

## 12. Risiko yang masih terbuka

| # | Risiko | Mitigasi / status |
|---|---|---|
| R1 | Refactor N+1 (5B) dapat mengubah angka | golden master HTTP + oracle + snapshot suite; SQL jalur tanpa cakupan dipertahankan identik di 5A |
| R2 | Kebisingan pengukuran (±10–20%) bisa memicu positif palsu / menyembunyikan regresi kecil | ambang dengan lantai absolut; 9 ulangan; catat beban CPU; jalankan di mesin tenang |
| R3 | Metrik "baris dipindai" tidak tersedia | diganti rencana EXPLAIN + jumlah baris dikembalikan + waktu; cukup untuk keputusan indeks |
| R4 | Dataset cabang disintesis dengan menyebar jurnal acak (bukan pola bisnis nyata) | cukup untuk kinerja & keseimbangan; UAT U10 dengan data klien nyata tetap diperlukan sebelum aktivasi |
| R5 | Dashboard (2,4 dtk) dan Proyeksi (1,4 dtk) sudah lambat untuk UI interaktif | diperbaiki di 5B (batching); tidak diperburuk 5A (gerbang anggaran) |
| R6 | G-2/G-3 (alert saldo awal, riwayat impor) | keputusan ditetapkan di 5A (lihat bagian 14) |
| R7 | Rute legacy master-DB `/api/c/…` (44 route, kelas `LEGACY_MASTER`) tetap dapat dibaca akun ALL | di luar Phase 5; tercatat di backlog kunci/putus |
| R8 | Backlog hardening H-1/H-2/H-3 tetap terbuka | tidak dihapus; H-3 (uji UI Electron) disarankan sebelum 5B |

---

## 13. Verifikasi syarat penutupan bypass untuk 5A (yang kini sudah berupa tes)

1. **Registri klasifikasi route**: 167 route; 43 sadar-cabang, 13 `READ_FINANCIAL_PENDING_5A` (pekerjaan 5A), 1 `REVIEW_5A`, 1 `ADMIN_ALL_BY_DESIGN`, 18 `COMPANY_LEVEL`, 15 `PHASE1_3_ADMIN_ALL`, 44 `LEGACY_MASTER`, 2 registri perusahaan, 30 non-perusahaan. Route baru tanpa klasifikasi ⇒ tes gagal; entri yang tumpang tindih dengan `BRANCH_AWARE_ROUTES` ⇒ gagal (memaksa keputusan sadar saat 5A membuat route sadar-cakupan).
2. **Daftar berkas yang menyentuh tabel jurnal**: 25 berkas, 7 di antaranya `READ_FINANCIAL_5A` (terkunci). Berkas baru ⇒ gagal sampai diklasifikasikan.
3. Kunci 13 route 5A saat ini **masih deny-by-default untuk LIMITED** (titik awal).

---

## 14. Keputusan: apakah 5A aman dimulai?

**YA — aman dimulai, dengan syarat berikut** (tidak ada yang menghalangi; semuanya masuk gerbang 5A):

1. **Jalur tanpa cakupan harus menghasilkan SQL identik** dan lolos `golden.mjs verify uat-1`, golden suite, dan `check-budget.mjs`.
2. **Tetapkan perilaku peringatan Dashboard (G-2)** dalam 5A: peringatan saldo awal dievaluasi per cakupan (bukan default Kantor Pusat). *Tidak mengubah desain; menunggu konfirmasi Anda bila ingin cara lain.*
3. **`GET journal-import/history` (G-3)** tetap `REVIEW_5A` dan **tetap ditolak untuk LIMITED** sampai Anda memutuskan kepemilikannya. *(Rekomendasi: tetap ALL-scope saja.)*
4. **Aturan rekonsiliasi komparasi 5B**: Σ saldo bertanda per akun (G-1) — saya sertakan sebagai aturan desain; tidak mengubah keputusan yang disetujui.
5. Perubahan baseline Phase 3 yang sudah disetujui (BC-1 `sessionStorage`, BC-2 daftar sadar-cabang) dicatat di log baseline saat dikerjakan.

Tidak ada keputusan D3/D4/D6/D8/D9/D10 yang menghasilkan konsekuensi berbeda dari rekomendasi tertulis; **tidak ada yang perlu Anda putuskan ulang** untuk memulai 5A selain butir 2–3 bila Anda ingin menyimpang dari rekomendasi.

**Berhenti di sini.** 5A tidak dimulai; `multi_branch_enabled` OFF; Phase 6 tidak disentuh; baseline Phase 3 beku.
