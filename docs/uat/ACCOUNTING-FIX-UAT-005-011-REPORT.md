# TERRA FINANCE — TARGETED ACCOUNTING FIX: UAT-005 & UAT-011

Tanggal: 2026-10-06 · Installer: `apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe` (07:07, 124.205.874 byte) · Lingkungan: installer diekstrak, port 4500, data scratch (data produksi tidak disentuh).

## UAT-005 — Cash Flow pecahan / pro-rata

**Investigasi.** Pro-rata itu sendiri valid secara akuntansi (satu entri kas bercampur beberapa aktivitas harus dibagi menurut bobot baris lawan). Yang salah adalah *cara menghitungnya*: `cashDelta * (bobot / totalBobot)` dalam `number` (float) dan saldo kas dijumlah float. Akibatnya (data UAT 5 tahun, sebelum perbaikan): Operating `8467770000.000004`, Investing `-483636363.6363636`, Financing `-136363636.36363634` — noise float + pecahan Rupiah yang bukan satuan laporan, dan jumlah alokasi tidak dijamin sama dengan kas entri.

**Akar masalah.** Aritmetika uang float di `db/company/reporting/cash-flow-service.ts` (alokasi, penjumlahan kategori, saldo awal/akhir).

**Perbaikan** (bukan pembulatan di output/UI):
- Seluruh hitungan dalam bilangan bulat sen (`BigInt`), memakai `toCents`/`fromCents` di `lib/money.ts`.
- Alokasi pro-rata memakai metode sisa terbesar (`allocateProRata`): kelipatan Rupiah utuh bila kas entri utuh (sen bila kas entri berpecahan), seri sisa dimenangkan baris pertama (deterministik). Jumlah alokasi == kas entri, persis; total tidak pernah bergeser (Rp100.000 / 3 → 33.334 + 33.333 + 33.333).
- Pembulatan hanya di batas alokasi per entri, bukan lebih awal; sisa direkonsiliasi, tidak hilang.
- Tidak ada migrasi database, tidak ada perubahan skema/kontrak API; data lama tetap dihitung ulang dari jurnal.

## UAT-011 — satu baris dengan Debit + Kredit → HTTP 500

**Akar masalah.** Hanya CHECK database (`chk_journal_entry_lines_debit_credit`) yang menjaga aturan ini; pelanggaran muncul sebagai `SqliteError` → 500. Service tidak memvalidasi bentuk baris.

**Perbaikan.** `assertLineShapes` di `db/company/journal-service.ts` (dipakai di create/manual, import commit, Saldo Awal, dan POST): tiap baris harus bilangan hingga, tidak negatif, dan tepat SATU sisi > 0 (batas 1 sen). Error baru `JournalInvalidLineError` → HTTP 400 dengan pesan jelas (“Baris N: satu baris tidak boleh berisi debit dan kredit sekaligus”), dipetakan di route jurnal dan Saldo Awal. Validasi sebelum insert dalam transaksi → atomik (tidak ada header/baris/audit). Jurnal yang seluruhnya nol tetap memakai `JournalZeroAmountError` lama. Preview import kini juga menandai nilai negatif. Form web menahan tombol simpan bila ada baris berakun tanpa nominal. CHECK database tetap sebagai lapisan terakhir. Reversal hanya menukar sisi baris asli (diuji: tak pernah menghasilkan baris cacat).

## Bukti

| Verifikasi | Hasil |
|---|---|
| Tes backend | 609 lulus / 54 file (+24 `uat-accounting-fixes.test.ts`, +2 `company-journal/routes.test.ts`) |
| TypeScript API + Web | bersih |
| Build API, Web, installer Electron | berhasil |
| UAT penuh diulang dari nol (data 5 tahun via Import Excel) | 796 pengecekan, 791 lulus, 5 gagal (semua temuan lama yang tidak diperbaiki + 1 false positive harness) |
| UAT-001/002/003 (70 pengecekan) | 0 gagal |
| UAT-005/011/integritas (s13, 43 pengecekan) | 0 gagal |
| Hardening UAT-006..010 (31 pengecekan) | 0 gagal |
| Rekonsiliasi akuntansi + backup/restore (142 pengecekan) | 0 gagal |
| integrity_check / foreign_key_check / baris yatim / baris tanpa akun | ok / 0 / 0 / 0 |
| Jurnal POSTED tak seimbang; total debit vs kredit | 0; 18.938.560.102.000 = 18.938.560.102.000 |
| Cash Flow vs Ledger vs Neraca vs Dashboard (1 hari, 1 minggu, 1 bulan, 1 tahun, 5 tahun, periode kosong) | semua cocok persis; semua nilai Rupiah utuh |
| Pemindaian installer | tanpa private key, ADMIN_SECRET, .env, database, file test, generator; public key ada; gradient 0 |

Contoh 5 tahun (sesudah): Operating 25.458.462.052, Investing −349.498.433, Financing 1.926.050.157, Net 27.071.565.500 = kas akhir Neraca = saldo Ledger.

## HARNESS ERROR (bukan bug aplikasi)

1. `SQLI-resp` — false positive lama: `counterparties?type=` mengabaikan filter (UAT-015 LOW), bukan SQL injection.
2. Run ke-5 gagal 8 pengecekan `401 Belum login` karena komputer tidur ±54 menit di tengah s05b → sesi uji kedaluwarsa oleh auto-logout 15 menit (perilaku benar). Seluruh UAT diulang (run ke-6) tanpa kejadian itu.
3. `RL-global` memakai ekspektasi lama (200/menit global); diperbarui ke desain per kategori.
4. `SES-idle-notice` gagal sekali karena halaman login masih “Memuat…” saat dicek (beban mesin); lulus pada s07 yang dijalankan ulang sendirian.

## Backlog (tidak diperbaiki pada tugas ini)

MEDIUM: UAT-015 sebagian (nama sheet salah tidak ditolak), UAT-012 (logout tidak disiarkan antar-tab). LOW: UAT-014, UAT-015 (filter counterparty), UAT-013/016/017/018.

Perubahan perilaku: baris jurnal dengan akun terpilih tetapi tanpa nominal kini ditolak (400) alih-alih diterima diam-diam; draft lama yang berisi baris nol-nol tidak bisa diposting sampai baris itu dibuang.

Bukti: `docs/uat/evidence-accounting-fix/`; harness: `docs/uat/harness/s13_accounting_fix.mjs`.
