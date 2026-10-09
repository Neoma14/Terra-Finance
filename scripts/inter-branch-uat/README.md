# UAT Antar Cabang (otomatis)

Menjalankan UAT terhadap **server hasil build** dengan **salinan data UAT** (bukan data nyata, bukan port 4000). Lihat `docs/architecture/INTER-BRANCH-UAT-REPORT.md`.

```bash
S=/path/kerja; mkdir -p $S
bash scripts/inter-branch-uat/reset-uat.sh $S /path/ke/backup-uat      # salin + migrasi + seed (multi-cabang ON hanya di salinan)
node scripts/inter-branch-uat/uat.mjs $S                               # HTTP UAT; hasil di $S/uat-results.json
# Electron (installer dibangun): UAT_EXTRA=1 PLAYWRIGHT_CORE=<playwright-core> node scripts/inter-branch-ui-e2e/electron-flow.cjs $S
```
`clock.mjs` menggeser jam server uji (kedaluwarsa); `uat.mjs` menyuntik trigger kegagalan sementara pada salinan DB uji lalu membuangnya (diverifikasi).
