# IB-1 PREFLIGHT REPORT

**Tanggal:** 2026-10-08 · **Workspace:** `D:\ABDI\Proyek Aplikasi\Codex\TERRA-FINANCE-CLEAN` (Clean Development Baseline) · **Jenis:** audit kesiapan saja.
**Yang dilakukan:** membaca Spek + Plan, membaca source (read-only), satu percobaan konkurensi kecil di folder scratch **di luar repo** (`scratchpad/p3-pre/`).
**Yang TIDAK dilakukan:** tidak ada kode, migration, tabel, schema, route, service, middleware, permission, UI, tes, atau database yang diubah; `multi_branch_enabled` tidak disentuh; `TERRA-Finance-Offline` tidak disentuh; tidak ada source dari folder WIP.

---

> **PEMBARUAN 2026-10-08 (Final Preflight Verification).** Keputusan OWNER atas K-1, K-2, K-3 dan F-1…F-9 sudah **APPROVED**; verifikasi akhir (read-only) dicatat di bagian **Final Gate Decisions** … **Final Implementation Gate** di akhir dokumen. Keputusan akhir: **READY FOR IMPLEMENTATION**. Koreksi terhadap Spek/Plan dicatat di [IB-1-SPEC-CHANGELOG.md](IB-1-SPEC-CHANGELOG.md). Bagian A–N di bawah adalah laporan awal dan dibiarkan apa adanya sebagai catatan historis; bila ada perbedaan, bagian Final di akhir yang berlaku.

## A. Overall Decision

# **READY FOR IMPLEMENTATION** — untuk cakupan **IB-1** (C0019 + model domain + `verifyInterBranchIntegrity`)

Tidak ada *architecture gap* yang memblokir IB-1. Fondasi yang dijanjikan Spek **benar-benar ada di source** (kolom jurnal IB, kebijakan akun + `counterpart_branch_id`, `canActOnBranch`, permission `interbranch.*`, audit `branch_id`, transaksi bersarang yang atomik, upgrade bercadangan).

Namun audit menemukan **9 temuan yang menyimpang dari Spek/Plan** (bagian C, bagian L). Tiga di antaranya mengubah isi `C0019` atau fase berikutnya dan **butuh keputusan Anda sebelum coding**; satu (konkurensi) terbukti secara empiris dan **wajib** ditangani di IB-3. Tidak satu pun saya perbaiki — hanya dilaporkan.

| # | Temuan | Dampak | Fase terdampak |
|---|---|---|---|
| F-1 | **Konkurensi:** dua transaksi tulis dari dua koneksi pada satu `company.db` dalam satu proses → pemenang tertahan **±5,8 dtk**, yang kalah mendapat **`SQLITE_BUSY`** (bukan 409). Terbukti (E.2). Spek §2/§14 menyebut "satu koneksi, penulis tunggal" — **tidak benar untuk jalur HTTP**. | Tidak ada jurnal ganda (aman), tetapi UX dan kode error salah. | IB-3, IB-5, IB-7 |
| F-2 | **Cadangan awalan `IB-` bertabrakan dengan jurnal IB sendiri** bila ditaruh di `assertReferenceNoAvailable` seperti tertulis di Spek §12 — fungsi yang sama dipanggil oleh posting IB. | Perlu parameter pengecualian. | IB-3 |
| F-3 | **Tidak ada guard "flag OFF → 404" di route mana pun.** Rute Phase 3 mengembalikan 200 dengan `multiBranchEnabled:false`; `MultiBranchDisabledError` dipetakan **403**. Selain itu OWNER dapat mematikan flag **kapan saja walau cabang & transaksi IB sudah ada** (tidak ada guard). Klaim Spek §23 "flag OFF ⇒ hanya satu cabang" hanya benar untuk perusahaan yang belum pernah menyalakannya. | Guard 404 harus dibuat; perlu keputusan perilaku saat flag dimatikan. | IB-2, IB-4 |
| F-4 | `createDraftJournalEntry` **tidak punya** parameter tautan IB; `reverseJournalEntry` tidak menulis `inter_branch_*` dan memaksa `origin='manual'`; `assertBranchAcceptsOrigin` menolak `inter_branch`. (Sudah diantisipasi Spek.) **Dua tes existing** menegaskan perilaku lama dan harus diganti secara sadar. | Perubahan baseline terkecil + 2 tes. | IB-3, IB-5 |
| F-5 | **Imutabilitas jurnal POSTED hanya di level aplikasi** — tidak ada trigger pada `journal_entries`/`journal_entry_lines` yang melarang UPDATE/DELETE baris POSTED. Trigger penjaga induk di Spek §11 hanya `BEFORE INSERT`: tautan IB masih bisa **ditempelkan lewat UPDATE**. | Spek "jurnal asli tidak berubah" hanya dijaga kode. | IB-1 (isi C0019) |
| F-6 | Keunikan akun antar-cabang per (cabang lawan, tipe) hanya **cek aplikasi** (`planOne`); `setAccountBranchPolicy` dapat membuat duplikat. | Resolver harus menolak ambigu (sudah di Spek); opsional indeks unik. | IB-1 (isi C0019) |
| F-7 | `cash_flow_activity`/`is_cash` pada akun antar-cabang **dapat diubah setelah dibuat** (`updateAccount`); "akun antar-cabang tidak masuk cash_flow_activity" tidak ditegakkan. | Perlu cek di resolver saat posting. | IB-1/IB-3 |
| F-8 | Spek §17 menulis body approve `selfApprovalReason?` — **bertentangan** dengan §8.1 (alasan tidak diwajibkan untuk OWNER). | Koreksi dokumen. | IB-2 |
| F-9 | Navigasi workspace **statis** (`WORKSPACE_NAV`), tidak ada item bersyarat flag/permission. | Perlu mekanisme kecil di UI. | IB-6 |

---

## B. Existing integration points

| Area | Existing implementation (bukti) | Reusable? | Gap |
|---|---|---|---|
| Buat jurnal | `createDraftJournalEntry(db, input, actor)` — `db/company/journal-service.ts:279`; validasi periode, tanggal, referensi, akun, cabang×origin, kebijakan akun, audit — semua dalam `db.transaction` | **Ya** | Tidak menerima `inter_branch_transaction_id/leg/side` (F-4) |
| Posting jurnal | `postJournalEntry` `:386` — membaca ulang akun, cabang, kebijakan, periode, keseimbangan di dalam transaksi | **Ya** | — |
| Reversal | `reverseJournalEntry` `:473` — tanggal & periode = jurnal asli; tolak jurnal bertaut IB (`:490`) | **Sebagian** | Tak menulis `inter_branch_*`, `origin` dipaksa `manual`, pengecualian internal belum ada (F-4) |
| Transaksi atomik | `db.transaction` bersarang = savepoint; **sudah dipakai produksi**: `journal-import-service.ts:335-347`, `opening-balance-import-service.ts:214`; **tes atomik**: `journal-branch.test.ts` "atomik … satu transaksi luar" | **Ya, tanpa helper baru** | Konkurensi lintas koneksi (F-1) |
| Kebijakan akun | `account-branch-policy.ts`: `INTER_BRANCH` **sudah mengizinkan origin `inter_branch`** dan menolak cabang = lawan | **Ya** | Resolver akun otomatis belum ada (memang tugas IB-1) |
| Akun antar-cabang | `createInterBranchAccountPair` (`account-policy-service.ts`), kolom `branch_policy`/`counterpart_branch_id` + trigger dua arah (C0016) | **Ya** | F-6, F-7 |
| Akses perusahaan | `requireCompanyAccess` — membaca System DB tiap request, tanpa cache (`middleware/company-access-guard.ts`) | **Ya** | — |
| Akses cabang | `resolveBranchAuthority`, `requireAccessibleBranch` (404 seragam), `resolveWriteBranch` (`middleware/branch-authority.ts`) | **Ya** | — |
| Permission | `canActOnBranch`, `hasBasePermission` (`db/system/authorization.ts:183`, `:~170`); `interbranch.read/create/approve/reverse` ada, *overridable*, *prepared* (`rbac.ts`) | **Ya** | Belum terpasang ke endpoint (memang tugas fase) |
| Peran OWNER | `request.companyAccess.role` dari System DB; DENY pada OWNER ditolak DB (S0014 trigger); `OWNER_SCOPE_FIXED` 409 (`company-branches/routes.ts:447`) | **Ya** | Sumber `OWNER_SCOPE_FIXED` hanya di route, bukan DB |
| Audit | `appendCompanyAudit(trx, …)` + `branch_id` (C0018); append-only trigger (C0012) | **Ya** | — |
| Periode | `loadPeriodOrThrow`, `assertPeriodIsWritable` (`fiscal-period.ts`); `resolvePeriodForDate(db, date)` sudah diekspor (`journal-import-service.ts:93`) | **Ya** | — |
| Backdate | `assertEntryDatePolicy`, `getMaxBackdateDays`, `todayLocalDate`, `subtractDays` (`journal-policy.ts`) | **Ya** (untuk `expires_at`) | — |
| Feature flag | `isMultiBranchEnabled` (`branch-service.ts:162`) | Sebagian | Tidak ada guard 404; flag dapat dimatikan bebas (F-3) |
| Pola migrasi | `C0001…C0018`; ALTER mentah + `PRAGMA table_info` idempoten; `company-upgrade.ts` otomatis saat startup (cadangan `.pre-upgrade` + `.pre-C0019`, integrity sebelum/sesudah, restore otomatis) | **Ya** | Tidak ada tes yang mengunci jumlah migrasi (dicari: tidak ada) |
| Pola route | `app.<method>(path,{preHandler:[requireAuth, requireCompanyAccess, requirePermission(p)]}, handler)`; `openCompanyDbForSlug` per request + `db.destroy()`; registrasi di `server.ts:204-227` | **Ya** | — |
| Pola service | modul fungsi + kelas `Error` ber-`code`; tanpa repository/DI | **Ya** | — |
| ID & referensi | `crypto.randomUUID()`; referensi diberikan pemanggil, `reference_no` UNIQUE global; prefiks lain: `IMP-`, `SALDO-AWAL-` | **Ya** | Generator `IB-` dibuat di service IB; F-2 |
| Identitas aktor | `system_users.id` = `authUser.id` (`identity-bridge.ts`), `request.companyAccess.systemUserId` | **Ya** | Tentukan satu konvensi (G) |
| Tes arsitektur | `architecture/scope-readiness.test.ts` fail-closed: route baru **harus** masuk `BRANCH_AWARE_ROUTES` atau registry; berkas baru yang menyebut `journal_entries` **harus** diklasifikasi | **Ya** | Menambah entri = mengedit berkas tes existing (disadari) |
| UI | React + react-query; `WORKSPACE_NAV`/`nav-config.ts`, `App.tsx` `WORKSPACE_REAL_MODULES`, `active-branch-selector.tsx` (polling 60 dtk), `routes/workspace/journal/*` | **Ya** | F-9 |

---

## C. Specification vs Source

Legenda: **VS** = VERIFIED IN SOURCE · **VT** = VERIFIED IN TEST · **PV** = PARTIALLY VERIFIED · **NV** = NOT VERIFIED.

### Business
| Keputusan | Bukti | Status |
|---|---|---|
| MVP hanya `TRANSFER_KAS` & `PEMBEBANAN` | Keputusan produk (belum ada kode; `type` divalidasi aplikasi) | **NV** (belum ada kode untuk diverifikasi; konsisten dengan skema C0015) |
| Create = submit, tanpa DRAFT tersimpan | Rancangan; tidak ada konflik dengan skema | **NV** (rancangan murni) |
| WAITING_APPROVAL tidak membuat jurnal | Jurnal hanya dibuat oleh `createDraftJournalEntry`; tidak ada pemicu otomatis | **VS** |
| Approve/receive/post satu aksi atomik | Transaksi bersarang atomik dipakai produksi (`journal-import-service.ts:335`) | **VS + VT** (`journal-branch.test.ts` "atomik … satu transaksi luar": 0 jurnal & 0 audit setelah gagal) |
| OWNER boleh self-approve; non-OWNER maker≠approver | Peran ada di `request.companyAccess.role` dari System DB tiap request; belum ada kode keputusan | **PV** (sumber peran **VS**; aturan itu sendiri belum ada kode) |
| Delegasi tidak memperluas hak IB | `hasBasePermission` tidak membaca delegasi; `ACTIVE_DELEGATION_CAPABILITIES`; tes `authorization.test.ts:123-155`, `routes.test.ts:726` | **VS + VT** |
| Hak = permission ∩ akses cabang | `canActOnBranch` (`authorization.ts:183`) | **VS + VT** (`authorization.test.ts`) |

### Accounting
| Keputusan | Bukti | Status |
|---|---|---|
| Dua jurnal berpasangan FROM & TO | Kolom + `UNIQUE (transaksi, leg, side)` + trigger semua-atau-kosong (C0015); tes `journal-branch.test.ts:156-166` | **VS + VT** (slot); pembentukan pasangan = **NV** (belum ada) |
| Posting deterministik, pengguna tak pilih D/K | Rancangan; `createDraftJournalEntry` menerima baris eksplisit dari pemanggil | **NV** |
| Akun lawan dari `counterpart_branch_id`, tanpa hardcode, tanpa clearing global | Kolom & trigger C0016; `planOne` mencari `branch_policy='INTER_BRANCH' AND counterpart_branch_id=?` | **VS** (data tersedia); resolver **NV** |
| Akun antar-cabang tak masuk `cash_flow_activity` | Default `null` saat dibuat (`account-service.ts:282`); **dapat diubah** (`:353`) | **PV** → F-7 |
| Reversal = dua jurnal baru; asli tidak diubah isinya | `reverseJournalEntry` hanya menandai asli `REVERSED/is_reversed`; **tidak ada trigger** yang menjaga isi POSTED | **PV** → F-5 |
| Pengecualian internal reversal bertaut IB | Saat ini ditolak tanpa pengecualian (`:490`) | **VS** (celah diketahui) |

### Security
| Keputusan | Bukti | Status |
|---|---|---|
| Server sumber kebenaran; company/branch access berlaku | `requireCompanyAccess`, `resolveBranchAuthority` | **VS + VT** |
| Flag OFF → 404 | **Tidak ada guard** di route mana pun; `MultiBranchDisabledError` → 403 (`branch-authority.ts:313`) | **NV / BERTENTANGAN** → F-3 |
| Final posting membaca ulang periode, tanggal, akun, cabang, kedaluwarsa | Periode/tanggal/akun/cabang/kebijakan: dibaca ulang di dalam `createDraft`+`post` | **VS** (periode, tanggal, akun, cabang, kebijakan); kedaluwarsa = **NV** (milik service IB) |
| Tidak ada posting parsial | Atomik terbukti (di atas) | **VS + VT** |
| Audit lengkap | `appendCompanyAudit` dalam transaksi yang sama | **VS + VT** |
| Satu penang pada konkurensi, kalah dapat 409 | Percobaan E.2: pemenang tunggal **benar**, tetapi kalah = `SQLITE_BUSY` setelah ±5,7 dtk | **PV / BERTENTANGAN** → F-1 |
| Peran tak dipercaya dari klien | `request.companyAccess.role` hanya dari System DB | **VS** |

### Reference & Reversal
| Keputusan | Bukti | Status |
|---|---|---|
| Prefiks `IB-` dicadangkan | `assertReferenceNoAvailable` hanya cek duplikat (`:112`); belum ada cadangan | **NV** → F-2 |
| Reversal tunduk periode terbuka | `reverseJournalEntry` memanggil `assertPeriodIsWritable` pada periode jurnal asli | **VS** |
| Reversal menghasilkan accounting event baru | Reversal = jurnal baru berstatus POSTED | **VS** |
| Status asli menjadi REVERSED | `:560` | **VS** |

---

## D. Database readiness

| Pertanyaan | Hasil |
|---|---|
| Jurnal punya kolom IB? | **Ya**: `inter_branch_transaction_id/leg/side`, `origin` ∈ {…,`inter_branch`,`head_office_effect`}, indeks UNIQUE parsial slot, trigger semua-atau-kosong — C0015. **Tanpa FK** (induk belum ada) |
| Kebijakan akun mendukung cabang lawan? | **Ya** — C0016, tervalidasi dua arah oleh trigger; `INTER_BRANCH` dibolehkan untuk origin `inter_branch` |
| Audit mendukung konteks cabang? | **Ya** — `company_audit_log.branch_id` (C0018) |
| Atomisitas company.db? | **Ya** — satu file, SQLite transaksional; savepoint terbukti |
| Tabel IB sudah ada? | **Belum** — tidak ada tabel/kolom `inter_branch_transactions`, `inter_branch_approvals`, `inter_branch_expiry_days` (diverifikasi pada kode dan pada salinan DB UAT di P-1: "tabel IB = 0") |

**Apakah C0019 masih benar-benar diperlukan? YA.** Status `WAITING_APPROVAL` harus bertahan lintas permintaan **tanpa** efek akuntansi, jadi tidak dapat disimpan di jurnal (jurnal baru ada saat disetujui) maupun di `company_audit_log` (append-only, bukan sumber status). Satu-satunya tempat yang atomik dengan jurnal adalah `company.db`. Tidak ada alternatif tanpa tabel.

---

## E. Atomic posting readiness

**E.1 Bisa dilakukan dengan helper yang ada? YA.**
`db.transaction(async trx => { createDraft(trx,FROM); createDraft(trx,TO); post(trx,…); post(trx,…); update IB; appendCompanyAudit(trx,…) })`. Setiap fungsi jurnal membuka `trx.transaction` (savepoint) dan menulis audit di transaksi yang sama. Sudah terpakai produksi (import jurnal, import saldo awal) dan teruji (rollback penuh: 0 jurnal, 0 audit). **Tidak perlu helper transaksi baru.** Syarat: prosedur **tidak boleh menangkap** error dari fungsi jurnal (sudah di Spek §12).

**E.2 Temuan konkurensi (F-1) — percobaan di scratch, bukan di repo.**
Dua koneksi knex `better-sqlite3` ke satu file (meniru dua request HTTP; `routes` memang memanggil `openCompanyDbForSlug` per request lalu `destroy()`), keduanya menjalankan klaim `UPDATE … WHERE status='WAITING'` lalu menulis jurnal:

| Skenario | Hasil |
|---|---|
| Tanpa penguncian | A selesai **5795 ms**; B gagal **`SQLITE_BUSY` setelah 5726 ms**; tepat 1 jurnal, status benar |
| Dengan antrean tulis per-perusahaan di dalam proses (mutex async) | A 67 ms, B 60 ms; B mendapati 0 baris terklaim (kalah bersih); tepat 1 jurnal |

Penyebab: `better-sqlite3` sinkron — koneksi kedua menunggu kunci dengan memblokir event loop yang sama, sehingga koneksi pertama tak bisa commit sampai batas waktu 5 dtk. Ini sifat platform yang **sudah ada** (bukan akibat IB), tetapi IB-3 menjadikannya terlihat (mis. dua penyetuju). Komentar di `journal-service.ts:638` ("tidak ada writer kedua") benar hanya per koneksi.
**Rekomendasi:** satu antrean tulis per `companySlug` (fungsi ±15 baris) yang membungkus seluruh aksi tulis IB, **plus** memetakan `SQLITE_BUSY` → 409/503 sebagai jaring pengaman. Ini helper baru yang **terbukti perlu** (kriteria Anda "jangan buat helper sebelum terbukti").

---

## F. Authorization readiness

Semua bahan ada; tidak ada permission baru.

| Aturan | Dukungan source | Status |
|---|---|---|
| Company access tiap request, tanpa cache | `requireCompanyAccess` | VS+VT |
| Branch access | `allowedBranchIds` dibaca tiap request; `canActOnBranch` | VS+VT |
| Permission efektif (role ∪ GRANT) − DENY | `hasBasePermission` | VS+VT |
| OWNER tak dapat di-DENY | trigger S0014 + `OWNER_PROTECTED` (`authorization.test.ts:182`) | VS+VT |
| OWNER selalu scope ALL | `OWNER_SCOPE_FIXED` 409 **di route** (`company-branches/routes.ts:447`) — bukan DB | VS (PV: tak dijaga DB). Tetap aman: `canActOnBranch` berlaku bila suatu saat OWNER ber-LIMITED |
| Peran hanya dari System DB | `request.companyAccess.role` | VS |
| Delegasi tidak menambah hak | `authorization.test.ts:123,154`, `routes.test.ts:726` | VT |
| `interbranch.*` untuk OWNER/ADMIN/ACCOUNTANT/STAFF sesuai Spek | `rbac.ts:38-57` (STAFF: read+create; ACCOUNTANT: +approve+reverse; VIEWER: tidak ada) | VS |
| OWNER self-approve; non-OWNER 403 `SELF_APPROVAL_NOT_ALLOWED` | **Belum ada kode** — satu fungsi `assertCanDecide` baru, membaca `request.companyAccess.role` | NV (rancangan sehat; titik integrasi jelas) |

Kesimpulan: aturan OWNER/non-OWNER dapat diimplementasikan **tanpa mengubah** `authorization.ts`, `rbac.ts`, atau `company-access-guard.ts`, sesuai Spek §23.
Konvensi identitas: `system_users.id` **sama** dengan `authUser.id` (`identity-bridge.ts`), sehingga `proposed_by` (System ID) dan `journal_entries.created_by/posted_by` (saat ini `authUser.id`) bernilai identik — pembanding maker≠approver aman.

---

## G. Account/branch readiness

```
cabang pemberi (FROM) → cabang lawan (TO) → akun INTER_BRANCH dengan counterpart_branch_id = TO
```
- **Data & integritas tersedia:** `accounts.branch_policy='INTER_BRANCH'`, `counterpart_branch_id`, trigger pasangan, kebijakan menolak cabang = lawan dan menolak manual/import.
- **Dua pola akun:** satu akun "counterpart = B" dipakai **semua cabang selain B** (COA satu per perusahaan); pemisahan per-cabang diperoleh dari `journal_entries.branch_id`. Cocok dengan Spek §5.
- **Wizard hanya membuat satu tipe per panggilan** (ASSET atau LIABILITY). Perusahaan yang hanya membuat ASSET tetap bisa diposting (fallback netto di Spek §5); bila tidak ada akun sama sekali → tolak dengan arahan.
- **Gap:** (1) resolver belum ada (IB-1); (2) keunikan per (lawan, tipe) hanya cek aplikasi (F-6) → resolver wajib menolak ambigu (sudah di Spek); (3) `cash_flow_activity`/`is_cash` pada akun antar-cabang dapat diubah (F-7) → resolver menolak akun antar-cabang yang `is_cash` atau berklasifikasi arus kas.
- Tanpa hardcode nomor akun, tanpa clearing global, pengguna tak memilih D/K: **terpenuhi oleh rancangan**; tidak ada yang menghalangi di source.

---

## H. Test readiness

Pola yang dapat dipakai langsung:

| Kebutuhan | Pola existing |
|---|---|
| Tes service dengan DB nyata | `__fixtures__/branch-test-helpers.ts` (`freshCompanyDb`, `seedBasics`, `addBranch`, `nextRef`, `testActor`) — dipakai `journal-branch.test.ts` |
| Tes HTTP penuh (peran × akses × override × delegasi) | `modules/company-branches/routes.test.ts` (Fastify `inject`, banyak user/perusahaan, `grant`, `delegate`) |
| Atomik/rollback | `journal-branch.test.ts` "atomik …" |
| Migrasi atas salinan UAT | `branch-migration.test.ts` + `company-upgrade*.test.ts` |
| Fail-closed route/berkas | `architecture/scope-readiness.test.ts` |
| Golden Master / E2E | harness `docs/uat/harness/phase5/`, e2e P-1 |

| Kategori | Dapat dibuat? |
|---|---|
| Otorisasi (OWNER self ok; non-OWNER 403; cabang/perusahaan tak berhak; delegasi tak memberi) | Ya — pola HTTP ada |
| Transaksi (submit/approve/reject/cancel/expire) | Ya |
| Akuntansi (2 jurnal, D/K, tanpa parsial, rollback, `IB-`, akun lawan) | Ya — pola service ada |
| Periode (terkunci, backdate, kedaluwarsa, reversal) | Ya |
| Keamanan (flag OFF 404, IDOR, lintas perusahaan/cabang, duplikat, replay) | Ya, **kecuali** guard flag 404 yang belum ada (F-3) |
| **Konkurensi (setujui/reversal bersamaan)** | Ya, **tetapi harus memakai dua koneksi nyata ke satu file** (pola `inject` per request sudah demikian) dan lolos hanya setelah penanganan F-1. Tes harus menegaskan hasil bersih (satu pemenang + 409), bukan `SQLITE_BUSY` |
| Regresi 827 tes | **2 tes existing akan menjadi usang dan perlu diganti secara sadar (bukan dilemahkan):** `branch-service.test.ts:220` dan `journal-branch.test.ts:103-104` ("inter_branch belum didukung"). Registry `scope-readiness.test.ts` perlu entri baru (route IB, berkas service IB). Tidak ada tes yang mengunci jumlah migrasi |

Catatan: `journal-branch.test.ts:156-166` menempelkan `IBT-1` lewat **UPDATE** tanpa induk. Trigger penjaga yang hanya `BEFORE INSERT` (Spek) tidak memecahkannya; trigger yang juga menjaga UPDATE (usulan F-5) **akan** memecahkannya dan tes itu harus ditulis ulang (lebih ketat, bukan lebih lemah).

---

## I. UI readiness

| Elemen | Titik integrasi yang direkomendasikan |
|---|---|
| Menu **Antar Cabang** | Item baru di grup `AKUNTANSI` pada `routes/workspace/nav-config.ts` (satu sumber untuk sidebar & `App.tsx`); daftarkan modul di `WORKSPACE_REAL_MODULES` (`App.tsx`). **Butuh** mekanisme tampil-bersyarat (flag ON + `interbranch.read`) — F-9. Data flag sudah tersedia dari query `branch-context` (`multiBranchEnabled`) yang dipolling `active-branch-selector.tsx` |
| Daftar (Masuk/Keluar/Semua) + filter | Halaman baru `routes/workspace/inter-branch/`, pola tab seperti `routes/workspace/journal/` (`journal-list-tab.tsx`) |
| Submit (Transaksi Baru) | Panel/form seperti `journal-form-panel.tsx` |
| Approve/Tolak/Batal/Reversal | Dialog modal seperti `journal-detail-modal.tsx` / `journal-reversal-tab.tsx` |
| Status ganda (bisnis vs jurnal) | Lencana seperti `journal-status-badge.tsx` (dua indikator) |
| Riwayat audit | Tab pada detail; data dari `company-audit-log` (**NV**: filter `entityType` belum dicek — verifikasi di IB-2) |
| Lencana jumlah masuk | `GET /inter-branch/summary` + `refetchInterval: 60_000` (pola `active-branch-selector.tsx`) |
| Query & cabang aktif | `lib/company-api-client.ts` sudah mengirim `X-Branch-Context`; **kunci query harus memuat cabang aktif** |
| Catatan | Cabang aktif tersimpan di `localStorage` (satu nilai per perusahaan, dibagi antar-tab). Aman karena server memvalidasi tiap request dan persetujuan dinilai terhadap cabang **transaksi**, tetapi dua tab dapat memiliki pilihan berbeda → perhatikan di UAT |

---

## J. Required implementation files (kemungkinan; **tidak diubah sekarang**)

| Fase | Baru | Diubah (berkas baseline) |
|---|---|---|
| **IB-1** | `db/company/migrations/C0019_inter_branch.ts`; `db/company/inter-branch-service.ts` (tipe, tabel transisi murni, `expires_at`, `resolveInterBranchAccounts`, `verifyInterBranchIntegrity`) atau dipisah domain/verify; tes: migrasi, domain, integritas | `architecture/scope-readiness.test.ts` (klasifikasi berkas baru yang menyebut tabel jurnal) |
| **IB-2** | `modules/company-inter-branch/routes.ts` (+tes); guard flag-404 (middleware kecil) | `server.ts` (registrasi); `middleware/branch-authority.ts` (`BRANCH_AWARE_ROUTES`); `scope-readiness.test.ts`; `company-profile-service.ts` (pengaturan kedaluwarsa) |
| **IB-3** | antrean tulis per-perusahaan (F-1); `executeInterBranchPosting`, `assertCanDecide` | `journal-service.ts` (parameter tautan IB; pengecualian internal; cadangan `IB-` dengan pengecualian — F-2); `branch-service.ts` (origin `inter_branch` ACTIVE↔ACTIVE); tes: `branch-service.test.ts:220`, `journal-branch.test.ts:103-104` |
| **IB-4** | — | `period-closing-service.ts` (`validatePeriodForClosing`); `branch-service.ts` (blocker penutupan + pembatalan otomatis saat INACTIVE/CLOSED; `setMultiBranchEnabled` — keputusan F-3) |
| **IB-5** | — | `journal-service.ts` (`reverseJournalEntry` untuk leg REVERSAL) |
| **IB-6** | `routes/workspace/inter-branch/*`, `features/workspace/use-inter-branch.ts`, `inter-branch-types.ts` | `nav-config.ts`, `App.tsx`, `workspace-shell.tsx` (lencana) |
| Semua | — | `docs/baseline/PHASE-3-AUTHORIZATION-BASELINE.md` §8 (pencatatan; berkas historis — **perlu persetujuan** sebelum diubah, karena Anda menetapkannya immutable; alternatif: berkas catatan perubahan baru) |

---

## K. Migration proposal (konseptual; **tidak ada migration dibuat**)

`C0019_inter_branch` — satu migration company.db, idempoten, tanpa backfill, `down` tersedia.

1. **`inter_branch_transactions`**: id, `transaction_no` (UNIQUE), `type`, `transaction_date`, `from_branch_id`/`to_branch_id` (FK RESTRICT, CHECK ≠), `amount` (>0), deskripsi/referensi, akun sisi pemberi, akun usulan sisi penerima, counterparty opsional, `status` (5 nilai), `reversal_state` (3 nilai; CHECK hanya sah bila `COMPLETED`), `proposed_by`, `idempotency_key` (UNIQUE bersama `proposed_by`), timestamp. Tanpa `company_id`, tanpa kolom accounting-event (diturunkan dari jurnal).
2. **`inter_branch_approvals`**: id, transaksi (FK), `kind` (POST/REVERSE), `status`, pemohon/waktu/alasan, `expires_at`, pemutus/waktu/alasan, `self_approved` (informasional), `confirmed_account_id`; UNIQUE parsial satu `WAITING` per transaksi.
3. **`company_profile.inter_branch_expiry_days`** (default 14, CHECK 1–90).
4. **Trigger:** transaksi tak dapat di-DELETE; kolom bisnis tak dapat diubah; transisi status/reversal hanya yang sah; approvals tak dapat di-DELETE/diubah setelah final; penjaga induk pada `journal_entries`.

**Tiga hal yang mengubah isi C0019 dan butuh keputusan Anda (sebelum IB-1 dikodekan):**

| ID | Pertanyaan | Rekomendasi |
|---|---|---|
| K-1 (F-5) | Penjaga induk pada `journal_entries`: hanya `BEFORE INSERT` (sesuai Spek) atau juga `BEFORE UPDATE OF inter_branch_*`, plus larangan UPDATE/DELETE baris `journal_entry_lines` milik jurnal bertaut IB? | **Ya, ketat**: tautan IB tak dapat ditempel/diubah lewat UPDATE dan baris jurnal bertaut tak dapat diubah/dihapus. Konsekuensi: tulis ulang `journal-branch.test.ts:156-166` agar membuat induk dulu. Menutup celah "imutabilitas hanya di aplikasi" khusus jurnal IB tanpa menyentuh jalur jurnal biasa |
| K-2 (F-6) | Tambah indeks UNIQUE parsial `accounts(counterpart_branch_id, account_type_id) WHERE branch_policy='INTER_BRANCH'`? | **Ya**, bila pemeriksaan data produksi/UAT menunjukkan 0 duplikat (salinan UAT: tidak ada akun INTER_BRANCH). Murah dan menutup ambiguitas pada akarnya. Bila ditolak, resolver tetap menolak ambigu |
| K-3 (F-3) | Perilaku saat OWNER mematikan flag padahal ada transaksi IB `WAITING_APPROVAL`/cabang >1? | **Tolak mematikan flag selama ada pengajuan IB `WAITING_APPROVAL`** (guard di `setMultiBranchEnabled`, IB-4); jurnal IB yang sudah `COMPLETED` tidak terpengaruh. Tidak mengubah C0019 |

---

## L. Risks

| # | Risiko | Mitigasi |
|---|---|---|
| R-A | **Konkurensi antar-koneksi** (F-1) — pemblokiran ±5 dtk + `SQLITE_BUSY` | Antrean tulis per-perusahaan + peta error; tes dua-koneksi di IB-3/IB-7 |
| R-B | Perubahan di berkas baseline sensitif (`journal-service.ts`, `branch-service.ts`) — regresi pada jurnal manual/import/saldo awal | Perubahan terkecil; golden master + 827 tes; uji mutasi; pengecualian eksplisit hanya untuk origin `inter_branch` |
| R-C | Dua tes existing berubah (F-4) dan tiga file tes arsitektur/registry bertambah entri | Setiap perubahan dijelaskan di laporan fase; tes pengganti lebih ketat |
| R-D | Flag dapat dimatikan walau ada data IB (F-3) | Keputusan K-3 |
| R-E | Imutabilitas jurnal hanya aplikasi (F-5) | Keputusan K-1 + `verifyInterBranchIntegrity` |
| R-F | Akun antar-cabang diubah klasifikasinya setelah dibuat (F-7) / duplikat (F-6) | Cek resolver + K-2 |
| R-G | Cadangan `IB-` dapat memblokir pengguna yang sudah memakai referensi `IB-…` pada jurnal lama | Periksa data UAT/klien untuk `reference_no LIKE 'IB-%'` sebelum IB-3 (belum dicek pada data nyata) |
| R-H | Penomoran `IB-YYYY-NNNNNN` (MAX+1) rentan ganda lintas koneksi | Sudah diredam antrean tulis (R-A) + UNIQUE sebagai jaring |
| R-I | Kedaluwarsa memakai jam lokal komputer | Diterima (Spek R-9) |
| R-J | Dokumentasi menyesatkan (F-1 komentar, F-8 `selfApprovalReason`, §23 flag OFF) | Koreksi dokumen di fase terkait |

---

## M. Recommended implementation order

Urutan yang Anda minta (data model → domain → posting atomik → otorisasi → audit → API → tes → UI → E2E → regresi keamanan) **tetap benar**, dengan dua koreksi berdasarkan source:
1. **Tes ditulis bersama tiap langkah**, bukan sesudah API (semua fase Plan sudah begitu; mengurutkan "tes" sesudah API akan melanggar gerbang Plan).
2. **Otorisasi (guard flag-404, `BRANCH_AWARE_ROUTES`, registry arsitektur) mendahului posting** (IB-2 sebelum IB-3): tes arsitektur fail-closed memaksa route baru terklasifikasi sejak awal. **Antrean tulis (F-1) dibangun di awal IB-3**, sebelum `executeInterBranchPosting`.

| Langkah | Isi |
|---|---|
| 0 | (Keputusan) K-1, K-2, K-3 |
| IB-1 | C0019 + domain murni + `verifyInterBranchIntegrity` + tes migrasi/trigger/transisi/resolver akun (+ klasifikasi arsitektur). **Tanpa** mengubah perilaku apa pun (golden master & 827 tes identik) |
| IB-2 | Guard flag-404, otorisasi, ajukan/daftar/detail (tanpa jurnal), audit `CREATED/SUBMITTED` |
| IB-3 | Antrean tulis → perubahan minimal `journal-service`/`branch-service` → `executeInterBranchPosting` + `assertCanDecide` + audit + tes atomik/injeksi kegagalan/konkurensi dua koneksi |
| IB-4 | Tolak/batal/kedaluwarsa; blocker periode & siklus hidup cabang; K-3 |
| IB-5 | Reversal berpasangan |
| IB-6 | UI |
| IB-7/8 | Keamanan, mutasi, performa, UAT, installer |

---

## N. Final gate

# **IB-1 MAY START** — setelah Anda memutuskan K-1, K-2, K-3 (bagian K) dan menyetujui bahwa temuan F-1…F-9 dimasukkan ke Spek/Plan sebagai koreksi.

Alasan tidak ada yang memblokir IB-1:
- IB-1 hanya menambah tabel/kolom/trigger dan modul domain yang **tidak dipanggil oleh jalur mana pun**; tidak mengubah `journal-service.ts`, `branch-service.ts`, route, atau middleware.
- Semua fondasi yang dibutuhkan IB-1 (kolom jurnal, kebijakan akun, audit cabang, upgrade bercadangan) sudah terbukti ada.
- Temuan yang paling serius (F-1 konkurensi, F-2 awalan `IB-`, F-3 flag) berada di IB-2/IB-3/IB-4, dan sudah punya jalan keluar yang jelas.

Batas yang tetap berlaku: tidak ada kode/migration/tes yang dibuat oleh laporan ini; implementasi menunggu izin Anda.

---

# FINAL PREFLIGHT VERIFICATION (2026-10-08)

Dasar: keputusan OWNER K-1, K-2, K-3 = APPROVED; F-1…F-9 = APPROVED sebagai koreksi Spek/Plan. Seluruh pekerjaan di bawah **read-only terhadap repo**: tidak ada source, tes, migration, schema, database, flag, atau baseline yang diubah. Percobaan dilakukan di folder scratch sesi (`scratchpad/p4-ibref`, `p4-proto`, dan salinan staging `p1-stage` yang sudah dikembalikan bersih). Semua data yang dibaca adalah salinan atau dibuka `readonly`.

## Final Gate Decisions

| Keputusan OWNER | Status | Bagaimana diverifikasi | Hasil verifikasi |
|---|---|---|---|
| **K-1** Guard ketat tautan IB pada jurnal (INSERT **dan** UPDATE; tak melemahkan imutabilitas POSTED) | APPROVED | Prototipe trigger di DB scratch (40 skenario) + prototipe migration di salinan staging dijalankan terhadap seluruh suite | 40/40 skenario sesuai rancangan; suite penuh **826/827** — satu-satunya yang gagal adalah `journal-branch.test.ts:156` (tes yang *memang* menempelkan tautan lewat UPDATE tanpa induk — perilaku yang justru dilarang K-1) |
| **K-2** Partial UNIQUE INDEX akun INTER_BRANCH per (cabang lawan, tipe) | APPROVED | Prototipe indeks (4 skenario) + pemindaian 103 company.db | Tidak ada duplikat di data mana pun; akun non-INTER tak terganggu |
| **K-3** OWNER tak boleh mematikan multi-cabang selama ada transaksi IB `WAITING_APPROVAL` | APPROVED | Audit jalur penulis flag + prototipe trigger (3 skenario) | Satu-satunya jalur penulis = `setMultiBranchEnabled`; dapat ditegakkan di server (service + trigger DB) |
| **F-1** s.d. **F-9** | APPROVED | Bagian "F-1 to F-9 Corrections" | Semua terverifikasi; tak satu pun memblokir IB-1 |
| Historical Phase 3 baseline | **IMMUTABLE** | `PHASE-3-AUTHORIZATION-BASELINE.md` dan manifest tidak disentuh; koreksi dicatat di dokumen baru `IB-1-SPEC-CHANGELOG.md` | — |

**Penegasan interpretasi (mohon dikoreksi bila keliru):** K-3 menyebut `WAITING_APPROVAL`. Saya memperluasnya ke **`REVERSAL_WAITING`** juga (transaksi `COMPLETED` dengan permintaan reversal yang menunggu), karena tujuan K-3 — mencegah transaksi pending terdampar — berlaku sama. Perluasan ini ada di prototipe dan changelog sebagai usulan yang dapat dicabut.

## F-1 to F-9 Corrections

| # | Temuan (ringkas) | Verifikasi akhir | Aturan final (koreksi) | Tahap |
|---|---|---|---|---|
| **F-1** | Konkurensi SQLite antar-koneksi | Ditinjau ulang: percobaan A=5795 ms, B=`SQLITE_BUSY` 5726 ms; dengan antrean tulis A=67 ms, B=60 ms (kalah bersih). **Tidak ada jalur IB-1 yang menulis** transaksi/jurnal IB, sehingga tidak ada dependensi keras. | **Known limitation**, bukan blocker IB-1. Kandidat pekerjaan **IB-3**: antrean tulis per-`companySlug` + peta `SQLITE_BUSY`→409/503. Tidak diimplementasikan sekarang. Sifat platform ini sudah ada sebelum IB. | IB-3 (diuji lagi di IB-7) |
| **F-2** | Awalan `IB-` bertabrakan dengan jurnal IB sendiri | Lihat "IB- Prefix Collision Verification" dan rancangan di bawah | `assertReferenceNoAvailable` **tidak diubah**. Cadangan awalan dipasang sebagai guard terpisah yang mengenal `origin` (+ trigger penjaga di DB). | IB-1 (trigger), IB-3 (guard service) |
| **F-3** | Flag OFF | Lihat tabel siklus hidup flag di bawah | Guard 404 route (IB-2); K-3 diterapkan di service **dan** trigger DB | IB-1 (trigger), IB-2 (service+404) |
| **F-4** | Helper jurnal | Lihat rincian di bawah | Perubahan terkecil; dua tes diganti secara sadar | IB-3, IB-5 |
| **F-5** | Imutabilitas | Lihat rincian K-1 di bawah | Trigger INSERT + UPDATE + status + hapus + baris | IB-1 |
| **F-6** | Keunikan akun | K-2 terverifikasi | `uq_accounts_inter_branch_pair` | IB-1 |
| **F-7** | Klasifikasi arus kas | Lihat rincian di bawah | Akun INTER_BRANCH: `is_cash=0` dan `cash_flow_activity IS NULL` — dijaga trigger DB + pre-check service + resolver | IB-1 |
| **F-8** | `selfApprovalReason?` | Lihat rincian di bawah | Dihapus; OWNER tanpa alasan; non-OWNER 403 | Dokumen (changelog); IB-2 kode |
| **F-9** | Menu | Lihat rincian di bawah | Item nav bersyarat (UX saja) | IB-6 |

### F-2 — rancangan alokasi referensi (diverifikasi)
Fakta source: hanya **dua** titik `INSERT INTO journal_entries` di jalur company.db (`journal-service.ts:319` create, `:531` reversal); `modules/journal/posting.ts:101` adalah jalur master-DB lama. `origin` tidak pernah dibaca dari request (rute membentuk objek input secara eksplisit); tidak ada `INSERT OR REPLACE`/`onConflict`/`merge` pada jurnal. `reference_no` UNIQUE **peka huruf besar-kecil** (terbukti: `ib-…` lolos UNIQUE terhadap `IB-…`) dan skema `createJournalSchema` pada satu rute tidak men-`trim`.

Aturan final:
1. `isReservedInterBranchReference(ref) = ref.trim().toUpperCase().startsWith("IB-")` — fungsi murni.
2. `createDraftJournalEntry`: setelah `origin` ditentukan (di dalam transaksi), bila referensi terreservasi **dan** `origin !== 'inter_branch'` → tolak (kelas error baru, 409). `origin = 'inter_branch'` hanya sah bersama tautan IB; jalur HTTP tidak dapat menyetel `origin`.
3. `reverseJournalEntry`: sama untuk `reversalReferenceNo`; reversal internal IB (`origin='inter_branch'`) dikecualikan.
4. **Backstop DB** (di C0019): trigger `BEFORE INSERT ON journal_entries WHEN upper(trim(NEW.reference_no)) LIKE 'IB-%' AND NEW.origin <> 'inter_branch'` → ABORT. Teruji: `IB-…`, `ib-…`, `  Ib-…` ditolak; `IBX-1`, `IB2026`, `JU-1`, `NULL`, `IMP-…`, `SALDO-AWAL-…` diterima.
5. Jurnal IB: referensi deterministik `<transaction_no>-F` / `-T` / `-F-REV` / `-T-REV`; `transaction_no` UNIQUE; pengalokasi nomor memeriksa pula bahwa `<no>-F|-T|-F-REV|-T-REV` belum ada di `journal_entries` (jaring bila ada referensi lama berawalan `IB-` di mesin klien); `journal_entries.reference_no` UNIQUE tetap menjadi pengaman terakhir.
6. Trigger penjaga induk (K-1) juga mewajibkan jurnal `origin='inter_branch'` bertaut (dan sebaliknya).
Hasil: journal IB tidak ditolak oleh `assertReferenceNoAvailable` (tidak diubah, hanya mencek duplikat); jurnal biasa tak dapat memakai `IB-` (3 lapis); tak ada celah duplikat (UNIQUE + reservasi + alokasi deterministik).

### F-3 — siklus hidup flag OFF dan penerapan K-3 di server
Jalur penulis flag: **hanya** `setMultiBranchEnabled` (`branch-service.ts:167`), dipanggil satu route `PUT …/multi-branch` (OWNER). `updateCompanyProfile` tidak dapat menyentuh kolom ini. Jadi satu titik di service + satu trigger DB menutup semuanya.

| Keadaan transaksi | Boleh mematikan flag? | Keterangan |
|---|---|---|
| `WAITING_APPROVAL` | **TIDAK** (409 `MULTI_BRANCH_HAS_PENDING_INTER_BRANCH`) | K-3. Jalan keluar: setujui / tolak / batalkan (OWNER dapat membatalkan) |
| `WAITING_APPROVAL` yang sudah lewat `expires_at` tetapi belum ditandai | **Ya, setelah ditandai** | Kedaluwarsa dievaluasi malas (tanpa cron). Service menandai `EXPIRED` lebih dulu **di dalam transaksi yang sama**, baru menghitung; trigger DB hanya melihat status tersimpan |
| `COMPLETED` + `NOT_REVERSED` | Ya | Terminal; jurnal tetap ada dan terbaca di buku besar |
| `COMPLETED` + `REVERSAL_WAITING` | **TIDAK** (perluasan K-3, lihat penegasan) | Menunggu keputusan lawan |
| `COMPLETED` + `REVERSED` | Ya | Terminal |
| `REJECTED` / `CANCELLED` / `EXPIRED` | Ya | Terminal |
Saat flag OFF: rute IB → 404 (guard IB-2); data tetap; menyalakan kembali memulihkan akses. `createBranch` sudah menolak saat OFF (source), jadi tidak ada cabang baru; cabang yang sudah ada tetap.
Penerapan server-side: (a) service `setMultiBranchEnabled` memeriksa **di dalam `db.transaction`** (menandai kedaluwarsa → menghitung → melempar error domain); (b) trigger `company_profile_ib_flag_off` (teruji G1–G3) menolak walau service dilewati. **Urutan:** trigger masuk di C0019 (IB-1); karena belum ada kode yang dapat membuat `WAITING_APPROVAL` sebelum IB-2, pesan ramah service **wajib masuk IB-2** (bukan IB-4 seperti Plan lama) agar tidak pernah ada jendela di mana trigger menolak dengan galat mentah.

### F-4 — perubahan helper jurnal (diverifikasi, tidak diubah)
| Titik | Keadaan sekarang | Perubahan minimal yang diperlukan | Fase |
|---|---|---|---|
| `createDraftJournalEntry` (`journal-service.ts:279`) | Tak punya input tautan IB; `origin` bebas diberikan pemanggil internal | Tambah input opsional `interBranch: {transactionId, leg, side}`; bila ada → `origin='inter_branch'` (server) dan tiga kolom diisi; bila `origin==='inter_branch'` tanpa tautan → tolak; guard referensi (F-2) | IB-3 |
| `reverseJournalEntry` (`:473`) | Menolak jurnal bertaut (`:490`); `reversalOrigin` hanya `manual`/`system` | Opsi **internal** (tak dapat dibentuk dari HTTP: rute membangun input secara eksplisit): lewati penolakan, `origin='inter_branch'`, `leg='REVERSAL'`, `side` dari jurnal asli | IB-5 |
| `assertBranchAcceptsOrigin` (`branch-service.ts:462`) | `SUPPORTED_JOURNAL_ORIGINS` tak memuat `inter_branch`. Aturan "cabang non-ACTIVE menolak semua origin selain `system`" **sudah ada** | Cukup menambah `'inter_branch'` ke daftar origin yang didukung (ACTIVE↔ACTIVE sudah dihasilkan oleh aturan yang ada; `head_office_effect` tetap tidak didukung). Komentar `:460` diperbarui | IB-3 |
| `postJournalEntry` | Membaca ulang akun/cabang/kebijakan/periode; kebijakan `INTER_BRANCH` **sudah** mengizinkan origin `inter_branch` | **Tidak berubah** | — |
| Tes existing | `branch-service.test.ts:220` (`assertBranchAcceptsOrigin(...,"inter_branch")` → "belum didukung"); `journal-branch.test.ts:103-104` (`draft({origin:"inter_branch"})` → "belum didukung") | Diganti, bukan dilemahkan: `inter_branch` diterima untuk cabang ACTIVE dan ditolak untuk INACTIVE/CLOSED; `origin:'inter_branch'` tanpa tautan ditolak; `head_office_effect` **tetap** "belum didukung" | IB-3 |
| Tes existing (K-1) | `journal-branch.test.ts:156-166` menempelkan `IBT-1` lewat UPDATE tanpa induk | Ditulis ulang: membuat induk + jurnal bertaut lewat jalur sah; UPDATE tautan **harus ditolak**. Terukur: satu-satunya kegagalan dari 827 | **IB-1** |

### F-5 — imutabilitas (K-1): cara kerja guard (teruji 40 skenario di DB scratch)
Trigger yang diusulkan untuk C0019 (semuanya pada jurnal **bertaut IB**; jurnal biasa tak tersentuh — terbukti A1: buat→posting→reversal jurnal biasa tetap lolos):
- **INSERT** `journal_entries`: bila ada tautan *atau* `origin='inter_branch'` → induk harus ada; `origin` harus `inter_branch`; `origin='inter_branch'` wajib bertaut; `branch_id` harus = `from_branch_id` (sisi FROM) / `to_branch_id` (sisi TO); induk harus `COMPLETED` untuk leg ORIGINAL, dan `COMPLETED`+`REVERSED` untuk leg REVERSAL (konsisten dengan urutan "klaim dulu" Spek §12). Slot ganda tetap ditolak UNIQUE (C0015).
- **UPDATE** `inter_branch_transaction_id/leg/side/origin`: ditolak bila nilainya berubah (menempel, memindah, mengosongkan, atau mengubah `origin`); *no-op* (nilai sama) diterima agar kode ORM tak rusak.
- **UPDATE** kolom inti jurnal bertaut POSTED/REVERSED (`entry_date`, `period_id`, `reference_no`, `branch_id`): ditolak. Transisi status hanya `POSTED→REVERSED` (yang dipakai `reverseJournalEntry`); `POSTED→DRAFT` dan `REVERSED→POSTED` ditolak.
- **DELETE** header jurnal bertaut: ditolak. **UPDATE/DELETE** baris `journal_entry_lines` milik jurnal bertaut POSTED/REVERSED: ditolak. **INSERT** baris ke jurnal ORIGINAL yang sudah tidak DRAFT: ditolak (leg REVERSAL dikecualikan karena `reverseJournalEntry` membuat header POSTED lebih dulu baru barisnya — urutan itu tidak diubah).
Jalur SQL yang masih mungkin (jujur): `INSERT OR REPLACE` mentah pada `journal_entries` **diterima** (terbukti F1: sisi jurnal bertaut berpindah FROM→TO), karena `recursive_triggers=0` sehingga penghapusan implisit tidak memicu trigger. Ini **bukan jalur aplikasi** (tidak ada `OR REPLACE`/`onConflict`/`merge` di source) dan memerlukan akses SQL langsung ke file `company.db`; dampaknya terdeteksi oleh `verifyInterBranchIntegrity` (jumlah/leg/sisi tak lengkap). Dicatat sebagai risiko residu R-K; tidak ditutup karena butuh perubahan pengaturan koneksi di luar IB.
Catatan cakupan: imutabilitas jurnal POSTED **non-IB** tetap hanya di level aplikasi seperti sekarang; menyempitkan K-1 ke jurnal bertaut IB adalah sesuai keputusan "jangan mengubah perilaku jurnal biasa".

### F-6 — indeks unik (K-2)
`CREATE UNIQUE INDEX uq_accounts_inter_branch_pair ON accounts(counterpart_branch_id, account_type_id) WHERE branch_policy = 'INTER_BRANCH'` — sintaks SQLite valid (versi runtime 3.49.2). Kunci "tipe/purpose" = `account_type_id` (ASSET/LIABILITY); **tidak ada kolom purpose** di skema dan wizard (`planOne`) memakai persis kunci yang sama. Teruji: duplikat (lawan,tipe) ditolak; lawan sama beda tipe diterima; lawan beda tipe sama diterima; akun non-INTER (kolom `counterpart_branch_id` NULL) bebas. **Konflik data:** 0 duplikat pada 64 company.db yang sudah punya kolom `branch_policy` (6 akun INTER_BRANCH, semuanya hasil uji E2E); 39 DB lain belum punya C0016 sehingga mustahil memuat akun INTER_BRANCH. Akun nonaktif tetap menempati slot (sama dengan `planOne`). **Konsekuensi kode:** pelanggaran UNIQUE saat `setAccountBranchPolicy` / wizard harus dipetakan ke 409 (`AccountPolicyChangeBlockedError`), bukan 500.

### F-7 — klasifikasi arus kas akun INTER_BRANCH
Keadaan sekarang (source): akun dibuat dengan `is_cash=false`, `cash_flow_activity=null` (`account-service.ts:282-283`) tetapi `updateAccount` (`:353-354`) dapat mengubahnya kapan saja — satu-satunya jalur perubahan (impor akun hanya `createAccount`). `setAccountBranchPolicy` sudah melarang perubahan identitas antar-cabang bila akun punya baris jurnal.
**Aturan bisnis final:** akun `INTER_BRANCH` **tidak pernah** akun kas dan **tidak pernah** berklasifikasi arus kas; efeknya pada Arus Kas per cabang selalu `unclassified` (D-9). Ditegakkan tiga lapis: (1) trigger DB (`accounts_ib_cash_ins/upd`; teruji H1–H5: INSERT/UPDATE `is_cash`, `cash_flow_activity`, serta menjadikan akun kas biasa sebagai INTER_BRANCH ditolak; akun biasa tak terganggu H6); (2) pre-check ramah di `updateAccount` dan `setAccountBranchPolicy` (kelas error baru → 409) agar tidak muncul sebagai 500; (3) resolver akun IB menolak akun yang melanggar saat posting. Setelah akun INTER_BRANCH dibuat, aturan tak dapat diubah: mengubah flag ditolak trigger, dan mengubah kebijakan menjauh dari INTER_BRANCH ditolak bila akun sudah dipakai. Tidak ada data existing yang melanggar (0 dari 6).

### F-8 — dokumentasi `selfApprovalReason?`
Inventaris kontradiksi: Spek §17 baris 336 (`body: confirmedAccountId, selfApprovalReason?`) — **dihapus oleh changelog**; dokumen lama `MULTI-BRANCH-AUDIT-AND-DESIGN.md` (baris 881, 939, 1111, 1206: "alasan wajib", `INTER_BRANCH_SELF_APPROVED`, `_APPROVAL_WAIVED`) — sudah dinyatakan digantikan oleh Spek §8.1 dan kini dipertegas di changelog (dokumen historis tidak diedit). Aturan final yang konsisten: **OWNER** menyetujui transaksinya sendiri **tanpa alasan** (audit tetap lengkap: `makerEqualsApprover`, `actorRole`, `self_approved` informasional); **non-OWNER** tidak boleh (403 `SELF_APPROVAL_NOT_ALLOWED`); body approve hanya `confirmedAccountId`; alasan tetap wajib untuk **tolak** dan **reversal** bagi siapa pun. Spek asli tidak diedit; changelog memiliki **aturan pengutamaan** atas butir yang tercantum.

### F-9 — mekanisme menu minimal
Data yang sudah tersedia di klien tanpa perubahan server: `useBranches()` → `multiBranchEnabled`; `useMyAuthorization()` → `permissions` efektif + `scope` (`GET …/authorization/me`, `listBasePermissions`); `branch-context` → daftar cabang yang dapat diakses. Mekanisme minimal (IB-6): properti opsional `visibleWhen` pada `WorkspaceNavLeaf` di `nav-config.ts` (mis. `{ multiBranch: true, permission: "interbranch.read", minAccessibleBranches: 1 }`) dan penyaringan **hanya pada render sidebar** `workspace-shell.tsx`; pembuatan `<Route>` tetap dari daftar penuh. Menu hanya UX: URL langsung tetap dapat dibuka dan **server menolak** (flag OFF → 404; tanpa permission → 403; tanpa akses cabang → 404; akun LIMITED hanya bila route ada di `BRANCH_AWARE_ROUTES`). Halaman wajib menangani 403/404 secara anggun.

## IB- Prefix Collision Verification

**Cakupan pemindaian (read-only; salinan atau `readonly`):** 202 berkas `.sqlite`/`.db` yang tersedia — seluruh data uji scratch (UAT 5 tahun, dataset golden, salinan E2E, backup/restored), data klien di `%APPDATA%\TERRA FINANCE.lama` (company `pt-migas-wardhana`, 3.813 jurnal; 10 backup master; sistem), data aplikasi aktif `%APPDATA%\TERRA Finance\terra-data` (berkas 4 KB, kosong), `terra-finance.sqlite` di `apps/api/data` repo asli. 103 di antaranya company-DB (punya `accounts` dan `journal_entries`). Kolom yang diperiksa: semua kolom bernama mirip referensi/nomor/kode/dokumen di semua tabel, dengan pola `IB-%` dan `IB%-%` (tak peka huruf besar-kecil).

| Hasil | Nilai |
|---|---|
| **Referensi jurnal berawalan `IB-`** | **0** di seluruh 202 berkas |
| Jurnal ber-`origin` `inter_branch`/`head_office_effect` | 0 |
| Jurnal bertaut IB (`inter_branch_transaction_id`) | 0 |
| Tabel `inter_branch_*` | 0 |
| Literal `"IB-"` pada source (`apps/`) | 0 |
| Pembangkit referensi existing | `IMP-<base36>-<6 hex>` (import), `SALDO-AWAL-<base36>` (saldo awal); lainnya diketik pengguna |
| Awalan referensi data klien nyata | hanya `JU` (3.813 jurnal) |
| Awalan terbanyak data UAT | `CRASH`, `BIG`, `MTR`, `PST`, `BDL`, `KTB`, `TBS`, `DRAFT`, `UJ`, `U2`, `U3`, `IMP` |
| Kecocokan non-jurnal | 6 **kode akun** `IBP-BL`, `IBP-METRO` (dua per DB, pada 3 salinan E2E: `mbverify`, `p1-e2e`, `p2-e2e`) — akun INTER_BRANCH yang dibuat tes E2E lewat wizard; **bukan referensi jurnal** dan tidak terkait pola `IB-` (kode akun `IBA-/IBP-` ≠ awalan `IB-` pada `reference_no`) |

**Penilaian tabrakan:** pada data yang tersedia **tidak ada tabrakan** dan tidak ada jurnal yang terkait konsep Inter-Branch. Reservasi awalan `IB-` karenanya **tidak** memutus data apa pun yang dapat diperiksa. Keterbatasan jujur: data di komputer klien lain tidak terlihat dari sini. Karena itu desain sengaja (1) tidak mengubah baris lama (trigger hanya memeriksa INSERT baru), dan (2) pengalokasi nomor IB memeriksa ketersediaan `<no>-F|-T|-F-REV|-T-REV` sehingga bila suatu mesin klien kebetulan memiliki referensi lama berawalan `IB-`, yang terjadi adalah nomor dilewati — bukan kegagalan posting. Rekomendasi tambahan (informasional, tidak memblokir): `up` C0019 dapat mencatat ke log jumlah referensi lama berawalan `IB-` pada company itu.

## Final Dependency Assessment

**Dependensi keras IB-1 — semua terverifikasi ada:**
| Dependensi | Bukti |
|---|---|
| Rantai migrasi company C0001–C0018, penemuan otomatis berkas baru (`knexfile`: `directory`+`extension`) | `db/company/knexfile.ts`; build memuat migrasi (196 JS identik dengan installer di P-1) |
| Tabel/kolom induk: `branches`, `accounts` (`branch_policy`, `counterpart_branch_id`, `is_cash`, `cash_flow_activity`, `account_type_id`), `journal_entries` (kolom IB C0015), `company_profile.multi_branch_enabled` (C0017), `counterparties` (C0005), `company_audit_log.branch_id` (C0018) | migrasi C0003–C0018 |
| Upgrade bercadangan otomatis saat startup + `integrity_check`/`foreign_key_check` sebelum-sesudah + restore otomatis (`.pre-upgrade`, `.pre-C0019`) | `company-upgrade.ts` |
| Helper tes: `freshCompanyDb` menjalankan `migrate.latest` (C0019 otomatis ikut), `seedBasics`, `addBranch` | `__fixtures__/branch-test-helpers.ts` |
| SQLite 3.49.2 mendukung partial index, trigger `RAISE`, `IS NOT` | terbukti di prototipe |

**Bukan dependensi IB-1 (tidak boleh/ tidak perlu dikerjakan di IB-1):** antrean tulis (F-1); perubahan `journal-service.ts`, `branch-service.ts`; route; middleware; UI; permission; mekanisme delegasi.

**Dampak terukur terhadap 827 tes** (prototipe migration di salinan staging; **bukan** di repo): **826 lulus, 1 gagal** — `journal-branch.test.ts:156` (diantisipasi K-1). Tes arsitektur, migrasi, upgrade/restore, otorisasi, jurnal biasa semuanya tetap hijau. Prototipe dihapus dari staging setelah pengukuran; repo `TERRA-FINANCE-CLEAN` tidak memuat C0019.

**Koreksi urutan yang ditemukan:**
1. Pre-check ramah pada `updateAccount` dan `setAccountBranchPolicy`/wizard (F-6, F-7) harus ikut **IB-1** — kalau tidak, trigger yang aktif sejak IB-1 mengubah perilaku yang sudah ada (mengubah `is_cash` pada akun antar-cabang) menjadi galat 500.
2. Pesan ramah K-3 pada `setMultiBranchEnabled` ikut **IB-2** (sebelum `WAITING_APPROVAL` dapat tercipta), bukan IB-4.
3. Penandaan kedaluwarsa malas di dalam transaksi pematian flag (F-3) mensyaratkan fungsi "tandai kedaluwarsa" di domain IB; disiapkan sebagai fungsi murni di IB-1, dipakai di IB-2.

**Risiko residu baru:** R-K (`INSERT OR REPLACE` mentah melewati trigger; terdeteksi oleh verifikasi, bukan dicegah); R-L (lebih banyak galat domain baru yang harus dipetakan ke 4xx di route).

## Final Implementation Gate

# **READY FOR IMPLEMENTATION** (cakupan IB-1)

Tidak ada temuan yang memblokir. IB-1 hanya menambah skema, trigger, indeks, modul domain murni/read-only, dan pre-check akun; tidak menyentuh jurnal biasa, route, middleware, atau UI. Semua prasyarat terbukti di source dan di prototipe, kecuali yang memang dibangun IB-1 sendiri.

**Peta berkas IB-1 (rencana; belum diubah):**
| Jenis | Berkas | Isi |
|---|---|---|
| **Baru** | `apps/api/src/db/company/migrations/C0019_inter_branch.ts` | 2 tabel, kolom `inter_branch_expiry_days`, semua trigger K-1/K-3/F-2/F-7, indeks K-2, `down` |
| **Baru** | `apps/api/src/db/company/inter-branch-domain.ts` | tipe, tabel transisi murni, `calculateExpiresAt`, `isInterBranchExpired`, `isReservedInterBranchReference` |
| **Baru** | `apps/api/src/db/company/inter-branch-accounts.ts` | `resolveInterBranchAccounts` (ambigu/hilang/terkunci/kas ditolak) |
| **Baru** | `apps/api/src/db/company/inter-branch-integrity.ts` | `verifyInterBranchIntegrity` (read-only) |
| **Baru (tes)** | `inter-branch-migration.test.ts`, `inter-branch-triggers.test.ts`, `inter-branch-domain.test.ts`, `inter-branch-accounts.test.ts`, `inter-branch-integrity.test.ts` | migrasi atas salinan UAT + restore; trigger K-1/K-3/F-2/F-7; indeks K-2; domain; resolver; verifikasi |
| **Diubah (baseline)** | `db/company/account-service.ts` | pre-check `updateAccount` (F-7) + kelas error |
| **Diubah (baseline)** | `db/company/account-policy-service.ts` | pre-check F-7, pemetaan UNIQUE K-2 |
| **Diubah (baseline)** | `modules/company-accounts/routes.ts`, `modules/company-branches/routes.ts` | pemetaan kelas error baru → 4xx |
| **Diubah (tes existing)** | `db/company/journal-branch.test.ts` (tes `:156-166`) | ditulis ulang agar membuat induk dan memeriksa UPDATE ditolak (K-1) |
| **Diubah (tes arsitektur)** | `architecture/scope-readiness.test.ts` | klasifikasi berkas baru yang menyebut `journal_entries` (`inter-branch-integrity.ts`) |
| **Tidak diubah di IB-1** | `journal-service.ts`, `branch-service.ts`, `period-closing-service.ts`, `server.ts`, `middleware/*`, `rbac.ts`, `authorization.ts`, semua UI | — |
| **Catatan perubahan** | `docs/architecture/IB-1-SPEC-CHANGELOG.md` (dokumen ini ditambah, historical baseline tidak disentuh) | — |

**Syarat gerbang keluar IB-1 (usulan):** migrasi teruji pada salinan UAT 5 tahun (jumlah jurnal/baris/akun identik, `integrity_check` ok, `foreign_key_check` 0, restore dari `.pre-C0019` teruji); suite penuh hijau dengan **satu** tes diganti (`journal-branch.test.ts:156`) dan tidak ada tes dilemahkan; golden master Phase 5.0 identik (flag OFF); `multi_branch_enabled` tak berubah.

**Batas:** tidak ada kode, migration, tes, source, atau flag yang diubah oleh pembaruan ini. IB-1 menunggu izin implementasi.

---
### Lampiran — bukti percobaan (di luar repo)
Pembaruan final: `scratchpad/p4-ibref/scan.cjs`, `scan2.cjs`, `q.cjs` (pemindaian referensi `IB-`, duplikat akun, akun kas), `scratchpad/p4-proto/proto.mjs` (40 skenario trigger/indeks), `ref.cjs` (reservasi referensi), dan prototipe migration sementara di salinan staging untuk menjalankan 827 tes (sudah dihapus). Semuanya di luar repo.
`scratchpad/p3-pre/conc.cjs` (tanpa antrean) dan `conc2.cjs` (dengan antrean). Hasil mentah: `A ok 5795ms`, `B ERR SQLITE_BUSY … 5726ms`; dengan antrean `A ok 67ms`, `B ok 60ms`, satu baris jurnal.
