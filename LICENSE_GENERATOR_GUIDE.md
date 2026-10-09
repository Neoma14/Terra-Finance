# Panduan License Generator TERRA FINANCE (Vendor Only)

Dokumen ini untuk **Terra Teknologi Digital (vendor)**. License generator adalah alat internal. Alat ini **bukan bagian dari aplikasi klien**, tidak ikut di installer, dan tidak boleh dikirim ke klien.


---

## 0. Cara termudah: TERRA License Generator (aplikasi .exe, tanpa PowerShell/CMD)

File: `tools/license-generator/gui/dist/TERRA-License-Generator.exe` (satu file, portable, tidak perlu instalasi). Klik dua kali untuk membuka.

- **Buat Lisensi**: isi Nama klien, pilih Lifetime atau tanggal berakhir, isi jumlah device, lalu klik *Buat Lisensi*. Kunci `TFO2-...` muncul dengan tombol *Salin kunci*.
- **Token Administrator**: tempel kunci lisensi klien, klik *Buat token*, lalu salin.
- **Verifikasi**: tempel kunci untuk memeriksa keasliannya (memakai public key saja).
- **Riwayat**: daftar lisensi yang pernah diterbitkan beserta tombol salin kunci.

Aplikasi membaca `license-private.pem` dan `license-public.pem` dari `%USERPROFILE%\TERRA-VENDOR\` (sama dengan CLI, dan memakai `issued-licenses.log` yang sama). Bila berkas ada di tempat lain (mis. flash drive), klik *Pilih lokasi private key...* di bagian bawah jendela. Yang diingat hanya lokasinya, bukan isi key.

Aturan keamanan:
- Private key **tidak ada di dalam .exe**. File ini aman dari sisi kunci, tetapi tetap alat vendor: **jangan dikirim ke klien dan jangan dimasukkan ke installer**.
- Setiap lisensi diperiksa ulang dengan public key sebelum ditampilkan; bila private dan public key tidak berpasangan, lisensi tidak diterbitkan dan tidak dicatat.
- Pembuatan keypair baru (`keygen`) sengaja **tidak** ada di aplikasi ini karena akan merusak semua lisensi lama; lakukan hanya lewat CLI sesuai bagian 3.
- Windows SmartScreen dapat menampilkan peringatan "publisher tidak dikenal" karena file belum ditandatangani kode. Pilih *More info* lalu *Run anyway*.

Membangun ulang .exe (hanya bila kode generator berubah): dari `tools/license-generator/gui` jalankan `node build.mjs`. Format lisensi tidak diduplikasi: build menyalin `src/lib.mjs` yang sama dengan CLI.

---

## 1. Konsep singkat

- Lisensi ditandatangani dengan **Ed25519** (kunci asimetris).
- **Private key** (`license-private.pem`) hanya ada di mesin vendor. Dipakai untuk **membuat** lisensi dan token Administrator.
- **Public key** sudah ter-embed di aplikasi klien (`apps/api/src/modules/license/license-public-key.ts`). Public key hanya bisa **memverifikasi**, tidak bisa membuat lisensi baru. Public key aman untuk dibundel.
- Tidak ada secret bersama (tidak ada `ADMIN_SECRET`). Lisensi palsu atau yang diubah ditolak karena tanda tangannya tidak cocok.

Format kunci lisensi:

```text
TFO2-<payload JSON base64url>.<tanda tangan base64url>
```

Isi payload: `lid` (License ID), `client`, `product` (selalu `TERRA FINANCE`), `expiry` (`null` = lifetime, atau `YYYY-MM-DD`), `devices` (activation policy), `issued`.

---

## 2. Lokasi private key

| Item | Lokasi default |
|---|---|
| Private key | `%USERPROFILE%\TERRA-VENDOR\license-private.pem` |
| Public key (salinan vendor) | `%USERPROFILE%\TERRA-VENDOR\license-public.pem` |
| Riwayat lisensi diterbitkan | `%USERPROFILE%\TERRA-VENDOR\issued-licenses.log` |

Folder ini **berada di luar repository**. Ubah lokasinya dengan variabel lingkungan `TERRA_VENDOR_DIR`, atau tunjuk file tertentu dengan `TERRA_LICENSE_PRIVATE_KEY` / `TERRA_LICENSE_PUBLIC_KEY`.

`.gitignore` sudah memblokir `*.pem`, `TERRA-VENDOR/`, `issued-licenses.log`, dan `license-private*`, tetapi tetap jangan menyimpan private key di repository.

---

## 3. Setup awal (sekali saja)

Dari folder repository:

```text
cd tools\license-generator
license-generator keygen
```

`keygen` membuat keypair sekali. Perintah ini menolak menimpa private key yang sudah ada, karena menimpanya akan merusak **semua** lisensi yang sudah diterbitkan.

Setelah keygen:

1. **Backup private key sekarang** (lihat bagian 7).
2. Public key otomatis ditulis ke `apps/api/src/modules/license/license-public-key.ts`. Commit file ini.
3. Jangan pernah menjalankan `keygen --force` kecuali Anda siap menerbitkan ulang semua lisensi klien.

---

## 4. Membuat lisensi baru

Mode interaktif (akan meminta input):

```text
license-generator create
```

Mode non-interaktif (untuk skrip):

```text
license-generator create --client "PT MIGAS WARDHANA" --expiry lifetime --devices 1
license-generator create --client "PT ABDI WARDHANA" --expiry 2031-06-30 --devices 1
```

Input:

- **Client Name**: nama klien yang tercantum di lisensi.
- **Product**: harus `TERRA FINANCE`.
- **Expiry**: `lifetime` atau tanggal `YYYY-MM-DD` (lisensi berlaku sampai akhir hari itu, UTC).
- **Activation Policy**: jumlah device, bilangan bulat >= 1.

Output:

```text
LICENSE GENERATED

License ID: TFL-...
Client: ...
Product: TERRA FINANCE
Expiry: Lifetime
Activation: 1 Device

License Key:
TFO2-....
```

Generator memverifikasi ulang kunci dengan public key sebelum menampilkannya. Setiap lisensi juga dicatat di `issued-licenses.log`. Lihat riwayat dengan `license-generator list`.

---

## 5. Verifikasi lisensi

```text
license-generator verify <license-key>
```

Perintah ini memakai **public key saja**, tanpa private key. Hasilnya `VALID` (dengan detail) atau `INVALID` (exit code 2). Kunci yang diubah sedikit pun akan `INVALID`.

Verifikasi dari sisi klien juga dilakukan otomatis: aplikasi menolak aktivasi jika kunci tidak valid, sudah expired, atau terikat ke komputer lain.

---

## 6. Token Administrator (maintenance)

Token Administrator dipakai untuk masuk ke menu Administrator di instalasi klien. Token ditandatangani vendor dan hanya berlaku untuk **satu license key**.

```text
license-generator admin-token <license-key>
```

Salin hasilnya dan masukkan di halaman login Administrator bersama license key tersebut. Token dari klien A tidak berlaku di klien B.

---

## 7. Backup dan pemulihan private key

### Lokasi
`%USERPROFILE%\TERRA-VENDOR\license-private.pem` (lihat bagian 2).

### Cara backup (wajib, segera setelah keygen)
1. Salin `license-private.pem` ke **minimal dua** media terpisah yang aman:
   - flash drive terenkripsi yang disimpan di lemari terkunci, dan
   - password manager / brankas terenkripsi (BitLocker, VeraCrypt, atau sejenisnya).
2. Jangan kirim private key lewat email, chat, atau cloud yang tidak terenkripsi.
3. Catat tanggal backup dan lokasinya di tempat yang aman, **bukan** di repository.
4. Uji restore sekali: salin dari backup ke folder lain, lalu jalankan `license-generator verify` dengan `TERRA_LICENSE_PRIVATE_KEY` diarahkan ke salinan itu (verifikasi memakai public key, tetapi `create` memakai private key).

### Jika private key hilang
- **Lisensi yang sudah terbit tetap valid** selama public key di aplikasi klien tidak berubah. Verifikasi memakai public key, dan public key sudah ada di aplikasi klien.
- **Anda tidak bisa lagi membuat lisensi baru atau token Administrator** dengan private key lama.
- Pemulihan yang benar: pakai backup. Jika tidak ada backup, lakukan keygen baru, lalu **semua instalasi klien harus diperbarui** dengan aplikasi yang memuat public key baru. Lisensi lama harus diterbitkan ulang. Ini harus direncanakan dan dikomunikasikan ke klien.
- **Jangan pernah** membuat keypair baru tanpa rencana, karena semua lisensi lama akan berhenti valid di build baru.

---

## 8. Membuat lisensi pengganti (replacement)

Lisensi pengganti dipakai saat lisensi lama habis masa berlakunya, atau saat klien meminta perubahan activation policy:

1. Terbitkan lisensi baru dengan TERRA License Generator (bagian 0) atau `license-generator create` (nama klien sama persis, expiry dan devices sesuai kesepakatan).
2. Kirim kunci baru ke klien.
3. Admin di komputer klien membuka menu **Lisensi** (sidebar kiri), menempel kunci, klik **Periksa kunci** (isi kunci ditampilkan: klien, tanggal berakhir, device), lalu **Terapkan lisensi**. Tidak perlu PowerShell/CMD dan tidak perlu teknisi.
   - Menu ini tetap bisa dibuka saat lisensi **sudah habis**; halaman Perusahaan yang terkunci menampilkan tautan "Periksa / perpanjang lisensi".
   - Aplikasi memberi peringatan sebelum lisensi habis (banner kuning di bawah 30 hari, merah di bawah 7 hari) dan banner merah permanen setelah habis. Data klien tidak pernah dihapus.
   - Bila nama klien pada kunci berbeda, atau masa berlakunya lebih singkat dari lisensi terpasang, aplikasi meminta konfirmasi tambahan. Kunci yang sudah kedaluwarsa tidak bisa diterapkan.
   - Hanya akun ber-role **admin** aplikasi yang dapat menerapkan kunci (ditegakkan di server); pengguna lain hanya melihat status.
   - Kunci dicek tanda tangannya di server. Kunci palsu ditolak dan lisensi lama tetap utuh (penggantian bersifat atomik). Penggantian tercatat di audit tanpa menyimpan isi kunci.

### Upgrade instalasi lama (lisensi format `TFO-...`)

Alur resminya:

```text
Lisensi lama (TFO-...)
→ dianggap legacy, tidak berlaku lagi
→ vendor menerbitkan lisensi baru dengan License Generator
→ teknisi mengaktifkan lisensi baru di komputer klien (langkah di bawah)
→ aplikasi klien memverifikasi tanda tangan dengan public key
```

Lisensi lama memakai skema HMAC dengan secret bersama yang sudah dihapus. Skema itu **tidak dihidupkan kembali** dan tidak ada konversi otomatis: setiap klien lama mendapat lisensi baru. Private key tetap hanya di mesin vendor; yang dibawa ke komputer klien hanya **kunci lisensi**.

Instalasi yang diaktivasi sebelum sistem lisensi Ed25519 menyimpan kunci format lama. Setelah aplikasi diperbarui, kunci itu terbaca **tidak valid**: pengguna tetap bisa login, tetapi semua data ditolak dengan pesan "Lisensi TERRA FINANCE belum aktif atau sudah tidak berlaku". Data tidak hilang dan tidak berubah.

Langkah (sekali per instalasi, sekitar satu menit; tanpa PowerShell):

1. Pasang installer baru di atas yang lama. Data tidak terhapus.
2. Buka TERRA FINANCE dan login dengan akun ber-role **admin** aplikasi (akun lain tidak bisa menerapkan lisensi).
3. Buka menu **Lisensi** di sidebar (atau klik tautan "Perpanjang lisensi" pada banner merah), tempel kode lisensi baru, klik **Periksa kunci**, lalu **Terapkan lisensi**.
4. Hasil sukses: pesan "berhasil diterapkan" dan status **Aktif**.

(Cadangan bila UI tidak bisa dipakai: endpoint `POST /api/license/replace` tetap tersedia untuk teknisi.)

Kunci palsu, kunci yang diubah, dan kunci yang sudah lewat tanggal ditolak, dan lisensi yang tersimpan tidak tersentuh.

---

## 9. Batasan yang perlu diketahui

- **Activation policy (devices)** tercatat di lisensi dan ditampilkan. Penegakan **per instalasi**: satu lisensi hanya bisa aktif di satu instalasi (fingerprint mesin). Menghitung device lintas komputer memerlukan server aktivasi online, yang belum dibangun.
- **Kedaluwarsa** dicek saat status dibaca. Lisensi expired membuat seluruh API bisnis ditolak (`403 LICENSE_INVALID`), sedangkan login, setup, lisensi, dan Administrator tetap bisa diakses supaya lisensi bisa diganti.
- Fingerprint mesin dapat berubah jika kartu jaringan atau hostname diganti. Dalam kasus itu lisensi ditandai `device_mismatch` dan perlu bantuan vendor.

---

## 10. Checklist scan sebelum rilis (wajib)

Jalankan setelah setiap build installer. Tujuannya memastikan private key dan kode signing tidak ikut ke client.

```text
# 1. Tidak ada private key di repository, dist, atau installer
Select-String -Path .\apps\desktop\dist\** -Pattern "PRIVATE KEY" -Recurse   # harus kosong
Select-String -Path .\deploy\api-hoisted\** -Pattern "PRIVATE KEY" -Recurse  # harus kosong

# 2. Tidak ada kode signing / generator di paket client
Select-String -Path .\deploy\api-hoisted\dist\** -Pattern "createPrivateKey|license-generator|TERRA-VENDOR" -Recurse  # harus kosong

# 3. Tidak ada ADMIN_SECRET / default secret lama
Select-String -Path .\apps\api\src\** -Pattern "ADMIN_SECRET|admin-secret" -Recurse  # harus kosong
```

Pemeriksaan yang sudah dilakukan pada build terakhir dicatat di laporan rilis.

---

## 11. Ringkasan alur dari awal sampai klien

1. `license-generator keygen` (sekali, lalu backup).
2. Commit `license-public-key.ts`, build installer.
3. Saat klien membeli: `license-generator create --client "<nama klien>" --expiry ... --devices ...`.
4. Verifikasi: `license-generator verify <kunci>`.
5. Kirim **kunci lisensi** dan installer ke klien (hanya kunci, bukan private key).
6. Klien install, lalu memasukkan kunci di wizard setup.
7. Bila perlu masuk Administrator: `license-generator admin-token <kunci>`.
8. Bila lisensi habis atau berubah: terbitkan pengganti, lalu klien memasukkannya lewat endpoint penggantian.
