# UI E2E Phase 5A/5B (laporan per cabang)

Chrome sungguhan terhadap server hasil build dengan salinan data UAT (bukan data nyata, bukan port 4000).

```bash
WORK=/path/kerja   # berisi node_modules/playwright-core, atau set PLAYWRIGHT_CORE
bash scripts/inter-branch-uat/reset-uat.sh $WORK /path/ke/backup-uat
node scripts/inter-branch-ui-e2e/server.cjs $WORK keep       # server port 4531
node scripts/phase5-ui-e2e/ui-scope.cjs $WORK                # 23 pemeriksaan; tangkapan layar di $WORK/shots-p5
taskkill //PID $(cat $WORK/server.pid) //F
```
Mencakup: LIMITED satu cabang (UI + akses langsung API), gabungan berlabel + posisi antar-kantor, komparasi, VIEWER tanpa opsi gabungan, dua tab dua cabang (sessionStorage), perusahaan tanpa multi-cabang tanpa pemilih.

## Electron (aplikasi terbungkus)
```bash
# build terisolasi (tidak menyentuh apps/desktop/dist), dari apps/desktop:
node scripts/prepare-deploy.js && npx electron-builder --dir "-c.directories.output=<folder-scratch>"
TERRA_EXE="<folder-scratch>/win-unpacked/TERRA FINANCE.exe" PLAYWRIGHT_CORE=<playwright-core> node scripts/phase5-ui-e2e/electron-scope.cjs $WORK   # 22 pemeriksaan
```
Data `$WORK/data` dipakai sebagai `--user-data-dir`; port 4000 harus bebas (tutup TERRA FINANCE lain). Tab kedua dibuka lewat `window.open`.
