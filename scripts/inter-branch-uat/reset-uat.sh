#!/usr/bin/env bash
# Menyiapkan data UAT terisolasi: salinan backup UAT 5 tahun -> migrasi (C0019) -> seed-uat (multi-cabang ON hanya di salinan, 3 cabang, persona).
# Pemakaian: reset-uat.sh <folder-kerja> <folder-backup-UAT>      (JANGAN diarahkan ke data pengguna nyata)
set -e
WORK="$(cd "$1" && pwd)"; BK="$(cd "$2" && pwd)"; HERE="$(cd "$(dirname "$0")" && pwd)"; UI="$HERE/../inter-branch-ui-e2e"
rm -rf "$WORK/data" && mkdir -p "$WORK/data/companies"
cp "$BK"/terra-finance-*.sqlite "$WORK/data/terra-finance.sqlite"
cp "$BK"/terra-system-*.sqlite "$WORK/data/terra-system.sqlite"
for d in "$BK"/companies/*/; do n=$(basename "$d"); mkdir -p "$WORK/data/companies/$n"; cp "$d"company-*.db "$WORK/data/companies/$n/company.db"; done
node "$UI/server.cjs" "$WORK" once
node "$HERE/seed-uat.mjs" "$WORK"
