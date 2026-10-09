# IB-1 IMPLEMENTATION REPORT

**Tanggal:** 2026-10-08 · **Workspace:** `D:\ABDI\Proyek Aplikasi\Codex\TERRA-FINANCE-CLEAN` · **Dasar:** `INTER-BRANCH-TRANSACTION-SPECIFICATION.md`, `INTER-BRANCH-IMPLEMENTATION-PLAN.md`, `IB-1-PREFLIGHT-REPORT.md`, `IB-1-SPEC-CHANGELOG.md`.
> **Pembaruan 2026-10-08:** pekerjaan dilanjutkan sampai IB-6 atas perintah OWNER; hasil akhir ada di `INTER-BRANCH-IMPLEMENTATION-REPORT.md`. Laporan ini dipertahankan sebagai catatan IB-1.

**Hasil:** **PASS — IB-1 IMPLEMENTED** (dengan deviasi cakupan yang dijelaskan di bagian 15 — mohon dibaca).

Tidak disentuh: `TERRA-Finance-Offline`, `PHASE-3-AUTHORIZATION-BASELINE.md`, `phase3-authorization-baseline.manifest.json` (hash identik dengan aslinya), Phase 5A WIP, `multi_branch_enabled` (OFF di semua database uji), database produksi/klien. Tidak ada IB-2/3/4, 5A, atau Phase 6.

---

## 1. Implemented Scope

IB-1 = **fondasi skema, penjaga integritas database, model domain murni, resolver akun, dan diagnostik integritas** — sesuai Plan IB-1 dan peta berkas preflight. Tidak ada jalur HTTP, permission, atau posting baru; karena itu perilaku aplikasi untuk semua yang tidak terkait IB tidak berubah (dibuktikan di bagian 13).

| Butir | Status |
|---|---|
| Migration `C0019_inter_branch` (2 tabel, kolom pengaturan, trigger, indeks, `down`) | ✅ |
| **K-1** guard tautan IB pada jurnal: INSERT **dan** UPDATE, kolom inti, status, hapus, baris | ✅ |
| **K-2** indeks unik parsial akun INTER_BRANCH per (cabang lawan, tipe) | ✅ |
| **K-3** trigger: flag tidak dapat dimatikan saat `WAITING_APPROVAL` / `REVERSAL_WAITING` | ✅ (trigger); pesan ramah service → IB-2 sesuai perintah |
| **F-7** akun INTER_BRANCH bukan kas / tanpa klasifikasi arus kas: trigger + pre-check service + resolver | ✅ |
| **F-2** awalan `IB-` dicadangkan (case/spasi dinormalkan): trigger + guard service (create, reversal, pratinjau import) | ✅ |
| Domain murni: tipe MVP, tabel transisi (2 jalur), kombinasi status, `calculateExpiresAt`, nomor & referensi jurnal, `allocateTransactionNo` | ✅ |
| `resolveInterBranchAccounts` (dipilih sistem dari `counterpart_branch_id`; tanpa hardcode) | ✅ |
| `verifyInterBranchIntegrity` (read-only, invarian I-1…I-11 yang dapat diperiksa di company.db) | ✅ |
| Hapus `selfApprovalReason?` dari Spek §17; dokumen disinkronkan | ✅ |
| F-1 konkurensi: **known limitation**, tidak diimplementasikan; kandidat IB-3 | ✅ (dicatat) |

## 2. Files Added

| Berkas (`apps/api/src/db/company/…`) | Baris | Isi |
|---|---:|---|
| `migrations/C0019_inter_branch.ts` | 248 | skema + penjaga DB |
| `inter-branch-domain.ts` | 149 | model domain murni + pengalokasi nomor (baca saja) |
| `inter-branch-accounts.ts` | 88 | resolver akun antar-cabang |
| `inter-branch-integrity.ts` | 184 | `verifyInterBranchIntegrity` |
| `__fixtures__/inter-branch-test-helpers.ts` | 162 | fixture tes (menyusun data dengan urutan alur yang disepakati) |
| `inter-branch-migration.test.ts` | 117 | 4 tes |
| `inter-branch-triggers.test.ts` | 294 | 32 tes |
| `inter-branch-domain.test.ts` | 144 | 14 tes |
| `inter-branch-accounts.test.ts` | 113 | 12 tes |
| `inter-branch-integrity.test.ts` | 133 | 12 tes |
| `docs/architecture/IB-1-IMPLEMENTATION-REPORT.md` | — | laporan ini |

## 3. Files Modified

Perubahan atas berkas milik baseline Phase 3 (SHA-256 baseline → sekarang). Baseline historis **tidak ditulis ulang**; daftar ini adalah catatan perubahan sesuai changelog C-00.

| Berkas | Baseline → IB-1 | Perubahan |
|---|---|---|
| `db/company/account-service.ts` | 17284f2f → e485e0ca | kelas `AccountInterBranchClassificationError` + pre-check di `updateAccount` (F-7) |
| `db/company/account-policy-service.ts` | 866ca219 → 7fc43460 | pre-check kas/arus kas dan duplikat (lawan, tipe) di `setAccountBranchPolicy` (F-7, K-2) |
| `db/company/journal-service.ts` | 04327c75 → 760a00e6 | kelas `JournalReferenceReservedError` + `assertReferenceNotReserved` dipanggil di create dan reversal (F-2). **Tidak ada** perubahan lain (tautan IB, reversal internal → IB-3/IB-5) |
| `db/company/journal-import-service.ts` | f1936b09 → 4c42ce5b | pratinjau menandai ERROR untuk referensi berawalan `IB-` |
| `modules/company-journal/routes.ts` | 7ce892ee → 79002dd6 | pemetaan `JournalReferenceReservedError` → 409 |
| `modules/company-accounts/routes.ts` | c2fc2cd4 → 4a9c73d9 | pemetaan `AccountInterBranchClassificationError` → 409 |
| `modules/company-branches/routes.ts` | 9a04e6a5 → 569fce08 | pemetaan yang sama pada jalur kebijakan akun |
| **Tes** `db/company/journal-branch.test.ts` | 8e96c3e0 → a171eb72 | tes `:156` ditulis ulang (K-1) — lihat bagian 13 |
| **Tes** `db/company/journal-import-service.test.ts` | c2e3000c → 5006cd2d | +1 tes (referensi `IB-` → ERROR) |
| **Tes** `architecture/scope-readiness.test.ts` | (di luar manifest) | +2 entri klasifikasi `COMPANY_LEVEL` untuk berkas baru |
| Dokumen | — | `INTER-BRANCH-TRANSACTION-SPECIFICATION.md` (baris `selfApprovalReason?` dihapus + status), `INTER-BRANCH-IMPLEMENTATION-PLAN.md` (status IB-1), `IB-1-SPEC-CHANGELOG.md` (realisasi) |

Tidak diubah: `branch-service.ts`, `period-closing-service.ts`, `company-profile-service.ts`, `server.ts`, `middleware/*`, `rbac.ts`, `authorization.ts`, seluruh UI, `package.json`, lockfile.

## 4. Database Migration

`C0019_inter_branch` — satu migration, idempoten (`IF NOT EXISTS`, cek `PRAGMA table_info`), tanpa backfill, `down` tersedia, berjalan lewat `company-upgrade` (cadangan `.pre-upgrade` + `.pre-C0019`, `integrity_check` sebelum/sesudah, restore otomatis bila gagal).

- **`inter_branch_transactions`**: id, `transaction_no` UNIQUE, `type`, `transaction_date`, `from/to_branch_id` (FK RESTRICT, CHECK ≠), `amount` (CHECK > 0), deskripsi/referensi, akun pemberi & akun usulan penerima, counterparty opsional, `status` (5 nilai), `reversal_state` (3 nilai; CHECK hanya sah bila COMPLETED), `proposed_by`, `idempotency_key` (UNIQUE bersama `proposed_by`), timestamp. Tanpa kolom accounting event (diturunkan dari jurnal).
- **`inter_branch_approvals`**: transaksi, `kind` POST/REVERSE, `status`, pemohon/cabang/waktu/alasan, `expires_at`, pemutus/waktu/alasan, `self_approved` (informasional), `confirmed_account_id`; CHECK: alasan wajib untuk REVERSE dan REJECTED, pelaku wajib untuk keputusan, `self_approved` hanya bila pelaku = pemohon; UNIQUE parsial satu `WAITING` per transaksi.
- **`company_profile.inter_branch_expiry_days`**: INTEGER NOT NULL DEFAULT 14, CHECK 1–90.
- **Indeks:** `uq_inter_branch_approvals_one_waiting` dan `uq_accounts_inter_branch_pair` (K-2). Tidak ada indeks sekunder lain (D-12).
- **20 trigger** (daftar tetap diuji): lihat bagian 9.

## 5. Transaction Flow

IB-1 **belum menjalankan alur** (ajukan/setujui/posting = IB-2/IB-3). Yang ada adalah *kontrak* alur yang ditegakkan database dan dimodelkan di domain:

- Tabel transisi: `WAITING_APPROVAL → COMPLETED | REJECTED | CANCELLED | EXPIRED` (terminal tidak kembali); `NOT_REVERSED → REVERSAL_WAITING → REVERSED | NOT_REVERSED`. Domain (`isValidStatusTransition`, `isValidReversalTransition`, `isValidStateCombination`) dan trigger DB identik; diuji menyeluruh (semua pasangan).
- Transaksi baru wajib `WAITING_APPROVAL`/`NOT_REVERSED`. Jurnal IB hanya dapat dibuat bila induk sudah `COMPLETED` (leg ORIGINAL) atau `COMPLETED`+`REVERSED` (leg REVERSAL) — memaksa pola "klaim dulu, jurnal sesudahnya" Spek §12; transaksi `WAITING_APPROVAL` **tidak dapat** memiliki jurnal.
- `calculateExpiresAt` = min(pengajuan + masa berlaku, akhir hari (tanggal transaksi + batas backdate)); `isInterBranchExpired` tegas pada batas milidetik.
- `allocateTransactionNo`: `IB-<tahun>-<urutan 6 digit>` (MAX+1 per tahun), melewati nomor yang referensi jurnal turunannya (`-F`, `-T`, `-F-REV`, `-T-REV`) sudah ada.

## 6. Authorization

**Tidak ada perubahan** pada model Phase 3 dan tidak ada permission baru. Tidak ada endpoint IB di IB-1, sehingga tidak ada keputusan otorisasi baru yang dapat dilewati. Yang ditegakkan di IB-1 hanya batas yang tidak bergantung pada peran:
- Self-approval: kolom `self_approved` hanya sah bila pelaku keputusan = pemohon (CHECK) dan `verifyInterBranchIntegrity` memeriksa konsistensinya. **Aturan OWNER vs non-OWNER (`assertCanDecide`, 403 `SELF_APPROVAL_NOT_ALLOWED`) belum dikodekan** — butuh endpoint dan peran dari System DB (IB-2/IB-3); rancangannya tidak berubah (OWNER tanpa alasan; non-OWNER ditolak; delegasi tidak memperluas; hak = permission ∩ akses cabang).
- Tes otorisasi/delegasi Phase 3 yang ada (`authorization.test.ts`, `company-authorization/routes.test.ts`, `company-branches/routes.test.ts`) tetap hijau.

## 7. Journal Posting

IB-1 **tidak membuat atau memposting jurnal IB** (IB-3). Yang disiapkan dan dibuktikan:
- Atomisitas dua sisi dengan fungsi jurnal existing sudah teruji (`journal-branch.test.ts` "atomik …": 0 jurnal dan 0 audit setelah kegagalan); `journal-service.ts` tidak diubah selain guard referensi.
- Penjaga DB untuk jurnal IB (bagian 9) menjamin hasilnya benar walau kode posting kelak keliru: induk COMPLETED, origin `inter_branch`, cabang sesuai sisi, referensi `IB-…`, slot unik, tak dapat diubah/dihapus.
- Reversal: urutan header-POSTED-lalu-baris `reverseJournalEntry` didukung (INSERT baris dijaga hanya untuk leg ORIGINAL); teruji dengan fixture reversal lengkap (4 jurnal).
- `reverseJournalEntry` dan `deleteDraftJournalEntry` tetap menolak jurnal bertaut lewat jalur biasa (teruji).

## 8. Account Rules

- `resolveInterBranchAccounts({from,to})`: FROM mendebit INTER_BRANCH[lawan=TO] (utama ASSET, cadangan LIABILITY); TO mengkredit INTER_BRANCH[lawan=FROM] (utama LIABILITY, cadangan ASSET). Dicari dari `branch_policy` + `counterpart_branch_id`; **tanpa nomor akun dan tanpa id cabang di kode**. Tidak ditemukan → `INTER_BRANCH_ACCOUNT_MISSING` dengan arahan membuat akun lewat menu terpandu; tidak aktif/terkunci/kas/berklasifikasi arus kas → `…_UNUSABLE` (tidak diam-diam beralih tipe); ganda → `…_AMBIGUOUS`; cabang sama ditolak.
- **F-7:** akun INTER_BRANCH selalu `is_cash=0` dan `cash_flow_activity IS NULL`. Tiga lapis: trigger `accounts_ib_cash_ins/upd` (final), pre-check `updateAccount` & `setAccountBranchPolicy` (409 ramah), resolver. Tidak dapat diubah setelah dibuat.
- **K-2:** `uq_accounts_inter_branch_pair` — duplikat ditolak DB; `setAccountBranchPolicy` menolak dulu dengan pesan ramah. Wizard pasangan akun tidak berubah dan tetap bekerja.

## 9. Integrity Guards

| Lapisan | Penjaga |
|---|---|
| Transaksi | CHECK (cabang ≠, nominal > 0, status, reversal_state, kombinasi); UNIQUE nomor dan (pembuat, kunci idempotensi); trigger: keadaan awal, kolom bisnis immutable, transisi status, transisi reversal, tanpa DELETE |
| Persetujuan | CHECK (alasan, pelaku, self_approved); UNIQUE parsial satu WAITING; trigger: tanpa DELETE, data permintaan immutable, final tak berubah |
| **K-1 jurnal** | INSERT: induk ada, origin ↔ tautan dua arah, referensi `IB-*`, cabang sesuai sisi, status induk sesuai leg; UPDATE tautan/origin ditolak bila berubah (no-op diterima); kolom inti jurnal POSTED/REVERSED immutable; status hanya POSTED→REVERSED; DELETE header ditolak; UPDATE/DELETE baris jurnal POSTED/REVERSED ditolak; INSERT baris ke ORIGINAL non-DRAFT ditolak |
| **F-2** | trigger `journal_entries_ib_ref_reserved` (huruf besar/kecil, spasi) + `JournalReferenceReservedError` di create/reversal + ERROR pada pratinjau import |
| **K-3** | trigger `company_profile_ib_flag_off` |
| **K-2 / F-7** | indeks unik parsial; trigger kas/arus kas |
| Diagnostik | `verifyInterBranchIntegrity` |

Residu yang diketahui (jujur): `INSERT OR REPLACE` SQL mentah pada `journal_entries` melewati trigger karena `recursive_triggers=0`; bukan jalur aplikasi (tidak ada `OR REPLACE`/`onConflict`/`merge` di source) dan memerlukan akses langsung ke file; dampaknya terdeteksi `verifyInterBranchIntegrity` (leg tidak lengkap). Imutabilitas jurnal POSTED **non-IB** sengaja tidak diubah (tetap penjagaan aplikasi seperti Phase 3).

## 10. Audit Trail

IB-1 **tidak menambah event audit** karena belum ada aksi IB. Daftar event final (Spek §15: `CREATED`, `SUBMITTED`, `APPROVED` + `makerEqualsApprover/actorRole/self_approved`, `ACCOUNT_CONFIRMED`, `POSTED`, `COMPLETED`, `REJECTED`, `CANCELLED`, `EXPIRED`, `REVERSAL_*`) dikerjakan bersama aksinya di IB-2…IB-5. Yang sudah ada dan tetap berlaku: `appendCompanyAudit` dalam transaksi yang sama, `branch_id`, tabel append-only. Penjaga skema yang mendukung audit: persetujuan tidak dapat dihapus atau diubah setelah final, `self_approved` konsisten dengan pelaku.

## 11. Test Results

| Pemeriksaan | Hasil |
|---|---|
| Typecheck api / web / shared (`tsc --noEmit`) | **0 / 0 / 0 error** |
| `pnpm test` (root → api) | **902/902** lulus, 72 berkas (baseline P-1: 827/67) |
| Tes IB-1 baru | **74** (migrasi 4, trigger/penjaga 32, domain 14, akun 12, integritas 12) + 1 tes import baru |
| Tes arsitektur (padanan `check:boundaries`; skrip itu tidak ada di repo) | **8/8** |
| Build api / web | OK / OK; `C0019_inter_branch.js` ikut ter-build |
| Uji mutasi (8 mutan: indeks K-2, trigger flag K-3, trigger UPDATE tautan K-1, cek cabang sisi, trigger kas F-7, guard referensi service, pre-check akun service, normalisasi huruf) | **8/8 terdeteksi**. Satu mutan awalnya lolos → menambah tes "pindah ke transaksi lain walau slot kosong" → terdeteksi |
| Lint | `pnpm -r lint` tidak dijalankan: ESLint belum terkonfigurasi (backlog H-1) |

## 12. Security Results

IB-1 tidak menambah permukaan HTTP. Hasil keamanan yang relevan (semua di level database/service):
- Tautan IB tidak dapat ditempel, dipindah, dikosongkan, atau diubah asalnya lewat UPDATE (termasuk pemindahan ke transaksi lain dengan slot kosong); jurnal bertaut POSTED tidak dapat diubah/dihapus; jurnal biasa tidak dapat mengklaim `IB-` dalam variasi `ib-`, `  Ib-`, `iB-`; IB tidak dapat dibuat untuk transaksi yang belum COMPLETED atau di cabang yang salah.
- Flag tidak dapat dimatikan saat ada transaksi menunggu (WAITING_APPROVAL, REVERSAL_WAITING), walau service dilewati.
- Akun antar-cabang tidak dapat menjadi kas/berklasifikasi arus kas; tidak ada akun ganda per (lawan, tipe).
- Tes keamanan Phase 3 (otorisasi, delegasi, IDOR cabang, origin guard, E2E) tetap lulus: E2E keamanan Multi-Branch **37/37** pada salinan UAT.
- Belum ada (IB-2/IB-3): IDOR/permission/self-approval/konkurensi pada endpoint IB.

## 13. Regression Results

| Pemeriksaan | Hasil |
|---|---|
| Golden Master Phase 5.0 (flag OFF) | small **43/43**; uat-1, uat-3, uat-7 masing-masing **126/126** identik |
| E2E keamanan Multi-Branch (padanan `test:e2e`) | **37/37** |
| Migrasi atas salinan UAT 5 tahun (6 company; server hasil build) | semua → **19 migrasi**, terakhir `C0019`; jumlah jurnal, baris jurnal, akun, periode, audit **identik**; Σdebit/Σkredit **identik**; tabel IB ada & kosong; flag `multi_branch_enabled = 0`; `inter_branch_expiry_days = 14` |
| `PRAGMA integrity_check` | **ok** pada 6 company.db + system (16 migrasi) + master (12) |
| `PRAGMA foreign_key_check` | **0** pelanggaran di semua |
| Cadangan & restore | `company.db.pre-C0019` terbentuk (18 migrasi, 12.003 jurnal, tanpa tabel IB, integrity ok); dipulihkan lalu diupgrade ulang → 19 migrasi, data sama, ok |
| Migrasi atas database C0013 dengan data nyata (tes `branch-migration.test.ts`) | tetap lulus; tes baru C0018→C0019 menegaskan snapshot data tidak berubah |
| Perubahan terhadap 827 tes lama | **satu** tes diganti secara sadar (alasan di bawah); tidak ada yang dihapus, dinonaktifkan, atau dilonggarkan; semua tes lain lulus tanpa perubahan |

**Tes yang diubah — `journal-branch.test.ts` "kolom inter_branch_*" (K-1):** versi lama menempelkan `IBT-1` lewat UPDATE tanpa transaksi induk — justru perilaku yang dilarang K-1. Versi baru mempertahankan seluruh tujuan lama (semua-atau-kosong, slot unik, deleteDraft/reverse menolak jurnal bertaut) dan menambah: UPDATE penempelan/pemindahan ditolak, tautan hanya lewat INSERT sah dengan induk COMPLETED. Satu-satunya perubahan asersi: pesan penolakan UPDATE sebagian kini bisa berasal dari penjaga C0015 **atau** C0019 (`/terisi semua atau kosong semua|IB:/`) karena urutan trigger tidak ditentukan; keduanya tetap menolak.
Tes `branch-service.test.ts:220` dan `journal-branch.test.ts:103-104` ("inter_branch belum didukung") **tetap berlaku** karena `assertBranchAcceptsOrigin` tidak diubah (berubah di IB-3).

## 14. Known Limitations

1. **F-1 konkurensi SQLite** (dua koneksi → ±5,8 dtk tertahan + `SQLITE_BUSY`) — known limitation platform; kandidat IB-3 (antrean tulis per perusahaan + pemetaan `SQLITE_BUSY`). Tidak diimplementasikan.
2. `INSERT OR REPLACE` SQL mentah melewati trigger (bagian 9); terdeteksi oleh verifikasi, tidak dicegah.
3. Trigger K-3 menolak dengan galat SQL mentah bila `PUT …/multi-branch` dipanggil saat ada transaksi menunggu; **belum mungkin terjadi** (belum ada kode yang membuat transaksi menunggu) dan pesan ramah masuk IB-2 sesuai perintah. Penandaan `EXPIRED` malas sebelum penghitungan juga di IB-2.
4. Imutabilitas jurnal POSTED non-IB tetap hanya di level aplikasi.
5. Karena belum ada alur posting, `verifyInterBranchIntegrity` dan trigger diuji dengan fixture yang menyusun data menurut urutan alur; kesesuaiannya dengan posting nyata diverifikasi ulang di IB-3.
6. Data klien lain di luar komputer ini tidak terlihat: pemindaian referensi `IB-` hanya atas 202 berkas yang tersedia (0 temuan). Pengalokasi nomor melewati referensi lama berawalan `IB-` bila ada.
7. Lint belum terkonfigurasi (H-1); H-2/H-3 tidak berubah.

## 15. Deviations From Specification

1. **Cakupan butir 5, 7, 8, 9 pada perintah implementasi** (integrasi otorisasi/route, posting atomik, lifecycle dengan aksi, event audit): **tidak diimplementasikan di IB-1.** Alasannya: Plan dan peta berkas preflight yang Anda setujui menempatkannya di IB-2 (otorisasi, ajukan, audit awal) dan IB-3 (persetujuan + posting atomik), dan perintah yang sama melarang memulai IB-2/IB-3/IB-4. Saya memilih peta berkas yang disetujui; yang dikerjakan IB-1 adalah prasyaratnya (kontrak transisi, penjaga DB, resolver akun, diagnostik). Jika Anda memang menghendaki butir-butir itu masuk IB-1, itu perlu keputusan tertulis karena mengubah batas fase.
2. **Ditambahkan di luar peta preflight (terbukti perlu):** guard service `JournalReferenceReservedError` + validasi pratinjau import + pemetaan 409 (changelog semula menaruhnya di IB-3). Tanpa itu trigger F-2 mengubah penolakan referensi `IB-` menjadi 500 generik.
3. **Ditambahkan pada C0019:** trigger keadaan awal transaksi dan syarat referensi jurnal IB berawalan `IB-` (GLOB, peka huruf).
4. Penafsiran K-3 diperluas ke `REVERSAL_WAITING` — sesuai perintah implementasi ("WAITING_APPROVAL, REVERSAL_WAITING").
5. `allocateTransactionNo` berada di `inter-branch-domain.ts` (baca saja) agar tidak ada berkas tambahan; modul ini karenanya tidak sepenuhnya murni dan diklasifikasikan `COMPANY_LEVEL` di tes arsitektur.
6. Tidak ada mekanisme "penandaan kedaluwarsa" (menulis) di IB-1 — hanya fungsi murni; penulisan di IB-2.
7. Skrip `pnpm typecheck` (root), `check:boundaries`, `test:e2e` tidak ada di repo; padanan yang sama seperti P-1 dipakai dan dicatat.

## 16. Final Status

# **PASS — IB-1 IMPLEMENTED**

Semua validasi wajib yang tersedia lulus (tsc 0 error, 902/902 tes, arsitektur 8/8, Golden Master identik, E2E 37/37, migrasi UAT + integrity_check + foreign_key_check bersih, cadangan/restore teruji, 8/8 mutan terdeteksi). Deviasi cakupan di bagian 15 butir 1 adalah satu-satunya hal yang memerlukan perhatian Anda.

IB-1 selesai. **Berhenti di sini:** tidak ada IB-2/IB-3/IB-4, Phase 5A, atau Phase 6 yang dimulai; menunggu review Anda.
