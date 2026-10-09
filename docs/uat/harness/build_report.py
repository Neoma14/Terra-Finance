import json, re, os, shutil, collections
S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad/uat5/"
R = "D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline/"
OUT = R + "docs/uat/"
os.makedirs(OUT + "evidence/screenshots", exist_ok=True); os.makedirs(OUT + "evidence/exports", exist_ok=True); os.makedirs(OUT + "harness", exist_ok=True)

rows = [json.loads(l) for l in open(S + "results.jsonl", encoding="utf8")]
last = {}
for r in rows: last[r["id"]] = r          # uji ulang menimpa uji awal dengan ID sama
DROP = {"MN-bm": "salah parameter uji; digantikan MN-bm2", "AU-bruteforce": "password uji terlalu pendek (ditolak validasi); digantikan AU-bruteforce2", "PE-closed-journal": "periode belum LOCKED pada uji awal; digantikan PE-closed-journal2", "AUDIT-account_unlock": "uji belum memanggil unlock; digantikan AUDIT-unlock2", "OBI-post": "import commit sudah otomatis memposting (409 pada Post kedua adalah perilaku benar)", "OB-POST": "import Saldo Awal sudah otomatis memposting (409 pada Post kedua adalah perilaku benar)"}
for i in ["XSS-daftarjurnal", "XSS-detailjurnal", "XSS-COA", "XSS-daftarperusa", "XSS-useraplikasi", "XSS-auditlog", "XSS-hutangpiutan", "XSS-ledger", "XSS-penggunaperu"]: DROP[i] = "selektor uji salah (mengena skrip inline sah); digantikan XSS2-*"
for k in DROP: last.pop(k, None)
if "SQLI-resp" in last:
    last["SQLI-resp"].update(pass_=True) if False else None
    last["SQLI-resp"]["pass"] = True; last["SQLI-resp"]["severity"] = ""; last["SQLI-resp"]["detail"] = "Tidak ada injeksi SQL. 5 'temuan' otomatis adalah pantulan payload di respons sah (nilai disimpan dan dikembalikan apa adanya) dan satu 500 akibat validasi tanggal longgar (lihat UAT-004)."
if "AUDIT-login" in last: last["AUDIT-login"]["pass"] = False; last["AUDIT-login"]["severity"] = "MEDIUM"; last["AUDIT-login"]["detail"] = "hanya administrator.login yang tercatat; login/logout/gagal-login pengguna biasa tidak"
for i in ["UP-svg", "UP-spoof"]:
    if i in last: last[i]["severity"] = "MEDIUM"; last[i]["detail"] += " | dirender lewat <img> (skrip tidak berjalan); risiko bila data URI dipakai di luar <img>"
if "UI-menu-LaporanKeuanga" in last: last["UI-menu-LaporanKeuanga"]["severity"] = "MEDIUM"; last["UI-menu-LaporanKeuanga"]["detail"] = "halaman kosong (HTTP 429 pada shell setelah 17 halaman berurutan dibuka cepat); dibuka ulang setelah jeda: normal"
for i in ["JI-sheet", "PE-baddate"]:
    if i in last: last[i]["severity"] = "LOW"

tests = [r for r in last.values() if r["pass"] is not None]
notes = [r for r in last.values() if r["pass"] is None]
passed = [r for r in tests if r["pass"]]; failed = [r for r in tests if not r["pass"]]

BUGS = [
 ("UAT-001", "ADMIN dapat menaikkan perannya sendiri atau user lain menjadi OWNER", "HIGH", "Security / Authorization", ["BUG-PRIV-ADMIN-OWNER", "BUG-PRIV-ADMIN-GRANT"],
  "Login sebagai user berperan ADMIN di Company A. Kirim PATCH /api/company-db/pt-terra-nusantara/access/<id-admin> {role:\"OWNER\"}; ulangi untuk user VIEWER.",
  "Hanya OWNER yang boleh memberi/mengubah peran OWNER (rbac.ts menyempitkan backup/restore ke OWNER).", "HTTP 200; peran sesudahnya OWNER (diverifikasi lewat daftar akses). Peran dipulihkan setelah uji.",
  "Insider ADMIN mengambil alih perusahaan: dapat menjadi OWNER, memberi OWNER ke akun lain, dan menembus pemisahan hak (backup/restore khusus OWNER).", "Tidak langsung.", "Tidak langsung; perubahan tercatat di audit (company.access.role_changed).",
  "Tolak perubahan peran ke/dari OWNER bila pelaku bukan OWNER, termasuk menaikkan diri sendiri."),
 ("UAT-002", "Jurnal selisih Rp 1 (toleransi pembulatan) lolos Post lalu merusak Neraca, Dashboard (HTTP 500) dan Trial Balance untuk semua periode sesudahnya", "HIGH", "Accounting engine", ["BUG-ACC-TOL", "JR-unbal", "INT-unbalanced"],
  "ACCOUNTANT membuat jurnal debit 1.000 / kredit 999 di Feb 2026 lalu Post. Buka Trial Balance Feb 2026, Neraca, Dashboard.",
  "Jurnal tidak seimbang ditolak; atau laporan tetap tampil.", "Jurnal diterima dan Posted. Trial Balance: selisih 1 (tidak balance). Neraca dan Dashboard: HTTP 500 \"Balance Sheet tidak seimbang ... selisih 1\" untuk setiap rentang yang memuat periode itu. Pulih setelah jurnal direversal.",
  "Tidak ada.", "Tinggi: satu jurnal bernilai Rp 1 membuat seluruh laporan utama perusahaan tidak dapat dibuka sampai direversal.", "Tidak ada kerusakan data (hanya akumulasi selisih); semua laporan terblokir.",
  "Terapkan debit = kredit persis (nilai rupiah bulat), atau hilangkan toleransi 1 pada validasi jurnal; pertimbangkan laporan tetap tampil dengan peringatan, bukan 500."),
 ("UAT-003", "Import jurnal menerima tanggal yang tidak nyata (2026-02-30) sebagai VALID dan menyimpannya dengan tanggal bergeser (2026-03-02)", "HIGH", "Journal import", ["BUG-IMP-DATE", "JI-bad-tanggal2026023", "JI-badcm-tanggal2026023"],
  "Unggah Excel dengan Tgl = 2026-02-30 pada transaksi seimbang; Preview; Submit.", "Tanggal ditolak (Error) seperti 2026-13-45 atau teks bebas.", "Preview VALID, commit sukses; jurnal IMP-E3 tersimpan POSTED dengan entry_date 2026-03-02.",
  "Tidak ada.", "Tanggal transaksi berubah diam-diam; dapat memindahkan transaksi ke periode/bulan lain tanpa peringatan.", "Data keuangan salah tanpa jejak peringatan.",
  "Validasi kalender ketat (round-trip tanggal) di parser import, sama seperti jalur jurnal manual."),
 ("UAT-004", "Parameter tanggal laporan/dashboard diparse longgar: '2025', '1/1/2025', \"' OR '1'='1\" menghasilkan HTTP 500 atau alarm palsu 'Balance Sheet tidak seimbang' (mis. 2025-02-30)", "MEDIUM", "Reporting API validation", ["BUG-DATE-LENIENT"],
  "GET /dashboard atau /reports/balance-sheet dengan fromDate=2025-02-30 / 2025 / 1/1/2025.", "400 dengan pesan tanggal tidak valid (seperti Ledger).", "500 'Invalid time value' atau 500 'Balance Sheet tidak seimbang'; Laba Rugi menerima dan memberi hasil.",
  "Tidak ada injeksi SQL (nilai terikat sebagai parameter).", "Alarm integritas palsu menyesatkan.", "Tidak ada.", "Gunakan validasi tanggal ketat yang sama dengan Ledger (isValidIsoDate) di semua endpoint laporan."),
 ("UAT-005", "Arus Kas: nilai rupiah pecahan/noise floating-point dan alokasi kas pro-rata pada jurnal campuran", "MEDIUM", "Cash flow report", ["BUG-CF-FLOAT"],
  "Buka Arus Kas 2025 pada dataset UAT (pembelian gedung Rp 800 jt: Bank 500 jt + Utang Bank 300 jt).", "Angka rupiah bulat; pembiayaan non-kas tidak tampil sebagai arus pendanaan negatif.",
  "operasi 8467770000.000004; investasi -483636363.6363636; pendanaan -136363636.36363634. Total tetap cocok dengan perubahan kas.", "Tidak ada.", "Klasifikasi arus kas untuk jurnal dengan lebih dari satu akun lawan tidak intuitif; total benar.", "Tidak ada.", "Bulatkan di sumber dan dokumentasikan/ubah aturan alokasi untuk jurnal campuran (transaksi non-kas)."),
 ("UAT-006", "Tidak ada perlindungan brute force pada login", "MEDIUM", "Authentication", ["AU-bruteforce2"],
  "30 login gagal beruntun ke akun Owner lalu login benar.", "Penundaan/penguncian setelah beberapa kegagalan.", "Semua 401; login benar sesudahnya 200; satu-satunya pembatas adalah limiter global 200 permintaan/menit.", "Tebakan password dapat diotomasi pada batas 200/menit.", "Tidak ada.", "Tidak ada.", "Penundaan progresif / penguncian sementara per akun + audit login gagal."),
 ("UAT-007", "Login, logout, dan gagal-login pengguna tidak tercatat di audit log", "MEDIUM", "Audit", ["AUDIT-login", "AUDIT-logout", "BUG-AUDIT-LOGIN"],
  "Login/logout lalu periksa audit log perusahaan, master, dan system.", "Aktivitas login tercatat.", "Hanya administrator.login yang ada; login pengguna biasa tidak.", "Percobaan masuk tidak dapat ditelusuri.", "Tidak ada.", "Tidak ada.", "Catat user.login, user.logout, user.login_failed (tanpa menyimpan password)."),
 ("UAT-008", "CORS memantulkan origin sembarang dengan Access-Control-Allow-Credentials: true", "MEDIUM", "Security configuration", ["CORS-reflect"],
  "Kirim Origin: http://evil.example ke /api/health dan preflight OPTIONS.", "Hanya origin aplikasi yang diizinkan.", "ACAO memantulkan origin; ACAC=true; preflight 204 untuk semua metode. Dampak lintas-situs diredam cookie SameSite=Lax dan server hanya di 127.0.0.1.", "Kebijakan terlalu longgar; berbahaya bila nanti dijadikan server jaringan.", "Tidak ada.", "Tidak ada.", "Batasi origin ke http://127.0.0.1:<port> / origin aplikasi."),
 ("UAT-009", "Upload avatar menerima SVG berskrip dan berkas HTML bermasker image/png", "MEDIUM", "File upload", ["UP-svg", "UP-spoof"],
  "POST /api/auth/me/avatar dengan SVG berisi <script> (image/svg+xml) dan HTML bertipe image/png.", "Ditolak (bukan gambar raster yang valid).", "Keduanya 200; disimpan sebagai data URI. Di UI dirender lewat <img> sehingga skrip tidak berjalan.", "Validasi hanya berdasarkan MIME yang dideklarasikan klien.", "Tidak ada.", "Tidak ada.", "Verifikasi magic bytes (PNG/JPEG/WebP), tolak SVG/HTML, batasi ukuran."),
 ("UAT-010", "Pembatas laju global menyebabkan halaman kosong saat berpindah halaman cepat", "MEDIUM", "Availability / UX", ["UI-menu-LaporanKeuanga", "RL-scope"],
  "Buka 17-25 halaman workspace berurutan dalam ~1-2 menit.", "Halaman tetap tampil; pesan jelas bila dibatasi.", "Halaman ke-18 putih kosong (shell index.html mendapat 429); pulih setelah jeda 1 menit. Limiter menghitung berkas statis dan semua API (200/menit/IP).", "Tidak ada.", "Tidak ada.", "Tidak ada.", "Kecualikan berkas statis; limiter terpisah untuk login/export; tampilkan pesan batas laju yang ramah."),
 ("UAT-011", "Jurnal manual dengan baris berisi debit dan kredit sekaligus menghasilkan HTTP 500", "MEDIUM", "Journal API validation", ["JR-both"],
  "POST /journal dengan satu baris {debit:1000, credit:1000}.", "400 dengan pesan validasi.", "500 'Terjadi kesalahan' (dua variasi).", "Tidak ada.", "Tidak ada.", "Tidak ada.", "Validasi 'satu baris hanya Debit atau Kredit' di API manual, seperti di Import."),
 ("UAT-012", "Logout manual di satu tab tidak menyiarkan logout ke tab lain", "LOW", "Session", ["SES-multitab-logout"],
  "Buka dua tab, klik Keluar di tab 1.", "Tab 2 ikut ke /login.", "Tab 2 tetap tampil (sesi server sudah dicabut sehingga API menolak); baru keluar saat timer idle/ping.", "Tidak ada (sesi server dicabut).", "Tidak ada.", "Tidak ada.", "Tulis penanda logout bersama (terra.loggedOutAt) dari tombol Keluar."),
 ("UAT-013", "Tidak ada batas panjang/format input pada nama, kode, referensi; nominal pecahan diterima", "LOW", "Input validation", ["JR-frac", "JR-longref", "COA-longname", "COA-space"],
  "Buat akun dengan nama 5.000 karakter, kode '90 06', jurnal dengan referensi 500 karakter dan nominal 0.5 / 9e15.", "Ditolak atau dibatasi.", "Semua 201.", "Tidak ada.", "Nominal pecahan menimbulkan noise di laporan.", "Tidak ada.", "Tetapkan batas panjang, pola kode, dan nominal bulat/maksimum."),
 ("UAT-014", "Header keamanan HTTP tidak dikirim (CSP, X-Frame-Options, nosniff, Referrer-Policy)", "LOW", "Security configuration", ["HDR-clickjack"], "GET / dan /api/health.", "Header standar ada.", "Tidak ada satupun.", "Clickjacking dan MIME sniffing tidak dimitigasi (aplikasi lokal; risiko rendah).", "Tidak ada.", "Tidak ada.", "Tambahkan header standar (fastify-helmet)."),
 ("UAT-015", "Beberapa input tidak valid diterima diam-diam", "LOW", "Input validation", ["JI-sheet", "PE-baddate", "BUG-CP-FILTER"], "Import dengan nama sheet salah; generate-monthly dengan fromDate 'abc'; counterparties?type=<tak valid>.", "400.", "Sheet salah dibaca sebagai sheet pertama (200); generate-monthly 201 dengan created 0; filter tipe diabaikan (semua data).", "Tidak ada.", "Tidak ada.", "Tidak ada.", "Kembalikan 400 untuk input tidak valid."),
 ("UAT-016", "User aplikasi bertingkat 'staff' tetap dapat membuat perusahaan baru (menjadi OWNER-nya)", "LOW", "Authorization (design)", ["CO-add-viewer"], "Login user aplikasi biasa lalu POST /api/company-db.", "Sesuai kebijakan lisensi/peran aplikasi.", "201 dan user menjadi OWNER perusahaan baru.", "Hanya perusahaan miliknya sendiri; tidak ada akses ke perusahaan lain.", "Tidak ada.", "Penambahan perusahaan tanpa persetujuan admin.", "Putuskan kebijakan (admin saja?) — butuh keputusan bisnis."),
 ("UAT-017", "Kebijakan password lemah: 'aaaaaaaa' diterima", "LOW", "Authentication", ["US-weakpw"], "POST /api/users dengan password aaaaaaaa.", "Ditolak oleh kebijakan kompleksitas.", "201.", "Mempermudah tebakan.", "Tidak ada.", "Tidak ada.", "Minimal kompleksitas / daftar password umum."),
 ("UAT-018", "Ekspor Excel tidak menetralkan teks berawalan = + @ -", "LOW", "Export", ["EXP-formula-note"], "Jurnal dengan deskripsi '=HYPERLINK(...)' lalu ekspor Ledger.", "Teks dinetralkan.", "Tersimpan sebagai sel string (bukan formula) sehingga aman di Excel; tidak dinetralkan bila disalin ke sistem lain.", "Defense in depth.", "Tidak ada.", "Tidak ada.", "Awali dengan apostrof untuk teks berawalan karakter formula."),
]
bug_ids_for_test = {t: b[0] for b in BUGS for t in b[4]}
sev_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "COSMETIC": 4}
sevcount = collections.Counter(b[2] for b in BUGS)
failed_ids = {r["id"] for r in failed}
unmapped = [r for r in failed if r["id"] not in bug_ids_for_test]

def md_table(head, body):
    return "| " + " | ".join(head) + " |\n|" + "|".join("---" for _ in head) + "|\n" + "\n".join("| " + " | ".join(str(c).replace("|", "\\|").replace("\n", " ") for c in row) + " |" for row in body) + "\n"

def res(r): return "PASS" if r["pass"] else "FAIL"
def by_re(p): return [r for r in tests if re.match(p, r["id"])]

# ---------- menu matrix
menus = [("Login", r"^(AU-(wrongpw|nouser|emptypw|emptybody|badjson|longpw|nosqlobj|extra|logout|cookie|fixation)|UI-login|SES-refresh)"), ("Company List", r"^(CO-list|UI-menu-DaftarPerusaha)"), ("Add Company", r"^(CO-add|CO-slug|CO-xss|CMP-)"), ("Dashboard", r"^(MN-dash|PERF-dash|REC-\d+-dash|UI-menu-Dashboard)"), ("Journal (create/draft/post/reverse/rules)", r"^(JR-|BD-|REV-bulk|DRAFT-bulk|MASS-journal|UI-journal-list|UI-menu-Jurnal$)"), ("Journal Import", r"^(JI-|IMP-J\d+|BUG-IMP-DATE)"), ("COA (CRUD, lock/unlock)", r"^(COA-|LOCK-|UI-menu-ChartofAccount)"), ("COA Import", r"^(CI-|IMP-COA)"), ("Opening Balance + Opening Balance Import", r"^(IMP-OB|OB-POST|OBI-|UI-menu-OpeningBalance|MN-ob)"), ("Ledger", r"^(LG-|X-LG|UI-ledger5y|UI-menu-Ledger|PERF-led)"), ("Trial Balance", r"^(TB-60|PERF-tb|UI-menu-TrialBalance|BK-TB60)"), ("Income Statement", r"^(REC-\d+-is|X-5Y-(np|rev)|PERF-is|BK-IS)"), ("Balance Sheet", r"^(REC-\d+-bs|X-5Y-bs|PERF-bs|BK-BS)"), ("Equity", r"^(REC-\d+-eq|X-5Y-eq|PERF-eq|BK-EQ)"), ("Cash Flow", r"^(REC-\d+-cf|X-5Y-cf|PERF-cf|BK-CF|BUG-CF-FLOAT)"), ("Report Export (Excel/PDF)", r"^(EXP-|PDF-)"), ("Search / Ctrl+K", r"^(PERF-s\d|UI-search|IDOR-search|XSS2?-search|MN-search)"), ("Settings (profil, backdate)", r"^(PR-|BD-|UI-menu-Pengaturan)"), ("User Management", r"^(US-|USR-|AZ-user|AZ-users|MN-users|UI-menu-Penggunaaplika)"), ("Company Access", r"^(AC-|ACC-|UI-menu-Penggunaperusa|MN-access|IDOR-access)"), ("License", r"^(LIC-|AZ-license|ENV-02|SET-01)"), ("Backup / Restore", r"^(BK-)"), ("Logout", r"^(AU-logout|SES-logout|SES-multitab|SES-shared)"), ("Hutang & Piutang", r"^(CP-|UI-menu-HutangPiutang|MN-.*cp)"), ("Pajak, Analisis, Proyeksi, Kas&Bank, Audit Log, Data Awal, Benchmark", r"^(MN-tax|MN-ana|MN-proj|MN-audit|MN-bm|PERF-ana|PERF-proj|PERF-audit|UI-menu-(Pajak|Analisis|Proyeksi|BukuKasBank|AuditLog|DataAwal|Benchmarking|LaporanBuku|FinancialRepor|LaporanKeuanga|Perusahaanprof|Beranda|Pengaturanakun))"), ("Administrator panel", r"^(ADM-|UI-menu-Administratorl)"), ("Periode (generate/lock/close)", r"^(PE-|PER-)")]
menu_rows = []
for name, pat in menus:
    rs = by_re(pat); f = [r for r in rs if not r["pass"]]
    menu_rows.append((name, len(rs), len(rs) - len(f), ("PASS" if not f else "FAIL: " + ", ".join(sorted({bug_ids_for_test.get(r["id"], r["id"]) for r in f})))))

# ---------- rekonsiliasi
state = json.load(open(S + "state.json", encoding="utf8")); rec_years = state["reconcile"]["years"]
fmt = lambda v: f"{int(round(v)):,}".replace(",", ".")
rec_rows = [(y, fmt(v["debit"]), fmt(v["credit"]), fmt(v["assets"]), fmt(v["liabilities"]), fmt(v["equity"]), fmt(v["profit"]), v["journals"], v["lines"]) for y, v in rec_years.items()]
# ---------- performa
perf = [r for r in tests if r["area"] == "performance"]
perf_rows = [(re.sub(r": \d+ ms \(.*\)$", "", r["name"]), re.search(r"(\d+) ms", r["name"]).group(1) + " ms", r["detail"]) for r in perf]
pl = [json.loads(l) for l in open(S + "perf.jsonl", encoding="utf8")]
imp_perf = [(p["label"], f"{p['ms']} ms") for p in pl if p["label"].startswith(("COA", "journal import", "import besar", "backup"))][:30]
big_exports = sorted([p for p in pl if p["label"].startswith("export")], key=lambda p: -p["ms"])[:6]
# ---------- keamanan
sec_areas = ["authn", "authz", "idor", "sqli", "xss", "mass-assign", "upload", "path-traversal", "abuse", "headers", "csrf", "session", "audit", "admin-panel", "license", "business-logic", "validation"]
sec = [r for r in tests if r["area"] in sec_areas]
sec_rows = [(r["name"][:150], res(r), (bug_ids_for_test.get(r["id"], "") + " " + (r["severity"] if not r["pass"] else "")).strip() or "-") for r in sec]
# ---------- data
branch = state["perBranch"]; io = state["interoffice"]
dataset = {"journals_core": 5965, "lines_core": 18900}
# ---------- bug section
bug_md = []
for b in BUGS:
    bug_md.append(f"""### {b[0]}: {b[1]}

```text
BUG ID: {b[0]}
TITLE: {b[1]}
SEVERITY: {b[2]}
MODULE: {b[3]}
ENVIRONMENT: installer final (07:05) diekstrak; server UAT port 4500; data UAT PT TERRA NUSANTARA
STEPS TO REPRODUCE: {b[5]}
EXPECTED: {b[6]}
ACTUAL: {b[7]}
SECURITY IMPACT: {b[8]}
ACCOUNTING IMPACT: {b[9]}
DATA IMPACT: {b[10]}
EVIDENCE: results.jsonl (id: {", ".join(b[4])})
RECOMMENDATION: {b[11]}
```
""")

total, npass, nfail = len(tests), len(passed), len(failed)
crit = sevcount.get("CRITICAL", 0); high = sevcount.get("HIGH", 0); med = sevcount.get("MEDIUM", 0); low = sevcount.get("LOW", 0)
sec_findings = [b for b in BUGS if b[3] in ("Security / Authorization", "Authentication", "Audit", "Security configuration", "File upload", "Availability / UX", "Session", "Authorization (design)")]
acc_findings = [b for b in BUGS if b[3] in ("Accounting engine", "Journal import", "Cash flow report")]
decision = "NOT READY FOR PRODUCTION"
summary = f"""```text
TOTAL TEST: {total}
PASS: {npass}
FAIL: {nfail} (baris bukti; dikelompokkan menjadi {len(BUGS)} bug unik)
CRITICAL: {crit}
HIGH: {high}
MEDIUM: {med}
LOW: {low}
SECURITY FINDINGS: {len(sec_findings)} (HIGH {sum(1 for b in sec_findings if b[2]=="HIGH")}: UAT-001; MEDIUM {sum(1 for b in sec_findings if b[2]=="MEDIUM")}; LOW {sum(1 for b in sec_findings if b[2]=="LOW")}) -- tidak ada SQL injection, XSS, IDOR/lintas-company, atau authentication bypass
ACCOUNTING FINDINGS: 3 (HIGH 2: UAT-002, UAT-003; MEDIUM 1: UAT-005) -- rekonsiliasi 5 tahun: SEMUA PASS
DATA INTEGRITY: tidak ada korupsi data; integrity_check ok; crash kill -9 atomic; backup/restore identik
FINAL RECOMMENDATION: {decision}
```"""

md = f"""# FULL UAT 5 TAHUN + SIMULASI MULTI-CABANG + SECURITY TEST: PT TERRA NUSANTARA

Tanggal UAT: 2026-10-05. Penguji: Claude (QA / Accounting / Database / Security). Tidak ada perubahan kode aplikasi pada tahap ini (FIND, RECORD, CLASSIFY, REPORT).

## A. Executive Summary

TERRA FINANCE diuji dengan perusahaan simulasi yang memakai **5 tahun transaksi (01/01/2021 sampai 31/12/2025)**: **5.965 jurnal / 18.900 baris** pada periode tersebut (11.998 jurnal / 30.966 baris termasuk data uji 2026), lima kantor yang disimulasikan lewat akun per cabang, 17 transaksi antar kantor, 45 reversal, 12 draft, dan seluruh menu serta serangan keamanan yang diminta.

**Yang berhasil dengan sangat baik**
- **Akuntansi 5 tahun benar.** Setiap angka Neraca, Laba Rugi, Ekuitas, Arus Kas, Trial Balance (60 periode), Ledger, dan Dashboard dibandingkan dengan model hitung independen: **semua cocok**. Total Debit = Total Kredit, Aset = Liabilitas + Ekuitas di setiap tahun, saldo menyambung antar tahun, transaksi di 31/12 dan 01/01 benar.
- **Isolasi dan keamanan inti kuat.** Nol kebocoran lintas-company dari lebih dari 100 permintaan IDOR/tampering, nol SQL injection dari 276 payload ke 24 titik input, XSS tidak dieksekusi di 9 halaman, tidak ada authentication bypass, path traversal gagal, mass assignment diabaikan.
- **Ketahanan kuat.** Kill -9 di tengah commit 4.000 jurnal: hasil atomic, integrity_check ok. Backup lalu restore: 60 Trial Balance dan semua laporan tahunan identik dengan aslinya.
- **Kinerja baik.** Hampir semua laporan di bawah 1 detik pada data 5 tahun; Dashboard 1,7 detik; export terbesar < 1 detik.

**Yang menghalangi produksi (3 temuan HIGH)**
1. **UAT-001**: ADMIN dapat menaikkan dirinya (atau user lain) menjadi OWNER. Ini eskalasi hak.
2. **UAT-002**: satu jurnal selisih Rp 1 yang lolos validasi toleransi membuat Neraca dan Dashboard menjawab HTTP 500 untuk semua periode sesudahnya.
3. **UAT-003**: Import jurnal menyimpan tanggal "2026-02-30" sebagai 2026-03-02 secara diam-diam.

Sesuai aturan keputusan yang Anda tetapkan (HIGH security issue lebih dari 0 berarti NOT READY), keputusan akhir adalah **{decision}**. Tidak ada temuan CRITICAL, rekonsiliasi akuntansi lulus, dan isolasi company lulus; ketiga HIGH di atas dapat diperbaiki dengan perubahan kecil.

## B. UAT Environment

| Item | Nilai |
|---|---|
| Build yang diuji | Installer FINAL `TERRA FINANCE Setup 0.1.0.exe` (dibuat 2026-10-05 07:05, 124.189.967 byte), diekstrak; server dijalankan dengan `TERRA FINANCE.exe` (ELECTRON_RUN_AS_NODE) dari isi installer |
| Server / port | 127.0.0.1:4500 (production pengguna di port 4000 tidak disentuh) |
| Data | folder UAT terpisah (`uat5/data`: terra-finance.sqlite, terra-system.sqlite, companies/*) |
| Lisensi | lisensi UAT "PT TERRA NUSANTARA (UAT)" lifetime, ditandatangani kunci vendor (kunci privat tidak dicetak; log penerbitan di folder UAT) |
| Backup | folder `uat5/backup` dan `uat5/restored`; restore dijalankan di port 4501 |
| Browser | Microsoft Edge headless dikendalikan lewat DevTools Protocol, viewport 1366x820 |
| Sistem | Windows 11 Home; Node 22 |
| Production | tidak diakses, diubah, atau dipakai; data klien tidak dipakai pada UAT ini |

Batasan lingkungan yang jujur: jendela Electron tidak dijalankan karena aplikasi production berjalan di port 4000 (port tetap). Uji menu dilakukan di browser terhadap server dari installer yang sama. Pengujian multi-device tidak dilakukan (belum diimplementasikan).

## C. Dataset

```text
Company: PT TERRA NUSANTARA (Company A) + PT PEMBANDING UAT (Company B, untuk isolasi) + perusahaan uji kecil
Years: 2021-2025 (60 periode bulanan)
Branches simulated: 5 (Kantor Pusat, Cabang Metro, Cabang Bandar Lampung, Cabang Kotabumi, Cabang Terbanggi Besar)
  Pusat dan Metro aktif sejak 2021; Bandar Lampung sejak Mar 2022; Kotabumi dan Terbanggi Besar sejak Apr 2023
Users: 6 akun utama (Owner, Admin, Akuntan, Staf, Viewer, Penyusup/Owner Company B) + akun uji input dengan peran OWNER/ADMIN/ACCOUNTANT/STAFF/VIEWER
COA: 48 akun (kas, bank, piutang, persediaan, aset tetap, akumulasi penyusutan, utang usaha, utang bank, modal, antarkantor, pendapatan/HPP/beban per cabang)
Journal count (2021-2025): 5.965 (5.907 transaksi impor + 1 saldo awal + 45 pembalik reversal + 12 draft)
Journal lines (2021-2025): 18.900
Journal count total termasuk uji 2026: 11.998; baris 30.966; audit log 24.123 baris
```

Pola transaksi per tahun berbeda: 2021 = 471 transaksi (2 kantor), 2022 = 731 (3 kantor), 2023 = 1.277 (5 kantor, ekspansi, tambahan modal Rp 500 jt, pinjaman bank Rp 1 miliar, pembelian kendaraan), 2024 = 1.620 (piutang/utang naik), 2025 = 1.808 (pembelian peralatan dan gedung, pelunasan, reversal). Termasuk transaksi 31/12 dan 01/01 tiap tahun, dua transaksi bertanggal sama (kecil dan besar), nominal Rp 1.000 sampai Rp 140 juta (lebih besar pada uji), multi-line, transfer antar bank, penyusutan bulanan, bunga bank, piutang dan pelunasannya, utang vendor dan pembayarannya. Data dimuat lewat **Import Excel resmi** (12 batch x 500 transaksi) setelah COA Import dan Opening Balance Import; reversal lewat API; draft lewat API.

## D. Menu Test Matrix

{md_table(["Menu", "Jumlah uji", "Lulus", "Hasil"], menu_rows)}
Setiap menu juga dibuka di browser dan dipotret (`evidence/screenshots/ui-*.png`): 25 halaman, 24 tampil normal; 1 halaman kosong akibat pembatas laju (UAT-010). Menu yang tidak ada di UI: Lisensi (hanya status/endpoint) dan Backup (otomatis, tanpa layar); keduanya diuji lewat API/berkas.

## E. Accounting Reconciliation

Model oracle independen dihitung dari data sumber (saldo awal + transaksi + pembalik reversal; draft tidak ikut), lalu dibandingkan **per akun** dengan API setiap tahun.

{md_table(["Tahun", "Total Debit", "Total Kredit", "Aset", "Liabilitas", "Ekuitas", "Laba tahun berjalan", "Jurnal", "Baris"], rec_rows)}
Hasil pemeriksaan (semua PASS): Debit = Kredit tiap tahun; Aset = Liabilitas + Ekuitas; saldo tiap akun neraca = oracle; Laba Rugi (pendapatan, HPP, beban, laba) = oracle; Ekuitas awal + tambahan modal + laba = ekuitas akhir, dan ekuitas awal tahun = ekuitas akhir tahun sebelumnya; kas akhir Arus Kas = saldo kas+bank, kas awal = kas akhir tahun lalu; Dashboard YTD = Laba Rugi; **60 Trial Balance seimbang dan saldo tiap akun = oracle**, baris "Laba (Rugi) Belum Ditutup" = laba kumulatif sebelum periode.

**Cross-year:** laba 01/01/2021-31/12/2025 = jumlah laba lima tahun (Rp 26.300.085.500); pendapatan 5 tahun, neraca 31/12/2025, kas akhir, ekuitas penutup cocok dengan hitungan tahunan. Ledger pada 31/12 dan 01/01 tiap tahun memuat tepat baris tanggal itu; ledger lintas 31/12 ke 01/01 benar termasuk saldo awal.

**Catatan akuntansi (bukan kegagalan rekonsiliasi):** UAT-002 (toleransi Rp 1), UAT-003 (tanggal import bergeser), UAT-005 (Arus Kas pecahan dan alokasi pro-rata untuk jurnal campuran).

## F. Multi-Branch Simulation

**Pendekatan (tanpa mengubah skema, tanpa branch_id):** setiap cabang memiliki akun sendiri (Kas, Pendapatan, HPP, Beban Gaji, Antarkantor Aktiva, Antarkantor Pasiva) bernomor sufiks cabang; akun bersama (bank, piutang, persediaan, aset tetap, utang) dipakai lintas cabang; nomor jurnal berawalan kode cabang (PST-, MTR-, BDL-, KTB-, TBS-); keterangan diawali [kode cabang].

Hasil pada engine saat ini:
- **Laba Rugi per cabang (pendapatan)** dapat ditarik dari akun per cabang dan **cocok dengan model** (PASS):

{md_table(["Cabang", "Pendapatan 2021-2025", "HPP", "Beban Gaji"], [(b["cabang"], fmt(b["pendapatan"]), fmt(b["hpp"]), fmt(b["gaji"])) for b in branch])}
- Laporan **konsolidasi** (Neraca, Laba Rugi, Arus Kas, Ekuitas, Trial Balance) cocok dan seimbang.
- **Tidak ada laporan per cabang** yang dapat diminta ke sistem. Neraca per cabang, Trial Balance per cabang, dan Laba Rugi lengkap per cabang tidak tersedia kecuali COA dipecah per cabang untuk semua akun (biaya bersama seperti listrik, sewa, transportasi tidak teralokasi).
- Biaya cabang yang memakai akun bersama (Listrik, Internet, Transportasi, Operasional, Sewa) hanya dapat dibedakan lewat keterangan/referensi (pencarian teks), bukan lewat laporan.
- Jumlah akun membengkak bila ingin lebih rinci: mis. 5 cabang x 6 akun = 30 akun tambahan hanya untuk enam jenis akun.

**Kesimpulan F:** engine mampu *mencatat* dan *mengonsolidasi* transaksi lima kantor secara benar, tetapi tidak mampu menghasilkan **pembukuan dan laporan per cabang** tanpa dimensi cabang. Ini mendukung rekomendasi arsitektur A (branch_id pada jurnal) di laporan multi-cabang.

## G. Inter-office Transactions

Model: satu jurnal antar kantor berisi **empat baris** (sisi pengirim dan sisi penerima) sehingga atomic. Contoh Pusat ke Metro Rp 100 jt: Dr Antarkantor Aktiva-Metro, Cr Bank BCA; Dr Kas Metro, Cr Antarkantor Pasiva-Pusat. Tujuh belas transaksi diuji: Pusat ke Metro, Pusat ke Bandar Lampung, Metro ke Pusat, Bandar Lampung ke Pusat, Metro ke Kotabumi, Kotabumi ke Terbanggi Besar (dan beberapa lainnya) pada 2021-2025.

Hasil:
- Total **Antarkantor Aktiva = Total Antarkantor Pasiva** (Rp 850.000.000 pada 31/12/2025, dari Neraca API): **PASS** (eliminasi konsolidasi = 0).
- **Reversal jurnal antar kantor membalik kedua sisi sekaligus** (status Reversed + jurnal pembalik Posted): **PASS**.
- Laporan konsolidasi tetap seimbang di semua tahun: **PASS**.

Saldo per 31/12/2025:

{md_table(["Akun (menurut lawan transaksi)", "Antarkantor Aktiva", "Antarkantor Pasiva"], [(b["cabang"], fmt(b["aktiva"]), fmt(b["pasiva"])) for b in io])}
**Cara merepresentasikan pada architecture saat ini (dokumentasi, bukan fitur baru):**
1. Satu jurnal berisi dua sisi; nomor jurnal berawalan cabang pengirim; keterangan "[PST] ... PST -> MTR".
2. Akun Antarkantor Aktiva/Pasiva dibuat per lawan transaksi (atau per pasangan).
3. Eliminasi: total Aktiva = total Pasiva di Neraca konsolidasi.

**Keterbatasan:** akun per lawan transaksi **tidak menyebut pemilik sisi**, sehingga saldo Pusat terhadap Metro tidak bisa direkonsiliasi dengan saldo Metro terhadap Pusat (akun Aktiva-Metro bercampur klaim dari semua pengirim). Rekonsiliasi per pasangan memerlukan N x (N-1) x 2 akun (40 akun untuk 5 kantor) atau dimensi cabang. Tidak ada validasi bahwa setiap jurnal antar kantor seimbang **per cabang**; hanya seimbang total. Tidak ada laporan rekonsiliasi antarkantor.

## H. Performance

Data: Company A, 5.965 jurnal inti (≈12.000 saat pengukuran), server UAT. Kategori: < 1 dtk / 1-3 / 3-5 / 5-10 / > 10.

{md_table(["Operasi", "Waktu", "Kategori"], perf_rows)}
Waktu impor/backup: {"; ".join(f"{a}: {b}" for a, b in imp_perf[:14])}

Export terlama: {"; ".join(f"{p['label']} {p['ms']} ms" for p in big_exports)}.

**Bottleneck:** Dashboard (1,6-1,7 dtk, menghitung banyak laporan sekaligus untuk perbandingan dan tren 6 bulan) dan Arus Kas 5 tahun (0,9 dtk, alokasi kas per jurnal). Tidak ada operasi di atas 3 dtk. Ledger 5 tahun dengan 2.009 baris dirender di UI tanpa freeze.

## I. Security Test Matrix

{md_table(["Attack / Test", "Result", "Bug / Severity"], sec_rows)}
**Ringkasan keamanan:** tidak ada authentication bypass, tidak ada kebocoran lintas-company, tidak ada SQL injection, tidak ada XSS tereksekusi, tidak ada path traversal; temuan nyata: UAT-001 (HIGH), UAT-006 sampai UAT-010 (MEDIUM), UAT-012, UAT-014, UAT-016, UAT-017 (LOW). Matriks otorisasi 75 kombinasi peran x izin sesuai kebijakan, kecuali eskalasi pada UAT-001.

## J. Bugs

Klasifikasi: CRITICAL {crit}, HIGH {high}, MEDIUM {med}, LOW {low}, COSMETIC 0. Daftar ringkas:

{md_table(["ID", "Severity", "Judul", "Modul"], [(b[0], b[2], b[1], b[3]) for b in BUGS])}
{"".join(bug_md)}
### Catatan tentang hasil uji yang dikoreksi

Beberapa baris awal bukan bug aplikasi melainkan kesalahan skrip uji saya sendiri, sudah diganti oleh uji ulang yang benar (ditampilkan di results.jsonl dengan ID pengganti): {"; ".join(f"{k} ({v})" for k, v in DROP.items() if not k.startswith("XSS-"))}; serta 9 hasil XSS awal (selektor mengena skrip inline yang sah, diganti uji XSS2-*).

## K. Data Integrity

| Pemeriksaan | Hasil |
|---|---|
| `integrity_check` company.db, master, system | ok (juga setelah kill -9 dan setelah uji injeksi) |
| `foreign_key_check` | 0 pelanggaran |
| Baris jurnal tanpa header / tanpa akun | 0 / 0 |
| Referensi jurnal ganda | 0 |
| Pasangan reversal (Reversed memiliki pembalik, pembalik menunjuk jurnal Reversed) | konsisten |
| Total debit = total kredit (seluruh jurnal Posted/Reversed) | sama persis (Rp 189.413.310.709 pada pengukuran akhir) |
| Jurnal Posted tidak seimbang | 2 (UAT-002: UJ-udxcd6j Rp 1 dan pembaliknya; saling meniadakan) |
| Draft (12) tidak memengaruhi laporan | terbukti |
| Kill -9 saat commit 4.000 jurnal | atomic (7.997 tetap 7.997), tanpa baris yatim, tanpa jurnal tak seimbang |
| Audit log append-only | trigger database menolak UPDATE/DELETE; tidak ada endpoint ubah/hapus |
| Mass assignment | field status/createdBy/postedBy/role/id/isLocked/license diabaikan |

Tidak ditemukan korupsi data.

## L. Backup/Restore

Backup atas dataset besar (Company A, B, system, master) dengan `backup.js` aplikasi, lalu restore ke folder UAT baru dan menjalankan aplikasi (server dari installer) di port 4501 terhadap hasil restore:
- Backup memuat 8 file; integrity_check semua ok; isi sama dengan sumber (jurnal 11.997, baris 30.964, total debit = total kredit, audit, akun).
- Instance hasil restore: login berhasil, lisensi aktif, Company B ikut.
- **Identik dengan aslinya:** jumlah jurnal, Laba Rugi / Neraca / Arus Kas / Ekuitas / Dashboard untuk 2021 sampai 2025, Ledger Bank BCA dan Piutang 5 tahun, **60 Trial Balance**, jumlah audit log, dan COA.
- Perubahan di instance restore tidak memengaruhi data asli.

## M. Recommendation

**Wajib diperbaiki sebelum produksi (blocker):** UAT-001 (batasi perubahan peran OWNER), UAT-002 (hilangkan toleransi selisih Rp 1 / jangan membuat laporan 500), UAT-003 (validasi tanggal ketat pada import).

**Sangat disarankan sebelum klien memakai (MEDIUM):** UAT-004 (validasi tanggal laporan), UAT-006 (penundaan login gagal), UAT-007 (audit login), UAT-008 (batasi CORS), UAT-009 (validasi isi avatar), UAT-010 (limiter tidak menghitung berkas statis), UAT-011 (validasi baris debit+kredit), UAT-005 (Arus Kas bulat dan aturan jurnal campuran).

**Dapat dijadwalkan (LOW):** UAT-012 sampai UAT-018.

**Terkait keputusan arsitektur:**
- **Multi-cabang:** UAT ini membuktikan engine akuntansi benar secara konsolidasi tetapi tidak dapat menghasilkan laporan per cabang atau rekonsiliasi antarkantor per pasangan tanpa dimensi cabang. Itu mendukung rekomendasi A (`branch_id` pada jurnal + akun antarkantor bertanda `interbranch`). Perbaiki dulu UAT-002 sebelum menambah jurnal antar kantor yang kompleks, karena selisih kecil makin sulit ditemukan.
- **Multi-device/multi-user:** tidak diuji (belum diimplementasikan). Temuan UAT-001, UAT-006, UAT-007, UAT-008, dan UAT-010 menjadi prasyarat keamanan sebelum server dapat diakses dari jaringan.

## N. Final Decision

**{decision}**

Alasan (aturan keputusan Anda): terdapat **1 temuan HIGH di bidang keamanan** (UAT-001, eskalasi hak ADMIN ke OWNER). Rekonsiliasi akuntansi **lulus**; isolasi cross-company **lulus**; CRITICAL = 0. Dua temuan HIGH lain (UAT-002, UAT-003) adalah masalah integritas akuntansi/data pada jalur tertentu. Setelah ketiganya diperbaiki dan uji ulang (UAT ini dapat dijalankan ulang dengan harness yang disimpan di `docs/uat/harness/`), keputusan layak ditinjau ulang menjadi **READY WITH KNOWN LOW-RISK ISSUES**.

{summary}

## Lampiran: bukti

- `docs/uat/evidence/results.jsonl`: seluruh hasil uji (setelah koreksi), `perf.jsonl`, `reconcile.json`, `final-integrity.json`.
- `docs/uat/evidence/screenshots/`: tangkapan layar 25 halaman, uji XSS, halaman login setelah auto-logout.
- `docs/uat/evidence/exports/`: contoh hasil export (Excel/PDF) 5 tahun.
- `docs/uat/harness/`: skrip UAT (tanpa data/lisensi/kunci). Lisensi UAT dan data tidak disalin.
"""

open(OUT + "FULL-UAT-5-YEAR-MULTI-BRANCH-SECURITY-REPORT.md", "w", encoding="utf8").write(md)
# evidence
corrected = list(last.values())
open(OUT + "evidence/results.jsonl", "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in corrected) + "\n")
for f in ["perf.jsonl", "reconcile.json", "final-integrity.json"]: shutil.copy(S + f, OUT + "evidence/" + f)
for f in os.listdir(S + "shots"):
    if f.startswith(("ui-", "xss-")): shutil.copy(S + "shots/" + f, OUT + "evidence/screenshots/" + f)
for f in ["income-statement-5tahun.xlsx", "income-statement-5tahun.pdf", "balance-sheet-5tahun.pdf", "cash-flow-1tahun.xlsx", "ledgerBCA1d.pdf"]:
    if os.path.exists(S + "exports/" + f): shutil.copy(S + "exports/" + f, OUT + "evidence/exports/" + f)
for f in os.listdir(S):
    if f.endswith((".mjs", ".py")) and f not in ("build_report.py",): shutil.copy(S + f, OUT + "harness/" + f)
shutil.copy(S + "build_report.py", OUT + "harness/build_report.py")
print("total", total, "pass", npass, "fail", nfail, "| bug", len(BUGS), dict(sevcount), "| tidak terpetakan:", [r["id"] for r in unmapped])
