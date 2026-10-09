# MULTI-BRANCH ARCHITECTURE REPORT

Status: **AUDIT ONLY. Belum ada kode multi-cabang yang diimplementasikan.**
Tanggal audit: 2026-10-05. Sumber: pembacaan kode TERRA FINANCE (apps/api, apps/web).

## Ringkasan keputusan (untuk dibaca dulu)

| | |
|---|---|
| **RECOMMENDED** | **A: satu perusahaan, satu company.db, satu COA bersama, kolom `branch_id` pada jurnal, akun Antarkantor sebagai akun biasa + `counterpart_branch_id`** |
| **REASON** | Perubahan data paling kecil, laporan per cabang cukup menambah satu filter, jurnal antar kantor tetap satu transaksi atomik, dan tidak merusak data lama (semua jurnal lama otomatis jadi "Kantor Pusat"). |
| **IMPLEMENTATION COMPLEXITY** | **MEDIUM-HIGH** (menyentuh skema jurnal, 7 service laporan, permission, import, UI) |
| **DO WE NEED SERVER?** | **TIDAK** untuk fitur multi-cabang itu sendiri. Server baru dibutuhkan hanya bila cabang-cabang harus memakai aplikasi secara bersamaan dari komputer berbeda (lihat laporan Multi-User). |
| **DO NOT IMPLEMENT YET** | **YES.** Ada keputusan akuntansi yang harus dijawab klien dulu (lihat "DESIGN DECISION REQUIRED"). |

Opsi yang dibandingkan:
- **A (rekomendasi):** satu company.db, `branch_id` di jurnal.
- **B:** satu company.db per cabang (database terpisah), konsolidasi lewat laporan gabungan.
- **C:** satu perusahaan induk + "perusahaan" terpisah per cabang yang saling berelasi (pakai fitur multi-company yang sudah ada).

## 1. Kondisi architecture saat ini

- Isolasi data per **perusahaan = satu file** `companies/<slug>/company.db` (ADR-001). Tidak ada kolom `company_id` di dalam company.db.
- Autentikasi: tabel `users` + `sessions` (master DB). Otorisasi: `company_access` (System DB) dengan peran `OWNER / ADMIN / ACCOUNTANT / STAFF / VIEWER`, dicek lewat alur `requireAuth -> requireCompanyAccess -> requirePermission`.
- Semua laporan (Neraca, Laba Rugi, Ekuitas, Arus Kas, Trial Balance, Ledger, Dashboard, Export) menghitung dari satu sumber: `journal_entries` + `journal_entry_lines` yang berstatus POSTED/REVERSED.
- **Tidak ada konsep cabang/kantor** di skema, service, permission, UI, maupun import.

## 2. Struktur data saat ini (yang relevan)

| Tabel | Catatan untuk multi-cabang |
|---|---|
| `company_profile` | 1 baris per company.db |
| `accounts` (COA) | `code` unik per company. Tidak ada atribut cabang. `is_locked` baru ditambahkan |
| `periods` | periode fiskal bersama untuk seluruh perusahaan |
| `journal_entries` | `period_id`, `entry_date`, `reference_no` (UNIK global), `status`. **Tidak ada `branch_id`** |
| `journal_entry_lines` | `account_id`, `debit`, `credit`, `counterparty_id`. Tidak ada cabang |
| `trial_balance_snapshots` | tabel ada tetapi tidak diisi oleh journal-service company DB (dihitung langsung) |
| `company_audit_log` | append-only (trigger). Tidak ada `branch_id` |
| `company_access` (System DB) | user -> company -> role. Tidak ada user -> cabang |

## 3. Dampak multi-cabang

| Area | Dampak |
|---|---|
| Skema jurnal | perlu `branch_id` (header) dan untuk jurnal antar kantor perlu cabang per baris |
| Laporan | semua query laporan perlu parameter `branchId` (satu cabang / semua = konsolidasi) |
| Konsolidasi | saldo Antarkantor harus saling meniadakan saat konsolidasi |
| Permission | perlu akses per cabang |
| Import | template Excel perlu kolom Cabang |
| Nomor jurnal | `reference_no` unik global sudah cukup, tetapi penomoran otomatis sebaiknya berprefiks cabang |
| Periode | tetap satu set periode perusahaan (menutup periode berlaku semua cabang) |
| Saldo awal | perlu saldo awal per cabang |

## 4. Cara menyimpan branch

Tabel baru `branches` di company.db:

```
branches(id, code UNIQUE, name, is_head_office BOOLEAN, is_active, created_at)
```

Migration aditif: buat `branches`, sisipkan satu baris **"Kantor Pusat" (is_head_office = 1)** per perusahaan.

## 5. Cara menentukan branch user

Tabel baru `branch_access(system_user_id, company_id, branch_id)` di System DB, di samping `company_access`. Aturan:
- OWNER/ADMIN: semua cabang (default).
- Peran lain: hanya cabang yang tercantum.
- Disimpan di server, **tidak pernah dipercaya dari body request** (pola yang sama dengan `role` saat ini).

## 6. Cara menentukan branch pada journal

- `journal_entries.branch_id NOT NULL DEFAULT <id Kantor Pusat>` (migration: kolom nullable -> isi semua baris lama dengan Kantor Pusat -> baru jadikan wajib di service).
- Cabang diambil dari cabang aktif pilihan user yang divalidasi terhadap `branch_access`; user dengan satu cabang otomatis terisi.
- Jurnal biasa: seluruh baris milik satu cabang. Jurnal antar kantor: lihat bagian 8.

## 7. Cara membuat laporan per branch

Tambahkan parameter opsional `branchId` ke fungsi bersama di `reporting-utils.ts` (`getAccountMovementInRange`, `getAccountBalanceAsOfInclusive`, `getFlowAccountCumulativeTotal`, `getCumulativeUnclosedProfitLoss`) dan ke `ledger-service`/`trial-balance-service`. Karena semua laporan sudah memakai fungsi-fungsi itu, perubahan terpusat. `branchId` kosong = konsolidasi seluruh cabang. Dashboard, Export Excel/PDF, dan pencarian mewarisi filter yang sama.

## 8. Cara membuat journal antar branch

Satu transaksi atomik yang menghasilkan **dua sisi seimbang per cabang**:

Contoh: Pusat mengirim kas Rp 10 juta ke Cabang Metro.
- Cabang Pusat: D `Antarkantor - Aktiva (Metro)` 10 jt / K `Kas` 10 jt
- Cabang Metro: D `Kas` 10 jt / K `Antarkantor - Pasiva (Pusat)` 10 jt

Aturan integritas yang harus ditegakkan di service (bukan UI):
1. Total debit = total kredit **per cabang** (bukan hanya total jurnal).
2. Baris akun Antarkantor wajib mengisi `counterpart_branch_id`.
3. Jurnal antar kantor memakai satu `interbranch_group_id` agar dapat ditelusuri dan direversal sebagai satu kesatuan.
4. Saldo `Antarkantor Aktiva` cabang X terhadap Y harus sama dengan `Antarkantor Pasiva` Y terhadap X (laporan rekonsiliasi antarkantor).

## 9. Struktur akun antarkantor

Hasil audit COA: `accounts` memiliki `account_type_id`, `normal_balance`, `account_subtype`, `subledger_type`, `cash_flow_activity`. Sistem **sudah memakai `account_subtype` untuk akun khusus** (mis. `opening_balance_adjustment`, `equity_retained`). Karena itu akun Antarkantor tidak perlu tipe akun baru.

Usulan:
- Dua akun COA bersama: `1xxx Antarkantor - Aktiva` (ASSET, debit, `account_subtype = 'interbranch'`) dan `2xxx Antarkantor - Pasiva` (LIABILITY, credit, `account_subtype = 'interbranch'`).
- Struktur ini **tidak ditentukan dari namanya**. Penanda adalah `account_subtype = 'interbranch'`; kode/nama akun bebas diubah klien.
- Detail lawan transaksi disimpan di baris (`counterpart_branch_id`), bukan dibuat akun terpisah per cabang. Ini menghindari ledakan jumlah akun (N cabang x N akun).
- Pada laporan konsolidasi, kedua akun dieliminasi (selisih harus nol; selisih = antarkantor belum cocok).

## 10. Risiko data corruption

| Risiko | Mitigasi |
|---|---|
| Migration mengisi `branch_id` salah pada jutaan baris | migration aditif, backup `company.db.pre-upgrade` otomatis (sudah ada di `company-upgrade.ts`), uji pada salinan |
| Jurnal antar kantor tidak seimbang per cabang | validasi di service di dalam transaksi + test |
| Laporan cabang dan konsolidasi berbeda | test rekonsiliasi: jumlah semua cabang = konsolidasi |
| Reversal jurnal antar kantor hanya satu sisi | reversal berdasarkan `interbranch_group_id` (semua sisi sekaligus) |
| User cabang melihat data cabang lain | filter cabang wajib di server untuk setiap query, bukan di UI |
| `reference_no` bentrok antar cabang | tetap unik global; penomoran otomatis berprefiks kode cabang |

## 11. Dampak ke company DB

- Migration aditif: `branches`, `journal_entries.branch_id`, `journal_entry_lines.counterpart_branch_id`, `journal_entries.interbranch_group_id`.
- Tidak ada DROP/DELETE. `down` migration menghapus kolom baru saja.
- Satu file company.db tetap satu perusahaan (opsi A), sehingga backup/restore tidak berubah.

## 12. Dampak ke permission

- Permission baru yang dibutuhkan: `branch.manage` (OWNER/ADMIN), `journal.interbranch` (ACCOUNTANT ke atas).
- `requirePermission` tidak berubah; ditambah middleware `requireBranchAccess` setelah `requireCompanyAccess`.
- Peran VIEWER/STAFF dibatasi ke cabang yang diberikan.

## 13. Dampak ke audit log

Tambahkan `branch_id` (nullable) ke `company_audit_log` agar audit dapat difilter per cabang. Trigger append-only tetap utuh (kolom baru diisi saat INSERT; tidak ada UPDATE).

## 14. Dampak ke report

Neraca, Laba Rugi, Ekuitas, Arus Kas, Trial Balance, Ledger, Dashboard/YTD, Export Excel/PDF, dan Pencarian perlu parameter cabang. Tambahan baru: **Laporan Konsolidasi** dan **Rekonsiliasi Antarkantor**. Karena logika laporan terpusat di `reporting-utils.ts`, ini perubahan MEDIUM, bukan penulisan ulang.

## 15. Migration strategy

1. Migration C0014: buat `branches`, sisipkan Kantor Pusat.
2. Migration C0015: tambah kolom `branch_id`, `counterpart_branch_id`, `interbranch_group_id` (nullable), isi baris lama = Kantor Pusat.
3. Rilis service: validasi cabang aktif (cabang tunggal = perilaku lama, tanpa perubahan bagi klien yang tidak memakai cabang).
4. Rilis laporan per cabang + konsolidasi di balik pengaturan "Aktifkan multi-cabang" per perusahaan.
5. Rilis jurnal antar kantor + rekonsiliasi.
6. Backup otomatis sebelum setiap migration (sudah ada).

## 16. Backward compatibility

- Perusahaan lama: otomatis 1 cabang (Kantor Pusat). UI tidak menampilkan pemilih cabang sampai fitur diaktifkan.
- API lama tanpa `branchId` tetap berlaku (default cabang aktif / konsolidasi).
- Import Excel lama (tanpa kolom Cabang) = Kantor Pusat.
- Tidak ada perubahan pada lisensi.

## DESIGN DECISION REQUIRED (jangan ditebak, tanyakan ke klien)

1. **Laba/rugi dan ekuitas per cabang:** apakah setiap cabang punya modal/ekuitas sendiri, atau modal hanya di Kantor Pusat dan cabang memakai Antarkantor sebagai "modal"? Ini menentukan apakah Neraca cabang harus balance sendiri.
2. **Neraca cabang harus seimbang sendiri?** Pada jurnal antar kantor yang dijelaskan, ya (per cabang seimbang). Bila klien ingin cabang tanpa Antarkantor Pasiva, struktur berubah.
3. **Periode:** apakah penutupan periode per cabang atau serentak? (rekomendasi: serentak).
4. **Mata uang / penomoran / pajak per cabang (NPWP cabang)?** Bila ya, perlu atribut tambahan di `branches`.
5. **Siapa yang boleh membuat jurnal antar kantor** (satu sisi saja atau kedua sisi)?
6. **Hak akses user cabang atas laporan konsolidasi.**

## Perbandingan opsi

| | A: branch_id (rekomendasi) | B: DB per cabang | C: perusahaan terpisah |
|---|---|---|---|
| Perubahan skema | sedang | kecil | kecil |
| Jurnal antar kantor atomik | **ya** (satu transaksi) | tidak (dua database) | tidak |
| Konsolidasi | query biasa | harus membuka N database | manual |
| Backup | 1 file | N file | N file |
| Risiko data tidak sinkron | rendah | **tinggi** | **tinggi** |
| Data lama | otomatis jadi Kantor Pusat | harus dipecah | harus dipecah |
| Kecocokan dengan arsitektur sekarang | tinggi | rendah (satu proses membuka banyak DB per request) | sedang |
