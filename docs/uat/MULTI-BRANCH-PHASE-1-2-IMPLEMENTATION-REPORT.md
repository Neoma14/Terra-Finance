# MULTI-BRANCH PHASE 1–2 — IMPLEMENTATION REPORT

Tanggal: 2026-10-07 · Acuan desain: `docs/architecture/MULTI-BRANCH-AUDIT-AND-DESIGN.md` (Revisi 6 APPROVED) · Cakupan: Phase 1 (Branch Core & Access Foundation) + Phase 2 (Account Policy & Branch-Aware Accounting). **Phase 3 tidak dikerjakan.**

---

## 1. Executive Summary

Phase 1–2 selesai dan terverifikasi pada empat lapis: unit/integrasi (726 tes backend), migrasi pada **data UAT 5 tahun nyata** (12.003 jurnal), end-to-end keamanan pada **server hasil build dan runtime Electron dari installer**, serta build semua paket.

| Hal | Hasil |
|---|---|
| Tes backend | **726 / 726 lulus** (619 lama tak diubah + **107 baru**), 63 file |
| Tes license generator | 17 / 17 |
| TypeScript API & Web | PASS / PASS |
| Build web, API, Electron | PASS — installer `TERRA FINANCE Setup 0.1.0.exe` (124.259.119 byte, 13:13) |
| Migrasi data UAT 5 tahun | **84 / 84** pemeriksaan (node dev) dan **84 / 84** (runtime Electron) |
| E2E keamanan pada server hasil build | **37 / 37** (node dev) dan **37 / 37** (runtime Electron dari installer) |
| Data hilang / berubah | **Tidak ada** (hash isi jurnal, baris, akun identik; jumlah sen identik) |
| Temuan Critical / High | **0** |

Yang dibangun: master cabang + lifecycle ACTIVE/INACTIVE/CLOSED tanpa hard delete; akses user ke banyak cabang (`user_branch_access`) dengan cakupan ALL/LIMITED; konteks cabang kerja yang divalidasi server; guard otorisasi terpusat dengan **deny-by-default** untuk akun LIMITED; kebijakan cabang **per akun** (`ALL_BRANCH`, `CENTRAL_ONLY`, `SYSTEM_ONLY`, `INTER_BRANCH`) + `counterpart_branch_id`; `branch_id` pada header jurnal dengan asal jurnal (`origin`); saldo awal per cabang; impor jurnal/saldo awal sadar-cabang; pembuatan terpandu pasangan akun antar-cabang (preview + konfirmasi); pengaman rilis `multi_branch_enabled` (default mati) dan perlindungan migrasi (salinan, pemeriksaan integritas sebelum/sesudah, pemulihan otomatis).

**Perilaku aplikasi untuk perusahaan yang ada tidak berubah** selama multi-cabang tidak dinyalakan: semua user lama scope `ALL`, semua jurnal lama di Kantor Pusat, semua akun `ALL_BRANCH`.

---

## 2. Files Changed

**Baru — migration** (`apps/api/src/db`): `company/migrations/C0014_create_branches`, `C0015_journal_branch_dimension`, `C0016_accounts_branch_policy`, `C0017_company_profile_multi_branch`, `C0018_company_audit_branch`; `system/migrations/S0011_company_access_branch_scope`, `S0012_create_user_branch_access`, `S0013_system_audit_branch_columns`.

**Baru — kode**: `db/company/branch-service.ts`, `account-branch-policy.ts`, `account-policy-service.ts`, `db-integrity.ts`; `db/system/user-branch-access.ts`; `middleware/branch-authority.ts`; `modules/company-branches/routes.ts`.

**Diubah**: `db/company/journal-service.ts` (branch, origin, kebijakan akun, status cabang, guard jurnal bertaut), `journal-import-service.ts`, `opening-balance-service.ts`, `opening-balance-import-service.ts`, `account-service.ts` (`branchPolicy`, `counterpartBranchId`), `company-audit.ts` (+`branchId`), `company-upgrade.ts` (backup + integritas + pemulihan), `company-provisioning.ts` (tabel wajib `branches`); `db/system/company-access.ts`, `rbac.ts` (6 permission), `system-audit.ts` (+`targetUserId`, `branchId`); `middleware/company-access-guard.ts`, `types/fastify.d.ts`; route: `company-journal`, `company-journal-import`, `company-opening-balance`, `company-opening-balance-import`, `company-access`; `server.ts` (registrasi, salinan pengaman System DB).

**Tes baru (8 file, 107 kasus)**: `branch-service.test.ts` (11), `account-branch-policy.test.ts` (21), `journal-branch.test.ts` (13), `import-branch.test.ts` (8), `branch-migration.test.ts` (9), `company-upgrade-restore.test.ts` (4), `db/system/user-branch-access.test.ts` (13), `modules/company-branches/routes.test.ts` (28), + helper `__fixtures__/branch-test-helpers.ts`.

**Bukti & harness**: `docs/uat/evidence-multibranch/{migration-verification,e2e-security-result}.json`, `docs/uat/harness/multibranch/{verify,e2e}.mjs`.

**Tidak diubah**: seluruh 619 tes lama (tidak ada yang diedit), seluruh kode web (tidak ada UI pada tahap ini), license generator.

---

## 3. Database Migration

Memakai `ALTER TABLE ... ADD COLUMN` mentah (bukan schema builder knex, yang pada SQLite membangun ulang tabel — berbahaya untuk `journal_entries` yang direferensi baris jurnal ber-CASCADE). Semua migration idempotent-guarded (cek kolom sudah ada).

| Migration | Isi |
|---|---|
| **C0014** | Tabel `branches` (kode UNIQUE, status CHECK, kolom penutupan + CHECK, soft delete). Unique index parsial **satu Kantor Pusat**. Trigger: tolak DELETE fisik, tolak ubah `code` & `is_head_office`, lindungi Kantor Pusat dari INACTIVE/CLOSED/hapus. Seed Kantor Pusat idempotent. |
| **C0015** | `journal_entries`: `branch_id` (FK RESTRICT), `origin` (CHECK), `system_process`, `exception_reason`, `inter_branch_transaction_id/leg/side` (cadangan Phase 6). Backfill: semua jurnal → Kantor Pusat; `origin` diturunkan dari `source`/`is_opening_balance`. Index `(branch_id, entry_date)`; UNIQUE parsial slot `(transaksi, leg, side)`. Trigger: INSERT tanpa cabang → Kantor Pusat (jalur lama), `branch_id` tak boleh NULL, **cabang jurnal POSTED/REVERSED terkunci**, `inter_branch_*` semua-terisi-atau-kosong. |
| **C0016** | `accounts.branch_policy` (CHECK 4 nilai, default `ALL_BRANCH` seragam) + `counterpart_branch_id` (FK). Trigger dua arah INSERT/UPDATE: `INTER_BRANCH` ⇔ counterpart terisi; counterpart harus cabang ada & belum dihapus. |
| **C0017** | `company_profile.multi_branch_enabled` (default 0). |
| **C0018** | `company_audit_log.branch_id` + index (tabel tetap append-only). |
| **S0011** | `company_access.branch_scope` (default `ALL`, CHECK) + `default_branch_id`. |
| **S0012** | `user_branch_access` (status ACTIVE/REVOKED, riwayat utuh, UNIQUE parsial aktif) + **trigger integritas lintas-perusahaan**. |
| **S0013** | `system_audit_log.target_user_id`, `branch_id`. |

**Perlindungan saat startup** (`company-upgrade.ts`, `server.ts`): (1) `PRAGMA integrity_check` + `foreign_key_check` **sebelum** migrasi — database yang sudah rusak tidak dimigrasi; (2) salinan `company.db.pre-upgrade` dan **`company.db.pre-C0014`** (dan `terra-system.sqlite.pre-S0011`) sebelum mengubah apa pun; (3) pemeriksaan **sesudah** migrasi — bila integritas buruk atau pelanggaran FK bertambah, file **dikembalikan otomatis** dari salinan (diuji dengan injeksi kegagalan); (4) satu company gagal tidak menghentikan company lain/server.

---

## 4. Branch Lifecycle

`ACTIVE` ↔ `INACTIVE`; `ACTIVE/INACTIVE → CLOSED` (alasan wajib, checklist); `CLOSED → ACTIVE` = reopen (alasan wajib, **hanya OWNER**). `CLOSED → INACTIVE` ditolak. Kantor Pusat tidak boleh INACTIVE/CLOSED/dihapus (service **dan** trigger database).

- **Checklist penutupan**: jurnal DRAFT di cabang itu **memblokir** (409 + rincian); saldo akun neraca tersisa menjadi **peringatan** (daftar akun + saldo) lewat `GET /branches/:id/close-preview`.
- **Tanpa hard delete**: trigger menolak `DELETE`. Soft delete (`deleted_at`) hanya untuk cabang **belum pernah dipakai** (nol jurnal, nol akun yang menunjuknya, nol akses aktif) dan hanya OWNER; kode cabang tetap dicadangkan.
- **Matriks status × asal jurnal** (ditegakkan di `assertBranchAcceptsOrigin`, dipakai buat-draft, posting ulang, reversal):

| Asal | ACTIVE | INACTIVE | CLOSED |
|---|---|---|---|
| manual / import / opening_balance | ✓ | ✗ | ✗ |
| system (proses terdaftar) | ✓ | ✓ *(ditandai + audit)* | ✓ *(ditandai + audit)* |
| inter_branch / head_office_effect | belum didukung (Phase 6) | — | — |

Jurnal sistem harus menyebut proses dari **daftar tertutup di kode** (`branch_closure_settlement`, `period_closing`, `system_adjustment`); `origin` tidak pernah dibaca dari request. Setiap jurnal pengecualian pada cabang non-ACTIVE menulis audit `branch.nonactive_posting`. Draft yang dibuat saat cabang ACTIVE **tidak lolos posting** bila cabang kemudian INACTIVE. Reversal pada cabang non-ACTIVE ditolak.

---

## 5. User Branch Access

`user → company_access (role, branch_scope) → user_branch_access → branch`. Satu user bisa memiliki banyak cabang; **role tetap satu per user per perusahaan** (tidak ada role per cabang).

- `ALL` (default; user lama tidak berubah) atau `LIMITED` (hanya cabang berstatus ACTIVE di `user_branch_access`). **LIMITED tanpa baris = tidak melihat apa pun** (fail-closed).
- Operasi terpisah: **grant**, **revoke** (baris → REVOKED, riwayat utuh), **transfer** (cabut X + beri Y dalam satu transaksi dan satu event audit; transfer gagal di tengah → rollback). Tidak boleh mengubah akses sendiri; tidak boleh mengelola user berperan lebih tinggi (`canManageRole`); hanya cabang ACTIVE yang dapat diberikan; mengubah cakupan ALL↔LIMITED **hanya OWNER**, OWNER selalu ALL.
- User baru yang diberi akses perusahaan **saat multi-cabang aktif** otomatis `LIMITED` tanpa cabang (selain OWNER) — bukan `ALL`.
- Pencabutan akses mereset `default_branch_id` yang menunjuk cabang itu.
- **Integritas database**: trigger memastikan `user_branch_access.company_id` **sama** dengan `company_id` dari `company_access` yang dirujuk (INSERT dan UPDATE); identitas baris (`company_id`, `access_id`, `branch_id`) tidak dapat diubah.

---

## 6. Active Branch Context

Dipisahkan dari akses. Konteks = **satu cabang ACTIVE** dalam akses, dikirim per request lewat header `X-Branch-Context` dan **divalidasi server tiap request** (tidak disimpan di sesi → aman multi-tab). Urutan: header → preferensi `default_branch_id` (divalidasi ulang) → Kantor Pusat/cabang operasional pertama. Header di luar akses / bukan ACTIVE → `403 BRANCH_CONTEXT_INVALID`.

`PUT /branch-context` hanya menyimpan **preferensi** (diaudit hanya bila berubah) dan **bukan perubahan permission**. "Semua Cabang" bukan konteks dan tidak ada sebagai baris database. `branchId` di body jurnal opsional dan **harus sama dengan konteks** (cabang dalam akses tetapi bukan konteks → `409 BRANCH_CONTEXT_MISMATCH`; di luar akses → 404).

---

## 7. Authorization

`Authentication → Company Access → Branch Access → Active Branch Context → Permission → Account Policy → Transaction Rule`.

- **Company Access**: `requireCompanyAccess` (slug → registry → `company_access` ACTIVE) kini juga memuat `branch_scope` dan cabang ACTIVE dari System DB **tiap request, tanpa cache** → pencabutan akses berlaku di request berikutnya walau sesi masih hidup (terbukti di E2E).
- **Deny-by-default untuk akun LIMITED**: hanya route di `BRANCH_AWARE_ROUTES` (cabang, konteks, jurnal, impor, saldo awal, COA/periode/profil baca) yang boleh dipanggil; **semua route lain** (laporan, export, ledger, dashboard, pencarian, audit log, saldo counterparty, trial balance, dsb.) dan seluruh rute legacy → `403 BRANCH_SCOPE_UNSUPPORTED`, **termasuk route yang ditambahkan kelak**. Dibuktikan oleh **tes matriks** yang menyisir seluruh route perusahaan yang terdaftar.
- **Objek by-id** (jurnal, cabang): di luar akses → **404 seragam** (identik dengan "tidak ada" — diuji byte-per-byte), tidak membocorkan keberadaan.
- **Permission baru** (gaya RBAC existing): `branch.read` (semua role), `branch.manage`, `branch.close`, `user_branch.manage` (ADMIN & OWNER), `branch.reopen`, `account.policy` (**hanya OWNER**). Pengelolaan cabang/akses hanya untuk scope ALL (LIMITED tertutup oleh deny-by-default).
- Mapping error terpusat (`replyBranchError`) + audit penolakan `security.branch_access_denied` (dibatasi laju).
- `company_id` dari body diabaikan; satu-satunya sumber perusahaan adalah slug yang diverifikasi.

---

## 8. Account Branch Policy

Kolom `accounts.branch_policy` (atribut eksplisit per akun, mengikuti pola `cash_flow_activity`/`subledger_type`/`is_locked`). **Tidak ada logika berbasis tipe, kategori, atau nama akun** (modul `account-branch-policy.ts` bahkan tidak membaca `account_type`).

| Kebijakan | manual / import | saldo awal | sistem | antar-cabang (Phase 6) |
|---|---|---|---|---|
| `ALL_BRANCH` | ✓ | ✓ | ✓ | ✓ |
| `CENTRAL_ONLY` | hanya jurnal Kantor Pusat | hanya Pusat | hanya Pusat | hanya sisi Pusat |
| `SYSTEM_ONLY` | ✗ | ✗ | ✓ | ✗ |
| `INTER_BRANCH` | ✗ | ✓ | ✗ | ✓ lewat layanan |

Ditegakkan di **satu pintu** (`journal-service`) saat **buat draft dan saat posting**, sehingga berlaku untuk jurnal manual, impor jurnal, saldo awal, dan impor saldo awal. Impor juga menandai pelanggaran sebagai ERROR pada tahap validasi (preview). Pelanggaran → `400 ACCOUNT_POLICY_VIOLATION` dengan pesan jelas; seluruh jurnal/impor ditolak atomik. Reversal mengecualikan pemeriksaan kebijakan (mencerminkan jurnal asli).

**Migrasi akun lama**: semua `ALL_BRANCH` seragam (terverifikasi pada 66 akun UAT dan di semua company). **Pengecualian yang disepakati** (akun penyeimbang saldo awal → `SYSTEM_ONLY`) diimplementasikan sebagai aturan terbatas `is_system_account = 1 AND account_subtype = 'opening_balance_adjustment'` dan tersimpan sebagai data. **Temuan**: akun penyeimbang itu **hanya ada di jalur legacy (master DB)**; di `company.db` tidak ada kode yang membuat/memakainya, sehingga aturan ini mengenai **0 akun**. Saya sengaja **tidak** menjadikan akun bersubtype itu `SYSTEM_ONLY` tanpa penanda sistem, karena akun bernama "Saldo Awal (Penyesuaian)" pada perusahaan yang dimigrasi dari legacy dipakai manual pada saldo awal — menandainya akan **merusak alur yang berjalan**. OWNER dapat mengubah kebijakan akun mana pun (`PUT /accounts/:id/branch-policy`, alasan wajib, audit before/after + jumlah baris lama yang terdampak; berlaku untuk posting **baru**).

---

## 9. Counterpart Branch

`accounts.counterpart_branch_id` (FK → `branches`): **wajib terisi bila `INTER_BRANCH`, wajib NULL bila bukan** — dijaga trigger DB pada INSERT dan UPDATE, plus validasi service. Cabang lawan **tidak pernah dibaca dari nama akun** (diuji: akun bernama "Antarkantor Passiva - Bandar Lampung" dengan `ALL_BRANCH` tetap akun biasa; akun `INTER_BRANCH` yang dinamai "Kas" tetap terkunci dari jurnal manual).

Aturan tambahan: akun `INTER_BRANCH` tidak dapat dipakai jurnal **cabang yang menjadi cabang lawannya sendiri**; akun antar-cabang yang **sudah dipakai jurnal** tidak boleh berubah cabang lawan/statusnya; cabang lawan harus ada, belum dihapus, belum CLOSED; counterpart dari perusahaan lain tidak dapat di-resolve (id cabang hidup di `company.db` perusahaannya).

Contoh kanonik, **dua akun dalam satu COA**: `Antarkantor Passiva – Bandar Lampung` (counterpart = Bandar Lampung, dipakai Metro) dan `Antarkantor Passiva – Metro` (counterpart = Metro, dipakai Bandar Lampung). Pembuatan terpandu menghasilkan persis pasangan ini (diuji di tes service, HTTP, dan server hasil build).

**Pembuatan terpandu** (`POST /accounts/inter-branch/preview` → `POST /accounts/inter-branch`, OWNER): validasi kedua cabang ada & satu perusahaan, bukan CLOSED, tidak ada konflik kode; hasil per akun `create` / `exists` (tidak digandakan) / `conflict`; **preview tidak mengubah apa pun**; konfirmasi (`confirm: true`) membuat semua akun dalam **satu transaksi** — konflik pada salah satunya membatalkan seluruhnya.

---

## 10. Journal Branch Validation

`journal_entries.branch_id` selalu ada, ber-FK, tidak pernah NULL, dan terkunci setelah POSTED. Sebelum jurnal dibuat/diposting server memeriksa: cabang ada & belum dihapus (dalam `company.db` yang sama) → status cabang vs asal jurnal → kebijakan tiap akun → (di route) akses user + kesesuaian dengan konteks aktif.

- Route jurnal: create (cabang = konteks, `branchId` palsu/di luar akses → 404, ≠ konteks → 409), post/reverse/reversal-by-ref/delete/put (cabang jurnal harus dalam akses **dan** = konteks; di luar akses → 404), list (dibatasi cabang kerja atau `?branchId` dalam akses; historis cabang CLOSED tetap terbaca), get-by-id (di luar akses → 404).
- Saldo awal: **satu per cabang** (sebelumnya satu per perusahaan); data lama = milik Kantor Pusat.
- Impor jurnal/saldo awal: cabang ditentukan **server** dari konteks (bukan isi file); deteksi duplikat berbasis isi hanya terhadap jurnal **cabang yang sama**.
- Jurnal bertaut transaksi antar-cabang (kolom `inter_branch_*` terisi) tidak dapat di-reverse atau dihapus lewat endpoint biasa.
- Audit jurnal memuat `branch_id`; import/saldo awal juga.

---

## 11. Existing Data Migration

Diverifikasi pada **salinan set backup UAT 5 tahun** (master + system + 6 company, termasuk `pt-terra-nusantara` 24 MB). Server dijalankan dari `dist` **dan** dari runtime Electron installer; migrasi berjalan otomatis seperti startup produksi.

**Sebelum → sesudah migrasi**

| Company | Ukuran company.db (byte) | Jurnal | Baris jurnal | Akun | Cabang |
|---|---|---|---|---|---|
| pt-terra-nusantara | 24.264.704 → 25.927.680 | **12.003 → 12.003** | **30.976 → 30.976** | **66 → 66** | (tidak ada) → **1** (Kantor Pusat) |
| pt-pembanding | 200.704 → 249.856 | 3 → 3 | 6 → 6 | 3 → 3 | → 1 |
| pt-nama-panjang | 192.512 → 241.664 | 0 → 0 | 0 → 0 | 0 → 0 | → 1 |
| pt-uji-tambah | 192.512 → 241.664 | 0 → 0 | 0 → 0 | 0 → 0 | → 1 |
| pt-xss-uji | 192.512 → 241.664 | 0 → 0 | 0 → 0 | 0 → 0 | → 1 |
| viewer-co | 192.512 → 241.664 | 0 → 0 | 0 → 0 | 0 → 0 | → 1 |
| **System DB** | 188.416 → 212.992 | — | — | company_access 11 → 11 (**semua `ALL`**) | tabel `user_branch_access` ada |

Pemeriksaan lain (semua PASS): total debit/kredit dalam sen identik; **hash isi baris jurnal, header jurnal, dan akun identik**; tidak ada jurnal tanpa cabang / di luar Kantor Pusat; tidak ada akun non-`ALL_BRANCH`; salinan `.pre-upgrade` dan `.pre-C0014` (company) serta `.pre-S0011` (system) terbentuk; **API setelah migrasi**: login, `branch-context` (ALL, konteks Kantor Pusat, multi-cabang mati), daftar jurnal (12.003), **Neraca seimbang**, dashboard, COA (`branchPolicy: ALL_BRANCH`), saldo awal — semua 200. Idempotensi (upgrade berulang tidak mengubah data/salinan) dan tidak adanya jurnal ber-`inter_branch_*` diuji pada tes migrasi otomatis (`branch-migration.test.ts`).

---

## 12. Security Tests

**E2E pada server hasil build (HTTP sungguhan: origin guard, rate limit, static) — 37/37, di node dan di runtime Electron installer.** Disertai 28 tes HTTP route (inject) + tes matriks.

| Skenario | Hasil |
|---|---|
| IDOR cabang: cabang lain vs id tak ada → respons identik | PASS (404) |
| IDOR jurnal cabang lain: baca / post / reverse / delete / put / reversal-by-ref | PASS (404, data tidak berubah) |
| `branch_id` tampering di body (cabang lain, Pusat, id palsu, **id cabang perusahaan lain**) | PASS (404) |
| Header `X-Branch-Context` palsu / di luar akses / cabang perusahaan lain | PASS (403 `BRANCH_CONTEXT_INVALID`) |
| `company_id` palsu di body | PASS (diabaikan; perusahaan lain tidak tersentuh) |
| Batas perusahaan: user perusahaan B → perusahaan A (semua endpoint cabang) | PASS (404) |
| Id cabang perusahaan A dipakai di B (jurnal, konteks, grant, transfer, kebijakan) | PASS (ditolak) |
| Bypass kebijakan: `CENTRAL_ONLY` di cabang non-pusat, `SYSTEM_ONLY` manual/impor/saldo awal, `INTER_BRANCH` manual/impor | PASS (400, tidak tersimpan) |
| Counterpart tampering: counterpart perusahaan lain, tanpa counterpart, counterpart bukan-`INTER_BRANCH`, counterpart = cabang sendiri, ubah counterpart akun terpakai | PASS |
| Manipulasi konteks aktif: PUT ke cabang di luar akses / INACTIVE / CLOSED / perusahaan lain | PASS |
| Akses dicabut saat sesi hidup | PASS — request berikutnya ditolak seketika |
| Privilege escalation: ADMIN tidak bisa reopen / ubah kebijakan akun / ubah cakupan / hapus cabang / nyalakan multi-cabang / ubah akses diri sendiri / kelola OWNER; ACCOUNTANT/STAFF tidak bisa kelola cabang | PASS |
| LIMITED di laporan, export, ledger, dashboard, pencarian, audit log, saldo counterparty, impor history, daftar user | PASS (403 `BRANCH_SCOPE_UNSUPPORTED`) |
| **Matriks seluruh route** (perusahaan + legacy) untuk akun LIMITED; tidak ada entri allowlist usang | PASS |
| Origin guard (Origin asing ke route cabang) | PASS (403); rate limiter global memakai kategori baca/mutasi yang sudah ada |
| Regresi hardening UAT-006…010 (throttle login, audit auth, CORS, rate limit, avatar) | PASS (bagian dari 726 tes) |

**Hasil: tidak ada privilege escalation, kebocoran lintas cabang, maupun lintas perusahaan yang ditemukan.**

---

## 13. Regression Tests

- **619 tes backend lama: tidak satu pun diedit, semuanya tetap lulus.** Jumlah dan cakupan tidak diturunkan; ditambah 107 tes baru → **726**.
- Tes baru mencakup (sesuai daftar wajib): create/edit cabang, ACTIVE↔INACTIVE, ACTIVE→CLOSED, historis cabang CLOSED terbaca, jurnal manual ke cabang CLOSED ditolak, user satu & banyak cabang, cabang tidak berizin ditolak, tampering URL/API, lintas perusahaan; kebijakan `ALL_BRANCH`/`CENTRAL_ONLY`/`SYSTEM_ONLY`/`INTER_BRANCH`, kebijakan tidak valid, `INTER_BRANCH` tanpa counterpart, non-`INTER_BRANCH` dengan counterpart, counterpart perusahaan lain, manipulasi nama akun; jurnal valid/tidak berizin/INACTIVE/CLOSED/tampering/pelanggaran kebijakan/`SYSTEM_ONLY` manual/penyalahgunaan `INTER_BRANCH`; **atomisitas** (kegagalan di jurnal kedua → tidak ada jurnal & audit pertama); migrasi (data, hash, idempotensi, salinan, pemulihan).
- Tes regresi yang menyentuh kode yang diubah (journal-service, impor, saldo awal, company-upgrade, company-access, rbac) semuanya hijau tanpa perubahan.

---

## 14. Database Integrity

- `PRAGMA integrity_check` = `ok` dan `foreign_key_check` = 0 pelanggaran: **sebelum dan sesudah** migrasi untuk seluruh 6 company UAT + System DB, dan pada salinan pengaman.
- Aplikasi sendiri kini memeriksa keduanya saat startup (menolak migrasi DB rusak; memulihkan bila migrasi memburuk) — diuji.
- Invarian yang dijaga database: satu Kantor Pusat; `branch_id` jurnal tidak NULL & terkunci; kode cabang tidak berubah; tidak ada DELETE cabang; `INTER_BRANCH` ⇔ counterpart; `user_branch_access` sejalan dengan perusahaan akses; `inter_branch_*` semua-atau-kosong dan slot unik; tabel audit append-only.
- Pemeriksaan integritas akuntansi bawaan TERRA tetap berjalan: Neraca seimbang pada data UAT sesudah migrasi (aset 32.834.010.999 = kewajiban 3.733.488.000 + ekuitas 29.100.522.999).

---

## 15. Build Verification

| Pemeriksaan | Hasil |
|---|---|
| TypeScript API (`tsc --noEmit`) | PASS |
| TypeScript Web (`tsc --noEmit`) | PASS |
| Backend tests | PASS — 726/726 |
| Web build (vite) | PASS |
| API build | PASS (migration baru ikut ter-bundle) |
| Electron build (`pnpm dist`) | PASS — `apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe` 124.259.119 byte |
| Pemeriksaan isi installer | Tidak ada kunci privat, `ADMIN_SECRET`, `.env`, database, atau file tes; migration C0014–C0018 & S0011–S0013 ikut tersedia |
| Runtime Electron (better-sqlite3 hasil rebuild) | Migrasi 84/84 + E2E keamanan 37/37 dijalankan dari paket installer |

ESLint tidak terpasang di workspace (kondisi lama, bukan akibat perubahan ini).

---

## 16. Known Limitations

Tidak ada yang Critical/High. Semuanya sesuai pembagian phase yang disetujui, kecuali yang ditandai ★ (keputusan implementasi yang perlu Anda ketahui).

| # | Keterbatasan | Tingkat | Ditangani |
|---|---|---|---|
| 1 | **Belum ada UI** cabang (kelola cabang, pemilih cabang kerja, manajemen akses, kebijakan akun). Seluruh fitur sudah tersedia lewat API; UI web tidak diubah. Akun LIMITED praktis belum bisa dipakai lewat aplikasi. | Medium | Phase 3/8 |
| 2 | **Laporan, dashboard, ledger, trial balance, pencarian, export belum difilter per cabang.** Aman: akun LIMITED **ditolak** di route tersebut (deny-by-default); akun ALL melihat agregat seluruh perusahaan seperti sekarang. Dashboard memakai saldo awal Kantor Pusat. | Medium | Phase 5 |
| 3 | Permission efektif per-user (override GRANT/DENY) dan delegasi belum ada; ADMIN scope ALL dapat mengelola cabang & akses cabang tanpa batas delegasi. | Medium | Phase 3–4 |
| 4 | Transaksi antar-cabang (proposal/approval/jurnal berpasangan/reversal) belum ada. Asal jurnal `inter_branch`/`head_office_effect` ditolak. Kolom `inter_branch_*` di jurnal **belum ber-FK** karena tabel induknya belum ada (FK + trigger ditambahkan di Phase 6; sementara dijaga CHECK all-or-none + slot unik). | Low | Phase 6 |
| 5 | Penyelesaian saldo saat cabang ditutup ("Selesaikan saldo ke Kantor Pusat") dan jalur pusat→cabang INACTIVE/CLOSED belum ada; saat ini penutupan hanya checklist + peringatan. | Low | Phase 6b |
| 6 | ★ Aturan `SYSTEM_ONLY` untuk akun penyeimbang saldo awal mengenai **0 akun** (lihat bagian 8) agar alur saldo awal yang berjalan tidak rusak. | Info | Keputusan Anda bila ingin kebijakan lain |
| 7 | ★ Hubungan `user_branch_access.branch_id` → cabang tidak bisa FK (beda file). Jaminan database hanya kesesuaian (user, perusahaan); keabsahan cabang dijaga validasi saat menulis + irisan dengan cabang perusahaan itu saat membaca (fail-closed, diuji). | Low | Desain (Revisi 6) |
| 8 | `reference_no` jurnal tetap UNIQUE **global** (nomor sama tidak bisa dipakai di dua cabang). | Low | Pertimbangkan Phase 5 |
| 9 | Kolom "Kebijakan Cabang" pada impor COA belum ada; kebijakan diatur via API. | Low | Phase 2 lanjutan / 8 |
| 10 | Company yang upgrade-nya ditolak (integritas rusak) tetap berskema lama dan fiturnya terganggu sampai dipulihkan manual dari salinan `.pre-*`; ini sama dengan perilaku upgrade sebelumnya, kini disertai log jelas dan pemulihan otomatis bila migrasi memburuk. | Low | — |
| 11 | Nama event audit memakai konvensi kode existing (huruf kecil bertitik): `branch.created/updated/activated/deactivated/closed/reopened/deleted`, `user_branch.access_granted/access_revoked/transferred/scope_changed/active_branch_changed`, `account.policy_changed`, `account.inter_branch_created`, `branch.nonactive_posting`, `security.branch_access_denied`, `company_setting.multi_branch_enabled` — setara `BRANCH_CREATED`, `USER_BRANCH_ACCESS_GRANTED`, dst. di desain. | Info | — |
| 12 | Harness `docs/uat/harness/multibranch/*.mjs` memuat path scratchpad lokal (sama seperti harness UAT sebelumnya). | Info | — |

---

## 17. Phase 1–2 Verdict

Kriteria:

| Kriteria | Hasil |
|---|---|
| Tidak ada Critical | ✅ |
| Tidak ada High | ✅ |
| Regresi existing PASS | ✅ 619 lama + 107 baru = 726/726; license generator 17/17 |
| Migration PASS | ✅ 84/84 pada data UAT 5 tahun, node dev **dan** runtime Electron; tanpa data hilang/berubah |
| Database integrity PASS | ✅ integrity_check ok, foreign_key_check 0, sebelum & sesudah |
| Branch authorization PASS | ✅ IDOR, tampering, konteks, pencabutan seketika, deny-by-default (matriks seluruh route) |
| Cross-company isolation PASS | ✅ struktural + trigger + tes HTTP + E2E |
| Account policy PASS | ✅ 4 kebijakan, CHECK/trigger, tanpa logika berbasis tipe/nama, dicek saat posting |
| Build (TS API/Web, tes, web, Electron) | ✅ |

## **READY FOR PHASE 3**

Catatan jujur untuk keputusan Anda: butir 1–3 pada bagian 16 berarti fitur ini **belum dapat dipakai pengguna akhir** lewat tampilan, dan pelaporan per cabang menunggu Phase 5 — itu sesuai pembagian phase yang disetujui, tetapi sebaiknya `multi_branch_enabled` **tidak dinyalakan pada perusahaan klien** sampai Phase 3 (+UI) selesai. Tidak ada pekerjaan Phase 3 yang dimulai.
