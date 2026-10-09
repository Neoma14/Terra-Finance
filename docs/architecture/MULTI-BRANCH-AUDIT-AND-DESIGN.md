# MULTI-BRANCH & REPORTING ARCHITECTURE AUDIT — TERRA FINANCE

Status: **AUDIT + DESAIN SAJA (Revisi 5 (Z.0–Z.16) + Revisi 6 (sanity check, C1–C8, di akhir) adalah acuan tunggal; Revisi 6 menang bila berbeda dan menggantikan bagian lain bila bertentangan). Tidak ada source code, migration, schema, UI, atau report engine yang diubah.**
Tanggal: 2026-10-06. Menggantikan/melengkapi `MULTI-BRANCH-ARCHITECTURE-REPORT.md` (2026-10-05) yang masih berupa perbandingan opsi.
Referensi bisnis: `contoh laporan LR dan Neraca sbn to ABD.xlsx` (sheet *Laba Rugi Gab*, *NERACA GAB*).

---

## A. EXECUTIVE SUMMARY

**Opsi A (satu perusahaan, satu company.db, satu COA, banyak cabang via `branch_id`) cocok untuk TERRA.** Contoh Excel mengonfirmasinya: satu badan hukum (PT. Sinar Bumi Nabung), satu struktur akun yang sama untuk Kantor Pusat dan 6 SPBU, laporan "Gabungan", dan akun perantara antar-SPBU yang dieliminasi saat digabung.

Tiga hal penting hasil audit:

1. **Titik penerapan filter cabang sempit dan sudah jelas.** Seluruh laporan (Neraca, Laba Rugi, Arus Kas, Ekuitas, Trial Balance, Ledger, Dashboard, Rasio, Proyeksi, Pajak) berakhir pada query `journal_entry_lines JOIN journal_entries` di **3 fungsi dasar** + 2 query langsung. Cukup menambah `branch_id` di `journal_entries` dan parameter `scope` pada titik-titik itu — **tidak perlu report engine baru**.
2. **Syarat agar Neraca per cabang bisa seimbang:** jurnal harus **milik tepat satu cabang dan seimbang di dalam cabang itu**. Karena itu `branch_id` diletakkan di **header jurnal**, dan transaksi antar-cabang dimodelkan sebagai **dua jurnal berpasangan** (satu per cabang) yang saling menyeimbangkan lewat akun antar-cabang.
3. **Ada gap klasifikasi akun yang nyata.** Engine sekarang hanya mengenal 9 tipe akun; Excel butuh pengelompokan lebih halus (Aktiva Lancar vs Tetap, Pendapatan Operasional vs Non-Operasional, rincian biaya, Laba Tahun Lalu vs Berjalan, Taksiran Pajak). Tabel `statement_lines` + `statement_line_accounts` **sudah ada di company.db tetapi tidak dipakai oleh engine laporan** — kandidat tepat untuk lapisan "Report Group" tanpa membuat tabel baru.

**Keputusan akhir: lihat bagian L — READY FOR IMPLEMENTATION secara arsitektur (bersyarat: 6 keputusan bisnis di bagian K.2 harus dijawab saat Phase 1, bukan blocker desain).**

---

## B. EXCEL REPORT ANALYSIS

File ini **template kosong** (semua angka 0/kosong; tidak ada daftar akun/saldo riil), jadi dipakai sebagai referensi *struktur* dan *aturan hitung*, bukan data uji. Data riil/COA klien tetap diperlukan untuk pemetaan.

### B.1 Laba Rugi Gab ("KOMPARASI LABA RUGI – GABUNGAN SPBU", 31 Des 2023)
| Temuan | Detail | Implikasi untuk TERRA |
|---|---|---|
| Kolom per cabang + Gabungan + Growth | `KANTOR PUSAT`, 6 kode SPBU (24.341.04, 24.341.05, 23.343.08, 23.353.17, 23.343.22, …), `GABUNGAN`, `Growth %` | Mode *Branch Comparison*; kolom cabang **dinamis** dari tabel `branches`, bukan hardcode |
| Hierarki | Pendapatan Operasional → HPP → **Laba/Rugi Bruto** → Biaya Operasional → **Laba/Rugi Bruto Operasional** → Pendapatan Non-Operasional → Biaya Non-Operasional (termasuk "HPP Non BBM") → **Laba/Rugi Bruto Non Operasional** → **Laba/Rugi Bruto Usaha** → Taksiran Pajak Penghasilan → **Laba/Rugi Netto Usaha** | Perlu *Report Group* + subtotal deklaratif; sekarang tidak ada pemisahan operasional/non-operasional di dalam HPP/Biaya, dan **pajak tidak masuk laporan** |
| Rincian per jenis produk | Premium, Solar, Pertamax, Pertalite, Dexlite, P.Dex, PX Turbo | Itu *akun COA klien*, bukan fitur aplikasi. Tidak boleh di-hardcode |
| Kolom Gabungan `J` | `=SUM(C:I)` pada baris detail, **tetapi** baris subtotal J29, J41, J52, J54 memakai rumus lain (`SUM(J22:J28)`, `SUM(J34:J40)`, …) yang **tidak sama** dengan kolom cabang (`C17-C27`, …) | **Bukti bahwa "gabungan" tidak boleh disalin gaya Excel.** Gabungan harus dihitung engine dengan rumus yang sama dengan kolom cabang, plus *reconciliation check* (Σ cabang = Gabungan) |
| Growth % | `=((J10-#REF!)/#REF!)*100` — **semua `#REF!`** (pembanding tak pernah terhubung) | Growth butuh periode pembanding eksplisit; pembagi nol/hilang harus ditangani (bagian F.5) |
| Header cacat | Kolom H tanpa kode SPBU, I7 berisi angka acak `24341128`, J6 mengacu workbook eksternal `[1]NERACA GAB` | Cabang harus berasal dari master data (kode+nama), bukan teks bebas |

### B.2 NERACA GAB ("KOMPARASI NERACA – GABUNGAN SPBU")
| Temuan | Detail | Implikasi |
|---|---|---|
| Dua periode + Mutasi + Growth | `C`=31-12-2023, `D`=31-12-2022, `E = C−D`, `F = (C−D)/D×100` | Neraca perlu *Current / Previous / Mutation / Growth*; default pembanding = tanggal yang sama tahun lalu |
| Growth gagal | `#DIV/0!` di hampir semua baris (pembagi 0) | Aturan pembagi nol wajib (F.5) |
| **Eliminasi antar-cabang di rumus** | Total Aktiva Lancar `=SUM(C9:C19) − C15` dengan baris 15 = **"PERANTARA AKTIVA ANTAR SPBU"**; Total Kewajiban `=SUM(C35:C40) − C39` dengan baris 39 = **"RUPA-RUPA PASIVA"** | Excel **mengurangkan kedua sisi** (piutang antar-SPBU di aktiva dan pasangannya di pasiva) pada total gabungan → ini persis *elimination*. Baris 15 = *inter-branch receivable*; baris 39 = pasangan *inter-branch payable* (diidentifikasi dari rumus, bukan dari namanya — nama "Rupa-rupa Pasiva" generik) |
| Ekuitas | Modal Saham Disetor, Cadangan, Laba Ditahan, **Laba Tahun Lalu**, **Laba Tahun Berjalan**; satu baris aneh "Kewajiban Jangka Panjang (Modal Awal)" di sisi kewajiban | Ekuitas satu level perusahaan (sesuai keputusan #13). Perlu **pemisahan laba tahun lalu vs tahun berjalan** — sekarang TERRA hanya punya satu baris jembatan `RE-BRIDGE` |
| Kontra-akun | "Akumulasi Peny. Aktiva & Inventaris" di sisi aktiva | Sudah didukung (`toCanonicalSign`) |
| Neraca hanya kolom GABUNGAN | Tidak ada kolom per-SPBU di sheet ini | Neraca per cabang & komparasi adalah **perluasan** dari contoh (diminta di spesifikasi) |

---

## C. EXISTING TERRA AUDIT

| Area | Existing | Gap | Risiko | Rekomendasi |
|---|---|---|---|---|
| Isolasi data | 1 perusahaan = 1 file `companies/<slug>/company.db`; tanpa `company_id` di dalam DB | Tidak ada konsep cabang | Rendah | Tambah tabel `branches` di company.db (otomatis ikut backup & isolasi perusahaan) |
| Journal header (`journal_entries`) | `entry_date, period_id, reference_no (UNIQUE), status, is_opening_balance, source CHECK('manual','import'), reversal_of_journal_id` | Tanpa `branch_id`. `reference_no` UNIQUE global; `source` CHECK tidak bisa diubah di SQLite tanpa rebuild tabel | Sedang | `ALTER TABLE ADD COLUMN branch_id` (nullable+FK) → backfill Kantor Pusat → trigger NOT NULL. Jangan ubah CHECK `source`; tautkan lewat `inter_branch_transactions` |
| Journal line | `account_id, debit, credit, counterparty_id`; CHECK satu sisi | Tanpa dimensi cabang (tidak perlu jika di header) | Rendah | Tetap tanpa kolom cabang di line; join `je.branch_id` |
| Journal engine | `createDraftJournalEntry`, `postJournalEntry`, `reverseJournalEntry`, `deleteDraft…`; satu transaksi knex + audit atomik | Tidak ada validasi cabang/scope | Sedang | Tambah `branchId` pada input; reversal **mewarisi** cabang asli; validasi cabang aktif & dalam scope |
| Ledger | `getAccountBalanceBeforeDate`, `getAccountLedgerByRange` (query langsung) | Tanpa filter cabang | Sedang | Tambah `scope` opsional (undefined = perilaku lama) |
| Trial Balance | Query movement per periode + loop akun (N+1) | Tanpa filter cabang | Sedang | `scope` + eliminasi opsional |
| Balance Sheet | `getBalanceSheet` **melempar `BalanceSheetNotBalancedError` (HTTP 500)** bila tidak seimbang | Neraca satu cabang bisa tak seimbang jika invariant "jurnal seimbang per cabang" dilanggar | **TINGGI** | Pastikan invariant ditegakkan di engine jurnal; error tetap fail-safe; tambahkan pesan kontekstual cabang |
| Income Statement | 5 section per tipe akun; **TAX tidak ikut**; tanpa subtotal operasional/non-operasional | Gap klasifikasi (bagian B) | Sedang | Report Group via `statement_lines` |
| Cash Flow | Berbasis jurnal: cari entry yang menyentuh akun kas, alokasi pro-rata ke lawan akun (BigInt, UAT-005) | Transfer kas antar-cabang | Sedang | Tetap benar per cabang jika akun antar-cabang diberi `cash_flow_activity` (financing/operating) — putuskan di Phase 5 |
| Equity Statement | Equity pembuka + mutasi + laba | Tanpa cabang | Rendah | `scope` |
| Dashboard/KPI | Memakai `getBalanceSheet/getIncomeStatement/getCashFlowStatement` (tidak ada engine kedua) | Tanpa filter cabang | Rendah | Cukup teruskan `scope` — **tidak perlu engine baru** |
| Rasio / Proyeksi / Pajak | Memakai service laporan di atas | Sama | Rendah | Ikut otomatis |
| Counterparty (hutang/piutang) | Saldo dihitung langsung dari journal lines | Tanpa cabang | Sedang | `scope` pada query saldo |
| Pencarian global | Query langsung `journal_entries`/lines (`company-search`) | **Bocor lintas cabang** jika tidak difilter | **TINGGI** | Filter scope wajib |
| Audit log perusahaan | `company_audit_log`, ditulis dalam transaksi yang sama | Tidak ada `branch_id`; bisa membocorkan isi jurnal cabang lain | Sedang | Tambah `branch_id` nullable; user LIMITED hanya lihat cabangnya |
| Authorization | `company_access(system_user_id, company_id, role, status)` di system DB; `requireAuth → requireCompanyAccess → requirePermission`; 15 permission, 5 peran. **Tidak ada scope cabang.** Ada ±51 route `/api/company-db/:companySlug/*` | Tidak ada scope baris | **TINGGI** (IDOR lintas cabang) | `branch_scope` + daftar cabang; resolver tunggal di `requireCompanyAccess`; **fail-closed** |
| Import jurnal | Kolom: `Kode Akun, Tgl, No Jurnal, Akun Buku Besar, Keterangan, Debet, Kredit`; pengelompokan per No Jurnal/tanggal; deteksi duplikat berbasis (tanggal + baris) | Tanpa kolom Cabang; sidik jari duplikat harus memuat cabang; 1 transaksi bisa mencampur cabang | Sedang | Lihat bagian H.4 |
| Import COA | `Kode, Nama, Tipe, …` | COA satu bersama → **tidak perlu cabang** | Rendah | Tambah kolom opsional penanda akun antar-cabang |
| Opening balance | **Hanya SATU opening balance per perusahaan** (service menolak yang kedua) | Butuh satu per cabang | **TINGGI** (perilaku existing berubah) | Aturan: satu per (perusahaan, cabang); data lama = Kantor Pusat |
| Period / closing | `periods.status OPEN/LOCKED/CLOSED`, level perusahaan | — | Rendah | **Tidak diubah** (sesuai keputusan #14) |
| Backup/restore | Menyalin company.db utuh | Aman; mapping hak akses ada di system DB | Sedang | Restore hanya untuk scope ALL |
| Legacy `modules/journal, ledger, accounts, statements` | Rute master-DB lama masih terdaftar | Tidak boleh jadi jalan belakang | Sedang | Konfirmasi tidak dipakai UI; tidak disentuh |
| Tes | 619 tes backend lulus | — | — | Semua harus tetap lulus (scope undefined = perilaku lama) |

### C.1 Dependency map (journal → report → dashboard)
```
journal_entries(+branch_id) ─┐
journal_entry_lines ─────────┤  ← SATU-SATUNYA sumber angka (status POSTED/REVERSED)
                             ▼
 ┌── getAccountBalanceBeforeDate (ledger-service)        ← saldo neraca (as-of)
 ├── getAccountMovementInRange   (reporting-utils)        ← flow Laba Rugi
 ├── getFlowAccountCumulativeTotal (reporting-utils)      ← laba kumulatif (RE-BRIDGE)
 ├── ledger lines query (getAccountLedgerByRange)
 ├── trial-balance movement query
 ├── cash-flow query (journal-based)
 └── counterparty balance query
                             ▼
 Balance Sheet · Income Statement · Equity · Cash Flow · Trial Balance · Ledger
                             ▼
 Dashboard (dashboard-service) → Projection · Ratio Analysis · Tax · Export (XLSX/PDF)
```
**Titik terbaik filter cabang = lapisan bawah (3 fungsi dasar + 4 query langsung).** Semua laporan di atasnya ikut otomatis. Menaruh filter di tingkat laporan akan menggandakan logika.

**Catatan kinerja:** engine memakai pola N+1 (1–3 query per akun). Mode *Comparison* dengan N cabang berarti N× pemanggilan. Rekomendasi: (1) implementasi awal = parameter `scope` (aman, kecil); (2) lalu satu fungsi agregasi `GROUP BY account_id, branch_id` untuk komparasi, diverifikasi **sama persis** dengan hasil (1) lewat tes ekuivalensi.

---

## D. DATABASE IMPACT

Prinsip: **perluas tabel yang ada; tabel baru hanya bila benar-benar perlu** (3 tabel baru: `branches`, `inter_branch_transactions`, `branch_access` di system DB).

### D.1 company.db
| Tabel | Kolom | Tipe | Null | Default | Index | FK | Tujuan |
|---|---|---|---|---|---|---|---|
| **branches** (baru) | id | string PK | N | uuid | PK | | |
| | code | string | N | | UNIQUE | | Kode cabang (mis. 24.341.04) |
| | name | string | N | | | | Nama tampil |
| | is_head_office | boolean | N | false | UNIQUE partial (hanya 1 true) | | Menandai Kantor Pusat |
| | is_active | boolean | N | true | | | Nonaktifkan (tidak hapus) |
| | sort_order | integer | N | 0 | | | Urutan kolom laporan |
| | created_at / updated_at | timestamp | N | now | | | |
| **journal_entries** | branch_id | string | N* | (backfill = id Kantor Pusat) | `(branch_id, entry_date)` | → branches.id RESTRICT | Cabang pemilik jurnal. *SQLite: ADD COLUMN nullable → backfill → trigger `BEFORE INSERT/UPDATE` menolak NULL |
| **accounts** | inter_branch_role | string | Y | NULL | | CHECK IN ('receivable','payable') | Penanda akun antar-cabang (dasar eliminasi; **bukan** berdasar nama) |
| **inter_branch_transactions** (baru) | id | string PK | N | | | | |
| | transaction_no | string | N | | UNIQUE | | Nomor unik (mencegah duplikat) |
| | transaction_date | date | N | | | | |
| | from_branch_id / to_branch_id | string | N | | index | → branches RESTRICT | CHECK from ≠ to |
| | amount | decimal(18,2) | N | | | | CHECK > 0 |
| | from_journal_id / to_journal_id | string | N | | UNIQUE masing-masing | → journal_entries RESTRICT | Pasangan jurnal |
| | status | string | N | 'POSTED' | | CHECK IN ('POSTED','REVERSED') | |
| | description, created_by, created_at | | | | | | |
| **statement_lines** (ada, tak terpakai engine) | line_kind | string | N | 'detail' | | CHECK IN ('group','detail','subtotal','total') | Jenis baris laporan |
| | formula | string | Y | | | | Rumus deklaratif (mis. `sum:children`, `ref:GROSS - ref:HPP`) — tanpa nama akun |
| **company_audit_log** | branch_id | string | Y | NULL | index | | Filter audit per cabang |
| **journal_entries** (opsional) | — | — | — | — | — | — | `reference_no` tetap UNIQUE global; pasangan antar-cabang memakai sufiks `-A`/`-B` |

### D.2 system DB
| Tabel | Kolom | Tipe | Null | Default | Index | FK | Tujuan |
|---|---|---|---|---|---|---|---|
| **company_access** | branch_scope | string | N | `'ALL'` | | CHECK IN ('ALL','LIMITED') | Default `ALL` = **perilaku user lama tidak berubah** |
| **company_access_branches** (baru) | access_id | string | N | | UNIQUE(access_id, branch_id) | → company_access CASCADE | |
| | branch_id | string | N | | | (validasi aplikasi → company.db.branches; tidak bisa FK lintas file) | |

**Fail-closed:** `LIMITED` tanpa baris cabang = tidak melihat apa pun (bukan "semua").

### D.3 Tabel yang dievaluasi dan **tidak** diubah
`journal_entry_lines` (tanpa kolom cabang), `periods` (level perusahaan), `users`/`system_users`, `account_types`, `counterparties`, `tax_reference_settings`.

### D.4 Permission baru (tambahan, bukan perubahan peran)
`branch.read`, `branch.manage` (OWNER/ADMIN), `report.consolidated` (hanya scope ALL), `interbranch.create` (ACCOUNTANT ke atas). Peran lama tetap; `branch_scope` adalah sumbu terpisah dari peran.

---

## E. ACCOUNTING MODEL

### E.1 Branch
- Cabang = **dimensi analitis** dalam satu perusahaan (satu COA, satu periode). Bukan entitas hukum.
- **Invarian inti:** setiap jurnal milik tepat **satu** cabang, dan **debit = kredit di dalam jurnal itu** (sudah ada). Akibatnya Σdebit = Σkredit **per cabang** → Neraca setiap cabang otomatis seimbang tanpa modal cabang.
- Kantor Pusat = cabang dengan `is_head_office = true`; data lama semuanya ke sini.

### E.2 Inter-Branch Transaction (bukan jurnal biasa ber-branch_id)
Contoh spesifikasi — Cabang A membayar Rp1.000.000 untuk Cabang B:
```
Jurnal #1 (cabang A)  Dr Piutang Antar Cabang  [inter_branch_role=receivable]  1.000.000
                      Cr Kas                                                   1.000.000
Jurnal #2 (cabang B)  Dr Beban / Aset                                          1.000.000
                      Cr Utang Antar Cabang    [inter_branch_role=payable]     1.000.000
```
- Dibuat oleh **satu service** dalam **satu `db.transaction`**: `inter_branch_transactions` + 2 jurnal + audit. Gagal satu → rollback semua.
- Tiap jurnal seimbang sendiri (invarian E.1 terjaga).
- Pencegahan duplikat: `transaction_no` UNIQUE + `from_journal_id`/`to_journal_id` UNIQUE + idempotency key dari klien.
- Pembatalan: reversal **kedua jurnal sekaligus** (satu aksi atomik). Reversal satu sisi saja **ditolak** (jurnal bertautan).
- Jurnal bertautan **tidak bisa diedit/dihapus sendiri**.

### E.3 Akun antar-cabang: dua akun atau satu?
Rekomendasi: **dua akun berflag** (`receivable` di Aktiva, `payable` di Kewajiban), sesuai Excel (baris 15 vs 39). Alasan: mengikuti contoh nyata, saldo tiap cabang terbaca jelas sebagai piutang/utang, eliminasi sederhana (kedua sisi dikurangkan, seperti rumus Excel).
Alternatif (satu akun "Rekening Antar Cabang" bersaldo netto) lebih ringkas tetapi menyembunyikan arah, tidak cocok dengan Excel. **Tidak direkomendasikan.**
Penentuan akun **berdasar flag `inter_branch_role`, bukan nama** — nama "Perantara Aktiva Antar SPBU" / "Rupa-rupa Pasiva" bervariasi antar klien.
Pencocokan per pasangan cabang: `piutang(A→B)` harus = `utang(B←A)`. Perlu `counterpart_branch_id` pada transaksi (sudah di `inter_branch_transactions`) → laporan **rekonsiliasi antar-cabang** (selisih ≠ 0 = anomali, ditampilkan, tidak disembunyikan).

### E.4 Consolidation & Elimination (di lapisan laporan)
- Gabungan = Σ semua cabang (dalam scope ALL).
- **Eliminasi = perlakuan reporting**: saldo akun `receivable` dan `payable` dikeluarkan dari total gabungan (menyerupai Excel). Jurnal asli **tidak dihapus/diubah**.
- Syarat: Σreceivable = Σpayable (dijamin oleh pasangan atomik). Jika tidak, laporan menampilkan **selisih eliminasi** sebagai peringatan, bukan menyembunyikan.
- Neraca gabungan tidak menggandakan aset/kewajiban; Neraca per cabang tetap menampilkan saldo antar-cabang masing-masing (informatif).
- Laba Rugi: transaksi antar-cabang yang bersifat laba/rugi (mis. beban dibayarkan cabang lain) tidak perlu eliminasi bila dicatat sebagai beban di penerima dan aset/kas di pembayar; **jual-beli internal dengan margin** (pendapatan antar-cabang) di luar lingkup tahap ini — dicatat sebagai risiko (K).

### E.5 Equity
- Ekuitas milik **Perusahaan**; tidak ada "Modal Cabang" wajib. Jurnal modal diposting di Kantor Pusat.
- Karena invarian E.1, Neraca cabang non-pusat seimbang lewat akun antar-cabang (cabang menerima dana dari pusat → Utang Antar Cabang).
- Laba per cabang = analisis (Laba Rugi per `branch_id`).

### E.6 Period closing
- Penutupan periode **per perusahaan**; tidak ada fiscal period per cabang. `periods` tidak diubah. Jurnal cabang mana pun tunduk pada status periode yang sama.

### E.7 Opening balance
- Satu opening balance **per cabang** (sekarang satu per perusahaan). Selisih (plug) diposting ke akun penyeimbang yang sudah ada **pada cabang itu**, sehingga Neraca per cabang tetap seimbang. Data lama = Kantor Pusat.

---

## F. REPORT ENGINE DESIGN

### F.1 Parameter `ReportScope` (satu konsep untuk semua laporan)
```
scope = { branchIds?: string[] | 'ALL', eliminateInterBranch: boolean }
```
- `undefined` = perilaku lama (tidak ada filter) → **kompatibel mundur**.
- User `LIMITED` → server **memaksa** `branchIds ⊆ izin`; `ALL` dan eliminasi ditolak (403) karena gabungan sebagian cabang menyesatkan.

### F.2 Tiga mode Laba Rugi
| Mode | Query | Hasil |
|---|---|---|
| **Individual** | `branchIds=[A]` | Laporan seperti sekarang, hanya cabang A |
| **Comparison** | kolom = tiap cabang dalam scope + **Gabungan** | Kolom dari `branches` (urut `sort_order`); Gabungan dihitung dengan **rumus yang sama** dan diverifikasi Σkolom = Gabungan |
| **Consolidated** | `ALL` | Satu kolom Gabungan (mode Comparison tanpa kolom cabang) |

### F.3 Hierarki laporan tanpa hardcode
```
Chart of Accounts → account_type / account_subtype
        → Report Group (statement_lines + statement_line_accounts + line_kind/formula)
        → Report Engine (scope) → Laporan
```
- Struktur Excel (Pendapatan Operasional → HPP → Laba Bruto → …) = **konfigurasi** `statement_lines` (kode, label, urutan, induk, jenis, rumus), bukan `if (account == "…")`.
- Akun yang belum dipetakan jatuh ke grup default per tipe akun + **peringatan "N akun belum dipetakan"**.
- **Invarian pengaman:** total laba bersih laporan berbasis grup **harus = total berbasis tipe akun** (yang sekarang sudah teruji). Salah pemetaan tidak bisa mengubah angka, hanya posisinya.
- Template default Indonesia (mengikuti struktur Excel) disediakan; klien bisa menyesuaikan.

### F.4 Neraca
- *Current / Previous / Mutation / Growth*: dua tanggal as-of (default: tanggal sama tahun lalu). Mutasi = Current − Previous.
- Mode: Individual, Comparison (kolom cabang + Gabungan), Consolidated (dengan eliminasi).
- **Laba Tahun Lalu vs Laba Tahun Berjalan:** pecah `RE-BRIDGE` memakai `fiscal_year_start_month` (sudah ada di `company_profile`); jumlahnya tetap = nilai jembatan lama (invarian).
- `BalanceSheetNotBalancedError` tetap sebagai pengaman; dengan invarian E.1 tidak boleh terjadi per cabang.

### F.5 Growth
```
growth = (current − previous) / |previous| × 100
```
- Dihitung **di server dalam integer cent** (BigInt, konsisten dengan `money.ts`), keluaran `number | null`, dibulatkan 1 desimal.
- `previous = 0` → `null` → UI menampilkan **"—"** (tidak pernah `Infinity`/`NaN`/error). Berlaku juga bila current = previous = 0.
- `previous < 0`: dibagi **|previous|** agar tanda growth searah perbaikan/penurunan (Excel memakai pembagi bertanda sehingga arah terbalik). **Perlu persetujuan bisnis (K.2 #5).**
- Hanya baris detail & subtotal yang punya growth; baris header tidak.

### F.6 Dashboard/KPI
Revenue, Expense, Profit, Cash, Assets, Liabilities, Equity, Margin **semuanya turunan** `getIncomeStatement/getBalanceSheet/getCashFlowStatement`. Cukup menerima `scope` → **tidak ada dashboard engine kedua**. Filter: Semua Cabang / Cabang X.

---

## G. AUTHORIZATION DESIGN

1. **Resolver tunggal** di `requireCompanyAccess` menghitung `request.branchScope` (`ALL` atau daftar id) dari `company_access.branch_scope` + `company_access_branches`. Semua service menerimanya — tidak ada route yang menghitung sendiri.
2. **Fail-closed:** LIMITED tanpa cabang → kosong; id cabang tak dikenal → 404.
3. **Aturan per kelas endpoint**
   - *List/laporan/ledger/search/dashboard/counterparty/audit log:* filter `je.branch_id IN scope` di query dasar.
   - *By-id (jurnal, ledger akun, dll.):* ambil baris → cek `branch_id ∈ scope`, bila tidak → **404** (bukan 403, agar keberadaan tidak bocor), sama seperti pola `sendAccessDenied` sekarang.
   - *Tulis (create/post/reverse/import/opening balance):* `branchId` dari body **divalidasi terhadap scope**; body/query tidak boleh meluaskan scope.
   - *Gabungan, eliminasi, restore backup, kelola cabang & akses:* hanya scope `ALL` + permission terkait.
4. **IDOR/manipulasi:** `branchId` di URL/query/body selalu diperiksa terhadap scope; id jurnal lintas cabang → 404; id cabang dari perusahaan lain → 404 (cabang hidup di company.db masing-masing, sehingga lintas-perusahaan tidak mungkin diresolusi).
5. **Peran:** OWNER = ALL (tidak bisa dibatasi); ADMIN default ALL, dapat dibatasi; ACCOUNTANT/STAFF/VIEWER bisa LIMITED.
6. **Audit:** perubahan scope & pembuatan cabang masuk audit log; akses ditolak dicatat.
7. **Tes otomatis wajib:** matriks (peran × scope × endpoint) yang menyisir **seluruh** route `/api/company-db/*` (51 route) agar route baru yang lupa menerapkan scope terdeteksi.

---

## H. MIGRATION PLAN

1. Memakai mekanisme yang sudah ada: `company-upgrade.ts` berjalan saat server start dan **menyalin `company.db.pre-upgrade` lebih dulu**.
2. Migration company.db baru (urut): `C0014_create_branches` → `C0015_journal_branch` → `C0016_inter_branch` → `C0017_statement_lines_kind`.
3. `C0015` (idempotent): `INSERT … WHERE NOT EXISTS` membuat **Kantor Pusat**; `ALTER TABLE journal_entries ADD COLUMN branch_id`; `UPDATE … SET branch_id = <HO> WHERE branch_id IS NULL`; trigger menolak NULL; index. Tidak ada UPDATE pada jumlah, akun, tanggal, status.
4. **Import:** kolom **`Cabang` opsional**. Kosong → cabang default konteks user (user LIMITED satu cabang → cabangnya; user ALL → Kantor Pusat). Nilai diisi harus kode cabang yang aktif **dan** dalam scope. **Satu transaksi = satu cabang** (baris dalam satu No Jurnal dengan cabang berbeda → error). Sidik jari duplikat dan unik `reference_no` memuat cabang. Import **tidak** membuat transaksi antar-cabang (hanya lewat service Inter-Branch). Alasan opsional: file lama tetap bisa dipakai; wajib akan merusak kompatibilitas.
5. **Opening balance import:** kolom `Cabang` opsional dengan aturan sama; satu per cabang.
6. **COA import:** tidak perlu cabang; kolom opsional `Peran Antar Cabang`.
7. **Verifikasi migrasi:** jumlah jurnal sebelum = sesudah; Σdebit/Σkredit per akun identik; hash `(id, amount, account_id)` seluruh line identik; migrasi dijalankan dua kali menghasilkan hasil sama; semua jurnal lama `branch_id = Kantor Pusat`; Neraca/Laba Rugi/Trial Balance sebelum vs sesudah identik angka demi angka.
8. Rollback: salinan `company.db.pre-upgrade`.
9. **User/akses lama:** `branch_scope = 'ALL'` default → perilaku sama persis.

---

## I. TEST PLAN (±70 kasus; 35 wajib dari spesifikasi + tambahan keamanan/integritas)

**Branch**
1 buat cabang · 2 edit · 3 nonaktifkan (tidak bisa dipakai jurnal baru; data lama tetap tampil) · 4 kode ganda ditolak · 5 cabang milik perusahaan lain tidak dapat dirujuk · +: hanya satu Kantor Pusat; tidak bisa menghapus cabang yang punya jurnal; hanya OWNER/ADMIN-ALL mengelola.

**Journal**
6 jurnal dengan cabang · 7 tanpa cabang → default konteks · 8 cabang tak valid ditolak · 9 injeksi `branchId` lintas perusahaan ditolak · 10 migrasi jurnal lama · +: jurnal pada cabang nonaktif ditolak; reversal mewarisi cabang; jurnal tak bisa mencampur cabang; jurnal bertautan tak bisa diedit/dihapus sendiri.

**Reporting**
11 semua cabang · 12 cabang A · 13 cabang B · 14 komparasi · 15 gabungan · 16 growth · 17 previous = 0 → "—" (tidak NaN/Infinity) · 18 cabang kosong (semua 0, tidak error) · 19 Neraca seimbang (gabungan **dan** tiap cabang) · +: **Σ kolom cabang = Gabungan** (property test pada data acak); Σ per tipe akun = Σ per Report Group; previous negatif; Laba Tahun Lalu + Berjalan = RE-BRIDGE lama; hasil `scope` undefined **identik** dengan sebelum fitur (regresi 619 tes).

**Authorization**
20 owner lihat semua · 21 user cabang A lihat A · 22 user A tak bisa akses B · 23 IDOR (id jurnal/akun/transaksi B) → 404 · 24 manipulasi API (query `branchId`, body, header) · +: matriks otomatis 51 route; pencarian global & audit log tidak bocor; LIMITED tanpa cabang = kosong; LIMITED ditolak untuk gabungan/eliminasi; export XLSX/PDF mengikuti scope; scope tidak bisa diubah sendiri.

**Inter-Branch**
25 buat transaksi · 26 kedua sisi terbentuk dan masing-masing seimbang · 27 rollback atomik (gagal sisi B → sisi A tidak ada, audit tidak ada) · 28 pencegahan duplikat (nomor & idempotency) · 29 eliminasi di gabungan (piutang = utang → 0 netto, tidak menggandakan) · 30 laporan per cabang tetap benar · +: reversal sepasang atomik; reversal satu sisi ditolak; selisih rekonsiliasi terdeteksi; from = to ditolak; periode LOCKED/CLOSED menolak.

**Migration**
31 jurnal lama → Kantor Pusat · 32 idempotent (2×) · 33 tidak ada jurnal ganda · 34 jumlah tidak berubah · 35 mapping akun tidak berubah · +: restore dari `pre-upgrade`; opening balance lama → Kantor Pusat; laporan sebelum/sesudah identik.

**Regresi lain:** Electron build, import jurnal/COA/opening balance lama (tanpa kolom Cabang), dashboard, backup/restore, lisensi, security hardening (rate limit, audit auth).

---

## J. ACCEPTANCE CRITERIA — JAWABAN ARSITEKTUR

| | Pertanyaan | Jawaban |
|---|---|---|
| A | Satu perusahaan banyak cabang? | **Ya** — tabel `branches` di company.db |
| B | Transaksi dikaitkan ke cabang? | **Ya** — `journal_entries.branch_id` |
| C | User dibatasi per cabang? | **Ya** — `branch_scope` + `company_access_branches`, fail-closed, di backend |
| D | Laporan per cabang? | **Ya** — parameter `scope` di 3 fungsi dasar |
| E | Laporan dibandingkan antar cabang? | **Ya** — mode Comparison (kolom dinamis) |
| F | Laporan konsolidasi? | **Ya** — Σ cabang + eliminasi flag `inter_branch_role` |
| G | Neraca Current/Previous/Mutation/Growth? | **Ya** — dua tanggal as-of, growth null-safe |
| H | Laba Rugi Cabang/Gabungan/Growth? | **Ya**, **dengan syarat** Report Group (Phase 3) agar hierarki Excel terbentuk |
| I | Antar-cabang atomic? | **Ya** — satu `db.transaction` (2 jurnal + tautan + audit) |
| J | Antar-cabang dapat dieliminasi? | **Ya**, di lapisan laporan; jurnal asli utuh |
| K | Data lama aman? | **Ya** — migrasi idempotent, backup `pre-upgrade`, verifikasi hash |
| L | Otorisasi di backend? | **Ya** — resolver tunggal + 404 pada id di luar scope |

---

## K. IMPLEMENTATION PHASES, RISIKO, & KEPUTUSAN

### K.1 Phases (tiap phase berdiri sendiri, diuji, bisa di-release terpisah)
| Phase | Isi | Keluaran/Gerbang |
|---|---|---|
| **1 — Branch Master** | `branches`, Kantor Pusat otomatis, CRUD (OWNER/ADMIN), permission baru, audit | Tes cabang 1–5; semua tes lama hijau |
| **2 — Journal Branch Dimension** | `journal_entries.branch_id` + migrasi + validasi + reversal mewarisi + opening balance per cabang | Tes jurnal 6–10 + migrasi 31–35 + hash laporan lama identik |
| **3 — Reporting (+ Report Group)** | `scope` pada 3 fungsi dasar & query langsung; Individual → Comparison → Consolidated; Previous/Mutation/Growth; Report Group via `statement_lines`; split laba tahun lalu/berjalan; dashboard ikut | Tes 11–19; Σcabang = Gabungan; total grup = total tipe |
| **4 — Authorization** | `branch_scope`, resolver, filter semua route, search, audit log, export | Tes 20–24 + matriks 51 route. **Dikerjakan SEBELUM UI cabang dibuka ke user biasa** |
| **5 — Inter-Branch** | tabel + service atomik + reversal berpasangan + `inter_branch_role` + rekonsiliasi | Tes 25–28 |
| **6 — Consolidation/Elimination** | eliminasi di Neraca/Laba Rugi gabungan, peringatan selisih | Tes 29–30 |
| **7 — UI** | Master cabang, pemilih cabang, kolom komparasi, form antar-cabang, kolom Cabang di import & template, export | Uji browser |
| **8 — Regression** | UAT penuh, security regression, installer scan, Electron build | Laporan hasil |

Catatan urutan: Phase 4 sengaja di depan Phase 5–7 supaya tidak ada periode di mana cabang ada tetapi data belum terproteksi.

### K.2 Keputusan bisnis yang masih perlu jawaban (tidak memblokir Phase 1–2)
1. Siapa boleh membuat transaksi antar-cabang: user sumber saja, atau perlu persetujuan cabang penerima? (rekomendasi: user sumber, cabang penerima hanya melihat)
2. Apakah jual-beli internal ber-margin akan terjadi? (di luar tahap ini bila tidak)
3. Apakah user LIMITED boleh melihat Gabungan? (rekomendasi: tidak)
4. NPWP/penomoran/mata uang per cabang? (bila ya → kolom tambahan di `branches`)
5. Growth dengan pembanding negatif: bagi |previous| (rekomendasi) atau ikuti rumus Excel?
6. Pembanding Laba Rugi: tahun lalu periode sama, atau periode sebelumnya?
Plus: **butuh COA riil klien SPBU** untuk menyusun template Report Group.

### K.3 Risk assessment (terbesar → terkecil)
| # | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| 1 | **Kebocoran lintas cabang** (IDOR, search, audit log, export, counterparty) | Data cabang lain terbaca | Resolver tunggal, fail-closed, matriks tes seluruh route, 404 pada id luar scope, Phase 4 sebelum UI |
| 2 | **Invarian "jurnal seimbang per cabang" dilanggar** → Neraca cabang 500 | Laporan tidak bisa dibuka | Satu jurnal = satu cabang di service **dan** trigger; tes property |
| 3 | **Migrasi merusak data lama** | Kehilangan/perubahan angka | Idempotent, backup `pre-upgrade`, hash line sebelum/sesudah, laporan lama dibandingkan angka demi angka |
| 4 | **Opening balance** berubah dari satu menjadi per-cabang | Perilaku lama berubah | Data lama = Kantor Pusat; aturan baru hanya menambah |
| 5 | **Kinerja** komparasi (pola N+1 × N cabang) | Laporan lambat | Awal pakai `scope`; lalu agregasi `GROUP BY` terverifikasi tes ekuivalensi |
| 6 | **Hierarki Excel tak terbentuk** karena klasifikasi kurang | Laporan tak sesuai harapan klien | Report Group deklaratif + COA riil klien + invarian total |
| 7 | **Eliminasi tidak cocok** (piutang ≠ utang) | Neraca gabungan menyesatkan | Selisih ditampilkan eksplisit, pasangan atomik |
| 8 | Perubahan fungsi dasar `getAccountBalanceBeforeDate` yang dipakai banyak laporan | Regresi luas | Parameter opsional, `undefined` = identik; 619 tes sebagai jaring pengaman |
| 9 | Rute legacy master-DB (`modules/journal`, `ledger`, `accounts`) | Jalan belakang | Konfirmasi tidak dipakai UI; tidak diubah; masuk matriks tes |
| 10 | `source` CHECK & `reference_no` UNIQUE | Antar-cabang sulit | Tidak mengubah CHECK; sufiks referensi |

---

## L. FINAL RECOMMENDATION

### **READY FOR IMPLEMENTATION** (secara arsitektur, bertahap, mulai Phase 1–2)

Alasan:
- Opsi A terbukti cocok dengan contoh nyata (gabungan, per cabang, eliminasi antar-SPBU di rumus Excel).
- Perubahan data **kecil dan idempotent** (1 kolom di jurnal, 1 flag di akun, 3 tabel baru); titik filter laporan **sempit** (3 fungsi + 4 query); dashboard tidak butuh engine kedua.
- Seluruh mekanisme pendukung sudah ada: migrasi saat start + backup `pre-upgrade`, transaksi atomik + audit, `company_access`, pola 404 untuk akses ditolak.

Syarat/catatan jujur:
- **Phase 3 (laporan sesuai hierarki Excel) memerlukan COA riil klien** dan jawaban K.2 #5–#6; tanpa itu Laba Rugi per-cabang tetap jalan (per tipe akun) tetapi belum berbentuk seperti Excel.
- **Phase 4 (otorisasi) tidak boleh dilewati atau ditunda** — ini risiko terbesar.
- Contoh Excel adalah template kosong: **tidak ada angka yang bisa dipakai memverifikasi hasil**; verifikasi memakai data uji sintetis + data klien nanti.
- Di luar lingkup tahap ini: jual-beli internal ber-margin, multi-mata-uang, periode per cabang, input bersamaan dari banyak komputer (lihat laporan Multi-User).

**BERHENTI di sini. Menunggu approval sebelum menulis kode apa pun.**


---
---

# REVISI 2 — FINAL MULTI-BRANCH REQUIREMENT REFINEMENT (2026-10-06)

Bagian M–V di bawah **menambah dan, bila bertentangan, menggantikan** bagian sebelumnya. Yang digantikan:
- **D.2** (`company_access_branches` → diganti `user_branch_access` + `delegations`, lihat S)
- **G** (Authorization → diperluas menjadi N, O, Q, R)
- **K.1** (Phases → diganti U)
- **L** (Rekomendasi → diganti V)

Audit tambahan terhadap kode yang ada (dasar semua keputusan di bawah):

| Temuan | Detail | Dampak |
|---|---|---|
| Hak akses dibaca dari DB **di setiap request** | `requireCompanyAccess` memanggil `findCompanyAccess` tiap request, tanpa cache; sesi hanya membuktikan identitas | Pencabutan akses cabang otomatis berlaku pada request berikutnya (bagian R.4) |
| Role & permission **statis** di kode | 5 peran (`OWNER/ADMIN/ACCOUNTANT/STAFF/VIEWER`) → 15 permission, `ROLE_RANK`, `canManageRole` | Tidak ada permission per-user. Role = paket permission. "Area Admin" = ADMIN + akses 2 cabang (bukan peran baru) |
| `canManageRole` sudah mencegah eskalasi peran | Aktor tidak boleh memberi/mengubah peran di atas dirinya; OWNER hanya oleh OWNER; ada *Owner Protection* (minimal 1 OWNER aktif) | Fondasi untuk "delegasi tidak boleh melebihi wewenang"; perlu diperluas ke sumbu cabang |
| `users.manage` saat ini **seluruh perusahaan** | 5 route `company-access` (list/grant/ubah peran/cabut/suspend) tanpa batas cabang | Harus dibatasi cabang, kalau tidak ADMIN cabang bisa mengelola semua |
| Dua infrastruktur audit | `audit_log` system DB (`actor_id, company_id, entity_type/id, before_json, after_json, reason`) dan `company_audit_log` (tanpa `company_id`, tanpa `branch_id`) | Dipakai ulang. Tambah kolom `target_user_id` & `branch_id` (nullable) |
| Sesi = token DB (`sessions`, kedaluwarsa idle 15 menit) | Tidak menyimpan konteks perusahaan/cabang | Konteks cabang tidak disimpan di sesi (bagian Q) |
| `company_access` ada di **system DB**, cabang akan ada di **company.db** | Dua file berbeda → tidak ada FK/transaksi lintas file | Keputusan penempatan tabel (S) |

---

## M. BRANCH LIFECYCLE DESIGN

### M.1 Status: **ACTIVE, INACTIVE, CLOSED** — tanpa DRAFT
Evaluasi `DRAFT`: **tidak diperlukan.** DRAFT berguna bila ada tahap setup yang berbeda dari "belum dipakai". Di TERRA cabang baru tidak bisa dipakai siapa pun sebelum akses diberikan, dan `INACTIVE` sudah mewakili "cabang disiapkan tapi belum beroperasi". Maka cabang boleh **dibuat langsung sebagai ACTIVE atau INACTIVE**. DRAFT hanya menambah satu status tanpa perilaku baru (over-engineering).

### M.2 Perilaku per status
| | ACTIVE | INACTIVE | CLOSED |
|---|---|---|---|
| Jurnal / transaksi baru, import, opening balance baru | ✓ | ✗ | ✗ |
| Menjadi *active branch context* user | ✓ | ✗ | ✗ |
| Grant akses user baru | ✓ | ✗ | ✗ |
| Lihat jurnal/ledger historis | ✓ | ✓ | ✓ |
| Laporan historis (per cabang & gabungan) | ✓ | ✓ | ✓ |
| Audit trail | ✓ | ✓ | ✓ |
| Reversal jurnal lama | ✓ | ✗ | ✗ (reversal = jurnal baru) |
| Kembali aktif | — | ✓ (`branch.manage`) | ✓ (`branch.reopen`, OWNER) |

Catatan: akses yang **sudah ada** ke cabang INACTIVE/CLOSED tetap tersimpan, sehingga user berwenang masih bisa membuka laporan historisnya (melalui *report scope*, bukan *context* — bagian Q). Cabang INACTIVE/CLOSED tidak muncul di dropdown cabang operasional.

### M.3 Matriks transisi
```
(buat) ──► ACTIVE ◄──► INACTIVE
              │            │
              ▼            ▼
              └──► CLOSED ─┘            CLOSED ──(reopen, OWNER, alasan wajib)──► ACTIVE
```
- ACTIVE↔INACTIVE: `branch.manage`, alasan opsional.
- ACTIVE/INACTIVE→CLOSED: `branch.close`, **alasan wajib**, melewati *closing checklist*.
- CLOSED→ACTIVE (**reopen**): `branch.reopen` (default **hanya OWNER**), alasan wajib. **Rekomendasi: diperbolehkan.** Alasan: penutupan karena salah klik atau cabang buka kembali adalah kasus nyata; menolaknya memaksa membuat cabang baru dengan kode baru dan memecah riwayat. Risiko integritas rendah karena reopen tidak menyentuh data historis; tetap tercatat `BRANCH_REOPENED`.
- **Kantor Pusat (`is_head_office`)**: tidak boleh INACTIVE/CLOSED/dihapus. Perpindahan status Kantor Pusat ke cabang lain di luar lingkup.

### M.4 Closing checklist (validasi sebelum CLOSED)
**Blokir keras:** (1) masih ada jurnal DRAFT di cabang itu; (2) saldo antar-cabang cabang itu ≠ 0 (piutang/utang antar-cabang belum diselesaikan — kalau dibiarkan, eliminasi gabungan tak pernah bersih); (3) ada transaksi antar-cabang belum lengkap.
**Peringatan (boleh lanjut, tercatat):** saldo kas/bank/persediaan cabang ≠ 0; saldo akun neraca lain ≠ 0 (disarankan dipindahkan ke pusat lewat transaksi antar-cabang dulu).
**Setelah CLOSED:** semua grant akses ke cabang itu ditandai tidak berlaku untuk operasional; `default_branch` user yang menunjuk cabang itu direset; tidak ada data yang dihapus.

### M.5 Penghapusan: **tidak ada hard delete**
- Cabang yang sudah punya jurnal, opening balance, transaksi antar-cabang, baris audit, atau grant akses (aktif/riwayat) → **tidak boleh dihapus**; gunakan lifecycle.
- Cabang yang **belum pernah dipakai** (dibuat karena salah ketik): **rekomendasi soft delete**, bukan DELETE fisik, dengan kolom `deleted_at/deleted_by`:
  - hanya bila pengecekan pemakaian = 0 (jurnal, opening, antar-cabang, grant tersisa);
  - hilang dari semua daftar; **kode tetap dicadangkan** (UNIQUE mencakup yang terhapus) agar tidak ada ambiguitas di audit log;
  - audit `BRANCH_DELETED` tetap ada; hanya OWNER.
- Tidak ada endpoint DELETE fisik di API. Trigger SQLite menolak `DELETE FROM branches` sebagai lapisan terakhir.

### M.6 Atribut cabang (minimum)
`code` (unik), `name`, `status`, `address`, `phone`, `opened_at`, `closed_at`, `close_reason`, `closed_by`, `reopened_at`, `is_head_office`, `sort_order`, `created_by`, timestamps, `deleted_at`. NPWP/penomoran/mata uang per cabang **ditunda** sampai klien menjawab (K.2 #4).

---

## N. USER MULTI-BRANCH ACCESS DESIGN

### N.1 Model: `Role + Permission + Branch Access`
- **Role** (sudah ada, company-wide) = paket permission.
- **Permission** = apa yang boleh dilakukan.
- **Branch Access** = **di cabang mana** permission itu berlaku. Sumbu baru dan independen.
- Tidak ada `users.branch_id`. Relasi **banyak-ke-banyak**: `user ↔ company_access ↔ user_branch_access ↔ branches`.
- "AREA ADMIN", "STAFF METRO", "SUPER ADMIN" **bukan peran di kode** — hanya kombinasi: ADMIN + {Metro, Bandar}; STAFF + {Metro}; ADMIN/OWNER + ALL.
- **Tidak ada role per-cabang** (mis. ACCOUNTANT di Metro tapi VIEWER di Bandar) pada tahap ini — satu peran per user per perusahaan. Ditandai sebagai keputusan K.2-baru #7 bila klien membutuhkannya (jalur upgrade: kolom `role_override` di `user_branch_access`).

### N.2 Dua bentuk cakupan akses
`company_access.branch_scope`:
- **`ALL`** — semua cabang perusahaan, **termasuk cabang yang dibuat kelak** (OWNER wajib ALL; tidak bisa dibatasi).
- **`LIMITED`** — hanya cabang yang tertera di `user_branch_access` berstatus ACTIVE.

**Fail-closed:** `LIMITED` tanpa baris = tidak melihat cabang apa pun (halaman "belum ada akses cabang"), tidak pernah jatuh ke "semua".

### N.3 Tiga operasi berbeda (tidak dicampur)
| Operasi | Arti | Permission | Efek data | Audit |
|---|---|---|---|---|
| **Add Access** | Menambah cabang ke akses user | `user_branch.manage` (dibatasi, lihat O) | Baris baru ACTIVE | `USER_BRANCH_ACCESS_GRANTED` |
| **Remove Access** | Mencabut satu cabang | `user_branch.manage` | Baris → REVOKED (riwayat tetap) | `USER_BRANCH_ACCESS_REVOKED` |
| **Transfer** | Pindah dari cabang X ke Y, **atomik** (cabut X + beri Y dalam satu transaksi) | `user_branch.manage` + aktor memegang **X dan Y** | Dua baris berubah, satu event | `USER_BRANCH_TRANSFERRED` (old=X, new=Y) |

Aturan umum: aktor **tidak boleh mengubah akses dirinya sendiri**; tidak boleh mencabut cabang terakhir milik OWNER; user tidak boleh dicabut hingga nol cabang tanpa peringatan eksplisit (diperbolehkan, akibatnya user hanya melihat layar "tanpa akses cabang").

### N.4 Hubungan dengan lifecycle cabang
Grant hanya ke cabang ACTIVE. Cabang INACTIVE/CLOSED mempertahankan akses lama untuk keperluan lihat historis. Cabang baru **tidak otomatis** diberikan ke user LIMITED (hanya user `ALL` melihatnya otomatis).

---

## O. DELEGATED AUTHORITY DESIGN

### O.1 Prinsip tunggal
> **Seorang aktor hanya dapat memberikan, mengubah, atau mencabut sesuatu yang (a) ia miliki sendiri dan (b) berada di dalam batas delegasinya.**

Tidak ada jalur "admin bebas memberi apa saja".

### O.2 Dua lapis
1. **Wewenang bawaan (peran).** Mekanisme `canManageRole` yang sudah ada tetap: tidak boleh memberi peran di atas peran sendiri; OWNER hanya oleh OWNER.
2. **Delegasi eksplisit (baru, kecil).** ADMIN dengan cakupan `LIMITED` **tidak otomatis boleh mengelola user** walau perannya memiliki `users.manage`. Ia butuh satu **delegasi aktif** dari OWNER (atau ADMIN ber-ALL yang memegang `delegation.manage`). Delegasi mencatat *siapa, atas cabang apa, boleh apa, sampai kapan*.
   - **Backward compatible:** ADMIN lama otomatis `branch_scope = ALL` → perilakunya tidak berubah, tidak butuh delegasi.

### O.3 Isi delegasi (kapabilitas tetap, bukan permission bebas)
| Kapabilitas | Arti |
|---|---|
| `manage_users` | Tambah/cabut/pindahkan user **staf** pada cabang cakupan delegasi |
| `manage_branch_info` | Ubah info cabang (nama, alamat) pada cabang cakupan |
| `view_branch_reports` | Melihat laporan cabang cakupan (sudah ikut `report.read` + akses; dicatat untuk kejelasan UI) |
| `inter_branch` | Membuat transaksi antar-cabang di antara cabang cakupan |

Ditambah: **cabang cakupan** (`delegation_branches`), **peran maksimum** yang boleh diberikan (`max_role`, selalu < peran penerima delegasi, dan tidak pernah OWNER/ADMIN-ALL), `expires_at` opsional, status `ACTIVE/REVOKED/EXPIRED`.
Yang **tidak pernah** dapat didelegasikan: pengaturan perusahaan, hapus perusahaan, restore/backup, kelola OWNER, konfigurasi keuangan sistem, `branch.close/reopen`, `delegation.manage`.

### O.4 Aturan penegakan (semuanya di backend, satu fungsi `assertDelegationBoundary`)
Aktor A (ADMIN, LIMITED, delegasi Metro+Bandar, `manage_users`):

| Aksi | Hasil |
|---|---|
| Tambah staf ke Metro | ✓ |
| Pindahkan staf Metro → Bandar | ✓ (A memegang keduanya) |
| Cabut akses staf dari Metro | ✓ |
| Beri akses **Kantor Pusat** | ✗ 403 (di luar cakupan) |
| Beri akses cabang yang A sendiri tak punya | ✗ |
| Beri scope `ALL` | ✗ (A bukan ALL) |
| Menjadikan siapa pun OWNER / ADMIN-ALL, termasuk dirinya | ✗ |
| Memberi peran ≥ `max_role` atau ≥ perannya | ✗ |
| Mengubah akses/peran dirinya sendiri | ✗ |
| Mengelola user yang punya akses **di luar** cakupan A | Hanya bagian irisan (Metro/Bandar) yang bisa disentuh; cabang lain milik user itu tidak terlihat dan tidak berubah |
| Membuat delegasi baru (re-delegasi) | ✗ (kedalaman delegasi = **1**) |

### O.5 Delegasi memengaruhi hak efektif dengan cara yang menyusut aman
**Hak efektif = irisan(delegasi, akses A saat ini, peran A saat ini).** Jika A kelak dicabut dari Bandar, otoritasnya atas Bandar hilang seketika walau baris delegasi belum diedit.

### O.6 Pencabutan delegasi
Mencabut delegasi A: kewenangan A langsung berhenti. **Akses yang pernah A berikan ke staf tidak otomatis dicabut** (staf diberi secara sah). Sebagai gantinya UI menampilkan "Akses yang diberikan melalui delegasi ini (N)" dengan opsi **"Cabut juga"** (default tidak dicentang). Setiap baris `user_branch_access` menyimpan `granted_by` dan `granted_via_delegation_id` sehingga bisa ditinjau. *Alternatif* (cabut berantai otomatis) ditolak: bisa menjatuhkan akses staf operasional tanpa sengaja.

### O.7 Audit
`DELEGATION_CREATED / UPDATED / REVOKED` (+ `DELEGATION_EXPIRED` otomatis saat dibaca/diterapkan), dengan snapshot sebelum/sesudah.

---

## P. USER TRANSFER DESIGN

1. **Transfer = perubahan akses ke depan.** Tidak menyentuh transaksi lama.
2. **Kepemilikan transaksi tidak pernah diturunkan dari user.** `journal_entries.branch_id` ditetapkan **saat jurnal dibuat** dan tidak berubah; `created_by` tetap user lama. Jadi memindahkan Staff A dari Metro ke Bandar **tidak mengubah satu pun jurnal historis** (tes 28). Laporan Metro tetap memuat jurnal yang dibuat A sebelumnya.
3. **Draft yang belum diposting.** Jurnal DRAFT buatan A di Metro tetap milik Metro. Setelah transfer, A tidak lagi melihatnya. Sistem **tidak** memindahkannya otomatis; saat transfer UI menampilkan "A punya N draft di Metro" agar admin cabang menindaklanjuti (posting/hapus/serahkan). Memindahkan cabang sebuah jurnal bukan fitur transfer user (dan tidak disediakan — mengubah `branch_id` jurnal terposting akan mengubah laporan historis).
4. **Atomik.** Cabut X + beri Y dalam **satu transaksi system DB**, satu baris audit `USER_BRANCH_TRANSFERRED` (old=X, new=Y, actor, target, alasan opsional).
5. **Konteks aktif.** Jika konteks A sedang X, request berikutnya mendapat `BRANCH_CONTEXT_INVALID`, UI otomatis pindah ke cabang A yang masih sah (Q.4).
6. **Batasan transfer.** Tidak boleh ke cabang CLOSED/INACTIVE; aktor harus memegang X dan Y; tidak boleh self-transfer.
7. **Cara paling umum** (user mutasi) dan **cara paling aman** (hanya tambah) dibedakan di UI: tombol terpisah *Beri akses*, *Cabut*, *Pindahkan*.

---

## Q. ACTIVE BRANCH / REPORT SCOPE DESIGN

### Q.1 Tiga hal yang sengaja dipisah
| Konsep | Isi | Tempat | Mengubah permission? |
|---|---|---|---|
| **Branch Access** | Cabang yang *boleh* | `user_branch_access` (DB) | — (inilah sumbernya) |
| **Active Branch Context** | Satu cabang *nyata* yang sedang dikerjakan | Dikirim per request + preferensi terakhir | **Tidak** |
| **Report Scope** | Cakupan *laporan*: satu cabang, beberapa cabang, atau gabungan | Parameter eksplisit di request laporan | **Tidak** |

### Q.2 Active Branch Context (operasional)
- Hanya cabang **ACTIVE** yang ada di akses user. Menentukan: default `branch_id` saat membuat jurnal/import/opening balance, isi dashboard, daftar jurnal, ledger, KPI.
- **Dikirim klien tiap request** (header `X-Branch-Context: <branchId>`) dan **divalidasi server tiap request** terhadap: perusahaan (slug), akses user, status cabang. Header palsu/di luar akses → ditolak.
- **Tidak disimpan di sesi server** → aman untuk banyak tab (tiap tab bisa cabang berbeda), tidak ada state basi.
- **Preferensi terakhir** disimpan di `company_access.default_branch_id` hanya sebagai kenyamanan saat login berikutnya; divalidasi ulang; bila tak lagi sah → cabang pertama yang sah.
- Mengganti konteks = `PUT .../me/active-branch` (memperbarui preferensi) → audit `ACTIVE_BRANCH_CHANGED` (ringan: hanya bila benar-benar berubah, dibatasi laju).
- "Semua Cabang" **bukan** konteks dan **bukan** baris di DB (tidak ada cabang `ALL`).

### Q.3 Report Scope (laporan)
Parameter eksplisit di tiap endpoint laporan: `scope = branch:<id> | branches:<id,id,…> | consolidated`.
| User punya akses | Scope yang boleh | Catatan |
|---|---|---|
| ALL + `report.consolidated` | satu cabang, beberapa cabang, **konsolidasi penuh** | konsolidasi = semua cabang non-terhapus |
| Metro, Bandar, Pusat (semua cabang perusahaan) + `report.consolidated` | sama dengan di atas | "Gabungan" = konsolidasi penuh karena mencakup semua cabang |
| Metro, Bandar (dari 3) + `report.consolidated` | Metro, Bandar, **"Gabungan Cabang Terpilih"** | diberi label tegas *bukan konsolidasi perusahaan*; eliminasi hanya untuk pasangan cabang yang keduanya ada di dalam pilihan; sisa saldo antar-cabang ke luar cakupan ditampilkan sebagai baris "tidak dieliminasi" |
| Hanya Metro | Metro | meminta Gabungan/cabang lain → 403 |
| LIMITED tanpa `report.consolidated` | hanya cabang tunggal per request | meminta lebih dari satu → 403 |
- Cabang INACTIVE/CLOSED yang masih dalam akses user boleh dipilih **di report scope** (historis), tidak di konteks.
- Konteks aktif menjadi **nilai awal** pilihan cakupan laporan di UI, tidak membatasinya.

### Q.4 Akses dicabut saat user sedang aktif (rekomendasi)
Urutan perilaku (semuanya aman karena hak dibaca dari DB tiap request):
1. **Request berikutnya langsung ditolak** untuk cabang itu: `403` kode `BRANCH_CONTEXT_INVALID` (bukan 500, tanpa membocorkan data).
2. Klien menangkap kode itu → **reset konteks otomatis** ke cabang sah pertama (bila ada) + pemberitahuan "Akses ke Cabang Metro telah dicabut; Anda dialihkan ke …".
3. Bila tidak ada cabang sah tersisa → layar "Anda belum memiliki akses cabang" (tanpa data).
4. Form yang sedang diisi: tidak disimpan ke cabang lain; user diberi pesan bahwa isian tidak dapat disimpan (tidak ada auto-submit ke cabang berbeda).
5. Report/export yang sedang berjalan: validasi dilakukan **di awal request**; hasil request yang sudah selesai tidak ditarik kembali (batas wajar offline satu proses).
Sesi tidak perlu dihentikan (identitas masih sah); yang berubah hanya otorisasi.

---

## R. SECURITY MODEL

### R.1 Lima lapis, semua di backend (frontend hanya kenyamanan)
```
Request
 1. Sesi/identitas ............ requireAuth (sudah ada)
 2. Perusahaan (company) ...... slug → registry → company_access ACTIVE (sudah ada). company_id TIDAK pernah dari body/header
 3. Permission (role) ......... requirePermission(...)  (sudah ada, ditambah permission baru)
 4. Branch authority .......... resolver tunggal: akses ∩ status cabang ∩ delegasi ∩ context/scope  (BARU)
 5. Data scope ................ filter di query dasar + cek kepemilikan baris untuk by-id (BARU)
```

### R.2 Company isolation (#20)
- Cabang **hidup di company.db perusahaannya** → struktural: branch id perusahaan B tidak ada di DB perusahaan A, jadi tidak bisa di-resolve walau id/kode/slug cabang diketahui.
- `user_branch_access.company_id` disimpan eksplisit dan **dicocokkan** dengan `company_access.company_id` pada setiap baca (defense-in-depth terhadap data salah).
- `company_id` dari body/query/header **diabaikan**; satu-satunya sumber adalah `:companySlug` yang diverifikasi akses.
- Respons untuk cabang/jurnal/user di luar batas = **404 identik** dengan "tidak ada" (tidak bisa membedakan "ada tapi bukan akses Anda" vs "tidak ada").

### R.3 Resolver tunggal `resolveBranchAuthority(request)`
Menghasilkan: `role`, `permissions`, `scopeKind (ALL|LIMITED)`, `accessibleBranchIds` (termasuk historis), `operationalBranchIds` (ACTIVE saja), `delegation` (kapabilitas+cabang aktif), `contextBranchId` (tervalidasi). Semua route memakainya; **tidak ada route yang menghitung sendiri**. Fail-closed pada setiap ketidakpastian.

### R.4 Pencabutan akses seketika
Tidak ada cache hak akses; `user_branch_access`, status cabang, delegasi dibaca tiap request. Delegasi yang kedaluwarsa dievaluasi pada saat itu juga (bukan cron).

### R.5 Audit route (kelas endpoint yang harus diubah/ditambah)
| Kelas | Route saat ini | Perlakuan |
|---|---|---|
| Cabang | (baru) CRUD + lifecycle + `me/active-branch` | permission `branch.*`; hanya cabang dalam akses; OWNER untuk reopen/delete |
| User & akses | 5 route `company-access` | **dibatasi cabang + delegasi**; daftar user hanya irisan; tulis lewat `assertDelegationBoundary` |
| Jurnal | create, post, reverse, delete draft, list, detail, import (±11) | `branchId` divalidasi (akses ∧ ACTIVE ∧ permission); by-id → 404 di luar scope; reversal mewarisi cabang & wajib ACTIVE |
| Laporan + export | 5 laporan + XLSX/PDF | parameter `scope` tervalidasi; export mengikuti scope |
| Dashboard / analisis / proyeksi / pajak | 4 | konteks/scope tervalidasi |
| Ledger / trial balance / akun / counterparty | ±5 | `scope` pada query; saldo akun di daftar COA mengikuti scope |
| Pencarian global | 1 | filter scope (sumber kebocoran paling halus) |
| Audit log | 1 | user LIMITED hanya baris cabangnya (`branch_id`); log sistem/akses hanya `ALL` |
| Opening balance (+import) | 2–4 | per cabang; cabang divalidasi |
| Periode | 3 | tetap level perusahaan |
| Profil/pengaturan perusahaan, backup/restore | beberapa | hanya `ALL` + permission |
| Legacy master-DB (`modules/journal`, `ledger`, `accounts`, `statements`) | terdaftar | **diaudit & dikunci/diputus** bila tidak dipakai UI (jalan belakang) |

### R.6 Ancaman & mitigasi
| Ancaman | Mitigasi |
|---|---|
| Forged `branch_id` / header konteks | Divalidasi tiap request terhadap akses+status |
| Forged `company_id` | Diabaikan; hanya slug terverifikasi |
| IDOR cabang/jurnal/user/ledger | Cek kepemilikan baris, 404 seragam, matriks tes seluruh route |
| Eskalasi lewat delegasi | `assertDelegationBoundary`, kedalaman 1, tak bisa ubah diri sendiri, irisan hak |
| Admin cabang mengambil alih perusahaan | LIMITED tak bisa memberi ALL/OWNER/cabang di luar cakupan |
| Penghapusan jejak | Tidak ada hard delete, tabel akses/delegasi memakai status (bukan DELETE), audit append-only |
| Konsolidasi/gabungan tanpa hak | `report.consolidated` + validasi cakupan di server |
| Race saat pencabutan | Validasi di awal request; satu request = jendela terkecil |
| Enumerasi | Respons 404 identik; rate limit yang sudah ada |
| Upaya ditolak tak terlihat | Audit `security.branch_access_denied` (dibatasi laju) |

---

## S. UPDATED DATABASE DESIGN

Prinsip: **pakai tabel yang ada bila bisa**. Tabel baru hanya yang tidak punya padanan.

### S.1 Penempatan (keputusan)
| Data | DB | Alasan |
|---|---|---|
| `branches`, `journal_entries.branch_id`, `accounts.inter_branch_role`, `inter_branch_transactions` | **company.db** | Dekat data akuntansi, ikut backup perusahaan, isolasi struktural antar perusahaan |
| `user_branch_access`, `delegations`, `delegation_branches`, perluasan `company_access` | **system DB** | Identitas & wewenang sudah di sini; perubahan akses cukup satu transaksi (+ audit sistem) tanpa transaksi lintas file; restore company.db lama tidak mengembalikan hak akses lama |
Konsekuensi: tidak ada FK lintas file → `branch_id` di system DB divalidasi aplikasi terhadap company.db saat **menulis**, dan resolver **mengabaikan** id yang tak dikenal saat **membaca** (fail-closed). Cabang tidak pernah dihapus fisik sehingga tidak ada id menggantung.

### S.2 company.db
**`branches`** (baru)
| Kolom | Tipe | Null | Default | Catatan |
|---|---|---|---|---|
| id | string PK | N | uuid | |
| code | string | N | | UNIQUE (termasuk yang soft-deleted → kode dicadangkan) |
| name | string | N | | |
| status | string | N | 'ACTIVE' | CHECK IN ('ACTIVE','INACTIVE','CLOSED') |
| is_head_office | boolean | N | false | UNIQUE parsial: hanya satu true; tak bisa INACTIVE/CLOSED/dihapus |
| address, phone | string | Y | | |
| sort_order | integer | N | 0 | urutan kolom laporan |
| opened_at | date | Y | | |
| closed_at, closed_by, close_reason | date/string/text | Y | | wajib terisi saat CLOSED (CHECK) |
| reopened_at, reopened_by | | Y | | |
| created_by, created_at, updated_at | | | now | |
| deleted_at, deleted_by | | Y | | soft delete, hanya bila belum pernah dipakai |
| (tidak ada `company_id`) | | | | satu file = satu perusahaan (ADR-001); isolasi struktural |
Index: `status`, `sort_order`. Trigger: tolak `DELETE`; tolak ubah `code`/`is_head_office` setelah dipakai; tolak ubah status Kantor Pusat.
Keamanan: tabel read-mostly; semua tulis lewat service + audit; tidak berisi data sensitif.

**Perluasan tabel yang ada** (tanpa tabel baru)
| Tabel | Kolom | Tujuan |
|---|---|---|
| `journal_entries` | `branch_id` (FK→branches, RESTRICT; index `(branch_id, entry_date)`) | dimensi akuntansi; trigger menolak NULL & menolak UPDATE `branch_id` pada jurnal POSTED/REVERSED |
| `company_audit_log` | `branch_id` (nullable, index) | audit per cabang |
| `accounts` | `inter_branch_role` ('receivable'/'payable'/NULL) | dasar eliminasi |
| `statement_lines` | `line_kind`, `formula` | Report Group (tabel sudah ada) |
| `company_profile` | `multi_branch_enabled` boolean default false | **pengaman rilis** (lihat U) |
| `inter_branch_transactions` (baru, Phase 6) | seperti desain bagian D | pasangan jurnal atomik |

### S.3 system DB
**`company_access`** (ada) → tambah: `branch_scope` ('ALL'|'LIMITED', default 'ALL'), `default_branch_id` (nullable; preferensi). Default 'ALL' → pengguna lama tidak berubah.

**`user_branch_access`** (baru) — relasi user↔cabang
| Kolom | Tipe | Null | Catatan |
|---|---|---|---|
| id | string PK | N | |
| company_id | string FK→companies_registry | N | denormalisasi untuk isolasi & kueri; dicocokkan dengan `company_access` |
| access_id | string FK→company_access | N | identitas user di perusahaan itu |
| branch_id | string | N | id di company.db (tanpa FK lintas file) |
| status | string | N | 'ACTIVE'/'REVOKED' (tidak ada DELETE; riwayat utuh) |
| granted_by, granted_at | | N | siapa & kapan |
| granted_via_delegation_id | string FK→delegations | Y | jejak asal wewenang |
| revoked_by, revoked_at, revoke_reason | | Y | |
Unique parsial: `(access_id, branch_id) WHERE status='ACTIVE'`. Index: `(company_id, branch_id)`, `access_id`.
Keamanan: ini **tabel otorisasi** — hanya service `user-branch-access` yang menulis; semua tulis dalam transaksi bersama audit.

**`delegations`** (baru)
| Kolom | Tipe | Null | Catatan |
|---|---|---|---|
| id | string PK | N | |
| company_id | FK→companies_registry | N | |
| grantee_access_id | FK→company_access | N | penerima |
| granted_by_access_id | FK→company_access | N | pemberi |
| can_manage_users, can_manage_branch_info, can_view_branch_reports, can_inter_branch | boolean | N | kapabilitas tetap |
| max_role | string | N | CHECK IN ('VIEWER','STAFF','ACCOUNTANT') (tidak pernah ADMIN/OWNER) |
| starts_at, expires_at | timestamp | N/Y | |
| status | string | N | 'ACTIVE'/'REVOKED'/'EXPIRED' |
| reason | text | Y | |
| revoked_by, revoked_at | | Y | |
| created_at, updated_at | | N | |
Index: `(company_id, grantee_access_id, status)`. Tidak ada kolom "re-delegasi" (kedalaman 1 ditegakkan oleh tiadanya fitur).

**`delegation_branches`** (baru): `(delegation_id FK CASCADE, branch_id)`, UNIQUE keduanya.

**`audit_log`** (system, ada) → tambah `target_user_id` (nullable) dan `branch_id` (nullable); sisanya sudah ada: `actor_id`, `company_id`, `action`, `before_json`=old_value, `after_json`=new_value, `created_at`, `reason`. Event baru memakai `entity_type`: `branch`, `user_branch_access`, `delegation`, `branch_context`.

### S.4 Tabel yang diminta tetapi **tidak** dibuat
- `users.branch_id` — **ditolak** (menyalahi persyaratan #4).
- `audit_logs` baru — **tidak perlu**, dua infrastruktur audit yang ada diperluas.
- `permissions` per-user — **tidak perlu**: peran tetap sebagai paket; delegasi memakai kapabilitas tetap.

### S.5 Permission (selaras dengan RBAC yang ada: huruf kecil bertitik)
Yang sudah ada dipakai ulang: `users.read` (=USER_VIEW), `users.manage` (=USER_CREATE/UPDATE/DISABLE), `report.read` (=REPORT_BRANCH_VIEW), `journal.*`.
**Baru (10):**
| Permission | Setara permintaan | OWNER | ADMIN | ACCOUNTANT | STAFF | VIEWER |
|---|---|---|---|---|---|---|
| `branch.read` | BRANCH_VIEW | ✓ | ✓ | ✓ | ✓ | ✓ |
| `branch.manage` | CREATE/UPDATE/ACTIVATE | ✓ | ✓* | | | |
| `branch.close` | BRANCH_CLOSE | ✓ | ✓* | | | |
| `branch.reopen` | BRANCH_REOPEN | ✓ | | | | |
| `user_branch.manage` | GRANT/REVOKE/TRANSFER | ✓ | ✓* | | | |
| `delegation.manage` | DELEGATION_CREATE/REVOKE | ✓ | | | | |
| `interbranch.read` | INTER_BRANCH_VIEW | ✓ | ✓ | ✓ | | |
| `interbranch.create` | INTER_BRANCH_CREATE | ✓ | ✓ | ✓ | | |
| `interbranch.reverse` | INTER_BRANCH_REVERSE | ✓ | ✓ | | | |
| `report.consolidated` | REPORT_CONSOLIDATED_VIEW | ✓ | ✓ | ✓ | | |
`*` = hanya pada cabang dalam cakupan/delegasinya; `branch.create` dan `branch.close` untuk ADMIN-LIMITED **tidak** berlaku (membuat/menutup cabang = ALL saja).
`interbranch.create` **tidak diberikan ke STAFF/VIEWER**, dan **bukan hasil otomatis dari multi-cabang**: user harus ACCOUNTANT ke atas **dan** memegang kedua cabang. Bila klien butuh pemberian per-orang di luar peran, jalur upgrade = tabel `user_permission_grants` (ditandai, tidak dibangun sekarang).

---

## T. UPDATED TEST PLAN

Gabungan test plan bagian I (35 kasus) + 31 kasus baru berikut + tambahan.

**Branch lifecycle**
1 buat cabang (ACTIVE dan INACTIVE) · 2 ubah info · 3 nonaktifkan: jurnal baru ditolak, data lama tampil · 4 tutup: checklist (draft ada → ditolak; saldo antar-cabang ≠ 0 → ditolak; alasan wajib) · 5 reopen oleh OWNER dengan alasan; ADMIN ditolak · 6 hapus cabang bertransaksi ditolak; soft delete hanya cabang tak terpakai; DELETE fisik ditolak trigger · 7 jurnal/import/opening balance ke cabang CLOSED/INACTIVE ditolak · +: Kantor Pusat tak bisa INACTIVE/CLOSED/dihapus; kode duplikat termasuk yang soft-deleted; transisi ilegal ditolak.

**User access**
8 grant · 9 revoke (riwayat tetap, baris REVOKED) · 10 transfer atomik (gagal separuh → tidak ada perubahan) · 11 user multi-cabang · 12 user satu cabang (tanpa dropdown) · 13 ganti konteks sah · 14 ganti konteks ke cabang tak berizin → 403 · +: LIMITED tanpa cabang = kosong (fail-closed); grant ke cabang CLOSED ditolak; tidak bisa ubah akses diri sendiri; OWNER terakhir tidak bisa dibatasi; cabang baru tidak otomatis muncul untuk LIMITED.

**Delegasi**
15 owner mendelegasi · 16 admin bertindak dalam cakupan · 17 di luar cakupan → 403 (Pusat, cabang tak dimiliki, scope ALL) · 18 tak bisa naik peran/permission, tak bisa jadi OWNER, tak bisa ubah diri sendiri · 19 pencabutan delegasi (kewenangan hilang seketika; opsi cabut grant turunan) · 20 audit trail lengkap · +: re-delegasi ditolak; kedaluwarsa otomatis; hak efektif menyusut saat akses delegator berkurang; ADMIN-ALL lama tetap berfungsi tanpa delegasi.

**Security**
21 lintas perusahaan · 22 IDOR cabang · 23 IDOR user access (id grant/delegasi milik perusahaan/user lain) · 24 `branch_id` palsu (body/query/header konteks) · 25 `company_id` palsu (diabaikan) · 26 laporan konsolidasi tanpa hak → 403; "Gabungan Cabang Terpilih" berlabel · 27 pencabutan berlaku di request berikutnya, termasuk saat sesi masih hidup · +: matriks otomatis (peran × scope × **seluruh** route perusahaan) agar route baru tak bisa lupa memeriksa; pencarian global/audit log/export tidak bocor; 404 identik "ada vs tidak ada"; jumlah/paginasi tidak membocorkan baris cabang lain; uji legacy route.

**Historical integrity**
28 transfer user tidak mengubah jurnal lama · 29 penutupan cabang tidak menghapus data · 30 laporan cabang CLOSED tetap benar & seimbang · 31 reopen tidak merusak data · +: `branch_id` jurnal POSTED tidak dapat diubah (trigger); draft pasca-transfer tetap milik cabang asal; konsolidasi tetap memuat cabang CLOSED pada periode historis.

**Audit**
Satu tes per event: `BRANCH_CREATED/UPDATED/DEACTIVATED/CLOSED/REOPENED`, `USER_BRANCH_ACCESS_GRANTED/REVOKED`, `USER_BRANCH_TRANSFERRED`, `DELEGATION_CREATED/UPDATED/REVOKED`, `ACTIVE_BRANCH_CHANGED` — memuat actor, target, company, branch, old/new, waktu; penulisan audit gagal → perubahan ikut rollback (pola yang sudah ada).

**Regresi**: seluruh 619 tes backend tetap hijau dengan `multi_branch_enabled = false`; pengguna dan perusahaan lama tidak melihat perubahan apa pun.

---

## U. UPDATED IMPLEMENTATION PHASES

### U.1 Penyesuaian urutan (alasan dependensi)
Urutan yang Anda usulkan hampir benar. Perubahan yang saya rekomendasikan:
1. **Resolver otorisasi (inti Phase 3) dibutuhkan oleh Phase 2.** Jurnal tak boleh menerima `branch_id` tanpa memvalidasi konteks terhadap akses. Maka Phase 2 membawa **versi minimal resolver** (satu cabang valid, semua user ALL), Phase 3 melengkapinya.
2. **Pengaman rilis:** flag `company_profile.multi_branch_enabled` (default **false**). Selama Phase 1–3 belum lengkap, tak seorang pun bisa membuat cabang kedua → tidak ada jendela di mana cabang ada tetapi data belum terlindungi.
3. **Otorisasi (Phase 3) sebelum Reporting (Phase 5)** — laporan butuh validasi scope.
4. **Report Group (klasifikasi laporan) bersifat independen** dan bisa dikerjakan paralel kapan saja setelah Phase 2.
5. **UI dibangun tipis di tiap phase** (tanpa UI fitur tak dapat di-UAT oleh klien); Phase 8 menjadi pemolesan/UX review, bukan pembangunan awal.
6. **Security & regression bersifat terus-menerus**: tiap phase punya gerbang tes keamanannya; Phase 9 adalah penutup menyeluruh.

### U.2 Phase
| Phase | Isi | Bergantung pada | Gerbang keluar |
|---|---|---|---|
| **1 — Branch Master + Lifecycle** | `branches`, Kantor Pusat otomatis, status ACTIVE/INACTIVE/CLOSED, closing checklist, soft delete, permission `branch.*`, audit event cabang, flag `multi_branch_enabled`; UI tipis Pengaturan→Cabang | — | tes lifecycle 1–7, audit; 619 tes lama hijau |
| **2 — Branch Dimension pada Journal** | `journal_entries.branch_id` + migrasi idempotent + trigger, validasi (cabang ACTIVE, konteks), reversal mewarisi cabang, opening balance per cabang, import kolom Cabang (opsional), resolver minimal | 1 | tes jurnal 6–10, migrasi 31–35, laporan lama identik angka demi angka |
| **3 — Multi-Branch User Access** | `branch_scope`, `user_branch_access`, resolver penuh, konteks aktif + preferensi, Add/Remove/Transfer, penerapan pada **semua** route (fail-closed), pencarian/audit log/export, UI: header branch switcher + manajemen akses user | 2 | tes akses 8–14, keamanan 21–27, matriks seluruh route |
| **4 — Delegated Authority** | `delegations`, `assertDelegationBoundary`, pembatasan 5 route `company-access`, UI delegasi | 3 | tes delegasi 15–20 |
| **5 — Branch-Aware Reporting** | `scope` pada fungsi dasar, Individual/Comparison/Consolidated(sementara tanpa eliminasi), Previous/Mutation/Growth, Report Group (paralel), dashboard | 3 (validasi scope) | tes laporan 11–19, Σcabang = Gabungan |
| **6 — Inter-Branch Transactions** | tabel + service atomik + `inter_branch_role` + reversal berpasangan + rekonsiliasi; permission `interbranch.*` | 2, 3 | tes 25–28 |
| **7 — Consolidation & Elimination** | eliminasi di lapisan laporan, selisih eliminasi, "Gabungan Cabang Terpilih" | 5, 6 | tes 29–30 |
| **8 — UI/UX polish** | konsistensi, empty state, bahasa, panduan klien/PDF, UAT bersama klien | 1–7 | UAT disetujui |
| **9 — Security & Regression (penutup)** | UAT penuh, security regression, installer scan, Electron build, pengujian beban kecil | semua | laporan akhir |

### U.3 Peta UI (ringkas, sesuai permintaan #22–25)
- **Header:** `TERRA FINANCE · [PT ABC ▼] · [📍 Cabang Metro ▼] · User`. Dropdown cabang hanya bila user punya >1 cabang operasional ACTIVE; satu cabang → label statis; perusahaan tanpa cabang tambahan (`multi_branch_enabled=false` / hanya Kantor Pusat) → **tidak ada elemen cabang sama sekali** (pengguna lama tidak melihat perubahan).
- **Pengaturan → Cabang:** tabel `Kode | Cabang | Status | Pengguna | Dibuat | Aksi`; aksi *Lihat/Ubah/Aktifkan/Nonaktifkan/Tutup/Buka kembali* hanya tampil bila berwenang (backend tetap menegakkan).
- **Pengguna → klik user:** daftar centang cabang + tombol *Beri akses / Cabut / Pindahkan*; hanya cabang dalam wewenang aktor yang bisa diubah (lainnya tampil abu-abu "di luar wewenang Anda").
- **Delegasi:** kartu "Dapat mengelola ✓ / Tidak dapat mengelola ✗" dengan bahasa awam, daftar cabang cakupan, masa berlaku, tombol Cabut + daftar "akses yang diberikan lewat delegasi ini".
- Aturan UI proyek tetap: warna solid, tanpa bayangan/gradient.

---

## V. FINAL ARCHITECTURE DECISION

### **Apakah desain ini cukup proper untuk mulai implementation?**

# **READY FOR IMPLEMENTATION** — mulai dari Phase 1 (lalu 2), **belum coding sampai Anda menyetujui**.

**Mengapa sudah cukup proper**
- Cabang diperlakukan sebagai bagian dari **Organisasi, Akuntansi, Otorisasi, Pelaporan, Manajemen User, dan Audit** — bukan sekadar filter laporan.
- Seluruh requirement #1–#27 terjawab: lifecycle (ACTIVE/INACTIVE/CLOSED, reopen, tanpa hard delete), akses banyak-ke-banyak, konteks aktif ≠ akses ≠ report scope, delegasi dengan batas tegas, transfer atomik tanpa mengubah riwayat, pencabutan seketika, isolasi perusahaan struktural, audit 12 event.
- **Memakai infrastruktur yang sudah ada:** `company_access`, `canManageRole`/Owner Protection, dua audit log, upgrade-saat-start dengan backup, pola 404, `statement_lines`. Tabel baru hanya 6 (`branches`, `inter_branch_transactions`, `user_branch_access`, `delegations`, `delegation_branches`, dan Report Group memakai tabel lama) dan tidak ada engine laporan/dashboard kedua.
- Tidak over-engineered: **tanpa DRAFT, tanpa role per-cabang, tanpa permission per-user, delegasi kedalaman 1, kapabilitas delegasi tetap 4 macam.**
- Pengaman rilis `multi_branch_enabled` + default `ALL` menjamin pengguna dan perusahaan yang ada **tidak berubah sama sekali** sampai fitur dinyalakan.

**Hal yang masih terbuka (tidak memblokir Phase 1–2, perlu dijawab sebelum Phase yang disebut)**
| # | Pertanyaan | Dibutuhkan sebelum | Rekomendasi |
|---|---|---|---|
| 1 | Role per-cabang (ACCOUNTANT di Metro, VIEWER di Bandar) diperlukan? | Phase 3 | Tidak sekarang |
| 2 | `interbranch.create` per-orang di luar peran? | Phase 6 | Cukup ACCOUNTANT ke atas + akses kedua cabang |
| 3 | Closing checklist: saldo neraca non-nol saat tutup — blokir atau peringatan? | Phase 1 | Blokir hanya draft & saldo antar-cabang; lainnya peringatan |
| 4 | "Gabungan Cabang Terpilih" untuk user multi-cabang parsial? | Phase 5 | Ya, berlabel tegas |
| 5 | Siapa boleh reopen? | Phase 1 | OWNER saja |
| 6 | Pertanyaan K.2 sebelumnya (#1–#6) dan COA riil SPBU | Phase 5–6 | — |

**Risiko terbesar (diperbarui):** (1) kebocoran lintas cabang pada ±51 route + pencarian/audit/export — dijaga resolver tunggal, fail-closed, dan matriks tes seluruh route; (2) **eskalasi lewat delegasi** — dijaga satu fungsi batas + irisan hak + kedalaman 1; (3) migrasi data lama — dijaga idempotent + backup `pre-upgrade` + verifikasi hash.

**BERHENTI. Tidak ada kode, migration, schema, UI, atau report engine yang diubah. Menunggu approval berikutnya.**


---

# REVISI 3 — KEPUTUSAN PRODUK DARI PEMILIK (2026-10-06)

Jawaban atas pertanyaan terbuka bagian V. **Keputusan ini mengikat dan menggantikan bagian sebelumnya bila bertentangan.**

| # | Keputusan | Dampak desain |
|---|---|---|
| 1 | **Tidak ada role per-cabang.** Peran sama di semua cabang. **Transaksi kompleks (terutama modal) hanya di Kantor Pusat.** Tiap cabang punya saldo sendiri, **COA sama untuk semua**. | Role tetap satu per user per perusahaan (sesuai N.1). **Fitur baru: akun "khusus pusat"** — kolom `accounts.branch_restriction` ('HEAD_OFFICE_ONLY' / NULL). Jurnal di cabang non-pusat yang memuat akun itu **ditolak di server** (jurnal manual, import, opening balance). Default usulan: semua akun bertipe EQUITY + akun antar-cabang; pemilik dapat menandai akun lain. Saldo per cabang sudah dicakup desain (branch_id di jurnal, COA tunggal). |
| 2 | **Belum dipahami** → dijelaskan di bawah; usulan: transaksi antar-cabang **hanya dibuat oleh pengguna Kantor Pusat**. | Menunggu konfirmasi. Bila disetujui, `interbranch.create` hanya untuk user yang punya akses Kantor Pusat (+ peran ACCOUNTANT ke atas). |
| 3 | **Cabang CLOSED: tidak boleh ada jurnal, kecuali dijalankan sistem atau merupakan dampak jurnal dari pusat.** | Mengubah M.2: CLOSED menolak semua jurnal **buatan user cabang** (manual/import/opening), tetapi menerima jurnal **berasal sistem** atau **sisi cabang dari transaksi antar-cabang yang dibuat pusat**. Lihat rincian di bawah. |
| 4 | **Ya** — "Gabungan Cabang Terpilih" untuk user dengan akses sebagian cabang, berlabel tegas bukan konsolidasi perusahaan. | Sesuai Q.3, tidak berubah. |

## Rincian keputusan #3: pengecualian CLOSED yang terkontrol
Agar pengecualian tidak menjadi celah, hanya dua jalur yang diizinkan, keduanya ditandai di data:

| Jalur | Syarat | Contoh |
|---|---|---|
| **Sistem** | `journal_entries.origin = 'system'`, dihasilkan proses internal (bukan input user), tercatat audit dengan `actor_type='system'` | proses penutupan otomatis, penyesuaian sistem |
| **Dampak dari pusat** | `origin = 'head_office_effect'`: sisi cabang dari **satu transaksi antar-cabang yang dibuat user Kantor Pusat**, tertaut ke jurnal pusat dalam **satu transaksi atomik** | pusat menarik sisa kas cabang yang ditutup; pusat menyelesaikan saldo antar-cabang |
- User cabang (walau punya akses cabang itu) **tetap tidak bisa** membuat jurnal ke cabang CLOSED.
- Jurnal tidak bisa berdiri sendiri di cabang CLOSED: harus tertaut ke transaksi antar-cabang yang jurnal pusatnya ikut dibuat.
- Reversal jurnal lama di cabang CLOSED mengikuti aturan yang sama (hanya lewat pusat/sistem).
- Alasan wajib + audit `BRANCH_CLOSED_POSTING` pada setiap jurnal pengecualian.
- **Efek positif:** checklist penutupan (M.4) menjadi lebih ringan — saldo antar-cabang tidak perlu nol **sebelum** CLOSED, karena pusat boleh menyelesaikannya **setelah** CLOSED lewat jalur ini. Usulan: aksi "Tutup cabang" menyediakan opsi *Selesaikan saldo ke Kantor Pusat* (jurnal penyelesaian otomatis, satu transaksi).
- Status INACTIVE: mengikuti aturan yang sama dengan CLOSED (menunggu konfirmasi).


---

# REVISI 4 — TRANSAKSI ANTAR-CABANG DENGAN PERSETUJUAN CABANG LAWAN (2026-10-06)

Keputusan pemilik untuk pertanyaan #2: **Opsi C — staf cabang boleh mengajukan, cabang lawan harus menyetujui.** Bagian ini menggantikan E.2 (pembuatan langsung), Phase 6 di U.2, dan baris `interbranch.*` di S.5 bila bertentangan. Nilai bertanda **(usulan)** menunggu konfirmasi.

## W.1 Prinsip: proposal dulu, jurnal baru ada setelah disetujui
```
PENDING_APPROVAL --(setuju, 1 transaksi DB)--> POSTED   (2 jurnal terbentuk bersamaan)
      |--(tolak, alasan wajib)---------------> REJECTED
      |--(pengaju membatalkan)---------------> CANCELLED
      '--(lewat batas waktu)-----------------> EXPIRED
POSTED --(permintaan reversal disetujui)-----> REVERSED  (2 reversal bersamaan)
```
- **Selama PENDING tidak ada jurnal sama sekali** → tidak mempengaruhi Neraca, Laba Rugi, Arus Kas, Trial Balance, atau Dashboard cabang mana pun. Tidak mungkin ada "setengah transaksi" atau selisih eliminasi sementara; invarian *kedua sisi ada bersama atau tidak sama sekali* tetap utuh.
- Saat **disetujui**, kedua jurnal dibuat + diposting + ditautkan + diaudit dalam **satu `db.transaction`**; gagal di mana pun → semuanya rollback dan proposal tetap PENDING dengan pesan penyebab.
- Persetujuan **idempotent**: `UPDATE ... SET status='POSTED' WHERE id=? AND status='PENDING_APPROVAL'`; bila 0 baris berubah, tidak ada jurnal dibuat (mencegah dobel-klik / dua penyetuju).

## W.2 Siapa melakukan apa
| Aksi | Siapa | Permission | Syarat cabang |
|---|---|---|---|
| Mengajukan | STAFF ke atas | `interbranch.create` | punya akses cabang **pengaju**, cabang ACTIVE |
| Membatalkan | pengaju (atau OWNER/ADMIN cabang pengaju) | `interbranch.create` | status PENDING |
| Menyetujui / menolak | user cabang **lawan** | `interbranch.approve` **(usulan: ACCOUNTANT ke atas)** | punya akses cabang lawan, cabang ACTIVE |
| Meminta reversal | ACCOUNTANT ke atas | `interbranch.reverse` | akses ke salah satu cabang |
| Menyetujui reversal | user cabang lawan | `interbranch.approve` | |

- **Tidak boleh menyetujui proposal sendiri** (pengaju ≠ penyetuju), walau user itu memegang kedua cabang. Pengecualian **(usulan)**: hanya OWNER, dengan alasan wajib, ditandai `self_approved` dan tercatat di audit, agar perusahaan kecil dengan satu orang tidak buntu.
- Pengaju melihat proposal miliknya dan statusnya. Penyetuju melihat **proposal masuk** untuk cabang lawannya: jumlah, tanggal, keterangan, nama cabang/pengaju, dan **pratinjau jurnal sisi dirinya sendiri**, bukan jurnal internal pengaju. Tidak ada kebocoran data jurnal cabang lain.

## W.3 Isi proposal dan pemilihan akun
- Pengaju mengisi: tanggal, jumlah, keterangan, cabang lawan, akun sisi **sendiri** (mis. Kas), dan akun **usulan** untuk sisi lawan (mis. Beban listrik).
- **Penyetuju mengonfirmasi/memilih akun sisi dirinya sendiri** saat menyetujui **(usulan)** karena dialah yang tahu klasifikasi di cabangnya. Jumlah dan tanggal **tidak bisa diubah** (untuk mengubahnya: tolak, lalu pengaju mengajukan ulang). Perubahan akun dicatat (lama → baru).
- Akun Piutang/Utang Antar Cabang **ditentukan sistem** dari flag `inter_branch_role`, bukan dipilih manual.
- Aturan **akun khusus pusat** (Revisi 3 #1) berlaku untuk kedua sisi dan divalidasi **saat disetujui**.
- **Koreksi atas Revisi 3:** akun antar-cabang diberi pembatasan `SERVICE_ONLY` (hanya boleh diposting oleh layanan antar-cabang), bukan `HEAD_OFFICE_ONLY`. Dengan begitu staf cabang tidak bisa menjurnal manual ke akun itu (rekonsiliasi terjaga), sementara proposal dari cabang non-pusat tetap sah. Nilai `accounts.branch_restriction`: `HEAD_OFFICE_ONLY | SERVICE_ONLY | NULL`.

## W.4 Validasi pada dua waktu
| Saat mengajukan | Saat menyetujui (diulang, karena keadaan bisa berubah) |
|---|---|
| kedua cabang ada dan berbeda, pengaju ACTIVE | kedua cabang **masih ACTIVE** |
| jumlah > 0 (integer cent, BigInt), tanggal valid | periode untuk tanggal itu **masih OPEN** |
| akun valid dan tidak terkunci | kebijakan tanggal (tidak masa depan, batas backdate) **masih lolos** |
| pengaju berwenang | akun masih aktif/tak terkunci; aturan akun khusus pusat; penyetuju berwenang dan ≠ pengaju |

Bila validasi saat menyetujui gagal, proposal **tidak diam-diam diubah**: tetap PENDING dengan pesan jelas; pengaju diminta mengajukan ulang bila tanggal/periode sudah tidak sah. Tanggal jurnal = tanggal proposal (bukan tanggal persetujuan), agar pengajuan akhir bulan tidak berpindah periode tanpa disadari; batas waktu persetujuan menjaga hal ini.

## W.5 Batas waktu, periode, dan cabang yang berubah status
- **Kedaluwarsa (usulan): 14 hari** → EXPIRED, dievaluasi saat dibaca/diterapkan (tanpa cron).
- **Penutupan periode:** proposal PENDING bertanggal di periode itu **memblokir penutupan** (seperti jurnal DRAFT hari ini).
- **Cabang pengaju/lawan menjadi INACTIVE/CLOSED saat PENDING:** proposal tidak dapat disetujui user cabang → otomatis CANCELLED/EXPIRED pada evaluasi berikutnya, dengan alasan tercatat.
- **Cabang lawan CLOSED (Revisi 3 #3):** jalur *dampak dari pusat* — hanya **user pusat** yang boleh mengajukan ke cabang CLOSED, **persetujuan cabang lawan dilewati** (tak ada operator aktif di sana); jurnal sisi cabang bertanda `origin='head_office_effect'`, alasan wajib, audit khusus.
- Pengajuan **dari pusat ke cabang ACTIVE** **(usulan)** tetap memerlukan persetujuan cabang itu (aturan seragam).

## W.6 Reversal
Memakai alur yang sama: ACCOUNTANT ke atas mengajukan *permintaan reversal* (alasan wajib) → cabang lawan menyetujui → kedua jurnal di-reverse atomik; tolak/batal/kedaluwarsa seperti proposal biasa. Reversal satu sisi saja tetap **ditolak**. Cabang CLOSED mengikuti jalur pusat.

## W.7 Konsolidasi
Hanya transaksi berstatus POSTED yang menciptakan saldo antar-cabang, sehingga Σpiutang = Σutang selalu terjaga dan eliminasi bersih. Laporan gabungan menampilkan **peringatan informatif**: "N transaksi antar-cabang menunggu persetujuan (total X)" — angka itu belum masuk laporan.

## W.8 Perubahan database (menggantikan tabel `inter_branch_transactions` di D.1)
**`inter_branch_transactions`** (company.db): `id`, `transaction_no` (UNIQUE), `kind` ('TRANSFER'/'REVERSAL'), `original_transaction_id` (untuk reversal), `transaction_date`, `from_branch_id`, `to_branch_id` (CHECK berbeda), `amount` decimal(18,2) CHECK > 0, `description`, **`status`** ('PENDING_APPROVAL','POSTED','REJECTED','CANCELLED','EXPIRED','REVERSED'), `proposed_by`, `proposed_at`, `expires_at`, `decided_by`, `decided_at`, `decision_reason`, `self_approved` boolean, `origin` ('branch'/'head_office_effect'), `from_journal_id` / `to_journal_id` (**NULL sampai POSTED**, UNIQUE bila ada, FK→journal_entries RESTRICT), `idempotency_key` UNIQUE.
**`inter_branch_transaction_lines`** (baru): `transaction_id` FK, `side` ('FROM'/'TO'), `account_id`, `debit`, `credit`, `memo`, `line_order` — baris yang kelak dijadikan jurnal; divalidasi dengan aturan satu-sisi-per-baris yang sama (`assertLineShapes`) dan seimbang per sisi.
`journal_entries.origin` ('manual','import','system','head_office_effect','inter_branch') ditambahkan sebagai kolom baru (**CHECK `source` lama tidak diubah**, karena SQLite tidak bisa mengubah CHECK tanpa membangun ulang tabel).
Index: `(to_branch_id, status)` (kotak masuk persetujuan), `(from_branch_id, status)`, `(status, expires_at)`.

## W.9 Permission (menggantikan baris `interbranch.*` di S.5)
| Permission | OWNER | ADMIN | ACCOUNTANT | STAFF | VIEWER |
|---|---|---|---|---|---|
| `interbranch.read` (milik/kotak masuk cabangnya) | ✓ | ✓ | ✓ | ✓ | |
| `interbranch.create` (mengajukan/membatalkan) | ✓ | ✓ | ✓ | ✓ | |
| `interbranch.approve` (menyetujui/menolak) | ✓ | ✓ | ✓ | | |
| `interbranch.reverse` (minta reversal) | ✓ | ✓ | ✓ | | |

Semua selalu dibatasi akses cabang (bukan seluruh perusahaan). Kapabilitas delegasi `inter_branch` (O.3) mencakup mengajukan dan menyetujui untuk cabang cakupannya.

## W.10 Audit (event tambahan)
`INTER_BRANCH_PROPOSED`, `INTER_BRANCH_APPROVED`, `INTER_BRANCH_REJECTED`, `INTER_BRANCH_CANCELLED`, `INTER_BRANCH_EXPIRED`, `INTER_BRANCH_REVERSAL_REQUESTED/APPROVED`, `INTER_BRANCH_SELF_APPROVED`, `BRANCH_CLOSED_POSTING`. Memuat pengaju, penyetuju, kedua cabang, jumlah, perubahan akun, alasan.

## W.11 Tes tambahan (menggantikan #25–#30 di bagian I untuk alur ini)
1. Pengajuan staf → PENDING, **tidak ada jurnal**, laporan tak berubah.
2. Setuju → 2 jurnal POSTED sekaligus, masing-masing seimbang, tertaut.
3. Gagal di tengah persetujuan → rollback total, tetap PENDING.
4. Dobel-setuju (dua tab/dua user) → hanya satu pasang jurnal.
5. Tolak (alasan wajib), batal, kedaluwarsa → tanpa efek ke laporan.
6. Pengaju tak bisa menyetujui sendiri; OWNER override tercatat `self_approved`.
7. User cabang lain/perusahaan lain tak bisa melihat/menyetujui (IDOR → 404).
8. STAFF tak bisa menyetujui; VIEWER tak bisa mengajukan.
9. Periode ditutup / tanggal tak sah saat disetujui → ditolak dengan pesan jelas.
10. Cabang jadi INACTIVE/CLOSED saat PENDING.
11. Pusat → cabang CLOSED tanpa persetujuan, bertanda `head_office_effect`; user cabang tetap ditolak.
12. Akun khusus pusat / `SERVICE_ONLY` ditegakkan pada kedua sisi.
13. Penyetuju mengubah akun sisinya → tercatat; jumlah tidak bisa diubah.
14. Reversal berpasangan lewat persetujuan; satu sisi ditolak.
15. PENDING memblokir penutupan periode.
16. Eliminasi gabungan bersih (Σpiutang = Σutang) dan peringatan "menunggu persetujuan" tampil.
17. Kotak masuk persetujuan hanya memuat cabang lawan milik user.
18. Idempotency key mencegah pengajuan ganda.

## W.12 Dampak ke phase
**Phase 6 dipecah:** **6a** proposal + persetujuan + pembuatan jurnal atomik + validasi + audit + UI kotak masuk/pengajuan; **6b** reversal berpasangan + kedaluwarsa + blokir penutupan periode + jalur `head_office_effect` untuk cabang CLOSED. Kompleksitas Phase 6 naik dari menengah ke **menengah-tinggi**; Phase 7 (eliminasi) tidak berubah. Keputusan akhir **READY FOR IMPLEMENTATION tetap** — Phase 1–2 tidak terpengaruh.


---
---

# REVISI 5 — FINAL ARCHITECTURE (KONSOLIDASI) (2026-10-07)

**Bagian ini adalah acuan tunggal yang final.** Bila ada perbedaan dengan bagian A–W di atas, **Revisi 5 yang berlaku.** Bagian lama tetap disimpan sebagai jejak keputusan dan sebagai rincian pendukung (mis. analisis Excel, dependency map, desain Growth) yang tidak berubah.

## Z.0 Keputusan terkunci & temuan audit baru

### Keputusan pemilik yang dikunci
| # | Keputusan | Diterapkan di |
|---|---|---|
| 1 | Role sama di seluruh perusahaan; kewenangan cabang = **branch access + permission** | Z.2, Z.3 |
| 2 | Antar-cabang opsi C; flow WAITING_APPROVAL; reject wajib alasan; pengaju ≠ penyetuju kecuali OWNER; reversal mengikuti flow yang sama | Z.7 |
| 3 | Approval ditentukan **permission** (`interbranch.approve`), role hanya default | Z.3 |
| 4 | INACTIVE ≠ CLOSED | Z.1, Z.9 |
| 5 | Kebijakan akun per-akun (ALL_BRANCH / CENTRAL_ONLY / SYSTEM_ONLY / INTER_BRANCH), bukan hardcode "Equity" | Z.8 |
| 6 | Kedaluwarsa 14 hari = **konfigurasi**, bukan aturan hardcode | Z.7, Z.12 |
| 7 | "Gabungan Cabang Terpilih" berlabel tegas, bukan konsolidasi perusahaan | Z.6 |
| 8–10 | ACTIVE/INACTIVE/CLOSED; user→`user_branch_access`→branch; akses ≠ konteks ≠ report scope | Z.1, Z.2, Z.5, Z.6 |
| 11 | Delegasi kedalaman 1, hanya capability & cakupan yang dimiliki | Z.4 |
| 12 | CLOSED: manual ditolak; sistem & dampak pusat yang sah boleh; semua pengecualian ditandai & diaudit | Z.9 |

### Temuan audit baru (dasar keputusan di bawah)
| Temuan | Bukti di kode | Keputusan |
|---|---|---|
| **Account policy tidak punya padanan yang cocok di COA existing.** `account_subtype` adalah **teks bebas** (maks 50 karakter), diisi user lewat form & kolom import "Sub Tipe", dan **dipakai logika posting** (mis. `opening_balance_adjustment`). `is_system_account` hanya melindungi edit/hapus, bukan posting. `account_type` (9 tipe) terlalu kasar dan Anda minta tidak jadi satu-satunya mekanisme. | `accounts` punya pola kolom-atribut tersendiri: `cash_flow_activity`, `subledger_type`, `is_locked`, `is_system_account` (masing-masing dengan validasi di service dan kolom import) | **Tambah satu kolom `accounts.branch_policy`** mengikuti pola itu — bukan memperluas `account_subtype` (rawan salah ketik, mencampur dua makna) dan bukan tabel kebijakan terpisah (relasi 1:1, tidak perlu) |
| **Permission saat ini statis di kode** (`ROLE_PERMISSIONS`), `hasPermission(role, permission)` — tidak ada permission per-user | `db/system/rbac.ts`, `requirePermission` | Perlu lapisan **efektif**: role default ∪ GRANT − DENY (Z.3). Cukup mengubah **satu titik** (`requirePermission` + resolver), 51 route tidak diubah |
| **Pola pengaturan perusahaan sudah ada**: kolom di `company_profile` yang diatur OWNER (`max_backdate_days`, `fiscal_year_start_month`) | C0001, C0013 | Kedaluwarsa antar-cabang & flag multi-cabang menjadi kolom `company_profile` yang sama |
| **Konflik terdeteksi:** akun penyeimbang opening balance bertipe Equity; jika semua Equity = CENTRAL_ONLY, opening balance **cabang** tidak bisa diposting | `opening_balance_adjustment` di `modules/accounts/routes.ts` | Akun itu ber-policy `SYSTEM_ONLY`, diposting oleh proses sistem terdaftar (Z.8) |
| **Opening balance cabang bisa memuat saldo antar-cabang** (transisi dari operasi yang sudah berjalan, seperti baris "Perantara Aktiva Antar SPBU" di Excel) | Excel NERACA GAB baris 15 & 39 | Origin `opening_balance` diizinkan pada akun INTER_BRANCH, dengan pemeriksaan keseimbangan lintas cabang (peringatan bila Σpiutang ≠ Σutang) |

---

## Z.1 BRANCH LIFECYCLE (final)

**Status:** `ACTIVE`, `INACTIVE`, `CLOSED`. Tanpa DRAFT (alasan di M.1). Cabang boleh dibuat langsung ACTIVE atau INACTIVE.

**Transisi:** ACTIVE ↔ INACTIVE (`branch.manage`) · ACTIVE/INACTIVE → CLOSED (`branch.close`, alasan wajib, checklist) · CLOSED → ACTIVE (`branch.reopen`, **OWNER default**, alasan wajib, audit). Kantor Pusat tidak boleh INACTIVE/CLOSED/dihapus.

**Penghapusan:** tidak ada hard delete (trigger menolak `DELETE`). Cabang yang **tidak pernah** dipakai (nol jurnal, opening balance, antar-cabang, akses, audit selain pembuatannya) boleh **soft delete** (`deleted_at`), hanya OWNER; kode tetap dicadangkan.

### Matriks perilaku: **asal jurnal × status cabang**
Asal jurnal (`journal_entries.origin`) **ditetapkan server, tidak pernah dari body/query/header request.**

| Asal jurnal | ACTIVE | INACTIVE | CLOSED |
|---|---|---|---|
| `manual` / `import` / `opening_balance` (input user cabang) | ✓ | ✗ | ✗ |
| `inter_branch` — diajukan **oleh cabang itu** | ✓ (lewat approval) | ✗ | ✗ |
| `system` — proses sistem terdaftar (Z.1.1) | ✓ | ✓ *(ditandai)* | ✓ *(ditandai)* |
| `head_office_effect` — dampak transaksi yang diajukan **pusat** | ✓ (lewat approval cabang) | ✓ **dengan approval** *(ditandai)*; bila tak ada penyetuju yang memenuhi syarat, OWNER boleh **menanggalkan approval** dengan alasan wajib | ✓ **approval ditanggalkan otomatis**, alasan wajib *(ditandai)* |
| Reversal jurnal lama | oleh user berwenang | hanya jalur sistem/pusat | hanya jalur sistem/pusat |
| Melihat jurnal/laporan/audit historis | ✓ | ✓ | ✓ |
| Menjadi *active branch context* | ✓ | ✗ | ✗ |
| Grant akses baru | ✓ | ✗ | ✗ |

*(ditandai)* = setiap jurnal pengecualian: (a) `origin` ≠ `manual`, (b) `system_process` atau alasan terisi, (c) audit `BRANCH_NONACTIVE_POSTING` (jurnal id, status cabang saat itu, alasan, aktor/proses), (d) muncul di laporan "Pengecualian cabang tidak aktif".
**Kebijakan INACTIVE untuk transaksi pusat — diusulkan aman:** tetap butuh persetujuan cabang (INACTIVE belum ditutup, mungkin masih ada penyetuju); jalur penanggalan hanya OWNER + alasan. *Menunggu konfirmasi Anda (Z.16 #1).*

### Z.1.1 "Proses sistem yang sah" didefinisikan ketat
Bukan flag bebas, melainkan **daftar tertutup di kode** (`system_process`): `opening_balance_plug`, `branch_closure_settlement`, `period_closing`, `system_adjustment` (daftar ditambah hanya lewat perubahan kode + review). Jurnal `system` **tidak dapat dibuat lewat API user mana pun**; endpoint hanya menerima proses terdaftar yang dipanggil dari dalam server.

---

## Z.2 USER BRANCH ACCESS (final)

```
user (system_users) ─► company_access (role, branch_scope, default_branch_id)
                             └─► user_branch_access (branch_id, status, granted_by/at, revoked_by/at)
                                        └─► branches (company.db)
```
- `branch_scope`: **`ALL`** (semua cabang, termasuk yang dibuat kelak; wajib untuk OWNER) atau **`LIMITED`** (hanya baris `user_branch_access` ACTIVE). **LIMITED tanpa baris = tidak melihat apa pun (fail-closed).**
- Banyak cabang per user. Tidak ada `users.branch_id`. Role satu per user per perusahaan (keputusan #1).
- **Tiga operasi terpisah:** *Add Access*, *Remove Access* (baris → REVOKED, riwayat utuh), *Transfer* (cabut X + beri Y atomik, satu event). Aktor harus memegang cabang yang disentuh; tak boleh mengubah akses sendiri.
- Grant hanya ke cabang ACTIVE. Akses lama ke INACTIVE/CLOSED dipertahankan untuk melihat historis.
- Transfer tidak mengubah jurnal lama (`branch_id` jurnal ditetapkan saat dibuat, terkunci setelah POSTED).
- Akses dicabut → berlaku **di request berikutnya** (tanpa cache) dengan `BRANCH_CONTEXT_INVALID`, UI memindahkan user ke cabang sah lain atau layar "tanpa akses cabang".

---

## Z.3 PERMISSION MODEL (final)

### Z.3.1 Tiga lapis
```
Role (default bundle)  +  Permission override per user (GRANT/DENY, terbatas)  →  Effective permission
                                        ×
                          Branch access (di cabang mana berlaku)
```
**Effective = (default role ∪ GRANT) − DENY.** Role tetap tidak diubah (5 role). *Authority sebenarnya ditentukan permission efektif*, sehingga perusahaan dapat menentukan siapa yang boleh approve **tanpa mengubah struktur role** (keputusan #3).

### Z.3.2 Override: dibatasi dan aman
- Hanya permission dalam **allowlist "dapat di-override"** (operasional, berisiko rendah): `interbranch.read`, `interbranch.create`, `interbranch.approve`, `interbranch.reverse`, `report.consolidated`. Permission administratif (`branch.close`, `branch.reopen`, `delegation.manage`, `company.update`, `backup.*`, `users.manage`, `account.lock`) **hanya mengikuti role** — tidak bisa di-GRANT per orang. Allowlist bisa ditambah kelak lewat perubahan kode terkaji.
- **Yang boleh menetapkan override:** user dengan `users.manage` + batas yang sama dengan delegasi: hanya permission yang **ia sendiri miliki secara efektif**; hanya atas user yang cabangnya ⊆ cakupan aktor; tidak boleh atas diri sendiri; **tidak boleh DENY pada OWNER**; admin berdelegasi hanya dalam kapabilitas `manage_users`.
- Override bersifat per user per perusahaan; **cakupan cabang tetap dari branch access** (menyetujui antar-cabang hanya untuk cabang yang ia akses).
- Disimpan sebagai baris berstatus (GRANT/DENY, ACTIVE/REVOKED) di `access_permission_overrides` (system DB); tidak ada DELETE; audit `PERMISSION_OVERRIDE_GRANTED/DENIED/REVOKED`.

### Z.3.3 Titik penegakan tunggal
Resolver menghasilkan `request.effectivePermissions` sekali per request; `requirePermission(p)` memeriksa himpunan itu (bukan `hasPermission(role, p)` lagi). Perubahan terkonsentrasi di `company-access-guard.ts` + `rbac.ts`; **51 route tidak perlu diubah satu per satu**, dan tes matriks menjaga tidak ada route yang melompati guard.

### Z.3.4 Daftar permission (gaya penamaan existing: huruf kecil bertitik)
Pemetaan nama dari permintaan: `INTER_BRANCH_APPROVE` → `interbranch.approve`, `USER_BRANCH_GRANT/REVOKE/TRANSFER` → `user_branch.manage`, `BRANCH_VIEW` → `branch.read`, dst.

| Permission | OWNER | ADMIN | ACCOUNTANT | STAFF | VIEWER | Override? |
|---|---|---|---|---|---|---|
| `branch.read` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `branch.manage` (buat/ubah/aktif-nonaktif) | ✓ | ✓* | | | | – |
| `branch.close` | ✓ | ✓* | | | | – |
| `branch.reopen` | ✓ | | | | | – |
| `account.policy` (ubah kebijakan akun) | ✓ | | | | | – |
| `user_branch.manage` (grant/revoke/transfer) | ✓ | ✓* | | | | – |
| `delegation.manage` | ✓ | | | | | – |
| `interbranch.read` | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `interbranch.create` (mengajukan/membatalkan) | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `interbranch.approve` (setujui/tolak) | ✓ | ✓ | ✓ | | | ✓ |
| `interbranch.reverse` (minta reversal) | ✓ | ✓ | ✓ | | | ✓ |
| `report.consolidated` (gabungan/terpilih) | ✓ | ✓ | ✓ | | | ✓ |
`✓*` = hanya cabang dalam cakupan/delegasinya. Yang sudah ada tetap: `users.read/manage`, `report.read` (= laporan satu cabang dalam akses), `journal.*`, `account.*`, `company.*`, `backup.*`.
Default `interbranch.approve` untuk role hanyalah **titik awal**; perusahaan dapat mencabutnya dari akuntan tertentu atau memberikannya ke staf tertentu lewat override.

---

## Z.4 DELEGATION MODEL (final)

- **Kedalaman 1:** hanya OWNER (atau ADMIN `ALL` yang memegang `delegation.manage`) yang membuat delegasi; **penerima delegasi tidak dapat mendelegasikan lagi.**
- **Isi delegasi:** kapabilitas tetap `manage_users`, `manage_branch_info`, `view_branch_reports`, `inter_branch`; **cabang cakupan**; `max_role` (selalu di bawah penerima; tak pernah ADMIN/OWNER); masa berlaku opsional; status ACTIVE/REVOKED/EXPIRED.
- **Hak efektif = irisan(delegasi, akses penerima saat ini, permission efektif penerima saat ini).** Menyusut otomatis bila salah satunya berkurang.
- **Yang tidak pernah boleh dilakukan penerima delegasi:** memberi akses di luar cakupan; memberi `ALL`; menaikkan role dirinya atau orang lain di atas `max_role`/perannya; memberi permission yang tak ia miliki; mengubah akses/permission dirinya sendiri; membuat/menutup/membuka kembali cabang; mengelola OWNER; membuat delegasi.
- ADMIN lama = `ALL` otomatis → perilaku tidak berubah, tidak butuh delegasi. ADMIN `LIMITED` hanya bisa mengelola user lewat delegasi aktif.
- Pencabutan delegasi: kewenangan berhenti seketika; akses yang pernah diberikan penerima **tidak otomatis dicabut** (opsi "cabut juga", default mati, daftar tinjauan `granted_via_delegation_id`).
- Satu fungsi tunggal `assertDelegationBoundary` dipakai semua route pengelolaan user/akses/override (tidak tersebar).

---

## Z.5 ACTIVE BRANCH CONTEXT (final)
Konteks = **satu cabang ACTIVE** yang ada di akses user; **bukan permission.** Dikirim per request (`X-Branch-Context`), divalidasi server tiap request (perusahaan + akses + status); tidak disimpan di sesi (aman multi-tab). Preferensi terakhir di `company_access.default_branch_id` hanya kenyamanan, divalidasi ulang. Mengganti konteks tidak mengubah permission; audit `ACTIVE_BRANCH_CHANGED` hanya saat benar-benar berubah (dibatasi laju). Konteks hanya **default** untuk `branch_id` jurnal baru dan isi halaman operasional; `branch_id` jurnal tetap divalidasi sendiri terhadap akses & status (tidak otomatis mengikuti user). "Semua Cabang" bukan konteks dan bukan baris database.
Satu cabang → label statis (tanpa dropdown). Perusahaan tanpa cabang tambahan → tidak ada elemen cabang sama sekali.

## Z.6 REPORT SCOPE (final)
Parameter eksplisit `scope = branch:<id> | branches:<id,…> | consolidated`, divalidasi server.
| Pengguna | Boleh |
|---|---|
| Akses satu cabang | hanya cabang itu |
| Akses beberapa cabang + `report.consolidated` | satu cabang, **beberapa cabang (komparasi)**, **"Gabungan Cabang Terpilih"** |
| Akses **semua** cabang (scope ALL, atau LIMITED yang mencakup seluruhnya) + `report.consolidated` | + **Konsolidasi Perusahaan** |
| Tanpa `report.consolidated` | hanya satu cabang per laporan |
**Pelabelan wajib untuk "Gabungan Cabang Terpilih":** judul laporan **"GABUNGAN CABANG TERPILIH — bukan laporan konsolidasi perusahaan"**, daftar cabang yang tercakup di bawah judul, peringatan jika ada cabang perusahaan di luar pilihan, label yang sama di **export XLSX/PDF** dan pada nama file. Eliminasi antar-cabang hanya untuk pasangan yang **keduanya** di dalam pilihan; sisa saldo antar-cabang ke cabang di luar pilihan **ditampilkan sebagai baris "tidak dieliminasi"**. Label **"Konsolidasi Perusahaan"** hanya muncul bila seluruh cabang non-terhapus tercakup. Cabang INACTIVE/CLOSED dalam akses boleh dipilih di report scope (historis), tidak di konteks. Active branch menjadi nilai awal pilihan scope, bukan batas.

---

## Z.7 INTER-BRANCH APPROVAL (final)

**Status:** `WAITING_APPROVAL → POSTED | REJECTED | CANCELLED | EXPIRED`; `POSTED → REVERSED`. (Nama `WAITING_APPROVAL` menggantikan `PENDING_APPROVAL` di Revisi 4.)
- Pengajuan **tidak membuat jurnal**. Disetujui → kedua jurnal dibuat, diposting, ditautkan, diaudit dalam **satu `db.transaction`**; gagal → rollback, tetap WAITING_APPROVAL.
- **Penyetuju:** user dengan **permission efektif `interbranch.approve`** *dan* akses ke cabang lawan, cabang ACTIVE (atau jalur khusus Z.1). **Bukan** "Accountant ke atas" — role hanya default.
- **Pengaju ≠ penyetuju.** Pengecualian **hanya OWNER**, alasan wajib, ditandai `self_approved`, audit `INTER_BRANCH_SELF_APPROVED`.
- **Tolak:** alasan **wajib** (validasi server, minimal panjang). **Batal:** oleh pengaju selama menunggu.
- **Reversal** memakai alur yang sama (permintaan → cabang lawan menyetujui → kedua jurnal di-reverse atomik); reversal satu sisi **ditolak**.
- **Penyetuju** mengonfirmasi/memilih akun **sisinya sendiri**; jumlah & tanggal tak dapat diubah; perubahan akun tercatat.
- **Validasi diulang saat disetujui:** kedua cabang status sesuai matriks Z.1; periode OPEN; kebijakan tanggal; akun aktif/tak terkunci; **`branch_policy` kedua sisi**; wewenang penyetuju.
- **Kedaluwarsa = konfigurasi:** `company_profile.inter_branch_expiry_days` (default **14**, rentang 1–90, hanya OWNER mengubah, audit). `expires_at` **dihitung dan dibekukan saat pengajuan** (mengubah konfigurasi tidak mengubah pengajuan yang sudah berjalan). Evaluasi saat dibaca (tanpa cron).
- **Pengajuan WAITING_APPROVAL memblokir penutupan periode** yang memuat tanggalnya. Cabang yang berubah ke INACTIVE/CLOSED saat menunggu → pengajuan dari cabang itu dibatalkan otomatis (alasan tercatat).
- **Pusat → cabang:** ACTIVE = butuh approval; INACTIVE = butuh approval (OWNER dapat menanggalkan bila tak ada penyetuju, alasan wajib); CLOSED = approval ditanggalkan otomatis; semua yang ditanggalkan bertanda `head_office_effect` + audit.
- Laporan gabungan menampilkan peringatan "N pengajuan menunggu (total X)" — belum masuk angka laporan.
- Tabel & kolom: Z.12. Daftar tes: Z.14.

---

## Z.8 ACCOUNT POLICY (final)

### Z.8.1 Audit & keputusan desain
Lihat tabel Z.0: tidak ada konsep existing yang pas (`account_subtype` teks bebas & dipakai logika; `is_system_account` bukan aturan posting; `account_type` terlalu kasar). Maka **satu kolom atribut baru `accounts.branch_policy`**, mengikuti pola kolom-atribut COA yang sudah ada, dengan validasi di service dan di import COA.

```
accounts.branch_policy  TEXT NOT NULL DEFAULT 'ALL_BRANCH'
  CHECK (branch_policy IN ('ALL_BRANCH','CENTRAL_ONLY','SYSTEM_ONLY','INTER_BRANCH'))
accounts.inter_branch_role  TEXT NULL  CHECK IN ('receivable','payable')
  CHECK ((branch_policy = 'INTER_BRANCH') = (inter_branch_role IS NOT NULL))
```
Default `ALL_BRANCH` → **seluruh akun lama berperilaku sama persis**; semua jurnal lama berada di Kantor Pusat sehingga kebijakan tidak mengubah data historis.

### Z.8.2 Arti & penegakan (**kebijakan × asal jurnal × cabang jurnal**)
| Policy | `manual/import` | `opening_balance` | `system` | `inter_branch` / `head_office_effect` |
|---|---|---|---|---|
| **ALL_BRANCH** | ✓ cabang ACTIVE mana pun | ✓ | ✓ | ✓ (sisi mana pun) |
| **CENTRAL_ONLY** | ✓ **hanya jurnal Kantor Pusat** | ✓ hanya Pusat | ✓ hanya Pusat | ✓ hanya **sisi Pusat** |
| **SYSTEM_ONLY** | ✗ | ✗ *(kecuali baris penyeimbang oleh `opening_balance_plug`)* | ✓ proses terdaftar | ✗ |
| **INTER_BRANCH** | ✗ | ✓ *(saldo awal antar-cabang, dengan pemeriksaan keseimbangan)* | ✗ | ✓ hanya lewat layanan antar-cabang |
- Ditegakkan di **service jurnal** (saat buat draft **dan** saat post), **import jurnal, import opening balance, layanan opening balance, layanan antar-cabang (saat approve)** — bukan di UI. UI hanya menyaring pilihan akun sebagai kenyamanan.
- Pelanggaran → HTTP 400 kode `ACCOUNT_POLICY_VIOLATION` dengan pesan yang menyebut akun, kebijakan, dan cabang (bahasa awam). Seluruh jurnal ditolak (atomik).
- **Reversal mengecualikan pemeriksaan policy** karena mencerminkan jurnal asli; ditandai audit bila akun sejak itu berubah policy.
- **Perubahan policy** hanya OWNER (`account.policy`), alasan wajib, audit `ACCOUNT_POLICY_CHANGED`. Berlaku untuk posting **baru**; riwayat tak berubah. UI menampilkan jumlah posting lama yang akan "melanggar" kebijakan baru sebelum menyimpan.
- Akun `INTER_BRANCH` wajib berflag `inter_branch_role` (piutang/utang) → dasar eliminasi (bukan nama akun).
- **COA import:** kolom opsional "Kebijakan Cabang" (nilai tak dikenal → baris ditolak dengan pesan, seperti kolom "Aktivitas Arus Kas"); baris existing tidak diubah (perilaku "lewati" yang ada).
- **Saran awal (bukan otomatis):** saat fitur multi-cabang dinyalakan, layar *Rekomendasi kebijakan akun* mengusulkan: akun Ekuitas (Modal, Laba Ditahan, dst.) → `CENTRAL_ONLY`; akun penyeimbang opening balance → `SYSTEM_ONLY`; Piutang/Utang Antar Cabang → `INTER_BRANCH`; sisanya `ALL_BRANCH`. OWNER meninjau dan menerapkan; tidak ada kebijakan yang diubah diam-diam.

---

## Z.9 BRANCH CLOSURE (final)
Alur **Tutup Cabang** (`branch.close`):
1. **Checklist.** *Blokir:* jurnal DRAFT di cabang itu; pengajuan antar-cabang WAITING_APPROVAL yang melibatkannya (batalkan/selesaikan dulu). *Peringatan (boleh lanjut, tercatat):* saldo kas/bank/persediaan/antar-cabang ≠ 0.
2. **Opsi *Selesaikan saldo ke Kantor Pusat*:** membuat jurnal penyelesaian otomatis (`system_process = branch_closure_settlement` / pasangan `head_office_effect`) dalam **satu transaksi**, ditandai & diaudit.
3. Status → **CLOSED** (alasan wajib, `closed_at/by`). Konteks user yang menunjuk cabang itu direset; akses lama tetap untuk melihat historis; grant baru ditolak.
4. **Sesudah CLOSED:** jurnal manual/import/opening dari cabang **ditolak**; pengecualian hanya `system` dan `head_office_effect` (matriks Z.1), semuanya ditandai + diaudit; seluruh data historis, laporan, dan audit tetap dapat dibuka; cabang tetap ikut konsolidasi untuk periode historisnya.
5. **Reopen:** `branch.reopen` (OWNER), alasan wajib, audit `BRANCH_REOPENED`; tidak menyentuh data.
6. Penutupan periode tetap level perusahaan.

---

## Z.10 AUTHORIZATION FLOW (final)

### Z.10.1 Alur setiap request ke `/api/company-db/:companySlug/*`
```
1  requireAuth ................ identitas sesi sah?                      → 401
2  requireCompanyAccess ....... slug→registry aktif? company_access ACTIVE? → 404 (seragam)
3  resolveBranchAuthority ..... baca TIAP request (tanpa cache):
      role, branch_scope, user_branch_access ACTIVE, status cabang (company.db),
      delegasi aktif/kedaluwarsa, override permission (GRANT/DENY)
      → effectivePermissions, accessibleBranches, operationalBranches, delegation
4  requirePermission(p) ....... p ∈ effectivePermissions?               → 403 PERMISSION_DENIED
5  Branch rule (per kelas route):
      baca/daftar : filter query ke cabang dalam akses/scope
      by-id       : ambil baris → branch ∈ akses? → 404 seragam bila tidak
      tulis       : branch jurnal/aksi ∈ operationalBranches & matriks status×asal (Z.1) → 403 BRANCH_NOT_OPERATIONAL
      konteks     : header ∈ operationalBranches?                       → 403 BRANCH_CONTEXT_INVALID
      laporan     : scope divalidasi (Z.6)                              → 403 SCOPE_NOT_ALLOWED
6  Aturan domain .............. branch_policy akun (Z.8) → 400 ACCOUNT_POLICY_VIOLATION; periode, tanggal, dll. (existing)
7  Eksekusi dalam 1 transaksi + audit (rollback bersama bila audit gagal — pola existing)
```
### Z.10.2 Prinsip
- `company_id` **tidak pernah** dari body/query/header; hanya slug yang diverifikasi.
- Frontend **tidak pernah** menjadi penentu: tidak ada filter di sisi klien yang menggantikan langkah 3–6.
- Akses di luar batas → **404 identik** dengan "tidak ada" (tidak membocorkan keberadaan); 403 hanya untuk "ada tetapi tak berwenang" pada objek yang memang boleh diketahui user.
- Fail-closed pada ketidakpastian; id cabang tak dikenal diabaikan.
- Pencabutan akses/permission/delegasi dan perubahan status cabang berlaku pada request berikutnya.
- Upaya ditolak (`forged branch`, `IDOR`) → audit `SECURITY_BRANCH_ACCESS_DENIED` (dibatasi laju).

---

## Z.11 AUDIT TRAIL (final)

**Infrastruktur dipakai ulang:** `audit_log` (system DB; untuk akses/delegasi/permission/konteks/keamanan) dan `company_audit_log` (company.db; untuk cabang, jurnal, antar-cabang, kebijakan akun). Dua kolom nullable ditambahkan: `target_user_id`, `branch_id` (system) dan `branch_id` (company). Kolom lain sudah memenuhi permintaan: `actor_id`, `company_id`, `action`, `before_json` (=old), `after_json` (=new), `reason`, `created_at`. Penulisan audit **dalam transaksi yang sama** dengan perubahan (audit gagal → perubahan rollback). Tabel audit append-only (pola existing).

| Kelompok | Event | Penyimpanan |
|---|---|---|
| Cabang | `BRANCH_CREATED`, `BRANCH_UPDATED`, `BRANCH_DEACTIVATED`, `BRANCH_ACTIVATED`, `BRANCH_CLOSED`, `BRANCH_REOPENED`, `BRANCH_DELETED` (soft) | company |
| Akses user | `USER_BRANCH_ACCESS_GRANTED`, `USER_BRANCH_ACCESS_REVOKED`, `USER_BRANCH_TRANSFERRED`, `USER_BRANCH_SCOPE_CHANGED` | system |
| Permission | `PERMISSION_OVERRIDE_GRANTED`, `PERMISSION_OVERRIDE_DENIED`, `PERMISSION_OVERRIDE_REVOKED` | system |
| Delegasi | `DELEGATION_CREATED`, `DELEGATION_UPDATED`, `DELEGATION_REVOKED`, `DELEGATION_EXPIRED` | system |
| Konteks | `ACTIVE_BRANCH_CHANGED` | system |
| Antar-cabang | `INTER_BRANCH_PROPOSED`, `_APPROVED`, `_REJECTED`, `_CANCELLED`, `_EXPIRED`, `_REVERSAL_REQUESTED`, `_REVERSAL_APPROVED`, `_SELF_APPROVED`, `_APPROVAL_WAIVED` | company |
| Pengecualian cabang tidak aktif | `BRANCH_NONACTIVE_POSTING` (jurnal id, status cabang, origin, alasan, aktor/proses) | company |
| Kebijakan akun | `ACCOUNT_POLICY_CHANGED` (lama→baru, jumlah posting terdampak) | company |
| Konfigurasi | `COMPANY_SETTING_CHANGED` (`inter_branch_expiry_days`, `multi_branch_enabled`) | company |
| Keamanan | `SECURITY_BRANCH_ACCESS_DENIED` | system |
Minimal kolom yang diminta (actor, target, company, branch, action, old, new, timestamp) **semuanya terpenuhi**.

---

## Z.12 DATABASE SCHEMA (final)

Ringkasan: **tabel baru 7** (`branches`, `inter_branch_transactions`, `inter_branch_transaction_lines`, `user_branch_access`, `access_permission_overrides`, `delegations`, `delegation_branches`); sisanya **perluasan kolom** tabel existing. `company_id` tidak ada di company.db (satu file = satu perusahaan, ADR-001) dan **ada eksplisit** di tabel system.

### company.db
| Tabel | Definisi (PK/FK/unique/index/status/soft-delete/keamanan) |
|---|---|
| **branches** | PK `id`. `code` UNIQUE (termasuk soft-deleted → kode dicadangkan). `name`, `status` CHECK IN (ACTIVE,INACTIVE,CLOSED) default ACTIVE, `is_head_office` (UNIQUE parsial: satu `true`), `address`, `phone`, `sort_order`, `opened_at`, `closed_at/closed_by/close_reason` (CHECK: terisi bila CLOSED), `reopened_at/by`, `created_by`, `created_at/updated_at`, `deleted_at/deleted_by` (soft delete; hanya cabang tak terpakai). Trigger: tolak `DELETE`; tolak ubah `code`/`is_head_office`; tolak status non-ACTIVE untuk Kantor Pusat. Index `status`, `sort_order`. Keamanan: tulis hanya lewat service+audit; tanpa data sensitif. |
| **journal_entries** (+kolom) | `branch_id` FK→branches RESTRICT (nullable saat ADD COLUMN SQLite → backfill Kantor Pusat → trigger menolak NULL & menolak UPDATE `branch_id` pada jurnal POSTED/REVERSED); `origin` CHECK IN (manual,import,opening_balance,system,inter_branch,head_office_effect) default manual; `system_process` (nullable, terisi bila origin=system); `exception_reason` (nullable). Index `(branch_id, entry_date)`. CHECK `source` lama **tidak diubah**. `reference_no` tetap UNIQUE global (pasangan antar-cabang memakai sufiks). |
| **accounts** (+kolom) | `branch_policy` (Z.8.1), `inter_branch_role`. Index `branch_policy`. |
| **inter_branch_transactions** | PK `id`; `transaction_no` UNIQUE; `kind` (TRANSFER/REVERSAL); `original_transaction_id` FK self; `transaction_date`; `from_branch_id`,`to_branch_id` FK→branches (CHECK berbeda); `amount` decimal(18,2) CHECK>0; `description`; **`status`** CHECK IN (WAITING_APPROVAL,POSTED,REJECTED,CANCELLED,EXPIRED,REVERSED); `proposed_by`,`proposed_at`,`expires_at` (dibekukan saat pengajuan); `decided_by`,`decided_at`,`decision_reason` (wajib saat REJECTED); `self_approved`; `approval_waived`+`waiver_reason`; `origin` (branch/head_office_effect); `from_journal_id`,`to_journal_id` (NULL sampai POSTED; UNIQUE; FK→journal_entries RESTRICT); `idempotency_key` UNIQUE. Index `(to_branch_id,status)`, `(from_branch_id,status)`, `(status,expires_at)`. |
| **inter_branch_transaction_lines** | PK `id`; `transaction_id` FK CASCADE; `side` (FROM/TO); `account_id` FK RESTRICT; `debit`,`credit` (CHECK satu sisi); `memo`; `line_order`. Dipakai membentuk jurnal saat approve. |
| **company_audit_log** (+kolom) | `branch_id` nullable, index. |
| **company_profile** (+kolom) | `multi_branch_enabled` boolean default false (pengaman rilis); `inter_branch_expiry_days` integer default 14 CHECK 1–90. |
| **statement_lines** (+kolom) | `line_kind`, `formula` (Report Group; tabel sudah ada). |

### system DB
| Tabel | Definisi |
|---|---|
| **company_access** (+kolom) | `branch_scope` CHECK IN (ALL,LIMITED) default ALL; `default_branch_id` nullable (preferensi). Default ALL → pengguna lama tidak berubah. |
| **user_branch_access** | PK `id`; `company_id` FK→companies_registry; `access_id` FK→company_access; `branch_id` (id company.db, divalidasi aplikasi — tanpa FK lintas file); `status` (ACTIVE/REVOKED); `granted_by`,`granted_at`; `granted_via_delegation_id` FK; `revoked_by`,`revoked_at`,`revoke_reason`. UNIQUE parsial `(access_id,branch_id) WHERE status='ACTIVE'`. Index `(company_id,branch_id)`. **Tidak ada DELETE** (riwayat). Resolver mencocokkan `company_id` dengan `company_access`. |
| **access_permission_overrides** | PK `id`; `company_id`; `access_id` FK; `permission` (CHECK dalam allowlist); `effect` (GRANT/DENY); `status` (ACTIVE/REVOKED); `granted_by`,`granted_at`,`revoked_by`,`revoked_at`,`reason`. UNIQUE parsial `(access_id,permission) WHERE status='ACTIVE'`. |
| **delegations** | PK; `company_id`; `grantee_access_id`,`granted_by_access_id` FK; `can_manage_users`,`can_manage_branch_info`,`can_view_branch_reports`,`can_inter_branch`; `max_role` CHECK IN (VIEWER,STAFF,ACCOUNTANT); `starts_at`,`expires_at`; `status` (ACTIVE/REVOKED/EXPIRED); `reason`; `revoked_by/at`; timestamps. Index `(company_id,grantee_access_id,status)`. |
| **delegation_branches** | `(delegation_id FK CASCADE, branch_id)` UNIQUE. |
| **audit_log** (+kolom) | `target_user_id`, `branch_id` nullable. |

### Ditolak / tidak dibuat
`users.branch_id`; tabel `permissions` per-role baru; tabel `audit_logs` baru; tabel kebijakan akun terpisah; cabang bernama `ALL`.

### Urutan migration (idempotent, memakai `company-upgrade` + backup `pre-upgrade`)
company.db: `C0014 branches` → `C0015 journal branch_id+origin (+backfill Kantor Pusat)` → `C0016 accounts branch_policy` → `C0017 company_profile settings` → `C0018 inter_branch tables` → `C0019 statement_lines kind` → `C0020 company_audit_log.branch_id`. system DB: `S0011 company_access scope` → `S0012 user_branch_access` → `S0013 overrides` → `S0014 delegations` → `S0015 audit_log columns`. **Item yang harus diverifikasi lewat spike kecil di awal Phase 2:** perilaku `ALTER TABLE ADD COLUMN ... REFERENCES` di better-sqlite3 dengan `foreign_keys=ON` (nullable → backfill → trigger NOT NULL).

---

## Z.13 API AUTHORIZATION (final)

Semua di bawah `/api/company-db/:companySlug`, melalui alur Z.10.1. "Aturan cabang" = langkah 5.

| Kelompok | Endpoint (ringkas) | Permission | Aturan cabang / catatan |
|---|---|---|---|
| Cabang | `GET /branches`, `GET /branches/:id` | `branch.read` | hanya cabang dalam akses; ALL melihat semua; 404 di luar akses |
| | `POST /branches`, `PATCH /branches/:id`, `POST /branches/:id/{activate,deactivate}` | `branch.manage` | create hanya scope ALL; ubah hanya cabang dalam cakupan/delegasi |
| | `POST /branches/:id/close`, `…/reopen`, `DELETE`(soft) | `branch.close` / `branch.reopen` / OWNER | checklist; alasan wajib |
| Konteks | `PUT /me/active-branch` | (login + akses) | cabang ∈ operationalBranches |
| Akses user | `GET /users`, `GET /users/:id/branches` | `users.read` | hanya irisan dengan cakupan aktor |
| | `POST/DELETE /users/:id/branches`, `POST /users/:id/branches/transfer` | `user_branch.manage` | `assertDelegationBoundary`; tak boleh diri sendiri; cabang ACTIVE |
| Permission user | `PUT/DELETE /users/:id/permission-overrides` | `users.manage` | allowlist; permission yang dimiliki aktor; bukan OWNER/diri sendiri |
| Delegasi | `GET/POST/PATCH/DELETE /delegations` | `delegation.manage` | depth 1; OWNER / ADMIN-ALL |
| Jurnal | list/detail/create/post/reverse/delete-draft/import | `journal.*` | `branchId` ∈ operasional; matriks status×asal; **`branch_policy`**; by-id 404 di luar akses |
| Opening balance (+import) | existing | existing | per cabang; policy `opening_balance` |
| Akun (COA) | `PATCH /accounts/:id/policy` | `account.policy` | OWNER; alasan wajib; audit |
| | existing list | `account.read` | saldo per cabang mengikuti scope |
| Antar-cabang | `POST /inter-branch` | `interbranch.create` | cabang pengaju ∈ operasional; idempotency key |
| | `GET /inter-branch?box=out\|in` | `interbranch.read` | `in` = hanya cabang lawan milik user (pratinjau sisi sendiri) |
| | `POST /inter-branch/:id/{approve,reject,cancel}` | `interbranch.approve` / `.create` | cabang lawan ∈ akses; ≠ pengaju (OWNER pengecualian); alasan reject wajib |
| | `POST /inter-branch/:id/reverse` | `interbranch.reverse` | memicu alur approval |
| Laporan + export | 5 laporan, XLSX/PDF | `report.read` (+ `report.consolidated` untuk >1 cabang) | `scope` divalidasi; export membawa label scope |
| Dashboard, analisis, proyeksi, pajak | existing | `report.read` | konteks/scope divalidasi |
| Ledger, trial balance, counterparty | existing | existing | `scope` pada query dasar |
| Pencarian global | `GET /search` | `journal.read`/`account.read` | filter akses cabang |
| Audit log | existing | existing | LIMITED hanya `branch_id` miliknya; log akses/delegasi hanya ALL |
| Profil/pengaturan, backup/restore | existing | existing | hanya ALL (`inter_branch_expiry_days`, `multi_branch_enabled`: OWNER) |
| Legacy master-DB (`modules/journal`, `ledger`, `accounts`, `statements`) | terdaftar | – | diaudit di Phase 3: dikunci/diputus bila tak dipakai UI |

---

## Z.14 TEST PLAN (final)

Gabungan: test plan bagian I (35, sebagian digantikan di bawah), bagian T (31) dan W.11 (18), ditambah tes baru untuk keputusan terakhir. Setiap tes keamanan dijalankan juga sebagai **matriks otomatis (peran × scope × permission × seluruh route perusahaan)**.

**Branch lifecycle** — buat (ACTIVE/INACTIVE), ubah, nonaktifkan, aktifkan, tutup (checklist blokir draft & pengajuan menunggu; peringatan saldo), reopen (OWNER saja, alasan wajib), hapus ditolak bila berjejak, soft delete bila tak terpakai, DELETE fisik ditolak trigger, kode dicadangkan, Kantor Pusat tak bisa nonaktif/tutup/hapus, transisi ilegal ditolak.

**Matriks status × asal jurnal (tiap sel satu tes)** — manual/import/opening × {ACTIVE ✓, INACTIVE ✗, CLOSED ✗}; inter_branch diajukan cabang × 3 status; system × 3 (INACTIVE/CLOSED ditandai + audit `BRANCH_NONACTIVE_POSTING`); head_office_effect × 3 (ACTIVE+approval; INACTIVE+approval, penanggalan oleh OWNER dengan alasan; CLOSED tanpa approval, alasan wajib); `origin` dari body/header **diabaikan**; jurnal `system` tak dapat dibuat via API; reversal di non-ACTIVE hanya jalur sistem/pusat.

**Account policy** — default `ALL_BRANCH` tak mengubah perilaku lama; `CENTRAL_ONLY` ditolak di cabang non-pusat (manual, import, opening, sisi antar-cabang) dan diterima di Pusat; `SYSTEM_ONLY` ditolak untuk user, diterima untuk proses terdaftar (plug opening balance di cabang berhasil); `INTER_BRANCH` ditolak manual/import, diterima lewat layanan & opening balance (dengan peringatan keseimbangan); CHECK `INTER_BRANCH` ⇔ `inter_branch_role`; ubah policy hanya OWNER + alasan + audit; policy baru hanya untuk posting baru; reversal mengecualikan policy; COA import kolom "Kebijakan Cabang" (nilai tak dikenal ditolak; baris existing tidak berubah); `ACCOUNT_POLICY_VIOLATION` jelas dan atomik; policy diperiksa saat **post** juga (draft lama).

**Effective permission & override** — default role; GRANT staf `interbranch.approve` → bisa approve; DENY akuntan → tak bisa; override di luar allowlist ditolak; aktor tak bisa memberi permission yang tak ia miliki; tak bisa pada diri sendiri / DENY OWNER; admin berdelegasi hanya untuk user dalam cakupan; override tidak memperluas cabang; pencabutan berlaku seketika; audit tiap perubahan.

**User access** — grant, revoke, transfer (atomik, riwayat REVOKED), multi-cabang, satu cabang (tanpa dropdown), konteks sah/tak sah, LIMITED tanpa cabang = kosong, cabang baru tak otomatis ke LIMITED, grant ke non-ACTIVE ditolak, tak bisa ubah akses sendiri, OWNER tak bisa dibatasi.

**Delegasi** — owner mendelegasi; admin bertindak dalam cakupan; di luar cakupan 403 (Pusat, cabang tak dimiliki, ALL); tak bisa naik role/permission/jadi OWNER/ubah diri; re-delegasi ditolak; kedaluwarsa; hak efektif menyusut; pencabutan + opsi "cabut juga"; ADMIN-ALL lama tetap jalan.

**Active branch & report scope** — konteks bukan permission; header palsu 403; konteks tak mengunci `branch_id` jurnal (divalidasi sendiri); scope tunggal/komparasi/**Gabungan Cabang Terpilih**/Konsolidasi sesuai hak; **label "bukan konsolidasi perusahaan" ada di layar, XLSX, PDF, dan nama file**; baris "tidak dieliminasi" untuk saldo ke luar pilihan; "Konsolidasi Perusahaan" hanya bila semua cabang tercakup; scope di luar akses 403.

**Inter-branch approval** — semua kasus W.11 (nama status `WAITING_APPROVAL`), ditambah: **permission-driven** (penyetuju ditentukan permission efektif, bukan role); reject tanpa alasan ditolak; kedaluwarsa memakai `inter_branch_expiry_days` (ubah 14→7 tak mengubah pengajuan lama; rentang 1–90 divalidasi; hanya OWNER); `expires_at` dibekukan; penanggalan approval hanya OWNER + alasan; pengajuan menunggu memblokir penutupan periode; cabang berubah status saat menunggu.

**Authorization flow & security** — lintas perusahaan, IDOR cabang/jurnal/user/akses/delegasi/override/antar-cabang, `branch_id`/`company_id` palsu, 404 seragam, paginasi/jumlah tak bocor, pencarian global/audit log/export mengikuti akses, legacy route, konsolidasi tanpa hak 403, **pencabutan berlaku pada request berikutnya** (akses, permission, delegasi, status cabang), race dua penyetuju.

**Historical integrity** — transfer user tak mengubah jurnal; `branch_id` jurnal POSTED terkunci; penutupan cabang tak menghapus data; laporan cabang CLOSED tetap benar & seimbang; reopen tak merusak; konsolidasi historis memuat cabang CLOSED; draft pasca-transfer tetap milik cabang asal.

**Migration** — jurnal lama → Kantor Pusat; idempotent (2×); tak ada jurnal ganda; jumlah/akun tak berubah (hash line); laporan sebelum/sesudah identik; opening balance lama → Pusat; semua akun lama `ALL_BRANCH`; restore dari `pre-upgrade`.

**Audit** — satu tes per event di Z.11 (aktor, target, company, branch, old/new, waktu); audit gagal → perubahan rollback.

**Regresi** — 619 tes backend hijau dengan `multi_branch_enabled=false`; import lama tanpa kolom Cabang/Kebijakan; Electron build; installer scan; security regression (rate limit, audit login, CORS); UAT penuh.

---

## Z.15 IMPLEMENTATION PHASES (final)

**Penyimpangan dari urutan usulan Anda dan alasannya** (berdasarkan dependensi kode, bukan sekadar urutan):
1. **Account policy masuk Phase 2**, bukan belakangan: begitu `branch_id` ada di jurnal, aturan siapa boleh memposting apa harus sudah tegak (akun Modal tak boleh masuk jurnal cabang).
2. **Resolver otorisasi minimal ada di Phase 2**; versi penuh + **effective permission/override** di Phase 3 (dibutuhkan approval di Phase 6).
3. **Reporting (5) setelah Access (3)** karena scope butuh validasi akses.
4. **Delegasi (4) setelah Access (3)**; independen dari Reporting → dapat berjalan paralel dengan 5.
5. **Penyelesaian saldo saat tutup cabang & jalur `head_office_effect` bergantung pada Inter-Branch (6b)**; Phase 1 hanya checklist + status.
6. **UI dibangun tipis di tiap phase**; Phase 8 untuk pemolesan. **Report Group** (klasifikasi laporan) independen, dapat paralel setelah Phase 2.
7. Flag `multi_branch_enabled=false` menjaga tak ada cabang kedua sampai Phase 1–3 lengkap.

| Phase | Isi | Bergantung | Gerbang keluar |
|---|---|---|---|
| **1 — Branch Master + Lifecycle** | `branches`, Kantor Pusat otomatis, status & transisi, checklist (blokir draft), soft delete, permission `branch.*`, pengaturan `multi_branch_enabled` & `inter_branch_expiry_days`, audit cabang, UI Pengaturan→Cabang | — | tes lifecycle; 619 tes lama hijau |
| **2 — Branch Dimension + Account Policy** | `journal_entries.branch_id/origin`, migrasi + trigger (spike verifikasi dulu), validasi cabang & matriks status×asal, **`accounts.branch_policy` + enforcement semua jalur + import COA + layar rekomendasi**, opening balance per cabang, kolom Cabang opsional di import, resolver minimal | 1 | tes jurnal/migrasi/policy/matriks; laporan lama identik angka demi angka |
| **3 — Multi-Branch Access + Effective Permissions** | `branch_scope`, `user_branch_access`, resolver penuh, konteks aktif, Add/Remove/Transfer, **override permission**, fail-closed di seluruh route, pencarian/audit/export, penguncian legacy route, UI switcher + manajemen akses | 2 | tes akses/permission/keamanan + matriks seluruh route |
| **4 — Delegation** | `delegations`, `assertDelegationBoundary`, pembatasan route `company-access`, UI delegasi | 3 | tes delegasi |
| **5 — Branch-Aware Reporting** | `scope` di fungsi dasar, Individual/Komparasi/Gabungan, **label Gabungan Cabang Terpilih** (layar+export), Previous/Mutasi/Growth, Report Group (paralel), dashboard | 3 | Σcabang = Gabungan; label & export |
| **6a — Inter-Branch Approval** | proposal, approve/reject/cancel, jurnal atomik, validasi ulang, permission efektif, expiry konfigurasi, inbox UI | 2, 3 | tes W.11 + permission-driven |
| **6b — Inter-Branch Lanjutan** | reversal via approval, kedaluwarsa evaluasi, blok penutupan periode, `head_office_effect` ke INACTIVE/CLOSED, **penyelesaian saldo saat tutup cabang**, laporan pengecualian | 6a, 1 | matriks status×asal lengkap |
| **7 — Consolidation & Elimination** | eliminasi via `inter_branch_role`, selisih eliminasi, baris "tidak dieliminasi", peringatan menunggu | 5, 6 | eliminasi bersih |
| **8 — UI/UX polish & dokumentasi** | konsistensi, empty state, panduan klien/PDF, UAT bersama klien | 1–7 | UAT disetujui |
| **9 — Security & Regression (penutup)** | UAT penuh, security regression, installer scan, build Electron | semua | laporan akhir |

---

## Z.16 FINAL ARCHITECTURE DECISION

# **READY FOR IMPLEMENTATION**

**Alasan.**
- Seluruh 12 keputusan Anda terpetakan ke desain yang konkret dan konsisten; tidak ada pertentangan tersisa (konflik opening-balance vs akun Ekuitas dan akun antar-cabang vs `CENTRAL_ONLY` sudah ditemukan dan diselesaikan lewat `SYSTEM_ONLY`/`INTER_BRANCH`).
- Account policy berdiri di atas **pola atribut COA yang sudah ada**, bukan hardcode tipe akun.
- Permission efektif dapat diterapkan dengan **perubahan terpusat** (guard + rbac), tanpa menyentuh 51 route satu per satu.
- Pengguna & perusahaan lama **tidak berubah** sampai fitur dinyalakan (flag, `branch_scope=ALL`, `ALL_BRANCH`, semua jurnal lama = Kantor Pusat).
- Infrastruktur dipakai ulang (audit, upgrade+backup, pola 404, pola setting `company_profile`).

**Catatan jujur (bukan penghalang, tetapi perlu diketahui):**
1. Satu **spike teknis** di awal Phase 2: perilaku `ADD COLUMN ... REFERENCES` + trigger NOT NULL pada better-sqlite3 (belum saya jalankan; desain sudah menyiapkan fallback membangun ulang tabel `journal_entries` dengan backup).
2. Phase 3 adalah **pekerjaan paling sensitif** (menyentuh seluruh route + legacy route); tidak boleh dilewati atau dikurangi cakupan tesnya.
3. Phase 6 (antar-cabang + approval + pengecualian status) adalah **bagian paling kompleks** secara akuntansi; kompleksitas menengah-tinggi.
4. Contoh Excel adalah template kosong → verifikasi angka memakai data sintetis dan COA riil klien nanti.
5. Di luar lingkup: jual-beli internal ber-margin, multi-mata-uang, periode per cabang, input bersamaan dari banyak komputer.

**Hal yang masih menunggu konfirmasi Anda — tidak ada yang memblokir Phase 1–2:**
| # | Pertanyaan | Dibutuhkan sebelum | Usulan |
|---|---|---|---|
| 1 | Kebijakan **INACTIVE** untuk transaksi dari pusat: tetap butuh approval cabang; hanya OWNER boleh menanggalkan bila tak ada penyetuju? | Phase 6b | Ya (Z.1) |
| 2 | Daftar **saran awal** kebijakan akun (Ekuitas → CENTRAL_ONLY, plug opening → SYSTEM_ONLY, Piutang/Utang Antar Cabang → INTER_BRANCH) sudah sesuai? | Phase 2 | Ya, hanya saran yang ditinjau OWNER |
| 3 | Aksi *Selesaikan saldo ke Kantor Pusat* saat tutup cabang diinginkan? | Phase 6b | Ya |
| 4 | Pertanyaan bisnis laporan K.2 #5–#6 (growth pembanding negatif; pembanding Laba Rugi) + **COA riil SPBU** | Phase 5 | — |

**BERHENTI. Tidak ada migration, schema, UI, atau source code yang dibuat. Menunggu approval Anda.**


---
---

# REVISI 6 — FINAL DESIGN SANITY CHECK (2026-10-07)

Pemeriksaan ini dilakukan terhadap Revisi 5 (Z.0–Z.16) dengan memverifikasi ulang ke kode (template COA, `journal-service`, rute legacy, kebijakan subledger). **Hasil: 8 concern desain ditemukan; semuanya diperbaiki di bagian ini (hanya dokumen, tanpa kode). Bagian ini menggantikan Revisi 5 bila bertentangan**, khususnya Z.7, Z.8, Z.12 (tabel antar-cabang, `accounts`, `journal_entries`) dan Z.14.

## Hasil verifikasi ke kode (fakta, bukan asumsi)
| Pertanyaan | Temuan |
|---|---|
| Template COA memuat akun antar-cabang? | **Tidak.** Template `general`, `banking`, `hospital`, `cooperative` tidak punya satu pun akun antarkantor. Akun itu harus dibuat. |
| Apakah semua Equity = milik pusat? | **Tidak bisa diasumsikan.** Template memuat `Modal Disetor/Modal Pemilik`, `Laba Ditahan` (`equity_retained`), dan koperasi memakai **Simpanan Pokok/Simpanan Wajib/SHU Ditahan**. Excel contoh menaruh **"Modal Awal" di bagian Kewajiban** (tipe liability). Maka kebijakan harus per-akun, bukan per-tipe. |
| Satu COA per perusahaan? | **Ya.** `accounts` tidak memiliki kolom cabang/perusahaan; `company_id` implisit (satu `company.db` = satu perusahaan, ADR-001); dimensi cabang hanya di header jurnal. |
| `createDraftJournalEntry` transaksi sendiri? | Ya: memanggil `db.transaction(...)` di dalamnya, lalu posting terpisah. Bila dipanggil 4× terpisah untuk transaksi antar-cabang, **bukan satu transaksi**. |
| Subledger wajib `counterparty_id`? | Tidak (opsional, "tanpa auto-tagging"), tetapi baris Hutang/Piutang bisa membawanya. |
| Rute legacy (`modules/journal`, `ledger`, `accounts`, `statements`) | Memakai `masterDb` (data lama) dengan `requireCompanyAccess`; **tidak sadar-cabang**. Tetap harus dikunci di Phase 3. |

---

## Concern & perbaikan

### C1 — Akun antar-cabang tidak terhubung ke cabang lawan (ACCOUNTING)
**Masalah.** Contoh Anda memakai akun **"Antarkantor Passiva – Bandar Lampung"** (satu akun per cabang lawan, bersaldo netto). Desain Revisi 5 hanya punya dua akun generik berflag `receivable/payable` dan menyimpan cabang lawan **hanya di tabel transaksi**. Akibatnya: (a) contoh Anda tidak bisa direpresentasikan apa adanya; (b) saldo awal (opening balance) atau saldo historis antar-cabang **tidak punya cabang lawan** sehingga **rekonsiliasi per pasangan cabang tidak bisa dihitung**; (c) "jangan parse nama akun" tidak terpenuhi.
**Dampak.** Eliminasi/rekonsiliasi bisa salah atau tidak dapat dibuktikan → *incorrect accounting*.
**Perbaikan (final).**
- `accounts.counterpart_branch_id` (FK→branches, nullable). **Wajib terisi bila `branch_policy = INTER_BRANCH`, dan wajib NULL bila bukan** (CHECK). Cabang lawan tidak pernah dibaca dari nama akun.
- Menggantikan `inter_branch_role` (receivable/payable). Akun antar-cabang adalah **akun COA biasa** (bisa tipe Aktiva atau Kewajiban; boleh netto seperti "Antarkantor Passiva – X" atau dua akun Aktiva/Passiva per cabang lawan — keduanya didukung). **Tetap satu COA**; hanya ada satu akun per cabang lawan per jenis (bukan COA terpisah per cabang).
- **Aturan posting:** pada jurnal cabang A, akun INTER_BRANCH harus ber-`counterpart_branch_id` ≠ A. Jurnal manual/import ke akun ini tetap ditolak (`INTER_BRANCH` hanya via layanan & opening balance).
- **Invarian pasangan (rekonsiliasi):** untuk setiap pasangan (A,B): `Σ(debit−kredit) pada akun INTER_BRANCH di jurnal A yang counterpart = B` **+** `Σ(debit−kredit) pada akun INTER_BRANCH di jurnal B yang counterpart = A` **= 0**. Berlaku untuk model netto maupun model Aktiva/Passiva, dan untuk saldo awal. Selisih ≠ 0 ditampilkan sebagai **selisih rekonsiliasi**, tidak disembunyikan.
- **Eliminasi konsolidasi:** semua akun `INTER_BRANCH` di dalam himpunan cabang yang dikonsolidasikan, hanya untuk pasangan yang **keduanya** berada di dalam himpunan; sisanya tampil sebagai "tidak dieliminasi".
- **Pembuatan akun:** saat cabang dibuat (Phase 1) sistem **menawarkan** (preview + konfirmasi OWNER) pembuatan akun antarkantor "– <cabang>" bagi cabang itu; tidak otomatis.
**Contoh Anda dengan desain final** (COA bersama berisi akun `1xxx Antarkantor Passiva – Bandar Lampung` [counterpart=BL] dan `2xxx Antarkantor Passiva – Metro` [counterpart=Metro]):
```
IBT-000001  Metro → Bandar Lampung  Rp1.000.000  status COMPLETED
Jurnal Metro (branch=METRO,  ibt=IBT-000001, leg=ORIGINAL, side=FROM)
  D  Antarkantor Passiva – Bandar Lampung  [counterpart=BL]   1.000.000
  K  Kas                                                       1.000.000
Jurnal Bandar Lampung (branch=BL, ibt=IBT-000001, leg=ORIGINAL, side=TO)
  D  Hutang                                                    1.000.000
  K  Antarkantor Passiva – Metro           [counterpart=Metro] 1.000.000
Cek pasangan: Metro IB(+1.000.000 debit) + BL IB(−1.000.000) = 0 ✓
```

### C2 — Jurnal tidak membawa identifier transaksi antar-cabang; reversal tidak terjejak (PAIRING/REVERSAL)
**Masalah.** Revisi 5 hanya menaruh `from_journal_id/to_journal_id` di tabel transaksi (satu arah) dan memodelkan reversal sebagai baris transaksi terpisah. Jurnal sendiri tidak menunjuk transaksinya; empat jurnal (2 asli + 2 reversal) tidak otomatis berada di bawah **satu** identifier; jurnal bisa "yatim" tanpa terdeteksi.
**Dampak.** Audit/investigasi/rekonsiliasi sulit; risiko jurnal yatim; reversal satu sisi tidak tercegah di level data.
**Perbaikan (final).**
- `journal_entries.inter_branch_transaction_id` (FK nullable, index), `inter_branch_leg` (`ORIGINAL`/`REVERSAL`), `inter_branch_side` (`FROM`/`TO`).
- **UNIQUE(`inter_branch_transaction_id`, `inter_branch_leg`, `inter_branch_side`)** → mustahil ada dua jurnal untuk slot yang sama.
- **Sumber kebenaran tunggal = jurnal.** Kolom `from_journal_id/to_journal_id` di tabel transaksi **dihapus** (derivatif → risiko inkonsisten).
- **Satu transaksi = satu identifier untuk keempat jurnal:** ORIGINAL/FROM, ORIGINAL/TO, REVERSAL/FROM, REVERSAL/TO. Persetujuan (pengajuan & reversal) dicatat di tabel baru `inter_branch_approvals` (`transaction_id`, `kind` POST/REVERSE, `status`, `requested_by/at`, `decided_by/at`, `reason`, `expires_at`, `self_approved`, `waived`). Status transaksi: `WAITING_APPROVAL → COMPLETED | REJECTED | CANCELLED | EXPIRED`; `COMPLETED → REVERSAL_WAITING → REVERSED` (reversal ditolak/kedaluwarsa → kembali `COMPLETED`). Nama `COMPLETED` menggantikan `POSTED`.
- Jurnal ber-`inter_branch_transaction_id` **tidak dapat** di-reverse, diedit, atau dihapus lewat endpoint jurnal biasa (guard di service jurnal) — hanya lewat alur antar-cabang.
- Kegunaan: pencarian (`GET /journals?ibt=…`), audit (tiap event audit memuat id transaksi), rekonsiliasi per pasangan, laporan "pasangan jurnal", pemeriksa integritas (C7).
- Kolom jurnal ini ditambahkan **di migration Phase 2** (nullable) agar Phase 6 tidak mengubah tabel jurnal lagi.

### C3 — Siapa yang berwenang membuat jurnal sisi cabang pengaju saat disetujui? (AUTHORIZATION)
**Masalah.** Saat penyetuju (cabang lawan) menyetujui, sistem harus membuat jurnal **di cabang pengaju**, tempat penyetuju **tidak punya akses**, dan penyetuju mungkin tidak punya `journal.create/post`. Alur Z.10 langkah 5 ("tulis: cabang ∈ operasional") akan memblokirnya — atau, bila diselesaikan sembarangan, membuka celah bypass.
**Dampak.** Fitur tidak bisa berjalan, atau implementasi diam-diam melewati pemeriksaan akses (*unauthorized branch access*).
**Perbaikan (final).** Satu **prosedur terprivilese yang sempit** `executeInterBranchPosting(trx, approvalRecord)`:
- Wewenang **semata-mata dari catatan persetujuan yang sudah divalidasi** (penyetuju berizin `interbranch.approve` + akses cabang lawan + bukan pengaju), bukan dari akses cabang user.
- Tidak dapat dipanggil dari endpoint lain; `origin` ditetapkan server (`inter_branch`); `created_by` = pengaju, `posted_by` = penyetuju; audit `actor` = penyetuju.
- Seluruh validasi domain tetap berjalan (periode, tanggal, akun aktif/tak terkunci, `branch_policy`, status cabang sesuai matriks).
- Langkah 5 Z.10 diubah: untuk aksi approve/reject, cek akses dilakukan pada **cabang lawan** (tempat keputusan), bukan pada cabang tempat jurnal dibuat.

### C4 — Atomicity bergantung pada cara implementasi (ATOMICITY)
**Masalah.** `createDraftJournalEntry` membuka transaksinya sendiri dan posting adalah langkah terpisah; bila dipanggil empat kali berurutan, tiap panggilan bisa commit sendiri → kondisi "Cabang A tersimpan, B belum".
**Dampak.** *Partial inter-branch transaction* — risiko terbesar akuntansi.
**Perbaikan (final) — aturan implementasi yang mengikat:**
1. **Satu `db.transaction` luar** untuk: (re)validasi, jurnal FROM, jurnal TO, posting keduanya, update status transaksi, catatan persetujuan, audit.
2. Fungsi jurnal diberi varian yang menerima `trx` (`…InTransaction(trx, …)`), perilaku identik dengan yang ada; 619 tes sebagai jaring pengaman. **Dilarang** memanggil varian yang membuka transaksi sendiri dari alur ini.
3. **Pemeriksaan pasca-kondisi sebelum commit** (di dalam transaksi): tepat 2 jurnal untuk (transaksi, leg); `branch_id` tiap jurnal = cabang transaksi; masing-masing seimbang; invarian pasangan C1 = 0; bila gagal → exception → rollback.
4. **Uji injeksi kegagalan** pada tiap titik tulis: insert jurnal A, insert jurnal B, posting A, posting B, update status, tulis approval, tulis audit → hasil harus selalu *semua ada* atau *tidak ada satu pun*.

### C5 — Asumsi COA & kebijakan akun (ACCOUNT POLICY)
**Masalah.** Saran "Ekuitas → CENTRAL_ONLY" tidak sesuai kenyataan COA: koperasi memakai Simpanan Pokok/Wajib/SHU; Excel contoh menaruh "Modal Awal" di Kewajiban; tidak ada akun antarkantor di template manapun.
**Dampak.** Aturan tipe-akun akan salah memblokir/membiarkan akun; akun antar-cabang belum ada saat dibutuhkan.
**Perbaikan (final).**
- **Tidak ada default berbasis tipe.** Semua akun default `ALL_BRANCH`. Layar "Rekomendasi kebijakan akun" hanya **mencantumkan kandidat** dengan alasan (mis. akun yang `account_subtype='equity_retained'`/`retainedEarningsAccountCode`, akun bertipe Equity untuk **ditinjau**, akun `opening_balance_adjustment`); tidak ada yang terpilih otomatis kecuali akun penyeimbang opening balance → `SYSTEM_ONLY`; OWNER memutuskan **per akun**.
- Akun antar-cabang dibuat lewat aksi terpandu (C1), bukan diasumsikan ada.
- Template COA ditambah (opsional) pengelompokan "Antarkantor" hanya sebagai contoh akun yang bisa dibuat, tanpa mengubah COA perusahaan yang sudah ada.

### C6 — Test plan belum eksplisit untuk beberapa skenario wajib (TEST PLAN)
**Perbaikan (tambahan mengikat ke Z.14):**
- **Golden test Metro → Bandar Lampung Rp1.000.000 (pembayaran hutang)** dengan jurnal persis seperti contoh C1 (termasuk `counterpart`, `leg`, `side`, invarian pasangan = 0, kas Metro −1.000.000, hutang BL −1.000.000).
- Approval berhasil → kedua jurnal tercipta; approval gagal → tidak ada jurnal; **gagal di jurnal Cabang A → B tidak tersimpan; gagal di jurnal Cabang B → A tidak tersimpan** (injeksi kegagalan per titik, C4); persetujuan ganda → satu pasang jurnal; pengaju menyetujui sendiri ditolak (OWNER pengecualian, tercatat); reject tanpa alasan ditolak; **menyetujui pengajuan yang sudah lewat `expires_at` ditolak walau belum ditandai EXPIRED** (cek `expires_at < now` saat approve); reversal → empat jurnal terjejak ke satu `inter_branch_transaction_id`; reversal satu sisi ditolak; endpoint jurnal biasa menolak reverse/edit/hapus jurnal bertaut; manipulasi lintas perusahaan ditolak.
- **Tampering** (masing-masing tes terpisah, hasil harus 404/403 server-side): `branch_id` di body & query; URL (`/journals/:id`, `/ledger/:accountId`) milik cabang di luar akses; **parameter `scope` laporan**; **parameter export XLSX/PDF**; **kolom Cabang pada import jurnal** (cabang di luar akses / tak dikenal / non-ACTIVE → seluruh file ditolak atomik); **opening balance dengan `branchId` di luar akses**; **reversal jurnal cabang lain**; header `X-Branch-Context`; pencarian global; `company_id` palsu; id cabang perusahaan lain.
- Akun INTER_BRANCH: `counterpart_branch_id` = cabang sendiri ditolak; jurnal manual ke akun antar-cabang ditolak; opening balance antar-cabang dengan selisih pasangan → peringatan.

### C7 — Integritas database perlu penjaga tambahan (DATABASE INTEGRITY)
**Masalah.** Beberapa jaminan masih mengandalkan disiplin aplikasi: kecocokan perusahaan pada `user_branch_access` (lintas file), pasangan jurnal tanpa pemeriksa, tidak ada pemeriksa yatim.
**Perbaikan (final).**
- **Trigger system DB** pada `user_branch_access`/`access_permission_overrides`/`delegations`: tolak insert/update bila `company_id` ≠ `company_access.company_id` dari `access_id`. Resolver tetap membuang `branch_id` yang tidak ada di `branches` perusahaan itu (fail-closed).
- Trigger company.db: tolak UPDATE/DELETE jurnal ber-`inter_branch_transaction_id` yang sudah COMPLETED kecuali oleh prosedur reversal; tolak `branch_id` jurnal berubah setelah POSTED (sudah di Z.12).
- **`verifyInterBranchIntegrity()`** (read-only; dipakai tes dan diagnostik admin): (1) tiap transaksi COMPLETED punya tepat 2 jurnal per leg, branch sesuai; (2) tiada jurnal ber-ibt tanpa transaksi, atau transaksi WAITING/REJECTED/CANCELLED/EXPIRED yang memiliki jurnal; (3) tiap pasangan seimbang dan invarian C1 = 0; (4) tiada jurnal REVERSAL tanpa ORIGINAL; (5) semua `branch_id` valid. Hasil tidak nol = alarm; dijalankan setelah migrasi dan di tes regresi.
- Semua perubahan penting tetap memakai audit dalam transaksi yang sama (pola existing).

### C8 — Penamaan & aturan kecil
`POSTED` → **`COMPLETED`** untuk transaksi antar-cabang (konsisten dengan spesifikasi Anda); `WAITING_APPROVAL` tetap. Rute legacy master-DB **wajib dikunci/diputus di Phase 3** (tetap catatan terbuka; tidak sadar-cabang). Audit event antar-cabang selalu memuat `inter_branch_transaction_id`.

---

## Perubahan skema final (menggantikan bagian terkait Z.12)
- **accounts:** `branch_policy`, `counterpart_branch_id` (CHECK: terisi ⇔ `INTER_BRANCH`), ~~`inter_branch_role`~~ (dihapus).
- **journal_entries:** `branch_id`, `origin`, `system_process`, `exception_reason`, **`inter_branch_transaction_id`, `inter_branch_leg`, `inter_branch_side`** + UNIQUE(`ibt`,`leg`,`side`).
- **inter_branch_transactions:** `id`, `transaction_no` UNIQUE, `transaction_date`, `from_branch_id`, `to_branch_id` (≠), `amount` CHECK>0, `description`, `status` (WAITING_APPROVAL, COMPLETED, REJECTED, CANCELLED, EXPIRED, REVERSAL_WAITING, REVERSED), `origin` (branch/head_office_effect), `idempotency_key` UNIQUE, timestamps. *(tanpa `from_journal_id/to_journal_id`)*
- **inter_branch_transaction_lines:** + `counterparty_id` (opsional, untuk baris Hutang/Piutang), `leg`.
- **inter_branch_approvals (baru):** lihat C2.
- Tabel & kolom lain seperti Z.12.

## Dampak ke phase
- **Phase 1:** + aksi terpandu "buat akun antarkantor untuk cabang ini" (preview + konfirmasi).
- **Phase 2:** migration jurnal memuat kolom `inter_branch_*` (nullable) dan `accounts.counterpart_branch_id`; aturan "akun INTER_BRANCH ≠ cabang sendiri"; refactor `…InTransaction` untuk fungsi jurnal (perilaku identik, dijaga 619 tes).
- **Phase 6a/6b:** sesuai C2–C4, C6, C7.
- Phase lain tidak berubah.

---

# MULTI-BRANCH DESIGN SANITY CHECK — HASIL

```
COA MODEL:                    PASS   (satu COA; tak ada dimensi cabang di accounts; company implisit per file)
BRANCH DATA ISOLATION:        PASS   (dengan syarat enforcement Z.10 + tes tampering C6)
USER ACCESS:                  PASS   (+ trigger company_id, C7)
ACTIVE BRANCH CONTEXT:        PASS
INTER-BRANCH TRANSACTION:     CONCERN → diperbaiki di Revisi 6 (C1 cabang lawan di akun, C3 wewenang posting)
INTER-BRANCH ATOMICITY:       CONCERN → diperbaiki (C4 satu transaksi, pasca-kondisi, injeksi kegagalan)
INTER-BRANCH JOURNAL PAIRING: CONCERN → diperbaiki (C2 identifier di jurnal, UNIQUE leg/side)
APPROVAL:                     PASS   (+ aturan expires_at saat approve, C6)
ACCOUNT POLICY:               CONCERN → diperbaiki (C5 tanpa default tipe; C1 counterpart)
BRANCH LIFECYCLE:             PASS
REPORT SCOPE:                 PASS
REVERSAL:                     CONCERN → diperbaiki (C2: 4 jurnal satu identifier; guard endpoint biasa)
DELEGATION:                   PASS
AUDIT TRAIL:                  PASS   (+ ibt id di tiap event)
DATABASE INTEGRITY:           CONCERN → diperbaiki (C7 trigger + verifyInterBranchIntegrity)
TEST PLAN:                    CONCERN → diperbaiki (C6 skenario wajib & tampering eksplisit)
```

**Verdict:** *Revisi 5* **tidak** memenuhi syarat "READY FOR PHASE 1–2" karena concern C1–C4 menyentuh *incorrect accounting*, *partial inter-branch transaction*, *orphan journal*, dan *broken reversal*. **Seluruh concern sudah diberi perbaikan konkret di Revisi 6.** Status: **NOT READY sampai Revisi 6 Anda setujui; setelah disetujui → READY FOR PHASE 1–2** (tidak ada concern tersisa yang menyentuh kebocoran lintas cabang/lintas perusahaan). **Tidak ada kode, migration, schema, atau UI yang dibuat.**
