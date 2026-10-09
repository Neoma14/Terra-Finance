# Uji UI end-to-end Antar Cabang (Chrome sungguhan)

Menjalankan alur utama di browser terhadap **server hasil build** (`apps/api/dist`, `apps/web/dist`) dengan **salinan data UAT**.
Tidak menyentuh data produksi/klien dan tidak memakai port 4000.

Prasyarat: `pnpm -C apps/api build`, `pnpm -C apps/web build`, Google Chrome, `playwright-core` (di folder kerja: `npm i playwright-core`),
dan satu folder backup UAT (struktur backup aplikasi).

```bash
WORK=/tmp/ib-ui; mkdir -p $WORK && (cd $WORK && npm init -y >/dev/null && npm i playwright-core)
bash scripts/inter-branch-ui-e2e/reset.sh $WORK /path/ke/backup-uat      # data + seed + server port 4531
node scripts/inter-branch-ui-e2e/ui-flow.cjs $WORK                       # 29 pemeriksaan; screenshot di $WORK/shots
```

Persona yang dibuat `seed.mjs`: OWNER, ACCOUNTANT Metro (LIMITED), ACCOUNTANT Bandar Lampung (LIMITED), ADMIN dua cabang, STAFF, VIEWER, pengguna tanpa cabang, dan OWNER perusahaan lain (multi-cabang OFF).
Sesi dibuat langsung (login UI diuji di tempat lain). Hentikan server: `taskkill //PID $(cat $WORK/server.pid) //F`.

## Uji jendela Electron (aplikasi terbungkus)
`electron-flow.cjs` menjalankan `apps/desktop/dist/win-unpacked/TERRA FINANCE.exe` dengan `--user-data-dir=<kerja>/data` dan `--remote-debugging-port=9333`, lalu terhubung lewat CDP (login sungguhan, 23 pemeriksaan).
```bash
bash scripts/inter-branch-ui-e2e/reset.sh $WORK /path/ke/backup-uat data-only   # tanpa server 4531
node scripts/inter-branch-ui-e2e/electron-flow.cjs $WORK                        # tutup dulu aplikasi TERRA FINANCE; port 4000 harus bebas
node scripts/inter-branch-ui-e2e/verify-accounting.mjs $WORK                    # verifikasi akuntansi (baca-saja)
```
Catatan: `ELECTRON_RUN_AS_NODE` dihapus dari lingkungan proses yang diluncurkan (skrip sudah melakukannya). Bucket rate-limit `auth` 30/menit: skrip menunggu 65 dtk bila logout mendapat 429. Jangan jalankan terhadap data pengguna nyata.
