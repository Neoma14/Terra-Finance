# IB-1 — SPEC CHANGELOG (addendum / change record)

**Tanggal:** 2026-10-08 · **Status:** koreksi disetujui OWNER (K-1, K-2, K-3, F-1…F-9) · **Jenis dokumen:** catatan perubahan *baru*; tidak menggantikan berkas mana pun.

## 0. Status historical baseline — TIDAK BERUBAH

- `docs/baseline/PHASE-3-AUTHORIZATION-BASELINE.md` — **tidak diubah**.
- `docs/baseline/phase3-authorization-baseline.manifest.json` — **tidak diubah**.
- Dokumen ini **tidak** mengklaim baseline Phase 3 berubah. Baseline Phase 3 tetap IMMUTABLE. Perubahan pada berkas source yang kelak dilakukan Inter-Branch dicatat **di sini** (dan di laporan fase), bukan dengan menulis ulang baseline historis. (Rencana lama di Spek §23 / Plan "catat di baseline §8" **digantikan** oleh butir C-00 di bawah.)
- `multi_branch_enabled` tidak diubah. Tidak ada kode, migration, schema, atau tes yang diubah oleh dokumen ini.

## Aturan pengutamaan

Untuk butir yang tercantum di dokumen ini, **dokumen ini berlaku di atas** `INTER-BRANCH-TRANSACTION-SPECIFICATION.md` ("Spek"), `INTER-BRANCH-IMPLEMENTATION-PLAN.md` ("Plan"), dan bagian terkait di `MULTI-BRANCH-AUDIT-AND-DESIGN.md`. Spek/Plan tidak diedit; pembaca wajib membaca keduanya bersama dokumen ini. Butir yang tidak disebut di sini tidak berubah.

## Ringkasan

| ID | Menyentuh | Ringkasan koreksi | Fase |
|---|---|---|---|
| C-00 | Spek §23, Plan | Pencatatan perubahan baseline → dokumen ini + laporan fase, **bukan** edit baseline §8 | semua |
| C-01 / F-1 | Spek §2, §14, §13 | Konkurensi: known limitation; antrean tulis per-perusahaan = pekerjaan IB-3 | IB-3 |
| C-02 / F-2 | Spek §12 (penomoran), D-7 | Cadangan `IB-`: guard terpisah berbasis `origin` + trigger DB; `assertReferenceNoAvailable` tidak diubah | IB-1/IB-3 |
| C-03 / F-3 + K-3 | Spek §23, §14, §29; Plan IB-4 | Guard 404 route; mematikan flag diblokir selama ada transaksi pending; urutan dipercepat | IB-1/IB-2 |
| C-04 / F-4 | Spek §11, §12; Plan IB-3/IB-5 | Perubahan helper jurnal dirinci; dua tes existing diganti | IB-3/IB-5 |
| C-05 / F-5 + K-1 | Spek §11 (penjaga induk) | Guard INSERT **dan** UPDATE, kolom inti, status, hapus, baris | IB-1 |
| C-06 / F-6 + K-2 | Spek §11 | Indeks unik parsial akun INTER_BRANCH | IB-1 |
| C-07 / F-7 | Spek §5 (catatan arus kas), D-9 | Akun INTER_BRANCH tidak pernah kas / berklasifikasi arus kas | IB-1 |
| C-08 / F-8 | Spek §17, §8.1 | Hapus `selfApprovalReason?` | IB-2 |
| C-09 / F-9 | Spek §16, Plan IB-6 | Mekanisme menu bersyarat (UX saja) | IB-6 |
| D-14…D-16 | Spek §32 | Keputusan baru K-1, K-2, K-3 dimasukkan ke matriks keputusan | — |

---

## C-00 — Pencatatan perubahan (menggantikan "catat di baseline §8")
- **Sebelum:** Spek §23 dan Plan menyatakan perubahan berkas baseline dicatat di `PHASE-3-AUTHORIZATION-BASELINE.md` §8.
- **Sesudah:** perubahan atas berkas Phase 3 dicatat di (a) dokumen ini, (b) laporan tiap fase IB, (c) manifest baru bila diperlukan (bukan manifest historis). Baseline Phase 3 historis tidak ditulis ulang.
- **Alasan:** keputusan OWNER; menjaga keterbacaan "apa yang dibekukan Phase 3" tanpa campur tangan.
- Berkas baseline yang diperkirakan berubah selama IB (rujukan, belum diubah): `journal-service.ts`, `branch-service.ts`, `account-service.ts`, `account-policy-service.ts`, `period-closing-service.ts`, `company-profile-service.ts`, `middleware/branch-authority.ts`, `server.ts`, `modules/company-accounts/routes.ts`, `modules/company-branches/routes.ts`, dan UI (`nav-config.ts`, `App.tsx`, `workspace-shell.tsx`).

## C-01 — F-1 Konkurensi SQLite
- **Sebelum:** Spek §2 menyebut Company DB "satu koneksi, penulis tunggal dalam proses"; §14 menjanjikan "satu pemenang, yang kalah 409".
- **Fakta:** koneksi dibuat per request (`openCompanyDbForSlug` → `destroy()`), jadi dua request bersamaan = dua koneksi ke satu file. Percobaan: tanpa penguncian pemenang tertahan ±5,8 dtk dan yang kalah mendapat `SQLITE_BUSY` (±5,7 dtk); dengan antrean tulis per-perusahaan keduanya selesai ±60 ms, tepat satu pemenang.
- **Sesudah:** *known limitation* platform (sudah ada sebelum IB; tidak diperkenalkan IB); **bukan blocker IB-1**; **kandidat IB-3**: antrean tulis per-`companySlug` membungkus semua aksi tulis IB, ditambah pemetaan `SQLITE_BUSY` → 409/503 sebagai jaring pengaman. Tes konkurensi memakai dua koneksi nyata ke satu file dan menegaskan hasil bersih. Tidak diimplementasikan sebelum IB-3.
- Komentar "tidak ada writer kedua" di `journal-service.ts` benar hanya per koneksi; koreksi komentar mengikuti IB-3.

## C-02 — F-2 Cadangan awalan `IB-`
- **Sebelum:** Spek §12/D-7: tambahkan baris di `assertReferenceNoAvailable` yang menolak awalan `IB-`.
- **Masalah:** fungsi yang sama dipanggil oleh posting IB sehingga jurnal IB sendiri ditolak; `reference_no` UNIQUE peka huruf besar-kecil sehingga `ib-…` lolos.
- **Sesudah:** `assertReferenceNoAvailable` **tidak diubah**. (1) `isReservedInterBranchReference(ref)` = `trim().toUpperCase().startsWith("IB-")`. (2) `createDraftJournalEntry` dan `reverseJournalEntry` menolak referensi terreservasi bila `origin !== 'inter_branch'`. (3) Trigger DB `journal_entries_ib_ref_reserved` (`BEFORE INSERT`, di C0019) sebagai backstop. (4) Referensi IB deterministik `<no>-F|-T|-F-REV|-T-REV`; pengalokasi nomor memeriksa ketersediaannya.
- **Data:** 0 referensi `IB-` pada 202 berkas data yang tersedia (lihat laporan preflight); baris lama tidak disentuh.

## C-03 — F-3 + K-3: siklus hidup flag
- **Sebelum:** Spek §23 menyatakan "flag OFF ⇒ hanya satu cabang"; Plan IB-4 memuat penutupan; tidak ada guard 404.
- **Fakta:** OWNER dapat mematikan flag kapan saja walau cabang/transaksi sudah ada; `MultiBranchDisabledError` → 403; tidak ada guard 404 pada rute mana pun.
- **Sesudah:**
  1. Pernyataan Spek §23 dikoreksi: hanya benar bagi perusahaan yang belum pernah menyalakan flag.
  2. **K-3:** `setMultiBranchEnabled(false)` ditolak (409 `MULTI_BRANCH_HAS_PENDING_INTER_BRANCH`) selama ada transaksi `WAITING_APPROVAL` — dan, sebagai perluasan atas penafsiran tujuan K-3, `COMPLETED` dengan `REVERSAL_WAITING`. Transaksi `WAITING_APPROVAL` yang sudah lewat `expires_at` ditandai `EXPIRED` dulu di transaksi yang sama sebelum dihitung. Status terminal (`COMPLETED`/`REJECTED`/`CANCELLED`/`EXPIRED`/`REVERSED`) tidak menghalangi.
  3. Ditegakkan di server pada dua lapis: service `setMultiBranchEnabled` (di dalam `db.transaction`) dan trigger `company_profile_ib_flag_off` (C0019). Jalur penulis flag hanya satu (`setMultiBranchEnabled` ← `PUT …/multi-branch`).
  4. Semua rute IB mengembalikan **404** saat flag OFF (guard baru, IB-2).
  5. **Urutan:** pesan ramah service masuk **IB-2** (bukan IB-4) karena `WAITING_APPROVAL` pertama dapat tercipta pada IB-2. OWNER yang ingin mematikan flag menyelesaikan/ membatalkan transaksi pending lebih dulu.

## C-04 — F-4 Helper jurnal
- **Sebelum:** Spek §12/Plan IB-3 menyebut perubahan `journal-service.ts` dan matriks `branch-service.ts` secara umum.
- **Sesudah (rinci):**
  - `createDraftJournalEntry`: input opsional `interBranch {transactionId, leg, side}`; bila ada → `origin='inter_branch'` (server) dan kolom tautan diisi; `origin='inter_branch'` tanpa tautan ditolak; guard referensi (C-02).
  - `reverseJournalEntry`: opsi **internal** (tak terbentuk dari HTTP) yang melewati penolakan jurnal bertaut, `origin='inter_branch'`, `leg='REVERSAL'`, `side` mengikuti jurnal asli. Jalur biasa tetap menolak jurnal bertaut.
  - `assertBranchAcceptsOrigin`: tambahkan `inter_branch` ke `SUPPORTED_JOURNAL_ORIGINS`. Aturan "cabang non-ACTIVE hanya menerima `system`" yang sudah ada menghasilkan ACTIVE↔ACTIVE tanpa matriks baru. `head_office_effect` tetap tidak didukung.
  - `postJournalEntry`: tidak berubah.
  - Tes existing yang menyatakan "inter_branch belum didukung" (`branch-service.test.ts:220`, `journal-branch.test.ts:103-104`) **diganti** dengan tes yang lebih ketat; `head_office_effect` tetap "belum didukung". Tes `journal-branch.test.ts:156-166` ditulis ulang di IB-1 (C-05).

## C-05 — F-5 + K-1: guard tautan IB (diperluas dari Spek §11)
- **Sebelum:** Spek §11 — trigger penjaga induk `BEFORE INSERT` saja.
- **Fakta:** tidak ada trigger pada jurnal POSTED; tautan IB dapat ditempel lewat UPDATE. SQLite `recursive_triggers=0`.
- **Sesudah (C0019):** untuk jurnal **bertaut IB** — INSERT: induk harus ada, `origin='inter_branch'` (dan sebaliknya), `branch_id` sesuai sisi (FROM/TO), induk `COMPLETED` untuk ORIGINAL dan `COMPLETED`+`REVERSED` untuk REVERSAL; UPDATE tautan/`origin` ditolak bila berubah (no-op diterima); UPDATE `entry_date/period_id/reference_no/branch_id` pada POSTED/REVERSED ditolak; status hanya `POSTED→REVERSED`; DELETE header ditolak; UPDATE/DELETE baris jurnal bertaut POSTED/REVERSED ditolak; INSERT baris ke ORIGINAL non-DRAFT ditolak. Jurnal biasa tidak terpengaruh; imutabilitas tidak dilemahkan.
- **Residu diketahui:** `INSERT OR REPLACE` SQL mentah melewati trigger (bukan jalur aplikasi; terdeteksi `verifyInterBranchIntegrity`).
- **Dampak tes:** `journal-branch.test.ts:156-166` (menempelkan `IBT-1` lewat UPDATE tanpa induk) ditulis ulang; ini satu-satunya dari 827 tes yang terdampak (terukur pada prototipe).

## C-06 — F-6 + K-2: indeks unik akun antar-cabang
- **Sebelum:** keunikan (cabang lawan, tipe) hanya cek aplikasi (`planOne`); Spek §11 menunda indeks sekunder tetapi tidak membahas ini.
- **Sesudah (C0019):** `CREATE UNIQUE INDEX uq_accounts_inter_branch_pair ON accounts(counterpart_branch_id, account_type_id) WHERE branch_policy='INTER_BRANCH'`. Hanya berlaku untuk akun INTER_BRANCH. Tidak ada kolom "purpose" di skema; kunci = `account_type_id`. Pelanggaran dipetakan ke 409 pada `setAccountBranchPolicy`/wizard. Resolver tetap menolak keadaan ambigu.
- **Data:** 0 duplikat pada seluruh data yang tersedia.

## C-07 — F-7 Klasifikasi arus kas akun INTER_BRANCH
- **Sebelum:** Spek §5 hanya mencatat bahwa akun antar-cabang tanpa `cash_flow_activity` muncul sebagai *unclassified*; tidak ada penegakan.
- **Sesudah:** aturan bisnis tegas — akun INTER_BRANCH selalu `is_cash=0` dan `cash_flow_activity IS NULL`. Penegakan: trigger DB (INSERT/UPDATE `branch_policy`, `is_cash`, `cash_flow_activity`), pre-check ramah di `updateAccount` dan `setAccountBranchPolicy` (409), dan penolakan oleh resolver saat posting. Tidak berubah setelah akun dibuat. Efek Arus Kas per cabang = `unclassified` (D-9 tetap).

## C-08 — F-8 `selfApprovalReason?`
- **Sebelum:** Spek §17 baris `POST /:id/approve`: "body: confirmedAccountId, selfApprovalReason?"; dokumen lama menyebut alasan wajib, `INTER_BRANCH_SELF_APPROVED`, `_APPROVAL_WAIVED`.
- **Diterapkan:** baris `selfApprovalReason?` pada Spek §17 sudah dihapus (2026-10-08, atas perintah OWNER); tidak ada lagi kontradiksi di Spek/Plan. Dokumen historis `MULTI-BRANCH-AUDIT-AND-DESIGN.md` tidak diedit (sudah dinyatakan digantikan).
- **Sesudah:** body approve = `{ confirmedAccountId }` saja. **OWNER:** menyetujui transaksinya sendiri tanpa alasan (audit lengkap: `makerEqualsApprover`, `actorRole`, `self_approved` informasional, server-diisi). **Non-OWNER:** tidak boleh (403 `SELF_APPROVAL_NOT_ALLOWED`). Alasan tetap wajib untuk **tolak** dan **reversal**. Event `INTER_BRANCH_SELF_APPROVED` dan `_APPROVAL_WAIVED` pada dokumen lama **tidak digunakan**; Spek §15 yang berlaku.

## C-09 — F-9 Menu Antar Cabang
- **Sebelum:** Spek §16: "menu hanya bila flag ON dan `interbranch.read`" tanpa mekanisme.
- **Sesudah:** properti opsional `visibleWhen` pada item nav (`multiBranch`, `permission`, `minAccessibleBranches`) disaring **hanya di sidebar**; data dari `useBranches` (flag), `useMyAuthorization` (permission efektif), `branch-context` (cabang yang dapat diakses). Pembuatan `<Route>` tidak difilter. Visibilitas menu = UX; server (flag 404, permission 403, akses cabang 404, `BRANCH_AWARE_ROUTES`) tetap penentu.

## Keputusan yang ditambahkan ke Spek §32

| Decision | Status | Final Decision |
|---|---|---|
| D-14 (K-1) | FINAL | Tautan IB pada jurnal dijaga ketat di DB: INSERT dan UPDATE; tidak dapat ditempel, dipindah, atau diubah; imutabilitas jurnal POSTED tidak dilemahkan |
| D-15 (K-2) | FINAL | Indeks unik parsial akun INTER_BRANCH per (cabang lawan, tipe akun) |
| D-16 (K-3) | FINAL | OWNER tidak dapat mematikan multi-cabang selama ada transaksi IB `WAITING_APPROVAL` (dan, per penafsiran, `REVERSAL_WAITING`) |

## Perubahan pada Plan

| Fase | Perubahan |
|---|---|
| IB-0 | Gerbang P-1 terpenuhi (Clean Development Baseline dipromosikan); catatan baseline → C-00 |
| IB-1 | Isi C0019 ditambah: trigger K-1, indeks K-2, trigger K-3, trigger F-2, trigger F-7; pre-check akun (F-6/F-7) + pemetaan error; satu tes diganti (`journal-branch.test.ts:156`) |
| IB-2 | + guard flag-OFF → 404; + pesan ramah K-3 pada `setMultiBranchEnabled`; + body approve tanpa `selfApprovalReason` |
| IB-3 | + antrean tulis per-perusahaan (F-1); + guard referensi `IB-` (F-2); + perubahan helper jurnal (F-4) |
| IB-4 | K-3 tidak lagi di IB-4 (dipindah ke IB-2); sisanya tetap |
| IB-6 | + mekanisme menu bersyarat (F-9) |
| IB-7 | + uji konkurensi dua-koneksi yang menegaskan hasil bersih (bukan `SQLITE_BUSY`) |

## Yang TIDAK berubah
Baseline Phase 3 historis dan manifestnya; model otorisasi Phase 3 (tanpa permission baru; delegasi tidak memberi hak IB); aturan OWNER (§8.1) dan non-OWNER; `multi_branch_enabled`; Phase 5A (WIP, bukan dependensi) dan Phase 6; semua keputusan D-0…D-13.

## Realisasi IB-1 (2026-10-08) -- selisih terhadap changelog ini
Rincian lengkap di `IB-1-IMPLEMENTATION-REPORT.md`. Ringkas:
- Ditambahkan di luar peta berkas preflight karena terbukti perlu: guard service `JournalReferenceReservedError` pada `journal-service.ts` (create dan reversal) dan validasi pratinjau pada `journal-import-service.ts`, beserta pemetaan 409 di `modules/company-journal/routes.ts`. Alasan: tanpa itu trigger F-2 yang aktif sejak IB-1 mengubah penolakan referensi `IB-` menjadi galat 500 generik (pesan SQL mentah disaring `toUserErrorMessage`). Changelog C-02 semula menaruh guard ini di IB-3.
- Ditambahkan pada trigger C0019: `inter_branch_transactions_initial_state` (transaksi baru wajib `WAITING_APPROVAL`/`NOT_REVERSED`) dan syarat referensi jurnal IB harus berawalan `IB-` (GLOB, peka huruf).
- Tidak dikerjakan (sesuai Plan: IB-2/IB-3, dan perintah untuk tidak memulai IB-2/3/4): otorisasi/route, `assertCanDecide`, posting atomik, lifecycle dengan aksi, audit event IB, pesan ramah K-3 pada `setMultiBranchEnabled`, guard 404 flag, antrean tulis (F-1), perubahan `branch-service.ts`.

## Realisasi IB-2 … IB-6 (2026-10-08)
Rincian di `INTER-BRANCH-IMPLEMENTATION-REPORT.md`. Selisih terhadap dokumen ini:
- Pesan ramah K-3 (`MULTI_BRANCH_HAS_PENDING_INTER_BRANCH`, 409) ada di `setMultiBranchEnabled` (IB-2), bersama penandaan kedaluwarsa malas; guard 404 flag OFF di semua rute IB.
- F-1: antrean tulis per `company.db` (`company-write-queue.ts`) diimplementasikan di IB-3 dan `SQLITE_BUSY` dipetakan 503; kunci idempotensi + klaim bersyarat status mencegah posting ganda saat diulang.
- Residu `INSERT OR REPLACE` ditutup dengan `PRAGMA recursive_triggers = ON` pada koneksi aplikasi (`createCompanyDb`).
- Titik tambahan di luar Spek §17: `GET /inter-branch/options`, `GET|PUT /inter-branch/settings`.
- F-9: menu bersyarat via `requires: "inter-branch"` pada `nav-config.ts`.
- Pratinjau penutupan cabang: pengajuan menunggu menjadi peringatan dan dibatalkan otomatis (bukan blocker keras).
