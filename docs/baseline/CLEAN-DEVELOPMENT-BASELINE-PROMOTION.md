# CLEAN DEVELOPMENT BASELINE — PROMOTION REPORT

**Tanggal:** 2026-10-08 · **Folder permanen:** `D:\ABDI\Proyek Aplikasi\Codex\TERRA-FINANCE-CLEAN` (sibling dari `TERRA-Finance-Offline`)
**Status:** `CLEAN DEVELOPMENT BASELINE PROMOTED` — `READY FOR IB-1 DESIGN/IMPLEMENTATION` (IB-1 **belum dimulai**).
Baseline Phase 3 historis (`PHASE-3-AUTHORIZATION-BASELINE.md`, `phase3-authorization-baseline.manifest.json`) **tidak diubah** (hash berkas di folder ini identik dengan aslinya).

## A. Origin
P-1 Clean Development Baseline Candidate (435 berkas baseline Phase 3 + 1 berkas rekonstruksi `company-search/routes.ts` + berkas pendukung terverifikasi), dipindahkan dari folder scratch sesi ke folder permanen. Bukan dari pohon WIP: sumber kode diambil dari staging P-1; hanya berkas pendukung non-kode (skrip desktop, docs arsitektur/baseline/uat, infra) yang disalin dari pohon asli, dan semuanya diperiksa bebas 5A.

## B. Integritas
**435/435** berkas manifest = SHA-256 identik; 0 hilang; 0 beda. `package.json` dan `pnpm-lock.yaml` tidak diubah (ikut dalam 435).

## C. Rekonstruksi
`apps/api/src/modules/company-search/routes.ts` = `fc4cd1a3ad0d12609cf91eb53dc0b11ca4377081a22d164e07fd9ec638c6a874` — **MATCH** hash historis (dihitung ulang di folder permanen).

## D. Bukti build
Dibangun ulang dari folder permanen dan dibandingkan dengan installer Phase 3: **196/196** JS non-tes API identik byte-per-byte; **15/15** aset web identik. (134 berkas tambahan di `dist` clean = hasil kompilasi berkas tes; tidak ada di installer.)

## E. Tes (dijalankan dari folder permanen)
| Pemeriksaan | Hasil |
|---|---|
| Typecheck api / web / shared | 0 / 0 / 0 error |
| `pnpm test` (api) | **827/827**, 67 berkas |
| Arsitektur / boundary (padanan) | 8/8 |
| E2E keamanan Multi-Branch (padanan), salinan data UAT 5 tahun | **37/37** |
| Golden Master Phase 5.0 (flag OFF) | small 43/43 · uat-1, uat-3, uat-7 masing-masing **126/126** identik |
| Build api / web | OK / OK |

Padanan: repo tidak punya `typecheck` di root, `check:boundaries`, atau `test:e2e`; yang dipakai sama dengan P-1 (tsc per paket, `src/architecture`, `e2e-stage.mjs` dari scratch).

## F. Kontaminasi Phase 5A: **0**
`report-scope.ts` (2 berkas): tidak ada. Referensi kode ke simbol WIP: 0. Berkas dengan hash khas-WIP: 0. Satu-satunya penyebutan "AuthorizedScope" adalah komentar/label di `scope-readiness.test.ts` (tes Phase 5.0, terverifikasi), bukan dependensi.

## G. Database (salinan backup UAT, dimigrasi oleh server hasil build; produksi tidak dibuka)
System 16 migrasi · Master 12 · Company 18 untuk masing-masing 6 perusahaan (terakhir `C0018`). `integrity_check` ok dan `foreign_key_check` 0 di semua. Tidak ada migrasi/tabel 5A atau Inter-Branch. `multi_branch_enabled` = **OFF** di semua perusahaan.

## H. Keterbatasan yang diketahui (tidak disembunyikan)
1. E2E Phase 3 "82/82" **tidak dapat direproduksi** — skrip historis tidak tersedia. Padanan: E2E 37/37 + golden + 827 tes.
2. Hash pohon di manifest historis (`6e40bb67…`) tidak dapat dihitung ulang — metode tidak terdokumentasi; verifikasi dilakukan per berkas.
3. Berkas di luar manifest yang masih **UNCERTAIN** (dampak rendah, tidak menyentuh API/migrasi/skema): `apps/desktop/build/icon*`, `pnpm-workspace.yaml`, serta `.gitignore` dan `LICENSE_GENERATOR_GUIDE.md` yang disalin dari pohon asli tanpa pembanding hash.
4. `node_modules` dan `dist` di folder ini hasil regenerasi (`pnpm install --frozen-lockfile`, build) dan bukan bagian baseline.
5. Folder ini bukan repositori git (sama dengan sebelumnya).

## I. Status
```
ORIGINAL WIP:            24 files, UNCHANGED: YES (diverifikasi ulang: 24 beda dari manifest, 0 hilang; report-scope.ts 2/2 masih ada)
CLEAN BASELINE:          separate permanent workspace, STATUS: READY
HISTORICAL PHASE-3:      UNCHANGED
IB-1:                    NOT STARTED
```
