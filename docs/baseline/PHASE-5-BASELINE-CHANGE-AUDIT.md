# PHASE 5: AUDIT PERUBAHAN BERKAS BASELINE PHASE 3

Dihasilkan otomatis pada 2026-10-09 (`p9-baseline-doc.cjs`). Pembanding: **isi** berkas baseline asli (salinan P-1 yang SHA-256-nya cocok manifest: 433 dari 435 berkas tersedia; 2 berkas dokumen tidak ada di salinan dan hash-nya di pohon kerja masih cocok manifest) terhadap pohon kerja saat ini, bukan sekadar hash manifest.
Manifest dan `PHASE-3-AUTHORIZATION-BASELINE.md` **tidak diedit**.

Berkas manifest yang kini berbeda dari manifest: **72** dari 435. Hilang: 0.
Berkas yang berbeda tetapi tidak ada di salinan pembanding (tidak dapat di-diff): tidak ada.

| Kategori | Jumlah berkas |
|---|---|
| Antar Cabang (IB-1..IB-6, UAT) | 18 |
| Aturan frontend (tanda pisah) | 15 |
| IB + Phase 5 | 3 |
| Phase 5A/5B (cakupan laporan) | 36 |

| Berkas | Kategori | Tambah | Hapus |
|---|---|---|---|
| apps/api/src/db/company/account-policy-service.ts | Antar Cabang (IB-1..IB-6, UAT) | +16 | -1 |
| apps/api/src/db/company/account-service.ts | Antar Cabang (IB-1..IB-6, UAT) | +10 | -0 |
| apps/api/src/db/company/branch-service.test.ts | Antar Cabang (IB-1..IB-6, UAT) | +5 | -2 |
| apps/api/src/db/company/branch-service.ts | Antar Cabang (IB-1..IB-6, UAT) | +19 | -4 |
| apps/api/src/db/company/index.ts | Antar Cabang (IB-1..IB-6, UAT) | +3 | -0 |
| apps/api/src/db/company/journal-branch.test.ts | Antar Cabang (IB-1..IB-6, UAT) | +34 | -12 |
| apps/api/src/db/company/journal-import-service.test.ts | Antar Cabang (IB-1..IB-6, UAT) | +11 | -0 |
| apps/api/src/db/company/journal-import-service.ts | Antar Cabang (IB-1..IB-6, UAT) | +4 | -0 |
| apps/api/src/db/company/journal-service.ts | Antar Cabang (IB-1..IB-6, UAT) | +48 | -4 |
| apps/api/src/db/company/period-closing-service.ts | Antar Cabang (IB-1..IB-6, UAT) | +7 | -0 |
| apps/api/src/modules/company-accounts/routes.ts | Antar Cabang (IB-1..IB-6, UAT) | +2 | -0 |
| apps/api/src/modules/company-journal/routes.ts | Antar Cabang (IB-1..IB-6, UAT) | +2 | -0 |
| apps/api/src/server.ts | Antar Cabang (IB-1..IB-6, UAT) | +2 | -0 |
| apps/web/src/App.tsx | Antar Cabang (IB-1..IB-6, UAT) | +2 | -0 |
| apps/web/src/features/workspace/use-journal.ts | Antar Cabang (IB-1..IB-6, UAT) | +3 | -0 |
| apps/web/src/lib/company-api-client.ts | Antar Cabang (IB-1..IB-6, UAT) | +3 | -1 |
| apps/web/src/routes/workspace/nav-config.ts | Antar Cabang (IB-1..IB-6, UAT) | +6 | -0 |
| apps/web/src/routes/workspace/workspace-shell.tsx | Antar Cabang (IB-1..IB-6, UAT) | +12 | -2 |
| apps/web/src/routes/accounts-page.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/benchmark-page.tsx | Aturan frontend (tanda pisah) | +2 | -2 |
| apps/web/src/routes/company-detail-page.tsx | Aturan frontend (tanda pisah) | +5 | -5 |
| apps/web/src/routes/journal-page.tsx | Aturan frontend (tanda pisah) | +3 | -3 |
| apps/web/src/routes/ledger-page.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/ratios-page.tsx | Aturan frontend (tanda pisah) | +2 | -2 |
| apps/web/src/routes/tax-page.tsx | Aturan frontend (tanda pisah) | +2 | -2 |
| apps/web/src/routes/workspace/accounts/account-detail-modal.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/dashboard/dashboard-date-filter.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/journal/journal-detail-modal.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/journal/journal-form-panel.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/journal/journal-import-tab.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/journal/journal-list-tab.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/opening-balance/opening-balance-form.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/web/src/routes/workspace/opening-balance/opening-balance-page.tsx | Aturan frontend (tanda pisah) | +1 | -1 |
| apps/api/src/middleware/branch-authority.ts | IB + Phase 5 | +31 | -0 |
| apps/api/src/modules/company-branches/routes.test.ts | IB + Phase 5 | +6 | -10 |
| apps/api/src/modules/company-branches/routes.ts | IB + Phase 5 | +5 | -2 |
| apps/api/src/db/company/counterparty-service.ts | Phase 5A/5B (cakupan laporan) | +5 | -3 |
| apps/api/src/db/company/dashboard-service.ts | Phase 5A/5B (cakupan laporan) | +14 | -13 |
| apps/api/src/db/company/ledger-service.ts | Phase 5A/5B (cakupan laporan) | +12 | -9 |
| apps/api/src/db/company/reporting/balance-sheet-service.ts | Phase 5A/5B (cakupan laporan) | +8 | -7 |
| apps/api/src/db/company/reporting/cash-flow-service.ts | Phase 5A/5B (cakupan laporan) | +7 | -6 |
| apps/api/src/db/company/reporting/equity-statement-service.ts | Phase 5A/5B (cakupan laporan) | +6 | -5 |
| apps/api/src/db/company/reporting/income-statement-service.ts | Phase 5A/5B (cakupan laporan) | +9 | -8 |
| apps/api/src/db/company/reporting/reporting-utils.ts | Phase 5A/5B (cakupan laporan) | +13 | -7 |
| apps/api/src/db/company/trial-balance-service.ts | Phase 5A/5B (cakupan laporan) | +7 | -5 |
| apps/api/src/modules/company-counterparties/routes.ts | Phase 5A/5B (cakupan laporan) | +11 | -3 |
| apps/api/src/modules/company-dashboard/routes.ts | Phase 5A/5B (cakupan laporan) | +7 | -3 |
| apps/api/src/modules/company-ledger/routes.ts | Phase 5A/5B (cakupan laporan) | +28 | -7 |
| apps/api/src/modules/company-reports/export.test.ts | Phase 5A/5B (cakupan laporan) | +1 | -1 |
| apps/api/src/modules/company-reports/routes.ts | Phase 5A/5B (cakupan laporan) | +58 | -74 |
| apps/api/src/modules/company-search/routes.ts | Phase 5A/5B (cakupan laporan) | +7 | -0 |
| apps/api/src/modules/report-export/build.ts | Phase 5A/5B (cakupan laporan) | +20 | -12 |
| apps/api/src/modules/report-export/document.test.ts | Phase 5A/5B (cakupan laporan) | +25 | -4 |
| apps/api/src/modules/report-export/document.ts | Phase 5A/5B (cakupan laporan) | +20 | -1 |
| apps/api/src/modules/report-export/pdf.ts | Phase 5A/5B (cakupan laporan) | +4 | -0 |
| apps/api/src/modules/report-export/xlsx.ts | Phase 5A/5B (cakupan laporan) | +4 | -0 |
| apps/web/src/features/workspace/use-counterparties.ts | Phase 5A/5B (cakupan laporan) | +4 | -3 |
| apps/web/src/features/workspace/use-dashboard.ts | Phase 5A/5B (cakupan laporan) | +4 | -3 |
| apps/web/src/features/workspace/use-ledger.ts | Phase 5A/5B (cakupan laporan) | +4 | -3 |
| apps/web/src/features/workspace/use-reports.ts | Phase 5A/5B (cakupan laporan) | +21 | -19 |
| apps/web/src/features/workspace/use-trial-balance.ts | Phase 5A/5B (cakupan laporan) | +4 | -3 |
| apps/web/src/lib/active-branch.ts | Phase 5A/5B (cakupan laporan) | +3 | -3 |
| apps/web/src/routes/workspace/books/cash-bank-view.tsx | Phase 5A/5B (cakupan laporan) | +7 | -1 |
| apps/web/src/routes/workspace/counterparties/counterparties-page.tsx | Phase 5A/5B (cakupan laporan) | +8 | -1 |
| apps/web/src/routes/workspace/dashboard/dashboard-page.tsx | Phase 5A/5B (cakupan laporan) | +8 | -1 |
| apps/web/src/routes/workspace/ledger/ledger-page.tsx | Phase 5A/5B (cakupan laporan) | +9 | -2 |
| apps/web/src/routes/workspace/reports/balance-sheet-tab.tsx | Phase 5A/5B (cakupan laporan) | +27 | -2 |
| apps/web/src/routes/workspace/reports/cash-flow-tab.tsx | Phase 5A/5B (cakupan laporan) | +14 | -2 |
| apps/web/src/routes/workspace/reports/equity-tab.tsx | Phase 5A/5B (cakupan laporan) | +26 | -2 |
| apps/web/src/routes/workspace/reports/income-statement-tab.tsx | Phase 5A/5B (cakupan laporan) | +30 | -2 |
| apps/web/src/routes/workspace/reports/reports-page.tsx | Phase 5A/5B (cakupan laporan) | +16 | -5 |
| apps/web/src/routes/workspace/trial-balance/trial-balance-page.tsx | Phase 5A/5B (cakupan laporan) | +15 | -2 |

## Temuan audit isi (bukan hanya hash)

1. **Setiap perubahan ditinjau diff-nya** (72 berkas). Semuanya masuk salah satu kategori yang disetujui: Antar Cabang (IB-1..IB-6 dan perbaikan UAT), Phase 5A/5B (BC-1, BC-2, cakupan laporan aditif, parameter opsional), penyesuaian aturan frontend (hanya teks tanda pisah). Tidak ditemukan perubahan di luar kategori itu, tidak ada berkas hilang, dan tidak ada perubahan pada `authorization.ts`, `rbac.ts`, `company-access-guard.ts`, migrasi S/C lama, atau logika delegasi/override.
2. **Perubahan perilaku global pada kode baseline** (bukan sekadar tambahan): (a) `db/company/index.ts`: `PRAGMA recursive_triggers = ON` pada setiap koneksi company.db (dianalisis pada IB: hanya trigger `branch_default` yang menulis tabel lain, tanpa rekursi diri; REPLACE kini memicu trigger DELETE); (b) `period-closing-service.ts`: penutupan periode juga diblokir bila ada pengajuan antar-cabang menunggu (tanpa baris antar-cabang = 0, perilaku lama); (c) `journal-service.ts`: awalan referensi `IB-` dicadangkan untuk jurnal antar-cabang dan jurnal ber-origin `inter_branch` hanya sah bersama tautan transaksi; reversal jurnal bertaut hanya lewat alur antar-cabang; (d) `branch-service.ts`: menonaktifkan multi-cabang diblokir bila ada pengajuan menunggu, menonaktifkan/menutup cabang membatalkan pengajuan menunggu (K-3).
3. **Perubahan tak terdokumentasi di laporan sebelumnya**: `workspace-shell.tsx` menghapus kelas `z-10` pada footer (agar footer tidak menimpa modal; kosmetik, tanpa dampak fungsi; dicatat di sini).
4. **Bukti kompatibilitas dengan tes ASLI baseline**: 5 berkas tes baseline berubah (`branch-service.test`, `journal-branch.test`, `journal-import-service.test`, `company-branches/routes.test`, `report-export/document.test`). Versi ASLI kelimanya dijalankan terhadap kode saat ini: **72 lulus, 5 gagal**, dan kelima kegagalan persis adalah ekspektasi yang digantikan keputusan yang disetujui: (i,ii) asal `inter_branch` tidak lagi "belum didukung" dan tautan `inter_branch_*` tidak lagi dapat ditempel lewat UPDATE (K-1, IB-1); (iii) cabang tertutup menolak `inter_branch` dengan galat status, bukan "belum didukung" (IB-2); (iv) LIMITED kini dapat membuka laporan cabangnya (Phase 5A/5B; D1-D10); (v) daftar route sadar-cabang memuat route Antar Cabang yang tidak diregistrasikan oleh tes lama. Seluruh berkas tes baseline lain (tanpa perubahan) lulus pada `pnpm test`. Tidak ada tes yang dihapus; versi saat ini hanya memperbarui ekspektasi tersebut (dan tanda pisah periode ekspor).
5. **Harness historis**: `docs/uat/harness/multibranch/e2e-phase3.mjs` menunjuk workspace lama (`TERRA-Finance-Offline`) dan tidak dijalankan; pembanding Phase 3 yang dipakai adalah E2E keamanan (39/39), golden master, dan 999 tes.
