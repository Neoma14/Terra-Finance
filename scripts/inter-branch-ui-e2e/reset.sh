#!/usr/bin/env bash
# Menyiapkan ulang data uji (salinan UAT), migrasi, seed persona, lalu menjalankan server hasil build di port 4531.
# Pemakaian: reset.sh <folder-kerja> <folder-backup-UAT> [data-only]
#   data-only: hanya menyiapkan data (tanpa menjalankan server port 4531), mis. sebelum membuka aplikasi Electron dengan --user-data-dir=<folder-kerja>/data
#   <folder-backup-UAT> berisi terra-finance-*.sqlite, terra-system-*.sqlite, companies/<slug>/company-*.db (hasil backup aplikasi).
set -e
WORK="$(cd "$1" && pwd)"; BK="$(cd "$2" && pwd)"; HERE="$(cd "$(dirname "$0")" && pwd)"
PID=$(cat "$WORK/server.pid" 2>/dev/null || true); [ -n "$PID" ] && (taskkill //PID "$PID" //F >/dev/null 2>&1 || kill "$PID" 2>/dev/null || true); sleep 2
rm -rf "$WORK/data" && mkdir -p "$WORK/data/companies"
cp "$BK"/terra-finance-*.sqlite "$WORK/data/terra-finance.sqlite"
cp "$BK"/terra-system-*.sqlite "$WORK/data/terra-system.sqlite"
for d in "$BK"/companies/*/; do n=$(basename "$d"); mkdir -p "$WORK/data/companies/$n"; cp "$d"company-*.db "$WORK/data/companies/$n/company.db"; done
node "$HERE/server.cjs" "$WORK" once      # migrasi (company.db -> C0019)
node "$HERE/seed.mjs" "$WORK"             # multi-cabang ON + cabang + akun antarkantor + persona + sesi
if [ "${3:-}" != "data-only" ]; then
  node "$HERE/server.cjs" "$WORK" keep    # server tetap hidup
  sleep 6; curl -s http://127.0.0.1:4531/api/health; echo
fi
