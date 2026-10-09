# Backlog Hardening & Release Checklist (sebelum rilis produksi)

Dibuat 2026-10-07 atas permintaan pemilik produk setelah review Phase 3 Multi-Branch. Item bertanda **WAJIB** harus selesai sebelum rilis produksi; sisanya dijadwalkan.

## A. Hardening teknis (diterima sementara, WAJIB sebelum rilis produksi)

| # | Item | Kondisi sekarang | Tindakan | Status |
|---|---|---|---|---|
| H-1 | **ESLint** | `pnpm lint` tidak berjalan: konfigurasi `.eslintrc` lama tidak cocok dengan ESLint 9 (flat config). Pemeriksaan tipe TS ketat dipakai sebagai pengganti | Migrasi ke `eslint.config.js` (flat), jalankan `pnpm lint` bersih, masukkan ke langkah build/CI | **WAJIB** — terbuka |
| H-2 | **Source map di paket produksi** | 195 file `.js.map` ikut `api/dist` di installer (`sourceMap: true` di `tsconfig.base.json`); web tidak membawa map | Matikan `sourceMap` pada build produksi API (atau kecualikan `*.map` di `electron-builder`), verifikasi isi paket | **WAJIB** — terbuka |
| H-3 | **Uji UI di jendela Electron** | Uji UI saat ini memakai Chrome terhadap server hasil build (selector cabang, pengelolaan akses & delegasi); server sudah diuji dari runtime Electron | Tambahkan uji UI otomatis yang menjalankan jendela Electron dari installer (mis. Playwright `_electron`) | **WAJIB** — terbuka |
| H-4 | Advisory `pnpm audit` | `@fastify/static` (high), `fastify`, `react-router`, dll. | Perbarui dependensi dengan uji regresi penuh | Dijadwalkan |
| H-5 | Kerangka uji unit untuk web | `apps/web` tidak punya test runner | Tambahkan Vitest + Testing Library untuk komponen kritis (selector cabang, modal delegasi) | Dijadwalkan |

## B. Gerbang aktivasi Multi-Branch (JANGAN dinyalakan sampai semua terpenuhi)

- [ ] `multi_branch_enabled = OFF` pada **semua** perusahaan klien (diverifikasi sebelum setiap rilis; default migrasi = OFF, tes `branch-migration` menjaganya).
- [ ] Persetujuan tertulis pemilik produk untuk aktivasi.
- [ ] Phase 5 selesai: laporan/dashboard/buku besar/pencarian/export mengikuti cabang aktif atau cakupan terpilih (hingga itu akun LIMITED sengaja ditolak di route tersebut).
- [ ] Phase 6 selesai bila transaksi antar-cabang dipakai klien.
- [ ] Setiap permission `interbranch.*` dan `report.consolidated` **dipasang pada endpoint/service yang relevan** dan diuji sampai database dan UI. Saat ini berstatus **prepared**, bukan implemented (hanya terdefinisi, bisa di-override, diaudit; belum mengendalikan fitur bisnis).
- [ ] Kapabilitas delegasi `view_branch_reports` dan `inter_branch` dipasang pada fitur Phase 5/6 yang bersangkutan (saat ini tersimpan/divalidasi/diaudit, belum berefek).
- [ ] Uji coba (UAT) dengan data salinan klien: migrasi, integritas (`integrity_check`, `foreign_key_check`), keamanan, dan kinerja.
- [ ] Panduan klien diperbarui (pengelolaan cabang, akses, delegasi, selector cabang aktif).

## C. Pemeriksaan rutin tiap rilis

1. Seluruh tes backend lulus; tes keamanan & matriks tidak dilemahkan.
2. `tsc --noEmit` API dan Web lulus; build web, API, dan Electron lulus.
3. Pemindaian isi installer: tanpa `.env`, database, kunci privat, `ADMIN_SECRET`, kredensial uji, file tes (dan, setelah H-2, tanpa `.js.map`).
4. Migrasi pada salinan data UAT 5 tahun (jumlah jurnal/baris/akun identik) dan e2e keamanan dari runtime Electron.
5. Pastikan data produksi dan port 4000 tidak disentuh pengujian.
