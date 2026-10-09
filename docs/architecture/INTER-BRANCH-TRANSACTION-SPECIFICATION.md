# INTER-BRANCH TRANSACTION — SPECIFICATION (DESIGN, BELUM ADA KODE)

**Status:** FINAL DESIGN GATE · 2026-10-07 · dokumen ini sendiri tidak mengubah kode. **Pembaruan 2026-10-08:** IB-1 diimplementasikan (lihat `IB-1-IMPLEMENTATION-REPORT.md`; seluruh alur IB-2…IB-6 di `INTER-BRANCH-IMPLEMENTATION-REPORT.md`); koreksi disetujui OWNER dicatat di `IB-1-SPEC-CHANGELOG.md` dan berlaku di atas dokumen ini untuk butir yang tercantum.
**Menurunkan dari:** `MULTI-BRANCH-AUDIT-AND-DESIGN.md` Revisi 3–6 (W.*, Z.7, Z.8, Z.12, C1–C8) yang sudah Anda setujui. Dokumen ini **mempertajam dan menyederhanakan**, bukan mendesain ulang; bagian yang menyimpang dari Revisi 6 ditandai **[BEDA]** dan dikumpulkan di bagian 32.
**Koreksi D-10 (final):** OWNER tidak memerlukan approval pengguna lain (business rule eksplisit, bagian 8.1). Pernyataan lama di `MULTI-BRANCH-AUDIT-AND-DESIGN.md` (W.2, Z.7: "alasan wajib, `self_approved`, audit `INTER_BRANCH_SELF_APPROVED`") **digantikan** oleh bagian 8.1 dokumen ini.

> **ATURAN PRODUK DEFINITIF.** OWNER memiliki full authority atas workflow Inter-Branch miliknya sendiri dan tidak membutuhkan approval user lain. Namun OWNER tidak melewati security, company/branch access, domain validation, accounting validation, atau audit.

**Baseline:** Phase 3 Authorization Baseline (FROZEN). `multi_branch_enabled = OFF`. Phase 5A/5B/5C dan Phase 6 tidak dimulai oleh dokumen ini. **Phase 5A yang sempat dikerjakan sebagian dibekukan sebagai WIP — NOT APPROVED / NOT PRODUCTION dan bukan dependensi Inter-Branch** (D-0 FINAL; lihat `docs/wip/`).

---

## 1. Executive Summary

TERRA sudah punya hampir seluruh fondasi untuk transaksi antar-cabang; yang belum ada hanya **entitas transaksinya dan prosedur posting dua sisinya**. Fondasi yang sudah ada dan dipakai apa adanya: cabang + siklus hidup, `user_branch_access`, permission `interbranch.read/create/approve/reverse` (berstatus *prepared*, sudah dapat di-GRANT/DENY), `canActOnBranch`, kebijakan akun `INTER_BRANCH` + `accounts.counterpart_branch_id` (+ pembuatan pasangan akun terpandu), kolom jurnal `inter_branch_transaction_id/leg/side` dengan UNIQUE slot dan trigger semua-atau-kosong, `journal_entries.origin`, audit `company_audit_log.branch_id`.

Rekomendasi inti:

1. **Satu konsep "Transaksi Antar-Cabang"** = *permintaan bertahap yang tidak punya efek akuntansi sampai cabang tujuan menyetujuinya*. Persetujuan, penerimaan, dan posting adalah **satu aksi atomik** — bukan tiga status. Ini menghilangkan seluruh kelas keadaan "setengah jadi".
2. **Tiga jalur yang tidak boleh dicampur (§7):** *Business Transaction* `WAITING_APPROVAL → COMPLETED | REJECTED | CANCELLED | EXPIRED`; *Accounting Event* `NOT_POSTED → POSTED`; *Reversal* `NOT_REVERSED → REVERSAL_WAITING → REVERSED`. **`COMPLETED` ≠ `POSTED`:** COMPLETED = transaksi bisnis selesai; POSTED = peristiwa akuntansi sudah masuk jurnal. Keduanya hanya berubah bersama, di dalam satu transaksi database. Pada MVP tidak ada DRAFT yang dipersistenkan, APPROVED, RECEIVED, FAILED, PARTIAL, AMENDED (alasan di §7).
3. **Jurnal dibuat hanya saat disetujui**, kedua sisi dalam **satu `db.transaction`**. Sudah saya buktikan (percobaan kecil di luar repositori) bahwa fungsi jurnal yang ada dapat dipanggil dengan `trx` sebagai `db` (menjadi savepoint) dan kegagalan sisi kedua membatalkan sisi pertama — jadi **refactor `…InTransaction` yang dijadwalkan di Revisi 6 tidak diperlukan**. **[BEDA]**
4. **Otorisasi memakai model Phase 3 tanpa permission baru:** `canActOnBranch(permission, cabang)` + segregation of duties (pengaju ≠ penyetuju) untuk semua **non-OWNER**. Delegasi **tidak menambah** hak (konsisten dengan aturan Phase 3 "hak efektif = delegasi ∩ akses ∩ permission"). **OWNER** dikecualikan dari segregation of duties lewat **business rule eksplisit workflow Inter-Branch** (bagian 8.1): OWNER dapat mengajukan, menyetujui, menerima, dan menyelesaikan transaksinya sendiri tanpa approval pihak lain dan tanpa delegasi; semuanya tetap diaudit. Bukan permission baru, bukan perubahan baseline Phase 3.
5. **MVP: dua jenis** — `TRANSFER_KAS` dan `PEMBEBANAN` (biaya/transaksi atas nama cabang lain, akun bebas dengan kebijakan akun tetap berlaku). Persediaan, pendapatan antar-cabang (margin), multi-baris, lampiran, ambang persetujuan, dan jalur `head_office_effect` ditunda.
6. **Akun antar-cabang tidak di-hardcode dan tidak berupa satu akun penampung (clearing) per perusahaan.** Sistem memilih akun `INTER_BRANCH` berdasarkan *cabang lawan* (`counterpart_branch_id`) dan sifat sisi; bila tidak ada, pengajuan diblokir dengan arahan membuat pasangan akun (fitur terpandu yang sudah ada).
7. **Schema: satu migration company.db (`C0019`) dengan 2 tabel** (`inter_branch_transactions`, `inter_branch_approvals`) + 1 kolom `company_profile.inter_branch_expiry_days`. System DB tidak berubah. Indeks sekunder **tidak** ditambahkan tanpa bukti `EXPLAIN` (aturan #16).

## 2. Current Architecture Findings (hasil audit repositori)

| Area | Temuan (bukti) | Dampak pada desain |
|---|---|---|
| **Perusahaan** | Satu `company.db` = satu perusahaan (ADR-001); tidak ada `company_id` di company.db; identitas/akses di System DB (`companies_registry`, `company_access`). Satu COA per perusahaan. | Tabel antar-cabang **harus di company.db** agar atomik dengan jurnal dan ikut backup perusahaan. Isolasi tenant = isolasi file; tak perlu kolom `company_id`. |
| **Cabang** | `branches` (C0014): `status` ACTIVE/INACTIVE/CLOSED, `is_head_office`, soft delete. Flag `company_profile.multi_branch_enabled` (C0017) default 0; `isMultiBranchEnabled`. | Modul hanya hidup saat flag ON; OFF = rute 404. |
| **Akses & otorisasi** | `requireCompanyAccess` membaca akses/override/delegasi dari System DB **tiap request**; `hasBasePermission` (role ∪ GRANT − DENY); `canActOnBranch(a, perm, branchId)` sudah ada "untuk fitur per-cabang (Phase 6)"; `resolveBranchAuthority` (akses, konteks); `requireAccessibleBranch` → 404 seragam; `BRANCH_AWARE_ROUTES` deny-by-default untuk LIMITED. | Seluruh gerbang otorisasi sudah tersedia. Tidak ada permission atau tabel hak baru. |
| **Permission** | `interbranch.read` (OWNER/ADMIN/ACCOUNTANT/STAFF), `.create` (idem), `.approve` & `.reverse` (OWNER/ADMIN/ACCOUNTANT); semua *overridable* dan *prepared* (`PREPARED_PERMISSIONS`). VIEWER tidak punya. | Cocok dengan W.9; tinggal dipasang ke endpoint (syarat gerbang aktivasi backlog B). |
| **Delegasi** | Kapabilitas `inter_branch` tersimpan/divalidasi tetapi *prepared*; aturan Phase 3: delegasi **tidak menambah permission**. | Revisi 4 W.9 menyatakan `inter_branch` "mencakup mengajukan dan menyetujui" — **bertentangan** dengan aturan Phase 3; Phase 3 yang menang (bagian 10). |
| **Mesin jurnal** | `createDraftJournalEntry`, `postJournalEntry`, `reverseJournalEntry` masing-masing membuka `db.transaction` sendiri; validasi periode (`assertPeriodIsWritable`), kebijakan tanggal (`assertEntryDatePolicy`: ≤ hari ini, batas backdate), referensi unik global (`reference_no` UNIQUE, diberikan pemanggil), akun aktif, **cabang×asal** (`assertBranchAcceptsOrigin`) dan **kebijakan akun** (`assertAccountsAllowedForJournal`) dicek saat buat **dan** saat posting. `reverse` menolak jurnal bertaut antar-cabang (`JournalInterBranchLinkedError`), begitu juga `deleteDraft`. | Titik ekstensi sudah disiapkan Phase 2; yang perlu diubah kecil (bagian 11/12). `assertBranchAcceptsOrigin` saat ini menolak `inter_branch` ("belum didukung"). |
| **Kolom jurnal** | C0015 sudah menambah `inter_branch_transaction_id/leg/side`, `uq_journal_entries_inter_branch_slot`, trigger semua-atau-kosong, `origin` memuat `inter_branch` dan `head_office_effect`. **Belum ada FK/trigger yang menjamin transaksi induk ada** (tabelnya belum ada). | Migration C0019 menambah trigger penjaga induk (bagian 11). |
| **Akun antar-cabang** | C0016: `branch_policy` (+ `INTER_BRANCH`), `counterpart_branch_id` (trigger dua arah); `createInterBranchAccountPair` (preview+konfirmasi, tipe ASSET "Antarkantor Aktiva – X" atau LIABILITY "Antarkantor Passiva – X", unik per (cabang lawan, tipe)); policy menolak INTER_BRANCH untuk manual/import dan menolak cabang = lawan. | Pemilihan akun otomatis berdasar `counterpart_branch_id` (bagian 5/12). |
| **Periode** | `periods` bersama seluruh cabang (tanpa kolom cabang); OPEN/LOCKED/CLOSED; LOCKED & CLOSED memblokir create **dan** post; tidak ada bypass "permission khusus". `period-closing-service` memeriksa jumlah DRAFT sebelum tutup. | Pengajuan WAITING bertanggal dalam periode harus memblokir penutupan (Z.7). Tutup periode = seluruh cabang. |
| **Audit** | `appendCompanyAudit(trx, …)` dalam transaksi yang sama (audit gagal ⇒ rollback), kolom `branch_id`, append-only (trigger). Audit sistem terpisah (System DB). | Dipakai apa adanya; event baru (bagian 15). |
| **Concurrency** | Company DB dibuka `pool {min:1,max:1}` (satu koneksi, penulis tunggal dalam proses). | Penjaga utama tetap *update bersyarat berstatus* (aman bila kelak ada banyak proses). |
| **Penomoran** | `reference_no` diisi pemanggil dan unik global; tidak ada generator penomoran terpusat. | Nomor transaksi IB dibuat di dalam transaksi pembuat; ruang nama referensi jurnal dilindungi (bagian 12). |
| **Lampiran** | Tidak ada infrastruktur lampiran di repositori (kecocokan "attachment" hanya header HTTP). | Lampiran **ditunda** (bagian 29). |
| **Notifikasi** | UI Phase 3 memakai polling 60 dtk / fokus jendela untuk perubahan akses. | Lencana kotak masuk memakai polling yang sama (bagian 21). |
| **Uang** | Kolom jumlah desimal (18,2); aritmetika BigInt sen (`lib/money.ts`). | `amount` desimal(18,2), validasi sen; tidak ada float baru. |

## 3. Problem Statement

Hari ini satu-satunya cara mencatat transaksi antara dua cabang adalah dua jurnal manual terpisah yang dibuat dua orang berbeda — tanpa tautan, tanpa jaminan kedua sisi ada, tanpa kontrol persetujuan, dan ditolak oleh kebijakan akun (akun `INTER_BRANCH` tidak boleh manual). Akibatnya saldo antar-cabang tidak dapat direkonsiliasi, dan Neraca per cabang tidak dapat dipercaya. Yang dibutuhkan adalah **transaksi bisnis yang menghubungkan dua cabang**, menghasilkan dua jurnal yang saling menyeimbangkan lewat akun antar-cabang, dapat ditelusuri, dan tidak pernah "setengah".

## 4. Business Requirements

| ID | Kebutuhan | Pemenuhan |
|---|---|---|
| BR-1 | Cabang A membuat transaksi kepada cabang B; hubungan asal–tujuan jelas | entitas `inter_branch_transactions` |
| BR-2 | Kedua jurnal tertaut & dapat ditelusuri dua arah | kolom `inter_branch_*` pada jurnal (sumber kebenaran tunggal) |
| BR-3 | Cabang tujuan mengonfirmasi sebelum ada efek akuntansi | persetujuan = penerimaan = posting (atomik) |
| BR-4 | Kotak masuk & kotak keluar per cabang | endpoint/halaman Masuk/Keluar |
| BR-5 | Tidak ada transaksi setengah-posted | satu `db.transaction` + pasca-kondisi + uji injeksi kegagalan |
| BR-6 | Pembalikan tanpa mengubah jurnal posted | reversal berpasangan (4 jurnal, 1 identifier) |
| BR-7 | Kontrol: pengaju ≠ penyetuju, batas cabang, audit lengkap | bagian 8–10, 15 |
| BR-8 | Perusahaan satu-cabang tidak berubah | flag OFF ⇒ modul tidak ada |
| BR-9 | Data siap untuk laporan per cabang/gabungan/eliminasi | bagian 22 |

## 5. Accounting Model

**Invarian dasar (berlaku untuk semua jenis):** nilai selalu mengalir dari **cabang pemberi (FROM)** ke **cabang penerima (TO)**.

```
FROM (pemberi)                              TO (penerima)
  D  Antarkantor [counterpart = TO]  A        D  Akun penerima (kas/beban/…)      A
  K  Akun pemberi (kas/…)            A        K  Antarkantor [counterpart = FROM]  A
```

Contoh golden (konsisten dengan Revisi 6 C1/C6): Metro → Bandar Lampung Rp1.000.000, pembayaran hutang BL oleh Metro:
Metro: D Antarkantor Aktiva – Bandar Lampung 1.000.000 / K Kas 1.000.000. BL: D Hutang Usaha 1.000.000 / K Antarkantor Passiva – Metro 1.000.000. Rekonsiliasi pasangan: Σ(D−K) akun antar-cabang Metro→BL + Σ(D−K) akun antar-cabang BL→Metro = 0.

**Mengapa satu-arah cukup:** semua kasus bisnis yang diminta adalah "A memberi nilai kepada B"; kasus sebaliknya adalah transaksi lain dengan pemberi tertukar. Itu membuat pembentukan jurnal **deterministik** (tanpa pilihan Debit/Kredit dari pengguna) dan menutup kelas kesalahan arah.

**Pemilihan akun antar-cabang (tidak di-hardcode, bukan satu akun clearing per perusahaan):**
- Sisi FROM mendebit akun `INTER_BRANCH` dengan `counterpart_branch_id = TO`; diutamakan tipe ASSET, cadangan tipe LIABILITY (model netto Revisi 6 C1 didukung).
- Sisi TO mengkredit akun `INTER_BRANCH` dengan `counterpart_branch_id = FROM`; diutamakan LIABILITY, cadangan ASSET.
- Tidak ditemukan / tidak aktif / terkunci / ambigu ⇒ pengajuan **ditolak saat diajukan** dengan pesan arahan ("buat akun antarkantor untuk pasangan Metro–BL", memakai fitur terpandu `accounts/inter-branch` milik OWNER). Tidak ada pilihan diam-diam.
- *Mengapa bukan satu clearing per perusahaan:* satu akun kehilangan identitas cabang lawan sehingga rekonsiliasi per pasangan dan eliminasi parsial (Gabungan Terpilih) tidak mungkin — kritik Revisi 6 C1 tetap berlaku.
- Akun sisi sendiri (Kas, Beban, Hutang, …) dipilih pengguna; akun sisi lawan yang dipilih pengaju hanyalah **usulan**, penyetuju mengonfirmasi akun sisinya sendiri (W.3).

**Jenis transaksi — evaluasi:**

| Jenis yang diminta | Hakikat akuntansi | Putusan |
|---|---|---|
| Transfer Kas | perpindahan uang; kedua akun harus `is_cash` | **MVP** `TRANSFER_KAS` (validasi: kedua akun kas) |
| Beban Antar-Cabang, Pembebanan Biaya | FROM membayar/menanggung, TO mengakui beban/hutang — satu pola yang sama | **MVP**, digabung menjadi `PEMBEBANAN` |
| Jurnal Antar-Cabang Manual | pola yang sama dengan `PEMBEBANAN` dengan akun bebas | **dilebur** ke `PEMBEBANAN` (akun bebas, kebijakan akun tetap berlaku); multi-baris ditunda |
| Transfer Persediaan | perpindahan fisik; TERRA belum punya modul persediaan, hanya akun | ditunda; secara akun = `PEMBEBANAN` dengan akun persediaan; fitur khusus (kuantitas/HPP) menunggu modul persediaan |
| Pendapatan Antar-Cabang | penjualan internal; bila ada margin ⇒ laba belum terealisasi harus dieliminasi | **ditunda ke Phase 7** (Revisi 1 K sudah mencatat sebagai risiko) |
| Koreksi Antar-Cabang | bukan jenis; = reversal (bagian 7) atau transaksi baru berarah sebaliknya | tidak ada jenis tersendiri |

Satu mesin, dua *preset* (`type`) yang hanya menentukan validasi akun dan label UI. `type` divalidasi di aplikasi (bukan CHECK DB) agar menambah jenis tidak memerlukan pembangunan ulang tabel SQLite.

**Transfer kas ≠ jurnal antar-cabang manual:** transfer kas mewajibkan kedua akun `is_cash` (mencegah transfer "kas" ke akun beban); pembebanan mewajibkan akun penerima bukan akun kas-ke-kas dan memo; keduanya memakai prosedur posting yang sama. **Catatan arus kas:** akun antar-cabang tanpa `cash_flow_activity` muncul sebagai `unclassifiedAmount` pada Arus Kas per cabang — sengaja dibiarkan jujur (keputusan D-9).

**Tanggal:** `transaction_date` = tanggal yang diajukan; kedua jurnal bertanggal sama dan berada pada periode yang memuat tanggal itu. Konsekuensi akuntansi yang harus disadari: jurnal baru muncul pada tanggal lampau (saat disetujui) di dalam periode OPEN, sehingga laporan yang sudah dicetak untuk periode itu dapat berubah. Mitigasi: batas `expires_at` (bagian 6), periode ditutup memblokir pengajuan WAITING, dan UI menampilkan peringatan. Alternatif "jurnal pemberi langsung saat kirim + akun *in-transit*" **tidak direkomendasikan untuk MVP** (menciptakan keadaan setengah-posted yang justru ingin dihindari); dicatat sebagai keputusan D-8.

## 6. Transaction Lifecycle

1. **Ajukan** (FROM): validasi lengkap → baris `WAITING_APPROVAL` + `approvals(kind=POST, WAITING)`; **tidak ada jurnal**; nomor `IB-YYYY-NNNNNN`; `expires_at` dibekukan.
2. **Keputusan** (TO): *Setujui* (konfirmasi akun sisi sendiri) → posting atomik → bisnis `COMPLETED` **dan** akuntansi `POSTED` berubah bersama saat commit; *Tolak* (alasan wajib) → `REJECTED`.
3. **Batal** (pengaju selama WAITING) → `CANCELLED`. **Kedaluwarsa** → `EXPIRED` (dievaluasi saat dibaca/diterapkan, tanpa cron).
4. **Reversal** (jalur sendiri; status bisnis tetap `COMPLETED`): pihak berwenang meminta (alasan wajib) → `reversal_state = REVERSAL_WAITING` → cabang lawan menyetujui (OWNER: aturan 8.1) → 2 jurnal reversal atomik → `REVERSED`; ditolak/dibatalkan/kedaluwarsa → kembali `NOT_REVERSED`.
5. **`expires_at`** = min(`proposed_at` + `inter_branch_expiry_days` [default 14, konfigurasi OWNER 1–90], akhir hari `transaction_date` + `max_backdate_days`) — **[BEDA/penambahan]** agar pengajuan tidak pernah dapat disetujui ke dalam keadaan yang pasti ditolak kebijakan backdate. Bila `max_backdate_days` NULL, hanya batas hari.
6. **Validasi diulang pada posting akhir** (keadaan bisa berubah sejak diajukan; lihat tabel 6.1): kedua cabang masih ACTIVE; periode OPEN; kebijakan tanggal; kedua akun aktif/tak terkunci; `branch_policy` kedua sisi; penyetuju berwenang (8.1); belum kedaluwarsa; status masih `WAITING_APPROVAL`. Gagal ⇒ **tidak ada jurnal**, status tetap `WAITING_APPROVAL` (penyetuju dapat menolak; pengaju mengajukan ulang), kesalahan dikembalikan — tidak diam-diam diubah.

### 6.1 Tanggal, periode, dan posting akhir

| Tanggal | Arti | Dipakai untuk |
|---|---|---|
| `transaction_date` | tanggal akuntansi; **sama** untuk kedua jurnal dan untuk reversal; tidak pernah diubah otomatis | penentuan periode, batas backdate |
| `proposed_at` | waktu pengajuan | dasar `expires_at`, audit |
| `decided_at` / `posted_at` | waktu dinding saat posting akhir | audit, `journal_entries.posted_at` |
| `expires_at` | min(`proposed_at` + `inter_branch_expiry_days`, akhir hari `transaction_date` + `max_backdate_days`); dibekukan saat pengajuan | kedaluwarsa |

Tidak ada `posting_date` terpisah: tanggal jurnal = `transaction_date` (keputusan D-8). Aturan: (a) **periode dibaca ulang di dalam transaksi posting akhir** — bila saat pengajuan OPEN lalu sebelum persetujuan menjadi CLOSED/LOCKED ⇒ posting **ditolak**, tidak ada jurnal; (b) `assertEntryDatePolicy` dijalankan ulang dengan "hari ini" = hari posting (tidak di masa depan; batas backdate) — karena `expires_at` dibatasi oleh batas backdate, kegagalan ini hanya terjadi bila pengaturan backdate diperketat setelah pengajuan; (c) `expires_at` diperiksa pada posting akhir; (d) untuk reversal, periode tanggal asli harus OPEN pada saat posting reversal; (e) pengajuan WAITING memblokir **penutupan** periode (IB-4), tetapi **penguncian** (LOCK) tidak diblokir — konsekuensinya persetujuan ditolak jelas, tidak pernah diposting ke periode terkunci.

## 7. State Machine — tiga jalur terpisah

Satu transaksi dilacak oleh tiga hal yang **tidak boleh dicampur**. `COMPLETED` bukan sinonim `POSTED`.

### 7.1 Business Transaction (kolom `status`)
```
                  ┌───────── cancel (pengaju / OWNER) ──► CANCELLED
                  ├───────── reject (TO, alasan) ───────► REJECTED
WAITING_APPROVAL ─┼───────── now > expires_at ──────────► EXPIRED
                  └── approve (TO) = posting atomik ────► COMPLETED
```
Terminal: `COMPLETED`, `REJECTED`, `CANCELLED`, `EXPIRED`. `COMPLETED` = **transaksi bisnis selesai**.

### 7.2 Accounting Event (diturunkan dari jurnal; **tidak disimpan**)
```
NOT_POSTED ──(commit posting atomik)──► POSTED
```
`POSTED` = kedua jurnal `ORIGINAL` (FROM & TO) benar-benar ada di `journal_entries` berstatus POSTED. Dihitung dari jurnal (sumber kebenaran tunggal) dan dikirim ke klien sebagai `accountingEvent`; karena tidak disimpan, tidak mungkin melenceng dari jurnal.

### 7.3 Reversal (kolom `reversal_state`)
```
NOT_REVERSED ── request reverse ──► REVERSAL_WAITING ── approve (lawan, atau OWNER) ──► REVERSED
                                          │  reject / cancel / expire
                                          └──────────────────────────────────────────► NOT_REVERSED
```
`reversal_state ≠ NOT_REVERSED` hanya sah bila `status = COMPLETED` (CHECK database). `REVERSED` terminal.

### 7.4 Kombinasi yang sah (selain ini = pelanggaran invarian)

| `status` | accounting event | `reversal_state` | jurnal |
|---|---|---|---|
| `WAITING_APPROVAL` | NOT_POSTED | NOT_REVERSED | 0 |
| `REJECTED` / `CANCELLED` / `EXPIRED` | NOT_POSTED | NOT_REVERSED | 0 |
| `COMPLETED` | POSTED | NOT_REVERSED | 2 ORIGINAL |
| `COMPLETED` | POSTED | REVERSAL_WAITING | 2 ORIGINAL |
| `COMPLETED` | POSTED | REVERSED | 2 ORIGINAL + 2 REVERSAL (efek netto nol) |

Setiap transisi = satu `UPDATE … WHERE id=? AND status=<asal> [AND reversal_state=<asal>]` (0 baris ⇒ ditolak, tidak ada efek). `COMPLETED` dan jurnal `POSTED` menjadi terlihat **bersamaan** saat commit; tidak ada keadaan di luar transaksi di mana salah satunya ada tanpa yang lain.

### 7.5 Yang dipertimbangkan dan putusannya

| Dipertimbangkan | Putusan | Alasan |
|---|---|---|
| `DRAFT` | **tidak dipersistenkan pada MVP (D-3 FINAL)** | tidak punya efek akuntansi; formulir cukup; menambah status + permukaan edit + nomor terpakai. **Berbeda dari diagram bisnis di permintaan gate** (DRAFT→WAITING_APPROVAL→COMPLETED): pembuatan = pengiriman dalam satu aksi, dan audit tetap mencatat `CREATED` lalu `SUBMITTED` agar kosakata siap bila DRAFT ditambahkan kelak (menambah satu nilai CHECK `status` + endpoint edit milik pengaju) |
| `SUBMITTED` | = `WAITING_APPROVAL` | satu-satunya status menunggu |
| `APPROVED`, `RECEIVED` sebagai status bisnis | **dilarang** | keadaan setengah jadi (disetujui tapi belum ada jurnal; diterima tapi jurnal pengirim belum ada). "Disetujui/diterima" adalah *aksi*, bukan status; hasilnya `COMPLETED` + `POSTED` |
| `POSTED` sebagai status bisnis | **dilarang** | `POSTED` hanya milik jalur accounting event (7.2) |
| `REJECTED`/`CANCELLED`/`EXPIRED` | ya | beda aktor & makna audit |
| `FAILED` | **tidak** | kegagalan = rollback; transaksi tetap `WAITING_APPROVAL`; tidak dipersistenkan sebagai status |
| `PARTIAL` | **tidak** | pembayaran/penerimaan sebagian dibuat sebagai transaksi terpisah; sebagian = akar saldo yang tak bisa dieliminasi |
| `AMENDED` | **tidak** | jumlah/tanggal tak dapat diubah. "Minta revisi" = *Tolak dengan alasan* + tombol **Ajukan ulang** yang menyalin isian menjadi pengajuan baru (nomor baru) |

## 8. Authorization Model

Urutan (Phase 3, tidak diubah): Authentication → Company Access → **Flag ON** → Branch Access → Permission efektif (`hasBasePermission`) → aturan domain.

| Aksi | Permission | Syarat cabang (server) | Syarat tambahan |
|---|---|---|---|
| Lihat daftar/detail | `interbranch.read` | akses ke FROM **atau** TO (`canActOnBranch`) | tidak terlihat ⇒ **404 seragam** |
| Ajukan | `interbranch.create` | akses ke FROM; **FROM = cabang aktif terverifikasi** (pola `resolveWriteBranch`; `fromBranchId` di body hanya boleh sama dengan konteks); FROM & TO ACTIVE | akses ke TO **tidak** disyaratkan |
| Batalkan | `interbranch.create` | akses ke FROM | pengaju sendiri; OWNER boleh membatalkan transaksi siapa pun di FROM |
| Setujui / Tolak | `interbranch.approve` | akses ke **TO** (bukan FROM) | **non-OWNER:** pengaju ≠ penyetuju. **OWNER:** boleh menyetujui transaksi yang diajukannya sendiri (aturan 8.1). TO ACTIVE |
| Minta reversal | `interbranch.reverse` | akses ke FROM atau TO | alasan wajib; hanya bila `status=COMPLETED` dan `reversal_state=NOT_REVERSED`; pemohon di sisi mana pun |
| Setujui reversal | `interbranch.approve` | akses ke **sisi lawan pemohon** | **non-OWNER:** pemohon ≠ penyetuju. **OWNER:** boleh menyetujui permintaan reversal buatannya sendiri |
| Membaca ringkasan lencana | `interbranch.read` | cabang terakses | hanya hitungan |

Prinsip: (a) keputusan otorisasi hanya di server; `fromBranchId`, `toBranchId`, `userId`, `companyId` dari klien tidak pernah dipercaya untuk hak; (b) otorisasi dasar Phase 3 berlaku untuk semua peran termasuk OWNER (alur autentikasi, akses perusahaan, flag ON, akses cabang, permission efektif); yang dikecualikan OWNER hanyalah syarat "pengaju ≠ penyetuju" lewat business rule 8.1; (c) override DENY mengalahkan role (OWNER tidak dapat di-DENY, aturan Phase 3); pencabutan berlaku di request berikutnya (tanpa cache); (d) approver tidak perlu mengganti cabang aktif — aksi dinilai terhadap cabang **transaksi** dan harus ada dalam akses (keputusan D-6).

### 8.1 Business rule OWNER dan segregation of duties (keputusan final D-10)

**Aturan.** Peran **OWNER** memiliki kewenangan penuh atas workflow Inter-Branch: boleh membuat transaksi; boleh menyetujui, menerima, dan menyelesaikan (posting) transaksi yang ia buat sendiri, serta meminta dan menyetujui reversalnya sendiri; tidak memerlukan approval pengguna lain; tidak memerlukan delegasi. Ini **business rule eksplisit untuk peran OWNER**, bukan authorization bypass dan bukan perubahan model Phase 3.

**Cara ditegakkan (server-side, satu titik).** Fungsi keputusan tunggal `assertCanDecide(access, tx, approval)`:
1. Syarat dasar tetap diperiksa untuk siapa pun: login, akses perusahaan, flag ON, `canActOnBranch(interbranch.approve, TO)`, cabang TO ACTIVE, status masih `WAITING_APPROVAL`, belum kedaluwarsa.
2. Lalu: bila `request.companyAccess.role === "OWNER"` (peran dari System DB, tidak pernah dari klien) ⇒ lolos tanpa syarat pengaju ≠ penyetuju. Selain itu bila `decided_by === requested_by` ⇒ ditolak `403 SELF_APPROVAL_NOT_ALLOWED`.
3. Tidak ada permission baru (mis. `owner.can_self_approve`), tidak ada kolom pengaturan, tidak ada konfigurasi perusahaan: status OWNER sudah menjadi sumber kebenaran. UI hanya menyembunyikan/menampilkan tombol sebagai kenyamanan; penolakan sebenarnya di server.

**Yang tidak berubah untuk OWNER:** tetap harus melewati autentikasi, akses perusahaan, flag, akses cabang (OWNER ber-scope ALL), dan validasi domain (periode OPEN, kebijakan tanggal, akun aktif, `branch_policy`, cabang ACTIVE, kedaluwarsa). Kedua jurnal tetap dibuat lewat prosedur atomik yang sama.

**Pembatalan oleh OWNER.** OWNER juga dapat membatalkan pengajuan `WAITING_APPROVAL` milik pengguna lain di cabang FROM (tindakan administratif, diaudit; bukan penyetujuan dan tidak menyentuh akuntansi karena belum ada jurnal).

**Audit OWNER tetap lengkap.** Semua event (PROPOSED, APPROVED, ACCOUNT_CONFIRMED, REJECTED, CANCELLED, REVERSAL_*) ditulis seperti pengguna lain. Bila pelaku keputusan = pengaju, `after_json` event APPROVED memuat `makerEqualsApprover:true` dan `actorRole:"OWNER"`, dan kolom informasional `approvals.self_approved` diisi server (bukan input klien). Alasan **tidak** diwajibkan untuk OWNER (berbeda dari draf sebelumnya); penolakan tetap mewajibkan alasan untuk siapa pun.

**Non-OWNER (ADMIN, ADMIN LIMITED, ACCOUNTANT, STAFF, …):** maker ≠ approver **mutlak**, walau memegang kedua cabang — pengaju yang memegang kedua cabang dapat memindahkan uang tanpa mata kedua, dan peran saja tidak cukup karena satu orang dapat memegang dua cabang. Delegasi tidak pernah memperluas hak melampaui cakupan pemberinya (hak efektif = delegasi ∩ akses ∩ permission). **Ambang nominal** dan **auto-approve** tidak ada di MVP.

## 9. Permission Mapping

Tidak ada permission baru. Pemetaan nama: `INTER_BRANCH_VIEW/CREATE/APPROVE/REVERSE` → `interbranch.read/create/approve/reverse`. Bundel role default tetap seperti `rbac.ts` (STAFF boleh mengajukan, tidak boleh menyetujui; VIEWER tidak punya). Perusahaan yang ingin akuntan tertentu tidak boleh menyetujui memakai **DENY** (sudah ada); staf tertentu boleh menyetujui memakai **GRANT** (sudah ada). Yang berubah: permission dipasang ke endpoint, dan dari status *prepared* menjadi *implemented* (item gerbang aktivasi di backlog B).

## 10. Delegation Interaction

Aturan Phase 3 dipertahankan: **delegasi tidak menambah permission** dan hak efektif = delegasi ∩ akses saat ini ∩ permission efektif. Karena pengelolaan antar-cabang sudah sepenuhnya diatur oleh `permission × akses cabang`, kapabilitas `inter_branch` **tidak dibutuhkan untuk mengajukan/menyetujui** dan tidak dipakai sebagai gerbang pada MVP. Konsekuensi: kalimat W.9 ("kapabilitas inter_branch mencakup mengajukan dan menyetujui") **dinonaktifkan**; kapabilitas tetap tersimpan (kompatibel) dan dapat diberi arti pembatas di fase berikut bila diinginkan (mis. membatasi admin-LIMITED mengelola override `interbranch.*`). **[BEDA]** → keputusan D-5. Admin LIMITED tanpa delegasi tetap tidak punya kewenangan administratif, tetapi **boleh** bertransaksi antar-cabang bila role+akses cabangnya memenuhi (itu bukan administrasi).

## 11. Database Design

Satu migration company.db **`C0019_inter_branch`** (idempoten, tanpa mengubah data, lewat jalur upgrade ber-backup + `integrity_check`). **Tidak ada migration System DB.**

**`inter_branch_transactions`** (dokumen bisnis; kolom bisnis tak dapat diubah setelah insert)

| Kolom | Tipe / aturan |
|---|---|
| `id` | TEXT PK (UUID) |
| `transaction_no` | TEXT NOT NULL **UNIQUE** (`IB-YYYY-NNNNNN`) |
| `type` | TEXT NOT NULL (`TRANSFER_KAS`/`PEMBEBANAN`; whitelist di aplikasi) |
| `transaction_date` | TEXT NOT NULL (YYYY-MM-DD) |
| `from_branch_id`, `to_branch_id` | TEXT NOT NULL FK→`branches` RESTRICT; **CHECK `from_branch_id <> to_branch_id`** |
| `amount` | DECIMAL(18,2) NOT NULL **CHECK > 0** |
| `description` | TEXT NOT NULL; `reference_text` TEXT NULL (nomor bukti eksternal) |
| `from_account_id` | TEXT NOT NULL FK→`accounts` (akun sisi pemberi; **bukan** akun antar-cabang) |
| `to_account_suggested_id` | TEXT NOT NULL FK→`accounts` (usulan; akun final di `approvals.confirmed_account_id`) |
| `from_counterparty_id`, `to_counterparty_id` | TEXT NULL FK→`counterparties` (untuk akun hutang/piutang) |
| `status` | TEXT NOT NULL **CHECK IN** (`WAITING_APPROVAL`,`COMPLETED`,`REJECTED`,`CANCELLED`,`EXPIRED`) — jalur Business Transaction (7.1) |
| `reversal_state` | TEXT NOT NULL DEFAULT `NOT_REVERSED` **CHECK IN** (`NOT_REVERSED`,`REVERSAL_WAITING`,`REVERSED`); **CHECK (`reversal_state`=`NOT_REVERSED` OR `status`=`COMPLETED`)** — jalur Reversal (7.3). *Accounting event tidak punya kolom* (diturunkan dari jurnal, 7.2) |
| `proposed_by` | TEXT NOT NULL (id user System DB; tanpa FK lintas file) |
| `idempotency_key` | TEXT NOT NULL; **UNIQUE(`proposed_by`,`idempotency_key`)** |
| `created_at`, `updated_at` | timestamp |

Tidak ada `from_journal_id/to_journal_id` (derivatif; sumber kebenaran = jurnal, Revisi 6 C2). Tidak ada `company_id`. Tidak ada `origin` pada MVP (`head_office_effect` ditunda — kolom tidak ditambahkan "kalau-kalau"). Tabel *lines* (Z.12) **tidak** dibuat: MVP satu akun per sisi, disimpan di header **[BEDA]** (D-4); multi-baris kelak = tabel baru tanpa mengubah ini.

**`inter_branch_approvals`** (siklus keputusan; satu transaksi dapat punya banyak, mis. reversal berulang)

| Kolom | Aturan |
|---|---|
| `id` PK; `transaction_id` FK→transactions RESTRICT | |
| `kind` | CHECK IN (`POST`,`REVERSE`) |
| `status` | CHECK IN (`WAITING`,`APPROVED`,`REJECTED`,`CANCELLED`,`EXPIRED`) |
| `requested_by`, `requested_by_branch_id`, `requested_at`, `request_reason` | alasan wajib untuk `REVERSE` |
| `expires_at` | dibekukan saat dibuat |
| `decided_by`, `decided_at`, `decision_reason` | alasan wajib bila `REJECTED` |
| `self_approved` | INTEGER 0/1 — **informasional**, diisi server bila `decided_by = requested_by` (hanya mungkin untuk OWNER); bukan input klien dan bukan dasar otorisasi |
| `confirmed_account_id` | akun sisi TO yang dikonfirmasi (kind `POST`), FK→accounts |
| **UNIQUE parsial** `(transaction_id) WHERE status='WAITING'` | tidak mungkin dua permintaan menunggu sekaligus |

**Penjaga integritas (trigger, bukan disiplin aplikasi):**
- `inter_branch_transactions`: tolak `DELETE`; tolak `UPDATE` kolom bisnis (semua kecuali `status`,`reversal_state`,`updated_at`); transisi `status` dan `reversal_state` hanya yang ada di §7; `COMPLETED` dan `REVERSED` tidak dapat kembali.
- `inter_branch_approvals`: tolak `DELETE`; tolak ubah setelah status final kecuali tak ada.
- `journal_entries` (melengkapi C0015): `BEFORE INSERT` bila `inter_branch_transaction_id` terisi ⇒ transaksi harus ada, `origin='inter_branch'`, dan `branch_id` = `from_branch_id` (side FROM) / `to_branch_id` (side TO).
- `company_profile.inter_branch_expiry_days` INTEGER NOT NULL DEFAULT 14 CHECK 1–90 (pola kolom pengaturan yang ada).

**Indeks:** hanya yang menjadi konsekuensi UNIQUE/PK. **Indeks sekunder** `(to_branch_id,status)`, `(from_branch_id,status)`, `(status,expires_at)` (usulan Revisi 4) **ditunda**: ukuran tabel kecil (ratusan–ribuan baris); akan ditambahkan hanya bila `EXPLAIN QUERY PLAN` pada dataset terisi menunjukkan perlu (gerbang IB-7). Pencarian jurnal-dari-transaksi sudah ditutup indeks UNIQUE parsial C0015 (kolom depan = id transaksi).

## 12. Journal Generation Design

**Kapan:** hanya saat persetujuan (dan saat persetujuan reversal). Tidak ada jurnal draf/pending. **Siapa:** prosedur terprivilese sempit `executeInterBranchPosting(trx, ApprovedDecision)` (C3) — wewenang berasal dari catatan keputusan yang sudah divalidasi, bukan dari akses cabang penyetuju ke cabang FROM; tidak dapat dipanggil dari route lain; `origin` ditetapkan server.

Langkah (semuanya dalam **satu** `db.transaction` luar):
1. **Klaim:** `UPDATE inter_branch_transactions SET status='COMPLETED' WHERE id=? AND status='WAITING_APPROVAL'` + `UPDATE approvals … status='APPROVED' WHERE status='WAITING'`. Ini menulis lebih dulu (mengunci tulis); 0 baris ⇒ keluar tanpa efek (idempoten). `COMPLETED` baru terlihat pihak lain setelah commit — bersama jurnal `POSTED`; bila langkah berikutnya gagal, klaim ini ikut di-rollback.
2. Validasi ulang (bagian 6.6).
3. Tentukan periode dari `transaction_date` (tepat satu periode, harus ada).
4. Resolusi akun antar-cabang kedua sisi (bagian 5).
5. `createDraftJournalEntry(trx, …)` sisi FROM dan sisi TO lalu `postJournalEntry(trx, …)` keduanya — fungsi yang ada, dipanggil dengan `trx` (savepoint). Atribut: `origin='inter_branch'`, `inter_branch_transaction_id/leg='ORIGINAL'/side`, `createdBy`=pengaju, `postedBy`=penyetuju, referensi `IB-…-F` / `IB-…-T`. Tiap sisi: satu baris akun sisi sendiri + satu baris antar-cabang sebesar `amount` (D/K sesuai bagian 5), `counterparty_id` bila diisi.
6. **Pasca-kondisi** sebelum commit: tepat 2 jurnal (transaksi, ORIGINAL) — **leg FROM dan leg TO keduanya ada** (atau tidak ada keduanya ⇒ exception); `branch_id` sesuai; masing-masing seimbang (Σ debit = Σ kredit); Σ pasangan antar-cabang = nominal pada kedua sisi berlawanan; status keduanya POSTED.
7. Audit (dalam transaksi yang sama): `INTER_BRANCH_APPROVED` (keputusan), `INTER_BRANCH_POSTED` (peristiwa akuntansi, memuat id kedua jurnal), `INTER_BRANCH_COMPLETED` (peristiwa bisnis), + audit jurnal standar oleh fungsi jurnal.
**Aturan keras:** *dilarang menangkap (`try/catch`) kesalahan dari langkah 5 di dalam prosedur* — sebagaimana terbukti dalam percobaan, kegagalan yang ditangkap di dalam transaksi luar hanya membatalkan savepoint-nya sementara sisanya ter-commit; semua kesalahan harus merambat ke luar sehingga seluruh transaksi di-rollback.

**Reversal (`REVERSE`):** prosedur analog: klaim (`reversal_state` `REVERSAL_WAITING`→`REVERSED`) → validasi (periode asal masih OPEN — reversal memakai tanggal & periode jurnal asli, aturan yang ada; bila periode sudah ditutup/terkunci ⇒ ditolak dan jalannya adalah transaksi koreksi berarah sebaliknya di periode terbuka) → `reverseJournalEntry(trx, …)` untuk kedua jurnal ORIGINAL dengan pengecualian internal terhadap penolakan "bertaut antar-cabang", menghasilkan jurnal baru `REVERSAL/FROM` dan `REVERSAL/TO` → pasca-kondisi (4 jurnal, 1 identifier, kedua ORIGINAL bertanda REVERSED) → `reversal_state = REVERSED`; audit `INTER_BRANCH_REVERSAL_APPROVED` + `INTER_BRANCH_REVERSAL_POSTED`. **Tidak ada pengubahan baris jurnal POSTED untuk "memperbaiki" transaksi:** tanggal, akun, jumlah, cabang, dan baris jurnal asli tidak pernah diubah; satu-satunya perubahan pada jurnal asli adalah penanda status `POSTED→REVERSED` (`is_reversed`) yang dilakukan oleh fungsi reversal yang sudah ada dan memang bagian dari semantik reversal TERRA. Reversal satu sisi tidak mungkin dibuat (tidak ada jalur lain; endpoint jurnal biasa tetap menolak jurnal bertaut).

**Penomoran:** `transaction_no` = `IB-<tahun transaction_date>-<urutan 6 digit>` dihitung di dalam transaksi pembuat (`MAX+1` per tahun) dengan UNIQUE sebagai pengaman; nomor tidak pernah dipakai ulang (celah karena penolakan/pembatalan dapat diterima, tercatat). Referensi jurnal: `<no>-F`, `<no>-T`, reversal `<no>-F-REV`, `<no>-T-REV`. **Ruang nama dilindungi:** jurnal manual/import dengan awalan `IB-` ditolak (baris kecil di `assertReferenceNoAvailable`, perubahan baseline) agar tumbukan tidak menggagalkan persetujuan (keputusan D-7).

## 13. Atomicity Strategy

- **Keputusan:** satu `db.transaction` pada satu `company.db` (satu koneksi, SQLite transaksional) — bukan transaksi terkoordinasi dan bukan "jurnal pending", karena **semua data (transaksi, approval, kedua jurnal, audit) berada di file yang sama**. Itu alasan utama tabel IB tidak boleh di System DB.
- Pasangan terhadap "A berhasil, B gagal": tidak ada, karena tidak ada commit di antara. Diuji dengan **injeksi kegagalan** pada tiap titik tulis (insert jurnal FROM, insert jurnal TO, post FROM, post TO, update status, tulis approval, tulis audit, pasca-kondisi) — hasil wajib "semua ada atau tidak satu pun".
- Otorisasi (membaca System DB) dilakukan **sebelum** membuka transaksi company.db dan membekukan `ApprovedDecision`; selisih waktu milidetik dalam satu proses; validasi domain diulang di dalam transaksi.
- Kesalahan di tengah ⇒ transaksi tetap `WAITING_APPROVAL`, pesan jelas ke penyetuju; tidak ada status `FAILED`.

## 14. Concurrency Strategy

| Skenario | Penjaga |
|---|---|
| Dua penyetuju menyetujui bersamaan / klik ganda | langkah 1 `UPDATE … WHERE status='WAITING_APPROVAL'` (0 baris ⇒ keluar) + UNIQUE slot jurnal `(transaksi,leg,side)` |
| Dua pengajuan identik (klik ganda) | `UNIQUE(proposed_by, idempotency_key)` (kunci dibuat saat formulir dibuka); duplikat mengembalikan transaksi yang sama |
| Setujui vs batal/tolak bersamaan | semua transisi memakai `WHERE status=<asal>`; yang kalah mendapat 409 `INTER_BRANCH_STATE_CHANGED` |
| Dua permintaan reversal | UNIQUE parsial `approvals(transaction_id) WHERE status='WAITING'` |
| Setujui vs penutupan periode | validasi periode di dalam transaksi + pengajuan WAITING memblokir penutupan |
| Setujui vs cabang menjadi INACTIVE/CLOSED | cek status cabang di dalam transaksi; perubahan status cabang membatalkan pengajuan WAITING terkait dalam transaksinya sendiri |
| Banyak proses (kelak) | pola klaim-dulu (menulis sebelum membaca-memutuskan) + `busy_timeout`; tidak memerlukan versi baris |
Locking optimistik dengan kolom versi **tidak** dipakai: status + `WHERE` sudah cukup dan lebih mudah diuji.

## 15. Audit Strategy

`company_audit_log` (append-only, dalam transaksi yang sama; `entity_type='inter_branch_transaction'`, `entity_id`=id, `branch_id`=cabang pelaku, `after_json` memuat `transactionNo`, kedua cabang, jumlah, status lama→baru, alasan; untuk keputusan: `actorRole`, `makerEqualsApprover`, `self_approved` — **ketiganya informasional/audit, bukan sumber otorisasi**). Daftar event final:

| Siklus | Event |
|---|---|
| Pembuatan | `INTER_BRANCH_CREATED`, `INTER_BRANCH_SUBMITTED` (keduanya ditulis berurutan pada aksi ajukan; tidak ada DRAFT) |
| Keputusan | `INTER_BRANCH_APPROVED` (OWNER-sendiri: `makerEqualsApprover:true`, `actorRole:"OWNER"`, `self_approved:true`), `INTER_BRANCH_ACCOUNT_CONFIRMED` (bila akun usulan diubah: lama→baru), `INTER_BRANCH_REJECTED` |
| Akuntansi / selesai | `INTER_BRANCH_POSTED` (id kedua jurnal), `INTER_BRANCH_COMPLETED` |
| Penutupan tanpa efek | `INTER_BRANCH_CANCELLED`, `INTER_BRANCH_EXPIRED` (ditulis sekali saat pertama diterapkan) |
| Reversal | `INTER_BRANCH_REVERSAL_REQUESTED`, `_REVERSAL_APPROVED`, `_REVERSAL_POSTED`, `_REVERSAL_REJECTED`, `_REVERSAL_CANCELLED`, `_REVERSAL_EXPIRED` |

Audit jurnal standar (`journal.create/post/reverse`) tetap ditulis oleh fungsi jurnal dengan `branch_id` masing-masing sisi dan memuat id transaksi. Pelanggaran keamanan (cabang di luar akses, ID salah) → audit sistem `security.branch_access_denied` (pola Phase 3, dibatasi laju). Setiap event memuat: siapa, kapan, status asal→tujuan, id transaksi, cabang, alasan bila ada.

## 16. UI Specification

Menu **Antar Cabang** (hanya bila flag ON dan `interbranch.read`), lencana jumlah *Masuk menunggu*. Halaman tunggal dengan tab **Masuk · Keluar · Semua**; tombol **+ Transaksi Baru** (bila `interbranch.create`).
- Filter: rentang tanggal, cabang asal, cabang tujuan, status, jenis. Kolom: Nomor · Asal → Tujuan · Tanggal · Jenis · Nominal · Status.
- **Transaksi Baru:** Jenis → Cabang tujuan (daftar cabang ACTIVE selain asal; cabang asal = cabang aktif, tampil tetap) → Tanggal → Nominal → Akun sisi sendiri (disaring sesuai jenis) → Akun usulan sisi tujuan → Keterangan → Referensi. Pratinjau jurnal **sisi sendiri** dan akun antar-cabang yang akan dipakai sebelum kirim.
- **Detail:** header (nomor, asal, tujuan, jenis, nominal, status), kronologi (dibuat oleh, disetujui oleh, diterima/diputuskan, diposting pada), jurnal sisi sendiri (tautan *drill-down* hanya bila cabang jurnal itu terakses; sisi lawan tampil sebagai nomor referensi tanpa isi), tombol sesuai hak: Setujui (dialog: konfirmasi akun sisi sendiri + pratinjau jurnal), Tolak (alasan wajib), Batalkan, Minta Reversal, **Ajukan ulang**.
- Penyetuju mengikuti cabang transaksi, tidak dipaksa mengganti cabang aktif.
- Semua status/tombol hanyalah kenyamanan; server menegakkan. Perusahaan satu-cabang: tidak ada menu.

## 17. API Specification

Prefiks `/api/company-db/:companySlug/inter-branch`; semua `requireAuth → requireCompanyAccess → (flag ON, else 404) → permission`; ditambahkan ke `BRANCH_AWARE_ROUTES` (BC-2) dan registry klasifikasi route (tes arsitektur Phase 5.0 fail-closed).

| Metode & path | Permission | Catatan |
|---|---|---|
| `GET /` `?box=in\|out\|all&status&type&from&to&fromDate&toDate&page` | `interbranch.read` | hanya baris yang FROM/TO-nya terakses; DTO per sisi |
| `GET /summary` | `interbranch.read` | `{incomingWaiting, outgoingWaiting}` untuk lencana |
| `GET /:id` | `interbranch.read` | tak terlihat ⇒ 404 |
| `POST /` | `interbranch.create` | body: type,toBranchId,date,amount,accounts,description,reference,idempotencyKey; `fromBranchId` diabaikan/divalidasi = konteks |
| `POST /:id/approve` | `interbranch.approve` | body: `confirmedAccountId` saja. OWNER menyetujui transaksinya sendiri tanpa alasan (§8.1); non-OWNER yang sama dengan pengaju ditolak 403 `SELF_APPROVAL_NOT_ALLOWED` |
| `POST /:id/reject` | `interbranch.approve` | body: reason (≥ 10 karakter) |
| `POST /:id/cancel` | `interbranch.create` | body: reason? |
| `POST /:id/reverse` | `interbranch.reverse` | body: reason (wajib) |
| `POST /:id/reverse/:approvalId/{approve,reject,cancel}` | approve / reverse | |
DTO transaksi selalu memuat tiga bidang terpisah: `status` (bisnis), `accountingEvent` (`NOT_POSTED`/`POSTED`, diturunkan dari jurnal), `reversalState`. Respons error: 400 validasi (`INTER_BRANCH_*`), 403 `FORBIDDEN`/`SELF_APPROVAL_NOT_ALLOWED`, 404 seragam, 409 `INTER_BRANCH_STATE_CHANGED`, 422 aturan akuntansi (periode/tanggal/akun/kebijakan).
Tidak ada endpoint `PUT/PATCH/DELETE` (dokumen tak dapat diubah/dihapus).

## 18. Security Model

- **Server = sumber kebenaran**: cabang asal dari konteks tervalidasi; cabang tujuan divalidasi terhadap `branches` perusahaan itu (id lintas perusahaan tak dapat di-resolve karena file berbeda); akses dibaca dari System DB tiap request.
- **IDOR:** identitas dokumen = UUID (+ `transaction_no`); setiap pembacaan/aksi diperiksa terhadap akses cabang user; tidak terlihat ⇒ 404 identik dengan tidak ada (muatan, jumlah baris, urutan, paginasi, total, waktu relatif).
- **DTO per sisi:** pembaca hanya di sisi TO tidak melihat akun sisi FROM (`from_account_id`) dan sebaliknya tidak melihat konfirmasi akun TO sebelum diputuskan, kecuali memiliki akses ke kedua cabang.
- **Eskalasi:** `interbranch.approve` tanpa akses TO ditolak; akses TO tanpa permission ditolak; DENY menang; delegasi tidak memperluas.
- **Spoofing:** `X-Branch-Context` palsu ⇒ 403 `BRANCH_CONTEXT_INVALID` (pola Phase 1–3); `fromBranchId`/`companyId`/`userId` pada body diabaikan atau ditolak bila berbeda.
- **Integritas data:** trigger (bagian 11); prosedur posting tidak dapat dipanggil dari HTTP; endpoint jurnal biasa menolak jurnal bertaut.
- **Replay/duplikat:** idempotency key + klaim status.
- **Waktu:** `expires_at` memakai jam lokal; manipulasi jam desktop diterima sebagai risiko (R-9).

### Ancaman → kontrol server-side (UI bukan batas keamanan)

| Ancaman | Kontrol |
|---|---|
| Company ID spoofing | tidak ada `companyId` dari klien; perusahaan = `:companySlug` yang diverifikasi `requireCompanyAccess` dari System DB; satu file DB per perusahaan |
| Branch ID spoofing (asal) | `fromBranchId` dari body diabaikan/ditolak bila ≠ konteks tervalidasi; `X-Branch-Context` divalidasi tiap request |
| Destination branch spoofing | `toBranchId` divalidasi terhadap `branches` perusahaan itu (ACTIVE, ≠ asal, belum terhapus); id perusahaan lain tak dapat di-resolve |
| Transaction ID IDOR | tiap baca/aksi diperiksa terhadap akses FROM/TO; tidak terlihat ⇒ 404 identik dengan tidak ada |
| Unauthorized approval / reversal | permission efektif + akses cabang TO (atau lawan pemohon) + `assertCanDecide` |
| Fake OWNER / manipulasi peran di body, query, header, payload sesi | peran **hanya** dari `request.companyAccess.role` yang dibaca dari System DB tiap request; field `role`/`selfApproved`/`status` dari klien diabaikan |
| Double approval / double posting | klaim status atomik `UPDATE … WHERE status='WAITING_APPROVAL'` + UNIQUE slot jurnal |
| Replay | `UNIQUE(proposed_by, idempotency_key)`; aksi pada status yang sudah berubah ⇒ 409 |
| Stale transaction state | semua transisi bersyarat status asal; validasi domain dibaca ulang di dalam transaksi posting |
| Inactive branch / closed period / locked account / expired | divalidasi ulang pada posting akhir (6.1); gagal ⇒ tanpa jurnal |
| Memilih akun antar-cabang sembarang untuk menghindari kebijakan | akun antar-cabang **tidak pernah** dipilih pengguna; dipilih sistem dari `counterpart_branch_id` + sifat sisi; kebijakan akun diperiksa lagi saat buat & posting jurnal |

## 19. Accounting Invariants

| ID | Invarian | Diperiksa |
|---|---|---|
| I-1 | Setiap jurnal seimbang (D = K) | fungsi jurnal + pasca-kondisi |
| I-2 | Transaksi `COMPLETED` (accounting event `POSTED`) punya **tepat 2** jurnal `ORIGINAL` — leg FROM **dan** leg TO — berstatus POSTED/REVERSED; bila `reversal_state=REVERSED` ditambah tepat 2 jurnal `REVERSAL` (total 4) | `verifyInterBranchIntegrity()` |
| I-3 | Transaksi `WAITING_APPROVAL/REJECTED/CANCELLED/EXPIRED` (accounting event `NOT_POSTED`) punya **0** jurnal; tidak pernah ada satu leg tanpa leg lawannya | idem |
| I-4 | `branch_id` jurnal FROM = `from_branch_id`; TO = `to_branch_id` | trigger + verifikasi |
| I-5 | Jumlah antar-cabang di sisi FROM = jumlah di sisi TO = `amount`, arah berlawanan; Σ(D−K) pasangan = 0 | pasca-kondisi + verifikasi |
| I-6 | Tidak ada jurnal ber-`inter_branch_*` tanpa transaksi induk, tidak ada slot ganda | trigger + UNIQUE |
| I-7 | `from ≠ to`; `amount > 0`; kolom bisnis tak berubah setelah insert | CHECK + trigger |
| I-8 | Jurnal REVERSAL selalu punya ORIGINAL; reversal satu sisi mustahil | verifikasi |
| I-9 | Kombinasi (`status`, accounting event, `reversal_state`) hanya yang ada di tabel 7.4; `COMPLETED` ⇒ approval POST `APPROVED`; ada approval REVERSE `WAITING` ⇔ `REVERSAL_WAITING` | verifikasi + CHECK |
| I-10 | Akun antar-cabang di sisi X menunjuk cabang lawan ≠ X | kebijakan akun (ada) |
| I-11 | Pengaju ≠ penyetuju, **kecuali** pelaku berperan OWNER (`self_approved=1`, tercatat di audit dengan `actorRole`) | verifikasi + audit |
`verifyInterBranchIntegrity()` read-only: dijalankan di tes, setelah migrasi, dan tersedia sebagai diagnostik admin; hasil ≠ 0 = alarm.

## 20. Error Handling

Kesalahan domain berkelas (pola `Error` + `code`) dipetakan satu tempat: `INTER_BRANCH_ACCOUNT_MISSING` (arahan membuat akun antarkantor), `…_ACCOUNT_AMBIGUOUS`, `…_SELF_APPROVAL_NOT_ALLOWED`, `…_STATE_CHANGED` (409), `…_EXPIRED`, `…_BRANCH_NOT_ACTIVE`, `…_DATE_NOT_ALLOWED`, `…_PERIOD_NOT_WRITABLE`, `…_REASON_REQUIRED`, `ACCOUNT_POLICY_VIOLATION` (ada). Pesan berbahasa awam, tidak membocorkan keberadaan cabang/transaksi di luar akses. Kegagalan posting tidak mengubah status; pesan menyebut penyebab dan tindakan (tolak & ajukan ulang bila tanggal/periode tak lagi sah). Kesalahan tak terduga → 500 generik + log server.

## 21. Notification

Cukup: **lencana jumlah masuk-menunggu** pada menu (polling 60 dtk/fokus jendela seperti Phase 3, memakai `GET /summary`) dan *toast* hasil aksi. Tidak ada sistem realtime/notification center. Tidak ada status "dibaca" per user (menghindari tabel baru); penolakan terlihat di tab Keluar (status + alasan).

## 22. Reporting Readiness

Tanpa membangun laporan baru: setiap sisi tersimpan sebagai jurnal biasa dengan `branch_id`, akun `INTER_BRANCH` berpenanda `counterpart_branch_id`, dan `inter_branch_transaction_id/leg/side`. Itu cukup untuk: laporan per cabang (Phase 5), rekonsiliasi pasangan (Σ=0), daftar pasangan jurnal, dan eliminasi Phase 7 (hanya untuk pasangan yang keduanya dalam himpunan; sisa "tidak dieliminasi"). Hanya transaksi `COMPLETED` menciptakan saldo; pengajuan WAITING tidak masuk laporan apa pun (laporan gabungan kelak menampilkan peringatan "N pengajuan menunggu"). Sampai Phase 5A selesai, pengguna LIMITED tidak dapat melihat laporan cabangnya — itu syarat gerbang aktivasi, bukan syarat pengembangan.

## 23. Backward Compatibility

- **Flag OFF:** rute `inter-branch/*` 404; menu tidak ada; tidak ada jurnal ber-`inter_branch_*`; hanya satu cabang (HQ) sehingga `from≠to` mustahil. Migrasi C0019 menambah tabel kosong dan satu kolom ber-DEFAULT — perilaku, angka laporan, dan golden master tidak berubah.
- Jurnal manual/import/opening balance/reversal biasa: tidak berubah, kecuali satu pengaman kecil (awalan referensi `IB-` dicadangkan).
- **Perubahan terhadap berkas baseline (harus dicatat di PHASE-3 baseline §8, masing-masing dengan tes):** `journal-service.ts` (menerima tautan IB + pengecualian reversal internal), `branch-service.ts` (matriks `inter_branch` pada `assertBranchAcceptsOrigin`; pembatalan otomatis pengajuan saat cabang non-aktif; blocker penutupan cabang), `period-closing-service.ts` (blocker pengajuan menunggu), `company-profile-service.ts` (pengaturan kedaluwarsa), `middleware/branch-authority.ts` (daftar sadar-cabang, BC-2), `server.ts` (registrasi). Tidak ada perubahan pada `authorization.ts`, `rbac.ts`, `company-access-guard.ts`, migrasi S/C yang ada.
- **Phase 5A WIP (D-0 FINAL):** 24 berkas manifest berbeda dari baseline + 2 berkas baru (`report-scope.ts` di `db/company` dan `middleware`) adalah **WIP / NOT APPROVED / NOT PRODUCTION**, terdokumentasi di `docs/wip/PHASE-5A-WIP-MANIFEST.md` dan `PHASE-5A-WIP-STATUS.md` (SHA-256, `tsc` belum hijau, tes belum dijalankan sebagai baseline). Tidak di-rollback, tidak diperbaiki, tidak dilanjutkan, **tidak menjadi dependensi** Inter-Branch, dan kodenya tidak dipakai sebagai fondasi. Baseline Phase 3 tetap FROZEN. Konsekuensi lingkungan (bukan desain): pohon kerja saat ini tidak dapat memberi baseline tes hijau — prasyarat P-1 pada plan IB-0.

## 24. Migration Strategy

`C0019_inter_branch` urut setelah C0018; idempoten (`IF NOT EXISTS`, cek `PRAGMA table_info`); tanpa backfill; dijalankan oleh `company-upgrade` yang sudah membuat cadangan `pre-upgrade` dan `integrity_check`. `down` menjatuhkan trigger/tabel/kolom. Verifikasi: jumlah jurnal/baris/akun identik, `integrity_check` ok, `foreign_key_check` 0, restore dari `pre-upgrade` teruji, golden master Phase 5.0 identik. Satu migration, bukan banyak; tidak ada migration "kalau-kalau".

## 25. Test Strategy

Prinsip: tes tidak dilemahkan (827 tes existing tetap hijau); tambahan ±120–150 tes.
- **Unit:** tabel transisi (semua pasangan sah/tidak sah); pemilihan akun antar-cabang (ASSET/LIABILITY/netto/hilang/ambigu); pembentukan baris per jenis; validasi nominal (sen, > 0, batas), tanggal, cabang (≠, ACTIVE), validasi jenis (kas-kas); kalkulasi `expires_at`.
- **Integrasi:** ajukan → daftar → setujui (2 jurnal terbentuk, tertaut, seimbang) → reversal (4 jurnal) ; tolak/batal/kedaluwarsa tanpa jurnal; ajukan ulang; validasi ulang saat setujui (periode ditutup, cabang non-aktif, akun dikunci, backdate lewat); pengajuan memblokir penutupan periode; cabang non-aktif membatalkan pengajuan; migrasi C0019 pada salinan UAT.
- **Akuntansi:** golden Metro→BL Rp1.000.000 (jurnal persis bagian 5, kas Metro −1jt, hutang BL −1jt, Σ pasangan = 0); `verifyInterBranchIntegrity()` = 0 setelah tiap skenario; Neraca per cabang seimbang; dataset 3–7 cabang, pasangan campuran.
- **Keamanan (masing-masing terpisah):** IDOR id/nomor; manipulasi URL, body (`fromBranchId`, `userId`, `companyId`, `status`), query, header `X-Branch-Context`; lintas perusahaan; LIMITED tanpa akses TO tidak dapat melihat/menyetujui; akses TO tanpa permission; DENY/GRANT override; delegasi tidak memperluas; pencabutan akses di tengah sesi; STAFF tak dapat menyetujui; VIEWER tak dapat apa pun; non-OWNER tidak dapat menyetujui transaksinya sendiri (server menolak walau UI dilewati); OWNER dapat (lihat blok tes OWNER/non-OWNER di bawah); jurnal bertaut tak dapat diedit/dihapus/di-reverse lewat endpoint biasa; DTO per sisi tidak membocorkan akun sisi lawan; 404 identik (muatan & timing kasar).
- **OWNER (business rule 8.1) — wajib:** (1) OWNER membuat transaksi → berhasil; (2) OWNER menyetujui transaksinya sendiri → berhasil; (3) OWNER menyelesaikan (posting) transaksinya sendiri → `COMPLETED` dengan 2 jurnal seimbang; (4) seluruh event tercatat di audit (PROPOSED, APPROVED dengan `makerEqualsApprover:true`/`actorRole:"OWNER"`, audit jurnal kedua sisi); (5) tidak diperlukan delegasi (tidak ada baris delegasi dalam skenario); (6) tidak ada pengguna lain yang harus menyetujui; ditambah: OWNER meminta+menyetujui reversal sendiri; validasi domain (periode CLOSED, cabang non-ACTIVE, akun terkunci, kebijakan akun, kedaluwarsa) **tetap menolak** OWNER; flag OFF ⇒ 404 untuk OWNER; OWNER tetap tidak dapat di-DENY (aturan Phase 3).
- **Non-OWNER — wajib:** (1) maker tidak dapat self-approve (ADMIN, ADMIN LIMITED, ACCOUNTANT, STAFF dengan GRANT) — ditolak server walau memegang kedua cabang dan walau UI/klien dimanipulasi (mis. body `role`, `selfApproved`, header); (2) pengguna tanpa `interbranch.approve` atau tanpa akses TO tidak dapat menyetujui; (3) delegasi tidak memperluas hak melebihi cakupan pemberi (hak efektif = delegasi ∩ akses ∩ permission); delegasi `inter_branch` tidak memberi hak menyetujui; (4) semua pembatasan ditegakkan server-side (uji langsung ke endpoint tanpa UI); role OWNER hanya dibaca dari System DB, tidak dari klien; (5) pengguna non-OWNER lain dapat menyetujui transaksi yang diajukan OWNER (OWNER tidak mengunci keputusan orang lain).
- **Mutasi:** hilangkan cek akses TO, abaikan DENY, lewati cek pengaju≠penyetuju **untuk non-OWNER**, perluas pengecualian ke ADMIN, percayai peran dari klien, percayai `fromBranchId` body, lewati pasca-kondisi, tangkap error di dalam prosedur ⇒ semuanya harus terdeteksi tes.
- **Konkurensi:** setujui ganda, setujui+batal, tolak+setujui, dua permintaan reversal, ajukan ganda (idempotency), setujui saat periode ditutup — selalu satu pemenang, tanpa jurnal ganda.
- **Injeksi kegagalan:** gagal di tiap titik tulis ⇒ atomik penuh.
- **Domain / periode (final gate):** periode OPEN saat diajukan lalu CLOSED sebelum disetujui ⇒ posting ditolak, 0 jurnal; periode LOCKED idem; cabang menjadi non-ACTIVE; akun terkunci/nonaktif setelah diajukan; kebijakan akun tidak valid; transaksi kedaluwarsa (walau belum ditandai EXPIRED); backdate diperketat setelah pengajuan; flag OFF ⇒ 404 semua endpoint IB dan perilaku single-branch tidak berubah.
- **Akuntansi (final gate):** selama `WAITING_APPROVAL` saldo/laba/kas/Neraca Saldo tidak berubah dan tidak ada jurnal; tepat dua leg; seimbang; rollback atomik penuh pada tiap titik gagal; kedua sisi dapat diidentifikasi dari `inter_branch_*`; reversal tidak mengubah baris jurnal asli (hanya penanda status) dan membuat 2 jurnal baru; `accountingEvent` pada DTO selalu konsisten dengan jurnal.
- **Duplikat:** approval ganda, posting ganda, reversal ganda (bersamaan dan berurutan) ⇒ satu pemenang, selebihnya 409.
- **Regresi:** jurnal manual/import/opening balance/reversal, perusahaan satu-cabang flag OFF, golden master reporting Phase 5.0, tes arsitektur fail-closed (route baru terklasifikasi, berkas penyentuh `journal_entries` bertambah di allowlist secara sadar).

## 26. UAT

| ID | Skenario | Diterima bila |
|---|---|---|
| UAT-01 | Buat transaksi antar-cabang Metro→BL (transfer kas) | tersimpan `WAITING_APPROVAL`, bernomor, **tanpa jurnal**, laporan tak berubah |
| UAT-02 | Cek tampilan Keluar pengaju | status, nominal, tujuan benar |
| UAT-03 | Penyetuju (BL) menyetujui | status bisnis `COMPLETED`, accounting event `POSTED`, 2 jurnal ORIGINAL |
| UAT-04 | Penerima melihat di Masuk + lencana | tampil, lencana turun setelah diputuskan |
| UAT-05 | Penerima menerima (konfirmasi akun sendiri) | jurnal BL memakai akun yang dikonfirmasi; perubahan akun tercatat |
| UAT-06 | Penerima menolak (alasan) | `REJECTED`, tanpa jurnal; pengaju melihat alasan; **Ajukan ulang** menyalin |
| UAT-07 | Jurnal dua sisi | persis golden; tertaut; drill-down hanya sisi yang terakses |
| UAT-08 | D = K | tiap jurnal seimbang; Σ pasangan = 0; `verifyInterBranchIntegrity` = 0 |
| UAT-09 | Pengguna cabang lain melihat | tidak terlihat (404/tidak ada di daftar) |
| UAT-10 | Pengguna tak berwenang memanipulasi (ID/URL/body/header) | semua ditolak server |
| UAT-11 | Reversal | 4 jurnal 1 identifier; kedua sisi dibalik; saldo kembali |
| UAT-12 | Dua penyetuju bersamaan | satu pasang jurnal |
| UAT-13 | Perusahaan satu-cabang (flag OFF) | tanpa menu, tanpa perubahan angka |
| UAT-14 | Jejak audit | semua event lengkap: siapa, kapan, dari→ke, alasan |
| UAT-15 | Pengajuan kedaluwarsa | tak dapat disetujui; status `EXPIRED` |
| UAT-16 | Periode ditutup saat pengajuan menunggu | penutupan diblokir dengan penjelasan |
| UAT-17 | Cabang tujuan dinonaktifkan saat menunggu | pengajuan dibatalkan otomatis, alasan tercatat |
| UAT-18 | Akun antarkantor belum ada | pengajuan ditolak dengan arahan; OWNER membuat pasangan akun lalu ulangi |
| UAT-19 | Non-OWNER: pengaju = penyetuju | ditolak server (`SELF_APPROVAL_NOT_ALLOWED`), termasuk ADMIN dan ADMIN LIMITED yang memegang kedua cabang |
| UAT-21 | OWNER membuat lalu menyetujui transaksinya sendiri | berhasil tanpa user lain & tanpa delegasi; `COMPLETED`, 2 jurnal seimbang; audit lengkap (PROPOSED, APPROVED dengan `makerEqualsApprover`, jurnal) |
| UAT-22 | OWNER meminta dan menyetujui reversal sendiri | `reversal_state=REVERSED`, 4 jurnal 1 identifier; audit lengkap |
| UAT-23 | OWNER tidak punya akses/flag/validasi domain yang dikecualikan | periode CLOSED, cabang non-aktif, akun terkunci tetap menolak OWNER |
| UAT-24 | OWNER menyelesaikan transaksi sendiri (self-complete) | `COMPLETED` + `POSTED`; audit `APPROVED` (`makerEqualsApprover:true`, `actorRole:"OWNER"`, `self_approved:true`), `POSTED`, `COMPLETED`; tanpa delegasi |
| UAT-25 | Non-OWNER (ACCOUNTANT/ADMIN) berbeda dari pengaju menyetujui | berhasil bila punya `interbranch.approve` + akses TO |
| UAT-26 | User tanpa permission / tanpa akses cabang TO mencoba menyetujui | ditolak (403 / 404), tanpa efek |
| UAT-27 | Delegasi (termasuk kapabilitas `inter_branch`) | tidak memperluas hak; hak tetap = permission ∩ akses |
| UAT-28 | Flag OFF | semua endpoint IB 404; perusahaan single-branch identik |
| UAT-29 | Cabang tujuan non-aktif / ditutup saat WAITING | pengajuan dibatalkan otomatis / persetujuan ditolak, tanpa jurnal |
| UAT-30 | Periode ditutup **setelah** pengajuan, **sebelum** persetujuan | persetujuan ditolak, 0 jurnal, status tetap `WAITING_APPROVAL` |
| UAT-31 | Akun terkunci / kebijakan akun tidak valid pada posting akhir | ditolak, 0 jurnal, pesan menyebut akun |
| UAT-32 | Pengajuan lewat `expires_at` | tak dapat disetujui; `EXPIRED` |
| UAT-33 | Fake OWNER: body `role:"OWNER"`, header/query peran, payload sesi dimanipulasi oleh non-OWNER | diabaikan; tetap `SELF_APPROVAL_NOT_ALLOWED` |
| UAT-34 | Spoof `companyId`/`companySlug` lain, `fromBranchId`, `toBranchId` palsu | ditolak/diabaikan server; tidak ada kebocoran |
| UAT-35 | IDOR `/inter-branch/:id` lain & `transaction_no` lain | 404 identik untuk tak-ada dan tak-berhak |
| UAT-36 | Dua penyetuju / klik ganda / replay | satu pasang jurnal; sisanya 409 |
| UAT-37 | Dua permintaan reversal / reversal ganda | satu reversal; sisanya 409 |
| UAT-38 | Atomik: kegagalan disuntik di tiap titik tulis | tidak pernah ada satu leg tanpa leg lawannya; semua-atau-tidak |
| UAT-39 | Saat `WAITING_APPROVAL` | tidak ada jurnal; saldo, laba, kas, Neraca Saldo tidak berubah |
| UAT-40 | Reversal | jurnal ORIGINAL tidak diedit (selain penanda status), 2 jurnal REVERSAL baru, terhubung ke transaksi asal |
| UAT-20 | Kombinasi akses (LIMITED 1 cabang, 2 cabang, ALL) × permission | sesuai matriks bagian 8 |
Sebelum aktivasi di perusahaan nyata: UAT dengan data menyerupai klien (volume cabang berbeda, saldo awal antar-cabang, cabang baru/ditutup, impor dari beberapa sumber).

## 27. Performance Considerations

Volume kecil (daftar paginasi); posting = ±2 insert header + 2×(1 header jurnal + 2 baris) + audit dalam satu transaksi — milidetik. Tanpa N+1 (akun diselesaikan satu query per sisi). Daftar memakai filter sederhana pada tabel kecil; **indeks sekunder tidak ditambahkan sebelum ada bukti `EXPLAIN`** (aturan #16). Tidak ada dampak pada laporan Phase 5 (jurnal biasa).

## 28. Risks

| # | Risiko | Mitigasi |
|---|---|---|
| R-1 | Transaksi setengah jadi | satu transaksi, pasca-kondisi, injeksi kegagalan, aturan "tidak menangkap error" |
| R-2 | Jurnal muncul di tanggal lampau saat disetujui (laporan lama berubah) | `expires_at` dibatasi, periode ditutup memblokir, peringatan UI; opsi in-transit D-8 |
| R-3 | Akun antarkantor belum dibuat → fitur tak bisa dipakai | pemeriksaan di awal + arahan terpandu; bagian aktivasi |
| R-4 | Saldo antar-cabang tak sama (Σ ≠ 0) dari data lama/opening balance | peringatan opening balance, `verifyInterBranchIntegrity`, laporan rekonsiliasi (Phase 5/7) |
| R-5 | Kebocoran data antar-cabang lewat DTO/404/timing | DTO per sisi, 404 seragam, tes khusus |
| R-6 | Perubahan berkas baseline | dicatat di baseline §8 + tes; area kecil |
| R-7 | OWNER menyetujui transaksinya sendiri tanpa mata kedua (business rule eksplisit) | audit lengkap + `self_approved` informasional; dapat ditinjau dari laporan audit; kontrol domain (periode, akun, kebijakan) tetap berlaku |
| R-8 | Tumbukan referensi jurnal | awalan `IB-` dicadangkan |
| R-9 | Jam komputer dimanipulasi (kedaluwarsa) | diterima; kontrol utama bukan waktu |
| R-10 | Mode banyak-perangkat kelak | pola klaim-status tidak bergantung pada proses tunggal |
| R-11 | Pengguna mengira "disetujui" ≠ "diposting" atau menyamakan `COMPLETED` dengan `POSTED` | UI menampilkan dua indikator terpisah (status transaksi, status jurnal); satu aksi atomik menggerakkan keduanya |
| R-12 | Pohon kerja Phase 5A sebagian di tengah jalan bercampur dengan perubahan IB di berkas yang sama | P-1: baseline bersih sebelum IB-1; kode WIP 5A tidak dipakai (D-0 FINAL) |

## 29. MVP Scope

**Masuk:** entitas transaksi + approval; jenis `TRANSFER_KAS` & `PEMBEBANAN`; ajukan/setujui/tolak/batal/kedaluwarsa; posting atomik dua sisi; reversal berpasangan; otorisasi penuh bagian 8; audit; Masuk/Keluar/Detail + lencana; blokir penutupan periode; pembatalan otomatis saat cabang non-aktif; `verifyInterBranchIntegrity`; migrasi C0019.
**Tidak masuk (alasan):** DRAFT; lampiran (tak ada infrastruktur, menambah penyimpanan/backup/keamanan); ambang persetujuan; transfer persediaan dan pendapatan antar-cabang (dependensi modul persediaan / eliminasi margin); multi-baris; `head_office_effect` & penyelesaian saat cabang CLOSED; laporan rekonsiliasi pasangan (Phase 5/7); notifikasi realtime; permintaan dari sisi penerima (tagihan).

## 30. Future Scope

Draf; lampiran; ambang/dual-control; multi-baris; persediaan; pendapatan/jasa dengan margin + eliminasi (Phase 7); penyelesaian saldo saat penutupan cabang (`head_office_effect`); permintaan dari sisi penerima; laporan rekonsiliasi per pasangan; notification center; arti pembatas untuk kapabilitas delegasi `inter_branch`.

## 31. Implementation Phases

Ringkasan (rincian, gerbang, dan estimasi tes ada di `INTER-BRANCH-IMPLEMENTATION-PLAN.md`): **IB-0** prasyarat (P-1 baseline bersih, karakterisasi, catat baseline) → **IB-1** skema C0019 + model domain + integritas → **IB-2** otorisasi + ajukan/daftar/detail → **IB-3** persetujuan + posting atomik → **IB-4** tolak/batal/kedaluwarsa + integrasi periode & siklus hidup cabang → **IB-5** reversal → **IB-6** UI → **IB-7** keamanan/konkurensi/mutasi/performa → **IB-8** UAT & gerbang aktivasi. Tiap fase berhenti di gerbang persetujuan.

## 32. Final Decision Matrix (D-0 … D-13)

Tidak ada keputusan yang tersisa ambigu pada tingkat desain.

| Decision | Status | Final Decision |
|---|---|---|
| D-0 | FINAL | Phase 5A WIP dibekukan: **WIP / NOT APPROVED / NOT PRODUCTION**, hanya didokumentasikan (`docs/wip/`); tidak di-rollback, tidak diperbaiki, tidak dilanjutkan, bukan dependensi Inter-Branch. Baseline Phase 3 FROZEN |
| D-1 | FINAL | Setujui + Terima + Posting = **satu aksi atomik**; hasil: bisnis `COMPLETED` dan accounting event `POSTED` berubah bersama; tidak ada status APPROVED/RECEIVED |
| D-2 | FINAL | MVP hanya `TRANSFER_KAS` dan `PEMBEBANAN`; persediaan, pendapatan/margin, eliminasi, multi-baris = future scope |
| D-3 | FINAL | Tanpa DRAFT yang dipersistenkan pada MVP; pembuatan = pengiriman; audit `CREATED`+`SUBMITTED` (menyimpang dari diagram bisnis yang memuat DRAFT — lihat 7.5) |
| D-4 | FINAL | Satu akun per sisi di header; tanpa tabel *lines* pada MVP |
| D-5 | FINAL | Delegasi (termasuk kapabilitas `inter_branch`) tidak memberi hak IB; hak = permission efektif ∩ akses cabang; model Phase 3 tidak berubah |
| D-6 | FINAL | Penyetuju tidak dipaksa mengganti cabang aktif; aksi dinilai terhadap cabang transaksi dan harus ada dalam akses |
| D-7 | FINAL | Awalan referensi `IB-` dicadangkan untuk jurnal IB (jalur manual/import menolaknya) |
| D-8 | FINAL | Jurnal bertanggal `transaction_date`; periode, kebijakan tanggal/backdate, dan `expires_at` divalidasi ulang pada posting akhir; tanpa model in-transit |
| D-9 | FINAL | Akun antar-cabang tanpa `cash_flow_activity` (muncul sebagai *unclassified* di Arus Kas per cabang) sampai Phase 5/7 |
| D-10 | FINAL | **OWNER full authority** atas workflow IB miliknya (buat, setujui, terima/selesaikan, reversal sendiri) tanpa approval user lain & tanpa delegasi; tetap melewati autentikasi, akses perusahaan, flag, akses cabang, status cabang/transaksi, periode, kebijakan/kunci akun, kedaluwarsa, dan audit lengkap. Non-OWNER: maker ≠ approver ⇒ `403 SELF_APPROVAL_NOT_ALLOWED`. Peran hanya dari System DB; tanpa permission `owner.can_self_approve` |
| D-11 | FINAL | `expires_at` dibatasi oleh batas backdate |
| D-12 | FINAL | Indeks sekunder ditunda sampai ada bukti `EXPLAIN` (hanya PK/UNIQUE pada migrasi awal) |
| D-13 | FINAL | Pengajuan hanya dari sisi pemberi (FROM); permintaan dari sisi penerima = future scope |

### Bagian requirement Anda yang saya anggap perlu dikoreksi
1. **Lima status linear (DRAFT→SUBMITTED→APPROVED→RECEIVED→POSTED)** — APPROVED dan RECEIVED sebelum POSTED menciptakan keadaan setengah jadi; digabung menjadi satu aksi atomik.
2. **"Akun Asal / Akun Tujuan" dipilih pengaju** — akun sisi penerima adalah keputusan klasifikasi cabang penerima; pengaju hanya mengusulkan, penerima mengonfirmasi.
3. **Lampiran** — belum ada infrastruktur; menambahnya memperluas penyimpanan, backup, dan permukaan serangan. Ditunda; kolom referensi teks cukup.
4. **Tujuh jenis transaksi** — hanya dua yang berbeda secara akuntansi; sisanya variasi atau bergantung modul yang belum ada.
5. ~~Aturan keras #11 vs keputusan terkunci #2~~ — **terselesaikan oleh keputusan D-10 final**: OWNER-tanpa-approval adalah business rule eksplisit (bagian 8.1), bukan bypass otorisasi.
