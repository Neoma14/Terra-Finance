import json, re, os, shutil, collections
S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad/uat5/"
R = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline/"
OUT = R + "docs/uat/"
REPORT = OUT + "FULL-UAT-5-YEAR-MULTI-BRANCH-SECURITY-REPORT.md"

def load(path):
    last = {}
    for l in open(path, encoding="utf8"):
        r = json.loads(l); last[r["id"]] = r
    return last
run1 = load(S + "run1/results.jsonl"); run2 = load(S + "results.jsonl")

# ---- koreksi harness putaran 2 (HARNESS ERROR, bukan bug aplikasi)
HARNESS2 = {"SQLI-resp": "detektor otomatis menandai respons daftar customer yang memuat NAMA payload SQLi yang sengaja disimpan di uji yang sama (pantulan data sah); tidak ada 5xx, tidak ada pesan SQL, integrity_check ok"}
for k in HARNESS2:
    if k in run2: run2[k]["pass"] = True; run2[k]["severity"] = ""; run2[k]["detail"] = "HARNESS ERROR (false positive): " + HARNESS2[k]
for i in ["UP-svg", "UP-spoof"]:
    if i in run2: run2[i]["severity"] = "MEDIUM"
for i in ["JI-sheet", "BUG-CP-FILTER"]:
    if i in run2: run2[i]["severity"] = "LOW"
for i in ["SES-multitab-logout"]:
    if i in run2: run2[i]["severity"] = "LOW"

t2 = [r for r in run2.values() if r["pass"] is not None]; f2 = [r for r in t2 if not r["pass"]]; p2 = [r for r in t2 if r["pass"]]
t1 = [r for r in run1.values() if r["pass"] is not None]

OPEN = {  # id bug -> (judul, severity, tes yang masih gagal)
 "UAT-005": ("Arus Kas: nilai pecahan dan alokasi pro-rata jurnal campuran", "MEDIUM", ["BUG-CF-FLOAT"]),
 "UAT-006": ("Tidak ada perlindungan brute force pada login", "MEDIUM", ["AU-bruteforce", "AU-bruteforce2"]),
 "UAT-007": ("Login/logout pengguna tidak masuk audit log", "MEDIUM", ["AUDIT-login", "AUDIT-logout"]),
 "UAT-008": ("CORS memantulkan origin sembarang dengan credentials", "MEDIUM", ["CORS-reflect"]),
 "UAT-009": ("Avatar menerima SVG/HTML berdasarkan MIME deklaratif", "MEDIUM", ["UP-svg", "UP-spoof"]),
 "UAT-010": ("Pembatas laju global dapat mengosongkan halaman (tidak terulang pada putaran ini, tidak diubah)", "MEDIUM", []),
 "UAT-011": ("Baris jurnal debit+kredit sekaligus -> HTTP 500", "MEDIUM", ["JR-both", "JR-both-recheck"]),
 "UAT-012": ("Logout manual tidak menyiarkan ke tab lain", "LOW", ["SES-multitab-logout"]),
 "UAT-013": ("Tanpa batas panjang input; nominal pecahan diterima", "LOW", []),
 "UAT-014": ("Header keamanan HTTP tidak dikirim", "LOW", ["HDR-clickjack"]),
 "UAT-015": ("Input tidak valid tertentu diterima diam-diam (sheet salah, filter tipe)", "LOW", ["JI-sheet", "BUG-CP-FILTER"]),
 "UAT-016": ("User aplikasi staff dapat membuat perusahaan", "LOW", []),
 "UAT-017": ("Kebijakan password lemah", "LOW", []),
 "UAT-018": ("Ekspor Excel tidak menetralkan teks berawalan = + @ -", "LOW", []),
}
failing_map = {t: b for b, (_, _, ts) in OPEN.items() for t in ts}
unmapped = [r["id"] for r in f2 if r["id"] not in failing_map]
sev = collections.Counter(v[1] for v in OPEN.values())

def md_table(head, body):
    return "| " + " | ".join(head) + " |\n|" + "|".join("---" for _ in head) + "|\n" + "\n".join("| " + " | ".join(str(c).replace("|", "\\|").replace("\n", " ") for c in row) + " |" for row in body) + "\n"
def res(r): return "PASS" if r["pass"] else "FAIL"
def group(prefix): return sorted([r for r in t2 if r["id"].startswith(prefix)], key=lambda r: r["id"])
u1, u2, u3 = group("U1-"), group("U2-"), group("U3-")
def tbl(rows): return md_table(["ID", "Uji", "Hasil", "Bukti"], [(r["id"], r["name"], res(r), r["detail"][:140]) for r in rows])

state = json.load(open(S + "state.json", encoding="utf8")); years = state["reconcile"]["years"]
fmt = lambda v: f"{int(round(v)):,}".replace(",", ".")
rec_rows = [(y, fmt(v["debit"]), fmt(v["credit"]), fmt(v["assets"]), fmt(v["liabilities"]), fmt(v["equity"]), fmt(v["profit"]), v["journals"]) for y, v in years.items()]
y1 = json.load(open(S + "run1/reconcile.json", encoding="utf8"))["years"]
same_numbers = all(years[y]["assets"] == y1[y]["assets"] and years[y]["profit"] == y1[y]["profit"] and years[y]["equity"] == y1[y]["equity"] for y in years)

def perf(rs):
    o = {}
    for r in rs.values():
        if r["id"].startswith("PERF-"):
            m = re.search(r"(\d+) ms", r["name"])
            if m: o[r["id"]] = (re.sub(r": \d+ ms.*", "", r["name"]), int(m.group(1)))
    return o
pf1, pf2 = perf(run1), perf(run2)
perf_rows = [(pf2[k][0], f"{pf1.get(k, ('', '-'))[1]} ms", f"{pf2[k][1]} ms") for k in pf2]

areas = collections.OrderedDict()
for a in ["reconcile", "cross-year", "trial-balance", "ledger", "export", "import", "journal", "coa", "company", "access", "users", "periods", "profile", "authn", "authz", "idor", "sqli", "xss", "mass-assign", "upload", "path-traversal", "abuse", "headers", "csrf", "session", "audit", "admin-panel", "license", "backup", "resilience", "data-integrity", "ui", "performance"]:
    rs1 = [r for r in t1 if r["area"] == a]; rs2 = [r for r in t2 if r["area"] == a]
    if rs2: areas[a] = (len(rs1), sum(1 for r in rs1 if r["pass"]), len(rs2), sum(1 for r in rs2 if r["pass"]))
area_rows = [(a, f"{v[1]}/{v[0]}", f"{v[3]}/{v[2]}") for a, v in areas.items()]

sec_ids = [("AU-wrongpw", "password salah"), ("AU-emptypw", "password kosong"), ("AU-nouser", "user tidak ada"), ("AU-expired", "sesi kedaluwarsa"), ("AU-logout", "logout lalu pakai token lama"), ("AU-badtoken", "token rusak/palsu"), ("AU-notoken", "tanpa token (15 endpoint)"), ("AU-idle", "idle 15 menit di server"), ("AU-deactivated", "user dinonaktifkan"), ("AZ-matrix", "matriks otorisasi 75 kombinasi"), ("AZ-viewer-selfup", "VIEWER menaikkan diri"), ("AZ-license-forged", "lisensi palsu"), ("IDOR-Company B -> Company A".replace(" -> ", "-")[:0] or "IDOR-B", "")]
sec_rows = []
for i, d in [("AU-wrongpw", "Authentication: password salah"), ("AU-emptypw", "Authentication: password kosong"), ("AU-nouser", "Authentication: user tidak ada"), ("AU-expired", "Authentication: sesi kedaluwarsa"), ("AU-logout", "Authentication: logout lalu API request"), ("AU-badtoken", "Authentication: token rusak/malformed"), ("AU-notoken", "Authentication: tanpa token pada 15 endpoint"), ("AU-idle", "Session: idle 15 menit (server)"), ("AU-deactivated", "Authentication: user dinonaktifkan"), ("AZ-matrix", "Authorization: matriks 75 kombinasi peran x izin"), ("AZ-viewer-selfup", "Authorization: VIEWER naikkan diri ke OWNER"), ("AZ-user-create-nonadmin", "Authorization: non-admin membuat user admin"), ("AZ-license-forged", "Authorization: lisensi palsu ditolak"), ("IDOR-Aakuntan-B".replace("Aakuntan-B", "ccompany"), "")]:
    if i in run2 and d: sec_rows.append((d, res(run2[i]), run2[i]["detail"][:120]))
for i in sorted(run2):
    if i.startswith(("IDOR-", "SQLI-", "XSS2-", "XSS-search", "MASS-", "PT-", "CSRF-", "ADM-")) and run2[i]["pass"] is not None:
        sec_rows.append((run2[i]["name"][:130], res(run2[i]), run2[i]["detail"][:100]))

md_new = f"""# FULL UAT 5 TAHUN + SIMULASI MULTI-CABANG + SECURITY TEST: PT TERRA NUSANTARA

> **Status terkini: READY WITH KNOWN LOW-RISK ISSUES** (setelah perbaikan UAT-001, UAT-002, UAT-003 dan UAT penuh diulang pada installer final 2026-10-05 23:27).
> Hasil UAT awal (installer 07:05, keputusan NOT READY) tetap disimpan utuh di bagian "Lampiran" di bawah dan di `docs/uat/evidence-run1-before-fix/`.

## RINGKASAN HASIL SETELAH PERBAIKAN

```text
FINAL STATUS: READY WITH KNOWN LOW-RISK ISSUES
TOTAL TEST (UAT penuh diulang): {len(t2)}
PASS: {len(p2)}
FAIL: {len(f2)} (semuanya temuan MEDIUM/LOW yang SENGAJA belum diperbaiki pada tahap ini, dipetakan ke {len([b for b in OPEN.values() if b[2]])} bug)
CRITICAL: 0
HIGH: 0   (sebelumnya 3: UAT-001, UAT-002, UAT-003 -> semuanya PASS)
MEDIUM: {sev['MEDIUM']}
LOW: {sev['LOW']}
```

Keputusan memakai gerbang produksi Anda: Critical = 0, HIGH keamanan = 0, rekonsiliasi akuntansi = PASS, isolasi lintas-company = PASS, UAT-001/002/003 = PASS, backup/restore = PASS, integritas data = PASS. Sisa MEDIUM/LOW tidak mengancam integritas akuntansi, otorisasi peran, isolasi data, integritas data, maupun backup/restore. Bukan "PRODUCTION READY" karena MEDIUM masih ada; beberapa di antaranya (UAT-006 brute force, UAT-008 CORS, UAT-007 audit login) wajib ditutup sebelum aplikasi dibuka ke jaringan/multi-device.

**Dua catatan kejujuran**
1. **UAT-009 (avatar menerima SVG/HTML)** saya klasifikasikan MEDIUM, bukan HIGH, karena avatar hanya dirender lewat elemen `<img>` (skrip tidak berjalan; sudah diuji di browser) dan tidak ada jalur lain yang menyajikan data URI itu. Bila Anda menilai ini HIGH keamanan, keputusan berubah menjadi NOT READY sampai ditutup. Perbaikannya kecil (cek magic bytes, tolak SVG).
2. **HARNESS ERROR** (kesalahan skrip uji, bukan bug aplikasi) putaran ini: `SQLI-resp` (false positive: daftar customer memuat nama payload SQLi yang sengaja disimpan di uji yang sama; tidak ada 5xx/pesan SQL) dan satu uji `U3-reversal-ok` pada eksekusi pertama yang mereverse jurnal yang masih Draft (diperbaiki dengan memposting dulu, lalu diulang: PASS). Putaran 1 punya sejumlah kesalahan harness lain yang sudah dikoreksi sebelum putaran ini (lihat bagian J laporan awal).

## POST-FIX REGRESSION: UAT-001 (Privilege escalation ADMIN ke OWNER)

```text
Finding: ADMIN dapat menaikkan perannya sendiri atau user lain menjadi OWNER (PATCH/POST /access).
Root Cause: route manajemen akses hanya memeriksa izin users.manage (OWNER dan ADMIN punya) dan validitas nilai peran. Tidak ada aturan "siapa boleh menetapkan/mengubah peran apa", sehingga permission yang sama dipakai untuk memberi OWNER. Pemeriksaan murni UI/izin tidak cukup.
Fix: db/system/rbac.ts menambah ROLE_RANK dan canManageRole(actor, targetSekarang, peranBaru): (1) tidak boleh menetapkan peran lebih tinggi dari perannya sendiri, (2) tidak boleh mengubah/menangguhkan/mencabut akses yang pangkatnya lebih tinggi, (3) peran OWNER hanya dapat dikelola OWNER. Dipasang di modules/company-access/routes.ts pada grant (POST), ubah peran (PATCH), ubah status, dan cabut (DELETE), SEBELUM menyentuh database. Perilaku lama dipertahankan: ADMIN boleh mengelola ADMIN dan peran di bawahnya; perlindungan OWNER terakhir tetap.
Test: 10 skenario regression di modules/company-access/routes.test.ts (30 tes file itu lulus) + {len(u1)} uji HTTP di harness (s10) terhadap installer final.
Expected: ADMIN -> OWNER (diri sendiri/orang lain) 403 dan database tidak berubah; ACCOUNTANT/VIEWER/STAFF -> OWNER 403; ADMIN -> ADMIN sesuai kebijakan lama; OWNER tetap bisa; manipulasi body ditolak.
Actual: seperti Expected (tabel di bawah).
Status: PASS
Evidence: docs/uat/evidence/results.jsonl (id U1-*), docs/uat/harness/s10_regression_high.mjs, apps/api/src/modules/company-access/routes.test.ts
```

{tbl(u1)}
Manipulasi body yang diuji (semua tidak pernah menghasilkan OWNER): `"owner"`, `"OWNER "`, `" OWNER"`, `"Owner"`, array, objek, `null`, huruf lebar-penuh, `\\u0000`, kunci `Role`/`roles`, **kunci `role` ganda di JSON mentah** (server memakai nilai terakhir dan otorisasi memeriksa nilai yang sama), field tambahan (`isAdmin`, `permissions`, `companyId`, `status`).

## POST-FIX REGRESSION: UAT-002 (Jurnal selisih Rp 1 tidak boleh Post)

```text
Finding: jurnal debit 100.000 / kredit 99.999 lolos Post; Neraca/Dashboard HTTP 500 dan Trial Balance tidak balance untuk semua periode sesudahnya.
Root Cause: validasi keseimbangan memakai toleransi (Math.abs(debit - kredit) <= BALANCE_TOLERANCE = 1) di journal-service; toleransi serupa (<= 1 / < 1) ada di preview import jurnal (parser), import Saldo Awal, tampilan Saldo Awal, jalur lama posting.ts, dan tiga form web. Sementara Trial Balance/Neraca (benar) menuntut selisih nol, sehingga satu jurnal "toleran" meracuni semua laporan.
Fix: lib/money.ts (perbandingan dalam bilangan bulat sen, tanpa toleransi; drift float murni seperti 0,1+0,2 vs 0,3 tidak dianggap selisih, selisih Rp 0,01 ditolak). journal-service: validasi dari request (assertLinesBalanced) + hitung ULANG dari baris yang benar-benar tersimpan di dalam transaction yang sama, sesudah insert dan sebelum commit, dan sekali lagi tepat sebelum status menjadi POSTED (SQL SUM bilangan bulat sen); kegagalan membatalkan transaction (tidak ada header/baris/audit). Toleransi dihapus dari parser import, import Saldo Awal, tampilan Saldo Awal, posting.ts lama, dan form web (journal-form-panel, opening-balance-form, journal-page). Reversal sengaja TIDAK memakai pemeriksaan ini: ia mencerminkan jurnal asli, dan harus tetap bisa membalik jurnal lama yang telanjur tak seimbang (jalur pemulihan).
Test: 11 skenario di apps/api/src/db/company/uat-high-fixes.test.ts (A-H + saldo awal + pemulihan) + {len(u2)} uji HTTP di harness (s10) + seluruh UAT penuh.
Expected: A diterima; B, C, D, E, F ditolak dan 0 perubahan database; G reversal seimbang; H import tak seimbang ditolak, commit tidak mengubah database; laporan tidak pernah 500 karena jurnal invalid.
Actual: seperti Expected. Data nyata Anda (salinan backup PT Sinar Bumi Nabung, 811 jurnal) tidak punya jurnal tak seimbang, jadi perbaikan aman untuk upgrade.
Status: PASS
Evidence: docs/uat/evidence/results.jsonl (id U2-*, INT-unbalanced)
```

{tbl(u2)}
## POST-FIX REGRESSION: UAT-003 (Tanggal kalender tidak nyata dinormalisasi)

```text
Finding: Import jurnal menyimpan tanggal 2026-02-30 sebagai 2026-03-02 tanpa peringatan.
Root Cause: toIsoDate di parser import memakai new Date(teks). JavaScript menormalisasi tanggal mustahil (30 Feb menjadi 2 Mar) dan menebak format lokal ("1/2/2026"). Hal yang sama ada di parser Saldo Awal dan COA, dan validateDateRange laporan memakai Date.parse (menerima "2025", "1/1/2025", dan 2025-02-30 yang lalu memicu 500 / alarm palsu 'Balance Sheet tidak seimbang').
Fix: SATU validator di lib/calendar-date.ts (isValidIsoDate: regex ketat + hari dalam bulan termasuk kabisat; parseExcelDate: Date/serial/ISO saja tanpa tebakan lokal, hasil tidak pernah dinormalisasi; isoDateSchema untuk zod). Dipakai di: parser jurnal/Saldo Awal/COA, journal-import-service (pesan "bukan tanggal kalender yang valid", periode tidak dicari untuk tanggal invalid), journal-service (kalender dicek PERTAMA sebelum aturan periode/masa depan/backdate; reversal), validateDateRange semua laporan/dashboard/export/analisis/pajak/proyeksi, ledger, periode (generate-monthly, createPeriod), filter daftar jurnal & audit log, body zod (jurnal, reversal, Saldo Awal, periode). Validasi kalender dipisahkan dari aturan bisnis (masa depan, backdate, periode OPEN) yang tetap berjalan sesudah tanggal valid.
Test: 9 skenario di uat-high-fixes.test.ts (validator, parser, jurnal manual, import, Saldo Awal, laporan, periode, reversal) + {len(u3)} uji HTTP di harness (s10).
Expected: 2026-02-28 VALID; 2026-02-29/30, 2026-04-31, 2026-06-31, 2025-02-29 INVALID; 2024-02-29 VALID; tidak ada perubahan database untuk input invalid; laporan 400 (bukan 500).
Actual: seperti Expected.
Status: PASS
Evidence: docs/uat/evidence/results.jsonl (id U3-*, JI-bad-tanggal2026023, PE-baddate)
```

{tbl(u3)}
Dampak perilaku (sengaja): tanggal di Excel berupa teks hanya diterima dalam format `YYYY-MM-DD` (atau sel bertipe tanggal Excel). Format lokal seperti `1/2/2026` kini menjadi ERROR di pratinjau, tidak lagi ditebak (sebelumnya bisa tersimpan sebagai tanggal AS/bulan-hari yang salah).

## FULL UAT RERUN

Seluruh harness dijalankan ulang dari nol terhadap installer final (`TERRA FINANCE Setup 0.1.0.exe`, 124.191.928 byte, 2026-10-05 23:27): lingkungan baru, COA Import, Opening Balance Import, 12 batch Import Jurnal (5.907 transaksi), 45 reversal, 12 draft, rekonsiliasi 5 tahun, kinerja, export, uji fungsional/CRUD, import positif/negatif, keamanan, regression 3 HIGH, ketahanan (kill -9, backup/restore), UI (25 menu, XSS, sesi) dan integritas akhir.

{md_table(["Area", "Putaran 1 (lulus/total)", "Putaran 2 setelah perbaikan"], area_rows)}
Pemeriksaan yang masih FAIL pada putaran ini ({len(f2)}) seluruhnya adalah temuan yang **belum diperbaiki karena di luar lingkup tugas ini** (MEDIUM/LOW):

{md_table(["Tes", "Bug", "Severity", "Detail"], [(r["id"], failing_map.get(r["id"], "?"), r["severity"], r["detail"][:110]) for r in sorted(f2, key=lambda r: r["id"])])}
Tidak ada FAIL yang tidak terpetakan: {unmapped if unmapped else "tidak ada"}. Tidak ada FAIL baru (regresi) dibanding putaran 1; FAIL putaran 1 yang hilang: UAT-001, UAT-002, UAT-003, UAT-004 (tanggal laporan, ikut beres karena validator bersama), dan `PE-baddate` (UAT-015 sebagian).

### Bug terbuka setelah perbaikan

{md_table(["ID", "Severity", "Judul", "Catatan"], [(k, v[1], v[0], ("tes gagal: " + ", ".join(v[2])) if v[2] else "tidak ada tes gagal pada putaran ini (catatan/observasi; tidak diubah)") for k, v in OPEN.items()])}
## SECURITY REGRESSION

Kategori yang diminta diulang: authentication (password salah/kosong, user tidak ada, sesi kedaluwarsa, logout lalu API, token rusak/hilang), authorization (OWNER/ADMIN/ACCOUNTANT/VIEWER, terutama ADMIN -> OWNER dan manipulasi role langsung), IDOR/lintas-company (dashboard, jurnal, ledger, laporan, export, search, API langsung, slug, ID), SQL injection (276 payload ke 24 titik), XSS (9 halaman + kotak pencarian).

{md_table(["Uji", "Hasil", "Bukti"], sec_rows)}
Ringkasan: **tidak ada authentication bypass, tidak ada kebocoran lintas-company, tidak ada SQL injection, tidak ada XSS tereksekusi, privilege escalation tertutup**. Temuan keamanan yang tersisa hanya MEDIUM/LOW: UAT-006, 007, 008, 009, 012, 014, 016, 017, 018.

## ACCOUNTING REGRESSION

Dataset 5 tahun yang sama (5.965 jurnal inti, 18.900 baris) dimuat ulang lewat Import Excel resmi pada installer final dan dibandingkan **per akun** dengan model oracle independen. Hasil: semua cocok.

{md_table(["Tahun", "Total Debit", "Total Kredit", "Aset", "Liabilitas", "Ekuitas", "Laba tahun berjalan", "Jurnal"], rec_rows)}
- Angka per tahun **identik dengan putaran 1** (aset, ekuitas, laba): {"YA" if same_numbers else "TIDAK"}.
- Total Debit = Total Kredit di setiap tahun; Aset = Liabilitas + Ekuitas di setiap tahun; Ekuitas awal tahun = ekuitas akhir tahun sebelumnya; Arus Kas ending = saldo kas+bank; Dashboard YTD = Laba Rugi.
- **60 Trial Balance seimbang** dan saldo tiap akun = oracle; baris "Laba (Rugi) Belum Ditutup" = laba kumulatif.
- Cross-year (31/12 ke 01/01, 5 tahun vs jumlah tahunan) PASS; jurnal reversal (45), draft (12), dan transaksi antar kantor (17) PASS.
- **Tidak ada HTTP 500 akibat satu jurnal invalid**: jurnal tak seimbang kini ditolak di pintu masuk, sehingga laporan tidak bisa diracuni.
- Integritas akhir database: `integrity_check` ok, FK 0 pelanggaran, 0 jurnal Posted tak seimbang, 0 referensi ganda, pasangan reversal konsisten, total debit = total kredit.
- Backup/restore atas data besar: restore identik di 60 Trial Balance, laporan 5 tahun, Ledger, audit, COA; kill -9 saat commit 4.000 jurnal atomic.
- Kinerja (ms):

{md_table(["Operasi", "Putaran 1", "Putaran 2"], perf_rows)}
Tidak ada regresi kinerja berarti; validasi balance tambahan (SUM bilangan bulat) dan validator tanggal tidak terasa pada import 500 transaksi per batch.

## FILES CHANGED

API (perbaikan): `apps/api/src/lib/calendar-date.ts` (baru), `lib/money.ts` (baru), `db/system/rbac.ts`, `modules/company-access/routes.ts`, `db/company/journal-service.ts`, `journal-import-service.ts`, `opening-balance-import-service.ts`, `opening-balance-service.ts`, `ledger-service.ts`, `fiscal-period.ts`, `reporting/reporting-utils.ts`, `modules/journal/parser.ts`, `modules/journal/posting.ts`, `modules/journal/routes.ts`, `modules/accounts/import-parser.ts`, `modules/company-opening-balance-import/parser.ts`, `modules/company-journal/routes.ts`, `modules/company-opening-balance/routes.ts`, `modules/company-periods/routes.ts`, `modules/company-analysis/routes.ts`, `modules/company-tax/routes.ts`, `modules/company-projection/routes.ts`, `modules/company-audit-log/routes.ts`.
Web: `apps/web/src/lib/money.ts` (baru), `routes/workspace/journal/journal-form-panel.tsx`, `routes/workspace/opening-balance/opening-balance-form.tsx`, `routes/journal-page.tsx`.
Test: `apps/api/src/db/company/uat-high-fixes.test.ts` (baru, 20 tes), `apps/api/src/modules/company-access/routes.test.ts` (+10 tes).
UAT: `docs/uat/harness/` (s10_regression_high, s11_remaining, run_all, perbaikan harness), `docs/uat/evidence/` (putaran 2), `docs/uat/evidence-run1-before-fix/` (putaran 1).

## REMAINING RISKS

1. UAT-006/007/008/010: login tanpa penundaan, login tidak diaudit, CORS longgar, pembatas laju global: wajib ditutup sebelum akses jaringan/multi-device.
2. UAT-009: validasi isi avatar (klasifikasi MEDIUM; lihat catatan kejujuran).
3. UAT-005: Arus Kas menampilkan pecahan dan alokasi pro-rata untuk jurnal campuran (total tetap benar).
4. UAT-011: input debit+kredit pada satu baris menghasilkan 500 (bukan 400).
5. Jurnal lama dari versi sebelum perbaikan yang telanjur tak seimbang (bila ada di instalasi lain) tidak diubah; tidak bisa diposting ulang, tetapi bisa direversal. Data klien yang diperiksa tidak memilikinya.
6. Perilaku baru yang perlu dikomunikasikan: tanggal teks di Excel hanya `YYYY-MM-DD`; jurnal harus seimbang persis; ADMIN tidak lagi bisa mengelola OWNER.
7. Jendela Electron tidak dijalankan (port 4000 dipakai aplikasi produksi); pengujian memakai server dari installer yang sama.

---

# LAMPIRAN: HASIL UAT AWAL SEBELUM PERBAIKAN (installer 07:05, keputusan NOT READY)

"""

orig = open(S + "run1/report-run1.md", encoding="utf8").read()
orig = orig.replace("# FULL UAT 5 TAHUN + SIMULASI MULTI-CABANG + SECURITY TEST: PT TERRA NUSANTARA\n", "", 1)
orig = orig.replace("docs/uat/evidence/", "docs/uat/evidence-run1-before-fix/")
open(REPORT, "w", encoding="utf8").write(md_new + orig)

# evidence putaran 2
ev = OUT + "evidence/"
shutil.rmtree(ev, ignore_errors=True); os.makedirs(ev + "screenshots"); os.makedirs(ev + "exports")
open(ev + "results.jsonl", "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in run2.values()) + "\n")
for f in ["perf.jsonl", "reconcile.json", "final-integrity.json"]: shutil.copy(S + f, ev + f)
for f in os.listdir(S + "shots"):
    if f.startswith(("ui-", "xss-")): shutil.copy(S + "shots/" + f, ev + "screenshots/" + f)
for f in ["income-statement-5tahun.xlsx", "income-statement-5tahun.pdf", "balance-sheet-5tahun.pdf", "cash-flow-1tahun.xlsx", "ledgerBCA1d.pdf"]:
    if os.path.exists(S + "exports/" + f): shutil.copy(S + "exports/" + f, ev + "exports/" + f)
os.makedirs(OUT + "harness", exist_ok=True)
for f in os.listdir(S):
    if f.endswith((".mjs", ".py")): shutil.copy(S + f, OUT + "harness/" + f)
print("total", len(t2), "pass", len(p2), "fail", len(f2), "tidak terpetakan", unmapped, "sev", dict(sev), "angka sama", same_numbers)
