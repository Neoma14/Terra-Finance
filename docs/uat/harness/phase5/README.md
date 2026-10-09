# Harness Phase 5.0 (baseline, profiling, golden master)

Semua skrip bekerja pada **salinan scratch** data UAT 5 tahun (`<scratch>/uat5/backup`). Tidak menyentuh data produksi atau port 4000. Tidak mengubah kode produk.
Prasyarat: `apps/api` sudah di-build (`pnpm --filter @konsultan/api build`) — skrip memuat layanan dari `apps/api/dist`.
Playwright tidak diperlukan.

| Langkah | Perintah | Hasil |
|---|---|---|
| 1. Bangun dataset (small / uat-1 / uat-3 / uat-7) | `node build-datasets.mjs` | `<scratch>/p50/datasets/*` (migrasi ke skema terkini, jurnal utuh disebar ke 1/3/7 cabang) |
| 2. Profiling layanan (cold/warm, jumlah query, bentuk query, EXPLAIN) | `node profile.mjs --modes=cold,warm [--pragma=base,cache64,cache64mmap] [dataset…]` | `<scratch>/p50/profile-current-*.json` (salinan di `docs/uat/phase5/`) |
| 3. Bukti SQL & kandidat indeks | `node prototypes.mjs` | `docs/uat/phase5/prototypes-sql-and-index-candidates.json` |
| 4. Baseline HTTP (min/median/p95) | `node http-baseline.mjs [dataset…]` | `docs/uat/phase5/http-baseline.json` |
| 5. Periksa anggaran | `node check-budget.mjs <hasil-baru.json>` | PASS/FAIL per endpoint |
| 6. Golden master | `node golden.mjs capture <dataset>` / `verify <dataset>` | `docs/uat/golden-master/phase5/<dataset>.golden.json` |
| 7. Hasil yang diharapkan per cakupan | `node golden.mjs scopes <dataset>` | `docs/uat/golden-master/phase5/expected-by-scope.<dataset>.json` |

Gerbang 5A/5B: `golden.mjs verify uat-1` (flag OFF, harus identik), `GOLDEN_FROM=uat-1 SKIP_IDS="journals:*" golden.mjs verify uat-3|uat-7` (laporan lintas-cabang harus identik dengan perusahaan-penuh), `check-budget.mjs`.
`oracle.mjs` menghitung angka langsung dari baris jurnal (SQL) tanpa memanggil layanan laporan; dipakai sebagai sumber kebenaran independen.

## Phase 5A/5B (2026-10-09)
- `golden.mjs` mengecualikan **secara eksplisit** bidang baru `scope`, `scopeLabel` (flag OFF) dan `interBranch` dari hash; semua angka dan field lain harus identik.
- `GOLDEN_SCOPE=all GOLDEN_FROM=uat-1 SKIP_IDS="journals:p1" node golden.mjs verify uat-3|uat-7`: dataset multi-cabang (flag ON) diminta `scope=all` dan dibandingkan dengan golden perusahaan-penuh. Tanpa `GOLDEN_SCOPE`, dataset flag ON memakai default baru (cabang aktif, D1) sehingga tidak identik dengan golden lama. uat-7: 6 dashboard berbeda hanya karena peringatan saldo awal milik dataset itu.
- `node golden.mjs reexport <dataset>`: menghitung ulang HANYA hash `exportDocuments` (setelah perubahan format ekspor yang disengaja dan sudah diperiksa diff-nya); `requests` dan `aggregateSha256` tidak disentuh.
- `node golden.mjs scoped uat-3|uat-7`: tiap cabang, subset, dan seluruh cabang diminta lewat HTTP lalu dibandingkan dengan oracle SQL independen (`expected-by-scope.<dataset>.json`); komparasi diperiksa terekonsiliasi dan waktunya dicatat.
