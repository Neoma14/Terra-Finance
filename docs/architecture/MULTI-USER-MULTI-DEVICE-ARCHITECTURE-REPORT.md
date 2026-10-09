# MULTI-USER MULTI-DEVICE ARCHITECTURE REPORT

Status: **AUDIT ONLY. Tidak ada perubahan multi-device yang diimplementasikan.**
Tanggal audit: 2026-10-05. Sumber: kode apps/api, apps/desktop, konfigurasi server.

## Ringkasan keputusan

| | |
|---|---|
| **RECOMMENDED** | **A: Local Server (satu PC server di kantor, komputer lain mengakses lewat LAN)** sebagai tahap 1. B (Cloud/VPS) dipertimbangkan sebagai tahap 2 bila ada cabang di luar kota yang memerlukan akses real-time. |
| **REASON** | Mengubah paling sedikit (API dan UI sudah berbasis HTTP, hanya binding dan keamanan yang perlu diubah), data tetap di bawah kendali klien, tidak ada biaya langganan, dan tidak bergantung internet. Cloud menambah HTTPS, backup server, keamanan publik, dan biaya operasional, serta sebagian besar fiturnya baru terasa nilainya bila cabang berada jauh. |
| **IMPLEMENTATION COMPLEXITY** | A: **MEDIUM**. B: **HIGH**. |
| **DO WE NEED SERVER?** | **YA.** Satu komputer harus menjadi pemilik database dan API. Tanpa itu, multi-device tidak aman. |
| **DO NOT IMPLEMENT YET** | **YES.** Pilihan arsitektur ada pada klien. Ada juga keputusan lisensi (lihat bagian 10). |

## 1. Architecture sekarang

- **Electron** menjalankan **satu proses Fastify** di dalam aplikasi desktop dan membuka jendela ke `http://127.0.0.1:4000` (port tetap).
- `app.listen({ host: "127.0.0.1" })`: server **hanya menerima koneksi dari komputer yang sama** (disengaja, tercatat di `server.ts`).
- Data: SQLite (`better-sqlite3`) di folder pengguna Windows (`%APPDATA%\TERRA FINANCE`): `terra-finance.sqlite` (master), `terra-system.sqlite` (system), `companies\<slug>\company.db` per perusahaan.
- Satu koneksi database dibuka **per request** dan ditutup di akhir request (pool 1 koneksi).
- Autentikasi: cookie session `httpOnly`, `sameSite=lax`, `secure` = false (HTTP lokal). Session disimpan di master DB. Sekarang idle 15 menit ditegakkan di server.
- Lisensi: terikat **fingerprint komputer** (hostname + platform + MAC pertama), satu instalasi = satu perangkat.
- Backup otomatis: sekarang menyalin master DB, system DB, dan semua `companies\<slug>\company.db` (diperbaiki pada tahap stabilisasi; lihat `apps/desktop/src/backup.js`). Salinan masih berada di komputer yang sama.

## 2. Apakah bisa multi-device?

**Tidak, tidak dengan arsitektur sekarang.** Alasan teknis: (a) server hanya mendengarkan 127.0.0.1; (b) database ada di disk satu komputer; (c) lisensi terikat satu komputer; (d) tidak ada HTTPS/pengamanan untuk akses jaringan; (e) Electron adalah klien sekaligus server.

Banyak user pada **satu komputer** (login bergantian) sudah bisa. Banyak user di **banyak komputer** tidak.

## 3. Apakah harus ada server?

**Ya.** Harus ada satu proses yang menjadi satu-satunya penulis database. Jangan membagi file SQLite lewat folder jaringan (SMB/Dropbox/Google Drive): SQLite tidak aman untuk itu dan berisiko merusak database (lihat bagian 7).

## 4. Option A: Local Server

```
PC Server (selalu menyala)
 ├─ TERRA API (Fastify, 0.0.0.0:4000 di LAN) + database SQLite
 └─ LAN
     ├─ PC Owner      (browser / aplikasi klien tipis)
     ├─ PC Accounting
     └─ PC Cabang
```

| Aspek | Penjelasan |
|---|---|
| Hardware | 1 PC/mini-PC biasa (4 GB RAM cukup, SSD, UPS dianjurkan). Tidak perlu server mahal. |
| LAN | Kabel/Wi-Fi kantor. IP tetap untuk server. |
| Backup | Backup terjadwal otomatis **semua** file database ke disk kedua/NAS + salinan di luar kantor. Wajib memperbaiki cakupan backup. |
| Database | SQLite tetap bisa dipakai untuk jumlah user kecil (lihat bagian 7); PostgreSQL hanya bila user serentak banyak. |
| API | Ubah binding dari `127.0.0.1` ke alamat LAN; jadikan layanan Windows (bukan terkait jendela Electron). |
| Keamanan | Firewall hanya LAN; HTTPS dengan sertifikat lokal; `COOKIE_SECURE`; batasi CORS (sekarang `origin: true`); rate-limit per user; kebijakan password. |
| Jika server mati | Semua user berhenti bekerja sampai server hidup. Data aman bila backup ada. Perlu prosedur pemulihan tertulis. |
| Jika internet mati | **Tidak berpengaruh** (tidak memakai internet). |
| Maintenance | Update aplikasi di satu tempat (server); klien tipis tidak perlu update besar. |
| Cabang di kota lain | Tidak terjangkau, kecuali memakai VPN. |

## 5. Option B: Cloud server / VPS

```
Owner / Accounting / Cabang / Laptop / Tablet
                │  Internet (HTTPS)
                ▼
          TERRA API (VPS)  ──  Database
```

| Aspek | Penjelasan |
|---|---|
| VPS/server | 1 VPS (2 vCPU / 4 GB), OS Linux, domain. |
| Database | Disarankan **PostgreSQL** (bukan SQLite) untuk akses serentak lintas internet. |
| Authentication | Cookie session lewat HTTPS, MFA dianjurkan, perlindungan brute force, kebijakan password. |
| HTTPS | Wajib (sertifikat publik, mis. Let's Encrypt). |
| Backup | Backup harian otomatis + replika; uji restore. |
| Concurrency | Transaksi database nyata; perlu penguncian penulisan antar user. |
| Permission | Role per perusahaan sudah ada; tambah role per cabang. |
| Internet | **Tergantung penuh.** Internet mati = tidak bisa bekerja. |
| Biaya operasional | VPS bulanan, domain, backup, pemantauan, patch keamanan, dan SDM yang menjaganya. |
| Security | Permukaan serangan publik: firewall, WAF, audit login, enkripsi data di disk, kepatuhan perlindungan data (UU PDP). |
| Lisensi | Model lisensi perlu diubah (per perusahaan/per user, bukan per komputer). |

## 6. Kelebihan dan kekurangan

| | A: Local Server | B: Cloud/VPS |
|---|---|---|
| Perubahan kode | sedang | **besar** (database baru, deployment, keamanan publik) |
| Biaya berjalan | rendah | ada langganan + perawatan |
| Bergantung internet | tidak | **ya** |
| Akses dari luar kantor | hanya via VPN | ya |
| Kontrol data | penuh di klien | di server (tanggung jawab vendor/klien) |
| Risiko keamanan | rendah (LAN) | lebih tinggi (publik) |
| Skala ke banyak cabang jauh | terbatas | baik |
| Satu titik gagal | PC server | VPS |

## 7. Dampak terhadap SQLite

- SQLite mendukung **banyak pembaca dan satu penulis pada satu waktu**. Penulisan diserialisasi; pada beban kantor kecil (puluhan user, bukan ratusan penulis serentak) ini umumnya cukup **bila hanya satu proses server yang mengakses file** (Option A).
- Kondisi sekarang tidak mengaktifkan WAL (`journal_mode` tidak diatur, mode rollback bawaan): penulis memblokir pembaca. Untuk multi-user perlu `PRAGMA journal_mode = WAL` dan `busy_timeout`.
- Berbahaya: beberapa PC membuka **file yang sama lewat folder jaringan**. Itu bukan arsitektur yang didukung.
- Untuk Option B atau banyak penulis serentak: ganti ke PostgreSQL (knex sudah dipakai, jadi migrasi sebagian besar di lapisan koneksi dan beberapa SQL khusus SQLite).

## 8. Dampak terhadap Fastify

- Ubah host binding dan matikan asumsi "localhost saja" (CORS `origin: true`, cookie tidak secure).
- Tambah HTTPS, rate-limit per user/IP, validasi origin.
- Tetap satu proses; tidak perlu microservice.
- Hapus ketergantungan pada proses Electron (jalankan sebagai layanan).

## 9. Dampak terhadap Electron

- Opsi A: Electron berubah menjadi **klien tipis** (cukup membuka alamat server) atau diganti browser biasa. Instalasi server tanpa jendela Electron.
- Port 4000 yang tetap (hardcoded) dan satu instalasi per komputer perlu dibuat dapat dikonfigurasi.
- Auto-update dan installer harus memisahkan "paket server" dan "paket klien".

## 10. Dampak terhadap authentication

- Session dan idle 15 menit sudah di server (siap dipakai multi-device).
- Perlu: kebijakan password, batas percobaan login, daftar sesi aktif/perangkat, pencabutan sesi oleh admin, dan (opsional) MFA.
- **Lisensi:** model "satu komputer = satu lisensi" bertentangan dengan banyak klien. **DESIGN DECISION REQUIRED:** lisensi dihitung per server/instalasi, per jumlah user, atau per perusahaan?

## 11. Dampak terhadap company DB

- Tetap satu file per perusahaan, dibuka hanya oleh proses server.
- Konkurensi: penulisan diserialisasi (`pool max 1` per koneksi sudah ada). Perlu `WAL` + `busy_timeout`.
- Jurnal berurutan (nomor referensi unik) sudah dilindungi `UNIQUE(reference_no)` sehingga dua user tidak bisa membuat nomor sama; UI perlu menangani pesan bentrok (409) dengan baik.

## 12. Dampak terhadap multi-company

Tidak berubah secara model. Akses perusahaan sudah per user (`company_access`). Yang baru: beberapa user sekaligus membuka perusahaan yang sama; perlu pengamanan edit bersamaan (mis. dua orang mengedit draft jurnal yang sama: gunakan versi/`updated_at` untuk mendeteksi bentrok).

## 13. Dampak terhadap branch

Multi-cabang (lihat MULTI-BRANCH ARCHITECTURE REPORT) dan multi-device saling melengkapi tetapi **independen**: cabang adalah konsep akuntansi, device adalah konsep jaringan. Cabang di lokasi berbeda hanya bisa memakai sistem yang sama secara real-time bila ada server (Option A dengan VPN atau Option B). Tanpa server, cabang tetap bisa memakai aplikasi sendiri-sendiri dan jurnal antar kantor dipertukarkan lewat file (tidak real-time).

## 14. Dampak terhadap permissions

Role per perusahaan sudah ada (OWNER/ADMIN/ACCOUNTANT/STAFF/VIEWER). Perlu penambahan: role/izin per cabang, kebijakan siapa boleh login dari perangkat mana, dan audit login (IP/perangkat).

## 15. Dampak terhadap backup

- **Sudah diperbaiki:** backup otomatis kini mencakup `companies\*\company.db` beserta system dan master DB. Yang tersisa untuk arsitektur server: salinan di luar komputer/server dan uji restore berkala.
- Server: backup terjadwal seluruh folder data, salinan di luar PC server, uji restore berkala. Gunakan SQLite online backup API / `VACUUM INTO` agar salinan konsisten saat aplikasi berjalan.

## 16. Rekomendasi

Jalankan bertahap:
1. **Sekarang (tanpa server):** cakupan backup sudah diperbaiki; berikutnya aktifkan WAL, dan selesaikan fondasi (idle logout, audit) yang sudah dikerjakan.
2. **Tahap 1:** Option A (Local Server) bila semua user berada di kantor yang sama atau terhubung VPN.
3. **Tahap 2:** Option B hanya bila klien membutuhkan akses real-time dari banyak lokasi tanpa VPN dan siap menanggung biaya serta tanggung jawab operasional server.

## 17. Estimasi tingkat perubahan architecture

| Opsi | Tingkat |
|---|---|
| Sekarang (satu komputer, banyak user bergantian) | **LOW** (sudah jalan) |
| A: Local Server | **MEDIUM** |
| B: Cloud/VPS (+ PostgreSQL) | **HIGH** |

## Pertanyaan yang harus dijawab klien sebelum implementasi

1. Berapa user dan berapa lokasi yang benar-benar perlu bekerja serentak? Apakah semuanya satu gedung/jaringan?
2. Apakah ada PC kantor yang selalu menyala dan dapat dijadikan server, dan siapa yang merawatnya?
3. Apakah cabang boleh bekerja offline lalu menyinkronkan, atau harus real-time?
4. Bagaimana model lisensi (per server, per user, per perusahaan)?
5. Apakah klien menerima data berada di server cloud (kepatuhan data)?
