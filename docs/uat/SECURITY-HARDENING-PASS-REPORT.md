# TERRA FINANCE — SECURITY HARDENING PASS

Tanggal: 2026-10-06 · Installer: `apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe` (00:16, 124.202.959 byte) · Lingkungan: installer diekstrak, port 4500, data scratch (port 4000 / data produksi tidak disentuh).
Lanjutan dari `FULL-UAT-5-YEAR-MULTI-BRANCH-SECURITY-REPORT.md`. UAT-001/002/003 tidak diubah.

## Hasil per temuan

| ID | Sebelum | Sesudah | Status |
|---|---|---|---|
| UAT-006 Brute force login | 25–30 password salah beruntun tidak ditahan sama sekali | Pembatas 3 lapis (IP+akun 5 gagal, akun 20, IP 30 dalam 15 mnt) → blokir sementara 5 mnt, `429` generik + `Retry-After`; in-memory (restart = bersih), tidak pernah permanen; sukses mereset; respons & waktu verifikasi sama untuk akun ada/tidak ada | PASS |
| UAT-007 Audit login/logout | Tidak tercatat | `auth.login_success/failed`, `auth.logout`, `auth.session_expired` di `audit_log` (append-only lewat trigger DB); berisi waktu, userId, identifier, ip, success, reason; tanpa password/token; `GET /api/auth/audit` hanya admin sistem, tidak ada endpoint tulis | PASS |
| UAT-008 CORS | Memantulkan origin apa pun + credentials | Allowlist: loopback + port app (+5173 non-production) + `CORS_ALLOWED_ORIGINS`; wildcard diabaikan; origin asing/`null`/malformed/port lain → 403 tanpa header CORS (juga untuk POST lintas-origin) | PASS |
| UAT-010 Rate limiter | 1 bucket global 200/mnt termasuk aset SPA | Per kategori: statis & health bebas; auth 30; mutasi 120; import 30; baca 1200 per menit (bucket terpisah); klien web mencoba ulang GET sekali bila 429 | PASS |
| UAT-009 Avatar | Menerima SVG | Allowlist PNG/JPEG/WEBP; ekstensi + MIME + magic bytes harus sepakat; tolak SVG/HTML/JS/PHP/EXE, polyglot (konten aktif), >500 KB; data URI dibentuk dari tipe hasil deteksi. Berlaku juga untuk logo perusahaan | PASS |

## Verifikasi

- Unit test backend: **583 lulus / 53 file** (32 test baru di `modules/auth/security-hardening.test.ts`). TypeScript API & Web bersih. Build API, Web, dan installer Electron berhasil.
- UAT penuh diulang dari nol pada installer baru (data 5 tahun dimuat ulang lewat Import Excel): **751 pengecekan, 743 lulus, 8 gagal**. Seluruh 8 adalah temuan lama yang sengaja tidak diperbaiki (+1 false positive harness).
- 29 pengecekan s12 (BF-1..6, AUD-1..8, CORS-1..6, AV-1..3, RL-1..5): semua PASS. Pengecekan lama AU-bruteforce, AU-bruteforce2, CORS-reflect, UP-svg, UP-spoof kini PASS.
- UAT-001/002/003 (s10, 70 pengecekan): 0 gagal. Akuntansi (112 pengecekan rekonsiliasi per akun, 60 Trial Balance, A = L + E), backup/restore deep-compare, kill -9 atomic, integritas DB: semua PASS.
- Pemindaian installer: tidak ada private key (hanya teks contoh di README dotenv), `ADMIN_SECRET`, `.env`, database, file test, generator lisensi; public key ada; gradient = 0.

## HARNESS ERROR (bukan bug aplikasi)

1. Uji brute-force harness mengulang otomatis saat 429 → menunggu blokir 5 menit berulang (macet 2×). Perbaikan: klien harness tidak mengulang `/api/auth/login`. Server direstart antar-tahap karena brute-force sengaja memblokir IP/akun uji.
2. AUD-5 awal menghitung event kedaluwarsa dari tes sesi idle sebelumnya (3 vs 1). Diubah menjadi selisih sebelum/sesudah.
3. RL-3/RL-5 awal memukul rute yang tidak ada (404 tidak melewati pembatas). Diganti rute mutasi nyata.
4. `SQLI-resp` (false positive lama): `counterparties?type=` mengabaikan filter dan mengembalikan 200 — itu LOW UAT-015, bukan SQL injection.
5. Waktu "journal import commit batch12" 48 dtk (sebelumnya 2 dtk) adalah jeda klien harness menunggu jatah import 30/menit pada pemuatan 24 request beruntun, bukan lambatnya server. Dashboard 0,9 dtk.

## Sisa temuan (tidak diperbaiki sesuai batas tahap)

- MEDIUM: UAT-005 (Arus Kas pecahan/pro-rata), UAT-011 (debit+kredit satu baris → 500).
- LOW: UAT-012 (logout tidak disiarkan antar-tab), UAT-014 (header keamanan/clickjacking), UAT-015 (nama sheet salah & filter counterparty tak valid diabaikan), UAT-013/016/017/018 (observasi).

## KNOWN LIMITATION

- Throttle login in-memory: hilang saat restart (sengaja); di balik proxy, IP klien memakai `request.ip` (tanpa trustProxy) — harus dikonfigurasi bila nanti ada reverse proxy.
- Rute tidak dikenal (404) tidak dihitung rate limit.
- Tidak ada re-encoding gambar; avatar/logo lama yang sudah tersimpan sebagai SVG tidak dimigrasi (tetap hanya dirender via `<img>`).
- Jendela Electron tidak dijalankan (port 4000 dipakai aplikasi pengguna); yang diuji adalah server dari installer yang sama + browser headless untuk UI.
- Keamanan tidak diklaim 100%; belum ada pen-test pihak ketiga, TLS/Secure cookie belum relevan untuk localhost.

Bukti: `docs/uat/evidence-hardening/`; harness: `docs/uat/harness/` (`s12_hardening.mjs`, `run_all.mjs`).
