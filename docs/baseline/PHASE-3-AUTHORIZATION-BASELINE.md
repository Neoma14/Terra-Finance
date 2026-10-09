# Phase 3 Authorization Baseline — APPROVED

**Status: FROZEN.** Disetujui pemilik produk pada 2026-10-07 ("PHASE 3 — APPROVED / PASS"). Fondasi ini **tidak diubah** kecuali ditemukan bug; perubahan apa pun terhadap berkas dalam manifest harus dicatat sebagai *Baseline Change* (bagian 8) dengan alasan dan tes yang menyertainya.

## 1. Identifikasi build

Repositori ini **bukan repositori git**, sehingga tidak ada commit hash. Penanda pengganti yang dapat diverifikasi ulang:

| Penanda | Nilai |
|---|---|
| Installer | `apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe`, 124.293.518 byte, dibuat 2026-10-07 20:01 |
| SHA-256 installer | `ce4cb4f72385011fa2db7fe0783c162645e2030c0f053ec73723072411f8c9d3` |
| SHA-256 pohon sumber (435 berkas, lihat manifest) | `6e40bb67cf93471d3e7c7d25c6d0ab23ddcbea71c513c51a73fe75e364deaecf` |
| Manifest per berkas | `docs/baseline/phase3-authorization-baseline.manifest.json` |

Cara memeriksa pelanggaran baseline: hitung ulang SHA-256 setiap berkas pada manifest dan bandingkan; berkas yang berbeda = perubahan terhadap baseline.

## 2. Hasil uji yang membentuk baseline

| Pemeriksaan | Hasil |
|---|---|
| Tes backend | **814 / 814** (726 lama + 88 baru Phase 3) |
| Uji mutasi batas otorisasi | 17 / 17 terdeteksi |
| E2E Phase 3 (server build / runtime Electron) | 82 / 82 / 82 / 82 |
| Regresi Phase 1–2 (Electron) | migrasi 84/84, keamanan 37/37 |
| UI Chrome (diverifikasi ke database) | 29 / 29 |
| `integrity_check` / `foreign_key_check` | ok / 0 |
| Data akuntansi UAT 5 tahun | 12.003 jurnal, 30.976 baris, 66 akun — identik |
| Critical / High terbuka | 0 |

## 3. Skema / migrasi terakhir

- **System DB:** `S0016_delegations_revisi5` (berturut: S0011 scope, S0012 user_branch_access, S0013 audit kolom, S0014 overrides, S0015 delegasi model lama → diarsipkan, S0016 delegasi Revisi 5).
- **company.db:** `C0018_company_audit_branch` (C0014 branches, C0015 dimensi cabang jurnal, C0016 kebijakan akun, C0017 flag multi-cabang, C0018 audit cabang).

## 4. Flag aktivasi

**`multi_branch_enabled = OFF`** pada seluruh perusahaan (default migrasi OFF; dinyalakan hanya pada *salinan* data uji, tidak pernah pada data produksi/port 4000). Tidak boleh dinyalakan tanpa persetujuan tertulis pemilik produk dan terpenuhinya gerbang di `docs/RELEASE-HARDENING-BACKLOG.md` bagian B.

## 5. Isi baseline (ringkas)

Cabang & siklus hidup; `user_branch_access`; konteks cabang aktif divalidasi server tiap request; kebijakan akun per akun; jurnal/saldo awal per cabang; override permission (GRANT/DENY, 5 permission tertutup); **delegasi Revisi 5** (4 kapabilitas tetap + `max_role` + cabang eksplisit + masa berlaku, dibuat OWNER, kedalaman 1, tanpa edit — cabut lalu buat baru); `delegation.manage` hanya OWNER; admin LIMITED tanpa delegasi tidak punya kewenangan administratif; deny-by-default akun LIMITED (`BRANCH_AWARE_ROUTES`); audit lengkap; UI Pengguna + Active Branch Selector. Laporan: `docs/uat/MULTI-BRANCH-PHASE-1-2-IMPLEMENTATION-REPORT.md`, `docs/uat/MULTI-BRANCH-PHASE-3-AUTHORIZATION-REPORT.md`.

## 6. Known limitations (diterima saat persetujuan)

1. Permission `interbranch.*`, `report.consolidated` dan kapabilitas delegasi `view_branch_reports`, `inter_branch` berstatus **PREPARED** — belum mengendalikan fitur bisnis.
2. Laporan, dashboard, buku besar, pencarian, export belum mengikuti cabang (Phase 5); akun LIMITED sengaja ditolak di sana.
3. Uji UI dijalankan di Chrome terhadap server hasil build, bukan jendela Electron.
4. `pnpm lint` belum berjalan (ESLint legacy).
5. `.js.map` ikut paket API.
6. Delegasi tidak dapat diedit (cabut lalu buat baru); satu delegasi aktif per penerima.
7. Pemberitahuan perubahan akses di UI mengikuti polling 60 dtk / fokus jendela (penegakan server seketika).
8. `user_branch_access.branch_id` tanpa FK (dua file DB); validasi aplikasi + irisan saat baca.
9. Advisory `pnpm audit` (`@fastify/static`, `fastify`, `react-router`) belum ditangani.

Rujukan hardening: **`docs/RELEASE-HARDENING-BACKLOG.md`** (item H-1…H-5 tetap wajib/terjadwal; tidak dihapus karena Phase 5/6 berjalan).

## 7. Prinsip yang mengikat fase berikutnya

**Active Branch bukan filter UI.** Setiap endpoint yang membaca atau mengubah data cabang menentukan scope dari otorisasi server-side (`requireCompanyAccess` → akses cabang → konteks tervalidasi → permission → batas delegasi). Frontend tidak pernah menjadi sumber kebenaran untuk akses cabang, cabang aktif, peran, permission, delegasi, maupun cakupan laporan konsolidasi.

## 8. Log perubahan terhadap baseline

| Tanggal | Berkas | Alasan | Tes |
|---|---|---|---|
| — | **Tidak ada berkas baseline yang diubah** (diverifikasi ulang dengan hash terhadap manifest pada akhir Phase 5.0: 0 berkas berbeda, 0 hilang) | — | — |
| 2026-10-07 | *Penambahan saja* (bukan perubahan): `apps/api/src/architecture/scope-readiness.test.ts`, `apps/api/src/db/company/reporting/reporting-golden.test.ts`, `apps/api/src/db/company/reporting/__golden__/reporting-small.{snapshot,querycounts}.json` | Phase 5.0: tes arsitektur fail-closed, golden master, anggaran query | 13 tes baru; suite 827/827 |
