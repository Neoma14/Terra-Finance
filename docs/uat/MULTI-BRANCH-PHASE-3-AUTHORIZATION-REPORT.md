# MULTI-BRANCH PHASE 3 — AUTHORIZATION & DELEGATION — LAPORAN (REVISI 2: KOREKSI DESAIN REVISI 5)

Tanggal: 2026-10-07 · Cakupan: **Phase 3 saja** + koreksi yang diminta pada review: (1) delegasi kembali ke model Revisi 5, (2) `delegation.manage` kembali OWNER saja, (3) Active Branch Selector, (4) status permission Phase 5/6 = *prepared*, (5) regression test khusus. Phase 4/5/6 **tidak** dikerjakan. **`multi_branch_enabled` tetap OFF** untuk semua perusahaan; seluruh pengujian memakai salinan data UAT (bukan produksi, bukan port 4000).

---

## 1. Executive Summary

Koreksi dari review selesai dan terbukti. Model authorization: **peran tetap satu per user**; permission operasional dapat ditambah/dibatasi per user (override); **delegasi mengikuti Revisi 5 — 4 kapabilitas tetap + `max_role` + cabang + masa berlaku**, hanya OWNER yang membuatnya; ADMIN **tidak** otomatis memegang `delegation.manage`; admin yang dibatasi per cabang **tidak punya kewenangan administratif tanpa delegasi aktif**. UI kini punya **pemilih cabang aktif** yang tunduk pada server.

| Area | Hasil |
|---|---|
| Tes backend | **814 / 814 lulus** = 726 lama (tidak ada yang dilemahkan) + **88 baru** |
| Uji mutasi (17 pelonggaran batas disengaja) | **17 / 17 terdeteksi** |
| E2E Phase 3 pada data UAT 5 tahun | **82 / 82** di server hasil build **dan** 82 / 82 di runtime Electron dari installer |
| Regresi Phase 1–2 (runtime Electron) | migrasi **84 / 84**, keamanan **37 / 37** |
| UI di Chrome nyata (data UAT, hasil dicek ke database) | **29 / 29** |
| Integritas database | `integrity_check` ok, `foreign_key_check` 0 — System DB dan company.db |
| Data akuntansi | 12.003 jurnal, 30.976 baris, 66 akun — identik sebelum/sesudah |
| TypeScript API & Web, build web/API/Electron | **PASS** — installer `TERRA FINANCE Setup 0.1.0.exe` (124.293.518 byte, 20:01) |
| Temuan Critical / High terbuka | **0** |

---

## 2. Authorization Model

```
User ─► Role (satu per perusahaan; tidak ada role-per-cabang)
         │
         ├─► Permission efektif = (role ∪ GRANT) − DENY            [override: users.manage, daftar tertutup]
         ├─► Akses cabang       = scope ALL | LIMITED + user_branch_access
         ├─► Cabang aktif       = header X-Branch-Context, divalidasi tiap request
         └─► Delegasi (Revisi 5)= kapabilitas tetap × cabang × max_role × masa berlaku  [dibuat OWNER]
                                   hak efektif = delegasi ∩ akses cabang SAAT INI ∩ permission peran SAAT INI

Wewenang atas cabang X = canActOnBranch() = akses cabang X DAN permission efektif   (DENY menang)
```

- **Titik penegakan**: `requireCompanyAccess` membaca scope, cabang, override, dan delegasi dari System DB **pada tiap request, tanpa cache**.
- **Pintu aturan tunggal**: `assertOverrideBoundary`, `assertDelegationBoundary`, `assertBranchAccessBoundary`, `getManageUsersScope` (`db/system/authorization.ts`).
- **Delegasi tidak menambah permission.** Ia hanya memberi kewenangan administratif atas cabang; permission operasional tetap dari role + override. Ini yang menjaga model tetap sederhana saat Phase 5/6 memakai permission tersebut.

Permission operasional (daftar tertutup `OVERRIDABLE_PERMISSIONS`; status **prepared**, lihat bagian 12):

| Permission | OWNER | ADMIN | ACCOUNTANT | STAFF | VIEWER |
|---|---|---|---|---|---|
| `interbranch.read` / `create` | ✓ | ✓ | ✓ | ✓ | – |
| `interbranch.approve` / `reverse` | ✓ | ✓ | ✓ | – | – |
| `report.consolidated` | ✓ | ✓ | ✓ | – | – |
| **`delegation.manage`** | **✓** | **–** | – | – | – |

---

## 3. Branch Access

Tambah satu/beberapa akses, cabut, pindah (atomik) — `POST/DELETE /access/:userId/branches`, `…/transfer`. **Pencabutan seketika**: request berikutnya pada sesi yang sama → `403 BRANCH_CONTEXT_INVALID` / cabang `404`.

Kewenangan mengelola akses (koreksi):

| Aktor | Boleh |
|---|---|
| OWNER, ADMIN scope **ALL** (ADMIN lama) | Seperti sebelumnya (wewenang peran), tanpa delegasi |
| ADMIN **LIMITED tanpa delegasi** | **Tidak ada jalur sama sekali** → `403 DELEGATION_REQUIRED` (akses, override, daftar user, info cabang) |
| ADMIN LIMITED **dengan delegasi `manage_users`** | Hanya pada cabang = *delegasi ∩ akses cabangnya saat ini*; target harus user LIMITED berperan ≤ `max_role`; bukan diri sendiri, bukan OWNER, bukan user scope ALL; tidak dapat mengubah scope (OWNER saja) |
| Cabang di luar irisan (tidak didelegasikan, tidak diakses, Kantor Pusat, id palsu) | `404` seragam (payload identik dengan "tidak ada") |

---

## 4. Active Branch Context & Selector

**Server (tidak berubah, kini lebih banyak bukti):** header/URL/body/query palsu ditolak (`403 BRANCH_CONTEXT_INVALID` / `404`).

**UI — Active Branch Selector (baru)** di header workspace:
- Tampil **hanya** pada perusahaan multi-cabang (perusahaan biasa: tidak ada perubahan, diuji).
- Menampilkan *cabang aktif yang diputuskan server* (`GET /branch-context`), badge cakupan ("Akses semua cabang" / "Terbatas (N aktif)"), daftar cabang sah (cabang nonaktif/ditutup ditandai "hanya baca" dan tak dapat dipilih).
- Memilih cabang → `PUT /branch-context` (server memvalidasi & menyimpan preferensi, diaudit), pilihan diingat di klien **hanya sebagai kenyamanan**, dan `X-Branch-Context` dikirim pada setiap request company-scoped (termasuk upload/download).
- **Server tetap sumber kebenaran**: bila pilihan tersimpan palsu/kedaluwarsa, server menolak; klien membuang nilainya, request BACA diulang sekali tanpa header, request TULIS **tidak pernah** diulang diam-diam; selector menampilkan pemberitahuan.
- **Perubahan akses terlihat**: data diperbarui saat jendela kembali fokus dan tiap 60 detik; perubahan scope/cabang memunculkan pemberitahuan "Akses cabang Anda berubah". (Penegakan tetap seketika di server; pemberitahuan UI mengikuti polling/fokus.)
- Keterangan pada popover: jurnal & saldo awal mengikuti cabang aktif; laporan/dashboard/buku besar **masih mencakup seluruh perusahaan** sampai Phase 5.

Diuji di Chrome: tampil/tersembunyi, pilihan tersimpan di server, header terkirim, `localStorage` dipalsukan → ditolak server & pulih, perubahan akses saat sesi → pemberitahuan, user LIMITED hanya melihat cabangnya.

---

## 5. Permission Override

Tidak berubah dari revisi sebelumnya (sesuai Revisi 5 Z.3): `Effective = (role ∪ GRANT) − DENY`; hanya 5 permission operasional; permission administratif ditolak (aplikasi + CHECK DB); tanpa diri sendiri/OWNER; aktor harus memegang permission yang diberikan; VIEWER tetap baca saja. **Koreksi:** aktor LIMITED hanya lewat delegasi `manage_users` (target dalam cakupan efektif dan peran ≤ `max_role`).

---

## 6. Delegation (kembali ke Revisi 5)

Tabel `delegations` + `delegation_branches` dibuat ulang oleh migrasi **S0016** (model lama permission×cabang **diarsipkan** sebagai `*_p3_archive`, tidak dibuang; teruji dari keadaan S0015 berisi data).

| Elemen Revisi 5 | Implementasi |
|---|---|
| 4 kapabilitas tetap | `manage_users`, `manage_branch_info`, `view_branch_reports`, `inter_branch` (kolom `can_*`, minimal satu) |
| `max_role` | `VIEWER`/`STAFF`/`ACCOUNTANT`, **selalu di bawah peran penerima** (CHECK + trigger + aplikasi), tak pernah ADMIN/OWNER |
| Cabang cakupan | daftar eksplisit; **tidak ada "semua cabang"** (`scopeAll` ditolak `SCOPE_ALL_NOT_ALLOWED`) |
| Pemberi | hanya pemegang `delegation.manage` = **OWNER**; cabang harus subset cakupan pemberi |
| Penerima | ADMIN atau ACCOUNTANT (trigger DB); bukan OWNER, bukan diri sendiri |
| Kedalaman 1 | penerima delegasi tidak membuat delegasi (`DELEGATION_DEPTH_EXCEEDED`; di HTTP sudah tertahan guard) |
| Satu aktif per penerima | indeks unik parsial; ganti = cabut lalu buat baru |
| Hak efektif = irisan | delegasi ∩ akses cabang saat ini ∩ permission peran saat ini → **menyusut otomatis** |
| Masa berlaku | masa depan, ≤ 366 hari, dievaluasi saat request |
| Pencabutan | OWNER, pemberi, atau penerima sendiri; pihak lain `404` |

Kapabilitas dan statusnya:

| Kapabilitas | Status | Efek nyata Phase 3 |
|---|---|---|
| `manage_users` | **aktif** | kelola akses cabang + override user di cabang cakupan (butuh `user_branch.manage` pada peran penerima) |
| `manage_branch_info` | **aktif** | `PATCH /branches/:id` nama/alamat/telepon pada cabang cakupan (bukan urutan/status; butuh `branch.manage` pada peran) |
| `view_branch_reports` | *prepared* | tersimpan, divalidasi, diaudit; efek saat Phase 5 |
| `inter_branch` | *prepared* | tersimpan, divalidasi, diaudit; efek saat Phase 6 |

Kapabilitas yang tak berlaku bagi peran penerima ditolak saat pembuatan (`CAPABILITY_NOT_APPLICABLE`, mis. ACCOUNTANT + `manage_users`) dan tak berefek bila peran kemudian turun (irisan).

---

## 7. Revocation

| Objek | Berlaku pada | Bukti |
|---|---|---|
| Akses cabang | request berikutnya, sesi sama | tes + e2e + UI |
| Override | request berikutnya | tes + e2e |
| **Delegasi** | request berikutnya: `DELEGATION_REQUIRED` | tes, matriks B, e2e, UI (delegasi dicabut saat halaman terbuka → aksi berikutnya ditolak server) |
| Akses cabang penerima berkurang / peran turun / penerima nonaktif / pemberi tak lagi OWNER / kedaluwarsa | request berikutnya (delegasi menyusut) | tes unit + HTTP + e2e |
| Akses perusahaan pemberi/penerima dicabut | delegasi ikut hilang (CASCADE), pencabutan tidak gagal | tes unit + HTTP |

Tidak ada cache izin. Rata-rata `/authorization/me` ≈ 30 ms (60 panggilan, data UAT 5 tahun).

---

## 8. Owner Rules

OWNER tetap penuh namun **bukan bypass**: tetap divalidasi perusahaan, target, cabang (id palsu/cabang perusahaan lain → `BRANCH_OUT_OF_SCOPE`), bukan diri sendiri, bukan override permission administratif, tidak mendelegasikan ke OWNER. `DENY` pada OWNER ditolak aplikasi dan trigger DB. OWNER secara struktural selalu scope ALL.

## 9. Admin Rules

- **ADMIN ALL** (semua ADMIN lama): perilaku tidak berubah; **tidak** memegang `delegation.manage` (tidak dapat membuat delegasi — `403`).
- **ADMIN LIMITED**: tanpa delegasi tidak ada kewenangan administratif; dengan delegasi, hanya dalam batas bagian 3/6. Tidak dapat membuat delegasi, tidak dapat mengelola peran (route `/access` tetap `BRANCH_SCOPE_UNSUPPORTED`), tidak dapat memberi scope ALL, tidak dapat menyentuh OWNER/ALL.
- Contoh instruksi §10: admin Metro+Bandar dengan `interbranch.approve` bertindak di Metro/Bandar; **Kotabumi ditolak** (`canActOnBranch`).

## 10. Audit Trail

Tidak berubah: `user_branch.access_*`, `permission_override.*`, `delegation.created/revoked/expired`, `security.authorization_boundary_denied` (dibatasi 1 entri/30 dtk per aktor+kode+operasi). Isi delegasi kini memuat `capabilities`, `maxRole`, `branchIds`, `expiresAt`, pemberi, alasan. Transaksi yang sama dengan perubahan (audit gagal ⇒ batal; teruji). Tanpa password/token/secret.

## 11. UI

Halaman **Pengguna**: kolom Akses Cabang & Wewenang Khusus; **Atur Wewenang** (centang cabang — untuk admin LIMITED hanya cabang efektif delegasinya; override *Ikuti peran / Izinkan / Batasi*; delegasi diterima); **Delegasikan Wewenang** (OWNER): penerima ADMIN/ACCOUNTANT, 4 kapabilitas (2 bertanda "disiapkan"), peran maksimum, cabang eksplisit tanpa opsi "Semua cabang", masa berlaku, alasan; kartu **Delegasi Wewenang** dengan Cabut. Plus **selector cabang aktif** (bagian 4). UI bukan lapisan keamanan — terbukti: aksi setelah delegasi dicabut tetap ditolak server. Bukti: `evidence-multibranch/ui-phase3/*.png`, `phase3-ui-result.json`.

---

## 12. Status permission Phase 5/6 — *prepared*, bukan implemented

`interbranch.read/create/approve/reverse` dan `report.consolidated` sudah: didefinisikan, punya default per peran, dapat di-override, diaudit, dan dievaluasi (`canActOnBranch`, `/authorization/me.preparedPermissions`). **Belum** dipasang pada endpoint/service bisnis mana pun. Konstanta `PREPARED_PERMISSIONS` dan checklist di `docs/RELEASE-HARDENING-BACKLOG.md` (gerbang aktivasi) mewajibkan setiap permission dipasang pada endpoint/service yang relevan dan diuji sampai database/UI saat Phase 5/6 dimulai. Kapabilitas delegasi `view_branch_reports` dan `inter_branch` berstatus sama.

---

## 13. Security & Regression Tests

**Baru (88):** `authorization.test.ts` (25: rbac, evaluasi murni, cakupan, batas override/akses/delegasi, trigger & CHECK, S0016 + arsip, penyusutan, cascade) dan `company-authorization/routes.test.ts` (63 HTTP).

| Kebutuhan review | Bukti |
|---|---|
| Model delegation Revisi 5 | unit + HTTP: 4 kapabilitas, `max_role` (di bawah penerima, bukan ADMIN/OWNER), cabang eksplisit, kapabilitas tak valid (`users.manage` = permission bukan kapabilitas), satu aktif per penerima, arsip S0015→S0016 |
| `delegation.manage` | rbac: hanya OWNER; HTTP: ADMIN ALL/LIMITED, ACCOUNTANT, STAFF → `403` membuat delegasi; `/authorization/me` ADMIN tanpa permission itu |
| Tanpa privilege escalation (OWNER, ADMIN, ADMIN LIMITED, user biasa) | PATCH role → OWNER/ADMIN ditolak untuk ADMIN, ADMIN LIMITED berdelegasi, STAFF; ADMIN LIMITED tak dapat membuat delegasi/memberi scope ALL/menyentuh OWNER; delegasi tak mengubah peran; DENY pada OWNER ditolak |
| Revocation berlaku request berikutnya | akses cabang, override, delegasi (sesi sama) — HTTP, e2e, UI; penyusutan otomatis |
| Delegasi tidak memperluas scope pemberi | delegasi Metro+Bandar tetapi akses penerima hanya Metro → Bandar `404`; akses dikurangi → efektif menyusut; pemberi LIMITED hipotetis hanya subset (unit); `scopeAll` ditolak; cabang perusahaan lain ditolak |
| Lintas perusahaan | akses/override/delegasi ke user B ditolak; cabang A pada delegasi B ditolak; izin A tak terbawa ke B; trigger DB |
| IDOR cabang | URL/header/body/query palsu (bagian 4) |

**Matriks A (18 skenario)** permission efektif × akses cabang (OWNER, ADMIN ALL/1/2/3/tanpa/dicabut/DENY, ACCOUNTANT, STAFF ALL/1/2/banyak/tanpa/GRANT dicabut/akses dicabut) dan **Matriks B (13 skenario)** kewenangan mengelola akses (OWNER, ADMIN ALL, ADMIN LIMITED tanpa delegasi / delegasi Metro / Metro+Bandar / akses lebih sempit / delegasi tak beririsan / kapabilitas prepared saja / dicabut / kedaluwarsa / akses Bandar dicabut, ACCOUNTANT, STAFF) — semua sesuai hasil yang diharapkan.

**Regresi:** 726 tes lama lulus tanpa perubahan asersi. Satu-satunya perubahan file tes lama (dari revisi sebelumnya): `company-branches/routes.test.ts` hanya mendaftarkan modul route baru ke matriks deny-by-default.

**Uji mutasi:** 17 pelonggaran sengaja (ADMIN mendapat `delegation.manage` lagi, DENY diabaikan, delegasi tak diiris dengan akses, kapabilitas tak diiris dengan permission peran, LIMITED melewati delegasi, `max_role` tak ditegakkan, target ALL, kedalaman, `scopeAll`, subset pemberi, validitas pemberi, `canActOnBranch` tanpa akses, kedaluwarsa, bypass cabang, diri sendiri, cakupan override, validasi kapabilitas) → **17/17 terdeteksi**.

## 14. Build Verification

| Langkah | Hasil |
|---|---|
| `tsc --noEmit` API / Web | PASS / PASS |
| Backend tests | 814/814 |
| Build web, API, Electron (`pnpm dist`) | PASS — installer 124.293.518 byte |
| Pemindaian isi paket | tanpa `.env`, database, kunci privat, `ADMIN_SECRET`, kredensial uji, file tes; S0014–S0016 dan route Phase 3 ada di paket |
| Server dari runtime Electron installer | migrasi 84/84, keamanan 37/37, Phase 3 82/82 |
| Migrasi S0015→S0016 pada DB berisi data | teruji (arsip utuh, rollback utuh, migrate ulang idempoten) |

## 15. Known Limitations

| # | Keterbatasan | Catatan |
|---|---|---|
| 1 | `interbranch.*`, `report.consolidated`, `view_branch_reports`, `inter_branch` = *prepared* | bagian 12; gerbang aktivasi di backlog |
| 2 | Uji UI di Chrome terhadap server hasil build, bukan jendela Electron | backlog H-3 (WAJIB sebelum rilis) |
| 3 | `pnpm lint` tidak berjalan (ESLint legacy) | backlog H-1 (WAJIB) |
| 4 | `.js.map` ikut paket API | backlog H-2 (WAJIB) |
| 5 | Delegasi tidak dapat di-*update*: cabut lalu buat baru; satu aktif per penerima | sederhana & aman; `DELEGATION_UPDATED` Revisi 5 belum |
| 6 | Opsi "cabut juga" (O.6) tidak ada | tidak relevan: delegasi tidak menciptakan baris akses turunan (`granted_via_delegation_id` tidak dipakai) |
| 7 | Pemberitahuan perubahan akses di UI mengikuti polling 60 dtk / fokus jendela | penegakan di server tetap seketika |
| 8 | Perubahan dari model sebelumnya: pada instalasi yang sempat memakai build Phase 3 sebelumnya, delegasi lama diarsipkan (tidak aktif) | multi-cabang belum aktif di klien manapun |
| 9 | Admin LIMITED berdelegasi melihat nama user LIMITED yang belum punya cabang (agar dapat menugaskannya) | hanya yang peran ≤ `max_role` |
| 10 | Pembatas audit pelanggaran di memori proses | hanya menekan pengulangan identik |
| 11 | Temuan lama tak disentuh: `user_branch_access.branch_id` tanpa FK (dua file DB), advisory `pnpm audit` | backlog H-4 |

## 16. Files Changed (revisi ini)

**Backend:** `db/system/rbac.ts` (ADMIN tanpa `delegation.manage`; konstanta delegasi Revisi 5; `PREPARED_PERMISSIONS`), `db/system/migrations/S0016_delegations_revisi5.ts` (baru), `db/system/authorization.ts` (ditulis ulang untuk delegasi Revisi 5), `modules/company-authorization/routes.ts` (ditulis ulang), `modules/company-branches/routes.ts` (gerbang delegasi, `PATCH` info cabang), `middleware/company-access-guard.ts`, `middleware/branch-authority.ts`, `types/fastify.d.ts`; tes: `db/system/authorization.test.ts`, `modules/company-authorization/routes.test.ts` (ditulis ulang).
**Web:** baru `lib/active-branch.ts`, `routes/workspace/active-branch-selector.tsx`; diubah `lib/company-api-client.ts`, `routes/workspace/workspace-shell.tsx`, `features/workspace/authorization-types.ts`, `use-authorization.ts`, `routes/workspace/users/{users-page,delegation-modal,user-authorization-modal}.tsx`.
**Harness/bukti/dokumen:** `docs/uat/harness/multibranch/{e2e-phase3,ui-phase3}.mjs`, `docs/uat/evidence-multibranch/phase3-*.json` + `ui-phase3/*.png`, `docs/RELEASE-HARDENING-BACKLOG.md` (baru). Tidak ada perubahan pada logika akuntansi, skema company.db, atau dokumen desain Revisi 6.

## 17. Final Verdict

| Kriteria | Status |
|---|---|
| Koreksi desain 1 (delegasi Revisi 5) & 2 (`delegation.manage` OWNER saja) | **SELESAI & terbukti** |
| Active Branch Selector (server tetap sumber kebenaran) | **SELESAI & terbukti** |
| Permission Phase 5/6 diperlakukan *prepared* | **Didokumentasikan + gerbang aktivasi** |
| Regression test khusus, 814 tes, mutasi 17/17 | PASS |
| E2E 82/82 (server & Electron), regresi 84/84 + 37/37, UI 29/29, integritas DB | PASS |
| Build TS, web, API, Electron + installer | PASS |
| Critical / High | **0** |

**PHASE 3 — SECURITY, AUTHORIZATION, DATABASE INTEGRITY, REGRESSION: PASS.**
**Aktivasi produksi Multi-Branch: NOT YET** (`multi_branch_enabled` tetap OFF; syarat di `docs/RELEASE-HARDENING-BACKLOG.md` bagian B).
**Phase 5/6: WAIT.**

Berhenti di sini; menunggu review. Tidak ada pekerjaan Phase 5/6 yang dimulai.
