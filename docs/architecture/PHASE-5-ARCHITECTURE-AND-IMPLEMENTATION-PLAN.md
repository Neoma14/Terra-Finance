# PHASE 5 — ARCHITECTURE & IMPLEMENTATION PLAN
### Branch-Aware Reporting · Design / Architecture & Authorization Integration Audit

> **ERRATUM (Phase 5.0, 2026-10-07).** Angka kinerja pada bagian 0 butir 3 dan bagian 3.2 (Arus Kas 3,3–6,4 dtk; Dashboard 9,8–18,4 dtk) **salah ukur**: pengukuran tunggal itu terjadi saat ada pekerjaan latar berat di mesin. Pengukuran ulang terkontrol (9 ulangan, min/median/p95, beban CPU dicatat) menunjukkan **Arus Kas ≈ 0,87 dtk dan Dashboard ≈ 2,4 dtk** pada data UAT 5 tahun. Kesimpulan arsitektur tetap (N+1 per entri adalah bottleneck nyata; komparasi butuh agregasi set-based), tetapi besarnya lebih kecil dan **tidak ada indeks yang dibutuhkan**. Rujukan: `docs/uat/PHASE-5.0-BASELINE-AND-PERFORMANCE-REPORT.md`.

Tanggal: 2026-10-07 · Status asli: RENCANA. **Pembaruan 2026-10-09: 5A dan 5B (satu cabang, gabungan, komparasi Neraca/Laba Rugi/Ekuitas/Neraca Saldo, akses LIMITED, BC-1, BC-2) SUDAH diimplementasikan; lihat `PHASE-5-IMPLEMENTATION-REPORT.md`.** Belum: 5C, Report Group, eliminasi (Phase 7, lihat `CONSOLIDATION-ELIMINATION-REQUIREMENTS.md`), komparasi Arus Kas/Dashboard (D8).
Baseline yang mengikat: `docs/baseline/PHASE-3-AUTHORIZATION-BASELINE.md` (FROZEN). `multi_branch_enabled` tetap OFF. Phase 6 tidak disentuh.

---

## 0. Ringkasan eksekutif

**Apa itu Phase 5.** Membuat seluruh pembacaan data keuangan — laporan, ekspor, buku besar, neraca saldo, dashboard, saldo counterparty, pencarian, log audit — **mengikuti cakupan cabang yang ditentukan server**, lalu menambah mode **Komparasi per cabang** dan **Gabungan**, dengan pelabelan yang jujur.

**Temuan audit terpenting (fakta dari kode dan pengukuran, bukan asumsi):**

1. **Tidak ada celah bypass hari ini, tetapi karena "ditolak semuanya", bukan karena "disaring benar".** Akun LIMITED ditolak di semua endpoint laporan (deny-by-default). Akun ALL-scope melihat angka **seluruh perusahaan** dan mengabaikan cabang aktif. Begitu `multi_branch_enabled` menyala, itu akan menyesatkan. Maka Phase 5 bukan sekadar menambah filter; ia harus **mengganti "ditolak" menjadi "disaring oleh server"** tanpa membuka jalur lain.
2. **Ada 12 titik kueri di 8 berkas** yang membaca data jurnal/audit untuk angka atau daftar yang akan terlihat user: 8 kueri saldo/gerakan keuangan (5 berkas), ditambah pencarian, dashboard (draft, aktivitas, saldo awal), dan log audit. Semuanya harus menerima cakupan. Daftar lengkap di bagian 5.1.
3. **Kinerja saat ini sudah berat dan akan jadi penghalang komparasi.** Diukur pada data UAT 5 tahun (12.003 jurnal, 30.976 baris, 66 akun) lewat server hasil build: Neraca ≈ 0,3 dtk, Laba Rugi ≈ 0,1 dtk, **Arus Kas 3,3–6,4 dtk, Dashboard 9,8–18,4 dtk** (sebelum ada cabang). Komparasi 7 cabang dengan arsitektur sekarang (N panggilan per akun) = Dashboard ±2 menit. **Kinerja adalah risiko #1** dan menentukan desain (agregasi set-based).
4. **Cache UI tidak mengenal cabang.** Kunci react-query tidak memuat cabang aktif, dan pilihan cabang disimpan di `localStorage` yang **dibagi antar tab** — dua tab dengan cabang berbeda dapat menampilkan data cabang yang salah dengan label yang benar. Ini harus diperbaiki di Phase 5 (server mengembalikan cakupan yang dipakai; UI menampilkan itu, bukan keyakinannya sendiri).
5. **Penamaan akuntansi:** sebelum Phase 7 tidak ada eliminasi. Karena itu "Gabungan semua cabang" **tidak boleh disebut "Konsolidasi Perusahaan"** pada Phase 5 — usulan label: *"Gabungan Seluruh Cabang — saldo antar-cabang belum dieliminasi"* (keputusan D2).

**Rekomendasi pembagian pekerjaan** (masing-masing gerbang review sendiri):

| Sub-fase | Isi | Risiko |
|---|---|---|
| **5.0** Baseline emas & anggaran kinerja | merekam keluaran semua laporan pada data UAT (golden master) + ukuran waktu, sebelum satu baris kode berubah | rendah |
| **5A** Inti cakupan + pembacaan satu cakupan (**keamanan dulu**) | `AuthorizedScope` (tipe bermerek), diteruskan ke 12 titik SQL, semua endpoint baca, ekspor berlabel, UI pemilih cakupan minimal | tinggi (keamanan) |
| **5B** Komparasi & Gabungan | kolom per cabang + Gabungan, agregasi set-based, label layar/XLSX/PDF/nama file, rekonsiliasi Σcabang = Gabungan, baris "tidak dieliminasi" | tinggi (kinerja, akuntansi) |
| **5C** Pembanding periode | Previous / Mutasi / Growth, pemecahan Laba Tahun Lalu vs Berjalan | sedang |
| *Ditunda* **Report Group** | hierarki Excel (Laba Bruto Operasional, dst.) | **usulan: persetujuan terpisah** (D5) |
| *Ditunda* **Eliminasi** | Phase 7 | — |

**Skema:** tidak ada tabel/kolom wajib baru. Hanya indeks, dan itupun **bersyarat** pada hasil `EXPLAIN` (bagian 8).
**Perubahan pada baseline Phase 3:** hanya yang aditif/terbukti perlu (bagian 9) — satu usulan perubahan nyata (BC-1, penyimpanan cabang per tab).
**Keputusan yang saya butuhkan dari Anda:** 10 butir di bagian 14 (masing-masing dengan rekomendasi).

---

## 1. Dokumen yang dibaca

`docs/architecture/MULTI-BRANCH-AUDIT-AND-DESIGN.md` (Bagian B Excel, F Report Engine, G, Q Active Branch/Report Scope, R, Z.5, Z.6, Z.9, Z.10, Z.13, Z.14, Z.15, Revisi 4 W.7, Revisi 6 C1–C8); `docs/uat/MULTI-BRANCH-PHASE-1-2-IMPLEMENTATION-REPORT.md`; `docs/uat/MULTI-BRANCH-PHASE-3-AUTHORIZATION-REPORT.md`; `docs/baseline/PHASE-3-AUTHORIZATION-BASELINE.md` (+ manifest); `docs/RELEASE-HARDENING-BACKLOG.md`. Kode: seluruh `modules/company-*` yang membaca data, `db/company/reporting/*`, `ledger/trial-balance/counterparty/dashboard/projection/ratio/tax/audit-log services`, `report-export/*`, `middleware/{company-access-guard,branch-authority}.ts`, `db/system/authorization.ts`, dan hook/halaman web terkait. Pengukuran kinerja memakai salinan data UAT (bukan produksi/port 4000).

Hal dari desain yang **berlaku untuk Phase 5**: Q.1–Q.3 / Z.5–Z.6 (tiga konsep terpisah: Branch Access, Active Branch, Report Scope; label *Gabungan Cabang Terpilih*), F.1–F.6 (scope di fungsi dasar, tiga mode, Growth), Z.13 (matriks API), C6 (tes tampering untuk `scope`, export, URL ledger), Z.15 (Phase 5 bergantung Phase 3; Report Group paralel; eliminasi di Phase 7).

---

## 2. Prinsip mengikat (dari persetujuan Phase 3)

> **Active Branch bukan filter UI.** Setiap endpoint yang membaca atau mengubah data cabang menentukan scope dari otorisasi server-side. Frontend bukan sumber kebenaran untuk branch access, active branch, role, permission, delegation, maupun consolidated reporting scope.

Konsekuensi desain yang dikunci:

| # | Prinsip | Mekanisme penegakan (bagian 4 & 11) |
|---|---|---|
| P1 | Cakupan **dihitung server** dari: sesi → akses perusahaan → akses cabang saat ini → permission efektif → parameter yang divalidasi | satu fungsi `resolveReportScope()` |
| P2 | Layanan data **tidak dapat dipanggil** tanpa cakupan yang sudah diotorisasi | tipe bermerek `AuthorizedScope`; parameter **wajib** (kompilator menolak panggilan lama) |
| P3 | Respons **menyebut cakupan yang dipakai server** (id, nama, mode, label); UI menampilkan itu | bidang `scope` pada tiap respons |
| P4 | Tidak ada endpoint baca-keuangan yang belum diklasifikasikan | registry klasifikasi route + tes yang gagal bila ada route tak terklasifikasi |
| P5 | Cabang di luar akses: **404 seragam**; kurang permission: 403 berkode | sama seperti Phase 1–3 |
| P6 | Tidak ada cache izin; cakupan dievaluasi **di awal tiap request** (termasuk ekspor) | sama seperti Phase 3 |

---

## 3. Keadaan sekarang (audit)

### 3.1 Otorisasi pada endpoint baca
- Seluruh endpoint di bagian 4 **tidak ada di `BRANCH_AWARE_ROUTES`** ⇒ akun **LIMITED ditolak** `403 BRANCH_SCOPE_UNSUPPORTED` (terbukti oleh tes matriks Phase 1–3).
- Akun **ALL-scope** (OWNER, ADMIN lama, dan semua user lama): **tanpa filter cabang**; angka = seluruh perusahaan. Pada perusahaan multi-cabang itu bukan "cabang aktif" dan bukan "konsolidasi" (tanpa eliminasi) — tidak benar secara semantik begitu flag menyala.
- Dengan flag OFF semua jurnal berada di Kantor Pusat sehingga angka hari ini = angka Pusat. **Kompatibilitas mundur wajib dijaga** (bagian 11, golden master).

### 3.2 Sifat pembacaan data
- Neraca, Laba Rugi, Ekuitas, Neraca Saldo, Dashboard menghitung **per akun** (≈66 kueri per laporan, satu kueri per akun). Arus Kas menjalankan kueri **per entri kas**. Dashboard menyusun KPI dan titik tren dari ketiga laporan tersebut (sumber waktu 10–18 dtk perlu dibuktikan lewat profiling pada 5.0).
- `getAccountBalanceBeforeDate` membaca akun dan tipe akun **di setiap panggilan** (N+1 berlapis).
- Pengukuran (server hasil build, data UAT 12.003 jurnal, 3× percobaan): Neraca 282/320/218 ms · Laba Rugi 113/114/179 ms · Ekuitas 210/378/467 ms · **Arus Kas 6395/3308/4140 ms** · **Dashboard 18406/9835/15086 ms** · Saldo counterparty 64–105 ms · Pencarian ≈ 90 ms.
- Indeks yang ada: `journal_entries(period_id)`, `(status)`, `(branch_id, entry_date)`; `journal_entry_lines(account_id)`, `(journal_entry_id)`.

### 3.3 UI
- Kunci query react-query tidak memuat cabang; `X-Branch-Context` diambil dari **localStorage per perusahaan (dibagi antar tab)**. Selector Phase 3 memanggil `invalidateQueries()` saat beralih, tetapi **tab lain** tidak tahu.
- Halaman laporan tidak punya konsep cakupan/label.

### 3.4 Hal yang sudah benar dan dipakai ulang
`requireCompanyAccess` (akses+cabang+override+delegasi per request), `resolveBranchAuthority` (daftar cabang dapat diakses/operasional, konteks tervalidasi), `requireAccessibleBranch` (404 seragam), `hasBasePermission`/`canActOnBranch`, daftar jurnal sudah menyaring cabang (Phase 2), `company_audit_log.branch_id` (C0018), `idx_journal_entries_branch_date`.

---

## 4. Desain inti: Report Scope

### 4.1 Parameter (server memvalidasi; klien hanya mengusulkan)
```
?scope=branch:<id>            satu cabang
?scope=branches:<id,id,...>   komparasi: kolom per cabang (+ Gabungan)
?scope=selected:<id,id,...>   Gabungan Cabang Terpilih (satu kolom)
?scope=all                    Gabungan Seluruh Cabang
(tanpa scope)                 default sisi server (lihat 4.3)
```

### 4.2 Aturan otorisasi (menyambung model Phase 3)

| Kondisi | Hasil |
|---|---|
| Flag **OFF** | cakupan dipaksa = seluruh perusahaan (satu cabang: Pusat) → angka **identik dengan hari ini**; `scope` selain kosong/`all` ditolak 400 |
| `branch:X`, X ∈ cabang yang dapat diakses user (ALL: semua non-terhapus; LIMITED: `user_branch_access`) dan user punya `report.read` | diizinkan; **INACTIVE/CLOSED boleh** (historis) |
| `branch:X`, X di luar akses atau tidak ada | **404 seragam** (tidak membedakan "tidak ada") |
| `branches:`/`selected:` (≥2 cabang) | butuh **`report.consolidated` efektif** (role + GRANT − DENY) **dan** seluruh id dapat diakses; salah satu di luar akses → 404 seragam (tanpa oracle); tanpa `report.consolidated` → `403 REPORT_SCOPE_FORBIDDEN` |
| `all` | butuh `report.consolidated` **dan** akses ke **seluruh** cabang non-terhapus (ALL-scope, atau LIMITED yang mencakup semua); selain itu 403/404 sesuai di atas |
| Batas | maks. 50 cabang per permintaan; id duplikat dibuang; urutan = `sort_order` cabang |
| DENY `report.consolidated` | mengalahkan semuanya (konsisten dengan Phase 3) |
| Delegasi `view_branch_reports` | **tidak pernah memperluas** cakupan (hak efektif = delegasi ∩ akses ∩ permission); lihat D6 |
| Pencabutan akses/permission saat laporan berjalan | divalidasi di awal request; hasil yang sudah selesai tidak ditarik (batas wajar offline) — sama dengan Q.4 |

### 4.3 Default tanpa parameter (flag ON)
`branch:<cabang aktif tervalidasi>`. Ini mengubah perilaku akun ALL-scope **hanya pada perusahaan yang flag-nya menyala** (dari "seluruh perusahaan" menjadi "cabang aktif", sesuai Q.2/Z.5). Perlu persetujuan Anda (D1).

### 4.4 Tipe bermerek — inti penutupan bypass
```ts
// db/company/report-scope.ts (BARU)
declare const brand: unique symbol;
export interface AuthorizedScope {
  readonly [brand]: true;                  // hanya dibuat oleh resolveReportScope()
  readonly mode: "SINGLE" | "COMPARISON" | "COMBINED_SELECTED" | "COMBINED_ALL";
  readonly branchIds: readonly string[];   // sudah divalidasi, unik, berurutan
  readonly branches: readonly {id; code; name; status}[];
  readonly companyWide: boolean;           // true bila seluruh cabang non-terhapus tercakup
  readonly label: ScopeLabel;              // judul + peringatan wajib
}
export async function resolveReportScope(request, db, rawScopeParam): Promise<AuthorizedScope>
```
Semua fungsi baca keuangan menerima `scope: AuthorizedScope` **tanpa nilai bawaan**. Konsekuensi: (a) route tidak bisa lupa — kompilasi gagal; (b) layanan tidak bisa menerima `string[]` mentah dari query; (c) satu-satunya tempat keputusan otorisasi cakupan adalah `resolveReportScope`, yang memakai `request.companyAccess` (diisi guard dari System DB, bukan dari klien).

### 4.5 Bentuk SQL
Tanpa cakupan penyaring (flag OFF / `companyWide`) SQL **tetap identik** dengan sekarang (tidak ada `IN (...)` tambahan) ⇒ risiko regresi angka nol, dibuktikan golden master. Dengan cakupan: `AND je.branch_id IN (?)` (indeks `idx_journal_entries_branch_date`). Mode komparasi memakai **satu** kueri teragregasi `GROUP BY jel.account_id, je.branch_id` (bagian 7).

---

## 5. Inventaris endpoint (server)

Legenda disposisi: **S** = SCOPED (memakai `AuthorizedScope`) · **C** = company-level (tanpa data cabang; tidak berubah) · **A** = hanya scope ALL (LIMITED tetap ditolak) · **L** = legacy.

| # | Endpoint | Permission sekarang | LIMITED sekarang | Disposisi Phase 5 | Catatan / aturan |
|---|---|---|---|---|---|
| 1 | `GET reports/balance-sheet` | report.read | 403 | **S** (5A, 5B komparasi, 5C pembanding) | respons memuat `scope` |
| 2 | `GET reports/income-statement` | report.read | 403 | **S** | idem |
| 3 | `GET reports/equity` | report.read | 403 | **S** | `RE-BRIDGE` dihitung per cakupan |
| 4 | `GET reports/cash-flow` | report.read | 403 | **S** (komparasi: setelah optimasi) | klasifikasi kas antar-cabang → Phase 6/7 |
| 5 | `GET reports/export/:kind` (BS, IS, EQ, CF, TB, ledger) | report.read | 403 | **S** + label wajib | label di layar/XLSX/PDF/nama file; cakupan divalidasi di awal |
| 6 | `GET trial-balance?periodId` | report.read | 403 | **S** | `RE-BRIDGE` per cakupan |
| 7 | `GET ledger/:accountId` | report.read | 403 | **S** | saldo awal & baris disaring cakupan; akun = COA bersama |
| 8 | `GET dashboard` | report.read | 403 | **S** (tertinggi risiko kinerja) | juga "aktivitas terbaru" (audit by `branch_id`) dan peringatan saldo awal per cabang |
| 9 | `GET counterparties/balances` | account.read | 403 | **S** | saldo disaring cakupan; **nama master tetap bersama** (D4) |
| 10 | `GET/POST counterparties` | account.read / create | 403 | **C** | master company-level; POST tetap ALL |
| 11 | `GET search` | (per kategori) | 403 | **S** untuk jurnal (cabang ∈ cakupan, total ikut cakupan); akun = COA bersama | cakupan = cabang aktif/akses; tanpa `scope` ekplisit |
| 12 | `GET audit-log` | users.manage | 403 | **A** (usulan) — D9 | LIMITED tetap ditolak; bila kelak dibuka: hanya `branch_id` miliknya |
| 13 | `GET analysis`, `GET projection`, `GET tax-summary` | report.read | 403 | **S** atau **A** — D3 | rasio/proyeksi/pajak turunan dari BS/IS; pajak sejatinya level perusahaan |
| 14 | `GET/PATCH tax-settings` | company.read/update | 403 | **C/A** | tidak berubah |
| 15 | `periods` (list = aware; generate/closing-check/lock/close) | existing | list OK; sisanya 403 | **C** | penutupan periode tetap level perusahaan; jumlah draft **tidak** dibocorkan ke LIMITED (aksi tetap ditolak) |
| 16 | `journals`, `journal/*`, `journal-import/*`, `opening-balance*` | existing | aware (Phase 2) | tidak berubah | sudah disaring cabang |
| 17 | `accounts*`, `account-types`, `accounts/inter-branch*`, `branch-policy` | existing | aware / OWNER | tidak berubah | COA bersama, tanpa saldo |
| 18 | `branches*`, `branch-context`, `authorization/*`, `delegations*`, `access/*` | Phase 1–3 | — | **dibekukan** (baseline) | hanya penambahan di daftar sadar-cabang bila perlu (BC-2) |
| 19 | `profile`, `company-access`, backup/restore, `GET/POST /api/company-db` | existing | existing | **C** | tidak berubah |
| 20 | Legacy `/api/c/:slug/*`, `modules/{journal,ledger,accounts,statements,ratios,tax,periods,counterparties}` (master-DB lama) | requireCompanyAccess | 403 | **L** — tidak disentuh | membaca `masterDb`, bukan `company.db`; ditandai untuk dikunci/diputus di backlog (R11) |

**Klasifikasi wajib (P4):** registry `ROUTE_CLASSIFICATION` memetakan setiap route terdaftar ke S/C/A/L/Aware; tes gagal bila ada route baru yang tak terklasifikasi — ini yang membuktikan **tidak ada endpoint yang lolos dari pemeriksaan** (bagian 11.3).

### 5.1 Titik SQL yang membaca data jurnal (semuanya wajib menerima `AuthorizedScope`; 12 titik di 8 berkas)

| # | Berkas:baris | Fungsi | Dipakai oleh | Perubahan |
|---|---|---|---|---|
| Q1 | `db/company/ledger-service.ts:76` | `getAccountBalanceBeforeDate` (saldo) | BS, TB, CF (kas awal/akhir), Ledger, Ekuitas | parameter cakupan wajib |
| Q2 | `ledger-service.ts:113` | `getAccountLedgerByRange` (baris) | Ledger, ekspor | idem |
| Q3 | `reporting/reporting-utils.ts:128` | `getAccountMovementInRange` | Laba Rugi, Ekuitas | idem |
| Q4 | `reporting-utils.ts:156` | `getFlowAccountCumulativeTotal` | RE-BRIDGE (BS, TB), Ekuitas | idem |
| Q5 | `reporting/cash-flow-service.ts:66` | entri bergerak kas | Arus Kas | idem |
| Q6 | `cash-flow-service.ts:81` | baris per entri kas | Arus Kas | idem |
| Q7 | `trial-balance-service.ts:55` | gerakan per akun per periode | TB | idem |
| Q8 | `counterparty-service.ts:101` | saldo counterparty | `counterparties/balances` | idem |
| Q9 | `modules/company-search/routes.ts:49–70` | cari jurnal + total | `search` | cakupan |
| Q10 | `db/company/dashboard-service.ts:214` | jumlah draft | dashboard | cakupan |
| Q11 | `dashboard-service.ts` (aktivitas terbaru, `getOpeningBalance`) | audit & saldo awal | dashboard | cakupan |
| Q12 | `db/company/company-audit-log-service.ts:47` | log audit | `audit-log` | cabang (bila dibuka) |
| — | `account-service.ts:335`, `period-closing-service.ts:44` | pemeriksaan pemakaian / jumlah draft | aksi administratif | **tidak berubah** (company-level, bukan angka laporan) |
| — | `company-journal/routes.ts` | daftar/detail jurnal | jurnal | sudah ber-cakupan (Phase 2) |

**Tes arsitektur** (11.3): berkas yang boleh memuat `journal_entries`/`journal_entry_lines` ditulis eksplisit (allowlist); berkas lain yang mulai menyentuhnya membuat tes gagal.

---

## 6. Inventaris UI (web)

| Halaman / komponen | Hook & endpoint | Perubahan Phase 5 |
|---|---|---|
| Laporan (4 tab) + `report-export-control` | `use-reports.ts` | pemilih cakupan; kunci query memuat cakupan; label/peringatan; tombol ekspor membawa cakupan |
| Neraca Saldo | `use-trial-balance.ts` | cakupan + label |
| Buku Besar / Ledger / Books hub (`cash-bank-view`) | `use-ledger.ts` | cakupan + label |
| Dashboard | `use-dashboard.ts` | cakupan (nilai awal = cabang aktif); komparasi menyusul |
| Counterparty (hutang/piutang) | `use-counterparties.ts` | saldo mengikuti cakupan; label |
| Analisis, Proyeksi, Pajak | `use-analysis.ts`, `use-projection.ts`, `use-tax.ts` | sesuai D3 |
| Pencarian global | `global-search.tsx` | hasil jurnal mengikuti cakupan |
| Audit log | `use-audit-log.ts` | tidak berubah (ALL) |
| `active-branch-selector.tsx`, `lib/active-branch.ts`, `company-api-client.ts` | Phase 3 | **BC-1** (penyimpanan per tab) — lihat bagian 9 |
| **Baru:** `ReportScopePicker`, `ScopeBanner` (label/peringatan), kolom dinamis per cabang | — | komponen bersama dipakai semua halaman laporan |

Aturan UI yang mengikat: UI **hanya menyajikan** apa yang dikembalikan `scope` pada respons server (judul, daftar cabang, peringatan); opsi yang tidak diizinkan disembunyikan **sebagai kenyamanan**, bukan penegakan.

---

## 7. Desain mesin laporan

### 7.1 Tiga mode (F.2)
Individual (`branch:`), Komparasi (`branches:` → kolom per cabang + kolom Gabungan), Gabungan (`selected:`/`all` → satu kolom). Kolom cabang dinamis dari tabel `branches` (urut `sort_order`), bukan hardcode.

### 7.2 Aritmetika & invarian
- Satu **primitif agregasi set-based** menggantikan N+1 untuk jalur komparasi: `SELECT account_id, branch_id, SUM(debit), SUM(credit) FROM lines JOIN entries WHERE status IN (...) AND date <= ? [AND branch_id IN (...)] GROUP BY account_id, branch_id` → seluruh laporan disusun dari peta hasil (sama untuk BS/IS/EQ/TB).
- **Rumus kolom Gabungan = rumus kolom cabang** (pelajaran Bagian B: Excel memakai rumus berbeda untuk subtotal). Gabungan **dihitung**, tidak dijumlahkan dari angka tampilan, lalu **diverifikasi**: Σ(kolom cabang) = Gabungan (rekonsiliasi; selisih ≠ 0 ⇒ error integritas, bukan angka disembunyikan).
- Neraca per cabang seimbang secara struktural (tiap jurnal seimbang dan milik satu cabang); akun Modal (`CENTRAL_ONLY`) hanya ada di Pusat sehingga Neraca cabang non-Pusat tidak memuat Modal — **bukan bug**, dijelaskan di UI. `BalanceSheetNotBalancedError` tetap pengaman.
- `RE-BRIDGE` dan "laba berjalan" dihitung **per cakupan**.
- Semua aritmetika uang tetap integer/BigInt sen (konsisten `money.ts`, UAT-005).

### 7.3 Antar-cabang sebelum Phase 6/7
Tidak ada eliminasi. Pada cakupan Gabungan, akun `INTER_BRANCH` dalam cakupan **ditampilkan apa adanya** dengan baris/peringatan **"tidak dieliminasi"** dan nilai selisih rekonsiliasi pasangan (invarian C1: Σ pasangan = 0) bila pasangan lengkap berada dalam cakupan. Eliminasi, selisih eliminasi, dan label "Konsolidasi Perusahaan" = Phase 7.

### 7.4 Pelabelan wajib (Z.6)
| Mode | Judul | Peringatan |
|---|---|---|
| Satu cabang | nama cabang | bila INACTIVE/CLOSED: "historis" |
| Komparasi | "Komparasi Cabang" + daftar | — |
| `selected:` | **"GABUNGAN CABANG TERPILIH — bukan laporan konsolidasi perusahaan"** + daftar cabang | bila ada cabang perusahaan di luar pilihan |
| `all` (Phase 5) | **"Gabungan Seluruh Cabang — saldo antar-cabang belum dieliminasi"** (D2) | wajib selama Phase 7 belum ada |
Label yang sama pada **XLSX, PDF, dan nama file**; dibangun di satu tempat (`ReportDocument.scopeLabel` wajib — kompilator menolak dokumen tanpa label).

### 7.5 Ekspor
`buildExportDocument` menerima `AuthorizedScope`; cakupan **dievaluasi ulang di awal request ekspor** (bukan dari halaman); nama file memuat label cakupan; ekspor `ledger` juga disaring.

### 7.6 Pembanding periode (5C)
Previous/Mutasi/Growth per F.4–F.5: `growth = (current − previous) / |previous| × 100` di server dalam sen, `null` bila pembagi 0 (UI "—", tidak pernah Infinity/NaN); pembanding default = tanggal sama tahun lalu; pemecahan Laba Tahun Lalu vs Berjalan memakai `fiscal_year_start_month` dan jumlahnya wajib sama dengan `RE-BRIDGE` lama (invarian).

---

## 8. Skema & migrasi

| Item | Kebutuhan | Keputusan |
|---|---|---|
| Tabel/kolom baru | tidak ada | `journal_entries.branch_id/origin`, `company_audit_log.branch_id`, `branches` sudah cukup |
| Indeks | pembacaan `je.branch_id IN (...)` + tanggal + status; agregasi `GROUP BY` | **bersyarat**: ukur dengan `EXPLAIN QUERY PLAN` pada data UAT; hanya bila terbukti perlu → migrasi `C0019_report_scope_indexes` (idempoten, tanpa mengubah data), mis. `journal_entries(status, entry_date, branch_id)`. Dijalankan lewat jalur upgrade yang sudah ber-backup & `integrity_check` (Phase 1–2) |
| `statement_lines` (`line_kind/formula`) | hanya bila Report Group disetujui | **tidak termasuk** (D5) |
| System DB | tidak ada | — |
| Data | tidak ada backfill | laporan tidak menulis apa pun |
Verifikasi migrasi (bila ada): jumlah jurnal/baris/akun identik, `integrity_check`/`foreign_key_check`, restore dari `pre-upgrade` teruji.

---

## 9. Perubahan terhadap baseline Phase 3 (dikendalikan)

Baseline dianggap beku. Hanya kebutuhan terbukti yang dicatat sebagai *Baseline Change* di `PHASE-3-AUTHORIZATION-BASELINE.md` bagian 8, dengan tes.

| ID | Berkas | Perubahan | Sifat | Alasan |
|---|---|---|---|---|
| BC-2 | `middleware/branch-authority.ts` | **menambah** entri `BRANCH_AWARE_ROUTES` untuk endpoint yang menjadi sadar-cakupan | aditif | wajib agar akun LIMITED dapat memakai endpoint tersaring; tes matriks mewajibkan pencatatan |
| BC-3 | `types/fastify.d.ts` / guard | tidak diperlukan | — | `resolveReportScope` memakai `request.companyAccess` apa adanya |
| **BC-1** | `apps/web/src/lib/active-branch.ts` (+ `active-branch-selector.tsx`) | **usulan:** simpan cabang aktif di `sessionStorage` (per tab) bukan `localStorage` (bersama) | perubahan perilaku UI | mencegah tab menampilkan data cabang yang salah; kepatuhan Q.2 ("aman untuk banyak tab"). **Perlu persetujuan Anda (D7)** |
Tidak diubah: `authorization.ts`, `rbac.ts`, migrasi S/C yang ada, `company-access-guard.ts`, seluruh logika delegasi/override.

---

## 10. Pemetaan fitur Phase 5 ↔ model otorisasi Phase 3

| Fitur Phase 5 | Autentikasi → akses perusahaan | Akses cabang | Cabang aktif | Permission | Delegasi | Catatan |
|---|---|---|---|---|---|---|
| Laporan satu cabang | ✓ | cabang ∈ akses | default | `report.read` | tidak memperluas | LIMITED kini dilayani |
| Komparasi / Gabungan Terpilih | ✓ | **semua** id ∈ akses | nilai awal pilihan | `report.read` + **`report.consolidated`** | tidak memperluas | 404 seragam bila ada id di luar akses |
| Gabungan Seluruh Cabang | ✓ | **seluruh** cabang non-terhapus | — | `report.consolidated` | — | label belum-dieliminasi |
| Ekspor | ✓ | sama seperti laporan | — | sama + validasi ulang di awal | — | label di berkas |
| Ledger / TB | ✓ | cabang ∈ akses | default | `report.read` | — | |
| Dashboard | ✓ | cabang ∈ akses | default (= konteks) | `report.read` | — | |
| Saldo counterparty | ✓ | cabang ∈ akses | default | `account.read` | — | nama master bersama |
| Pencarian | ✓ | cabang ∈ cakupan aktif | konteks | per kategori | — | tanpa oracle keberadaan |
| Audit log | ✓ | ALL saja (usulan) | — | `users.manage` | — | D9 |

Tidak ada jalur lain: cakupan **hanya** dari `resolveReportScope`; UI tidak memberi id yang dipercaya.

---

## 11. Rencana pengujian

### 11.1 Ketepatan angka (inti keselamatan akuntansi)
1. **Golden master (5.0):** rekam keluaran BS, IS, EQ, CF, TB (tiap periode), ledger (akun contoh), dashboard, saldo counterparty, pencarian pada data UAT 5 tahun **sebelum** perubahan; setelah 5A, dengan flag OFF dan dengan cakupan "seluruh perusahaan", keluaran **identik byte-per-byte** (kecuali bidang `scope` baru yang dikecualikan secara eksplisit).
2. **Dataset multi-cabang sintetis** (dibuat lewat layanan/import resmi pada salinan, 5 tahun, ≥6 cabang termasuk INACTIVE dan CLOSED, akun CENTRAL_ONLY/INTER_BRANCH): Σ(laporan tiap cabang) = laporan Gabungan; Neraca tiap cabang seimbang; Arus Kas tiap cabang konsisten; `RE-BRIDGE` per cakupan; Σ cabang = seluruh perusahaan = laporan lama (golden master).
3. Growth: pembagi 0/negatif/dua-nol; Previous/Mutasi; Laba Tahun Lalu + Berjalan = `RE-BRIDGE`.
4. Properti acak (fuzz) antar-cakupan: untuk subset acak cabang, Σ individual = Gabungan Terpilih.

### 11.2 Keamanan & otorisasi (matriks)
- Matriks otomatis: **peran × scope(ALL/LIMITED) × permission(report.read, report.consolidated, DENY) × delegasi × mode cakupan × seluruh endpoint S** (bagian 5) ⇒ hasil 200/403/404 sesuai tabel 4.2.
- **Tampering** (masing-masing tes): `scope=` cabang di luar akses / id palsu / cabang perusahaan lain / duplikat / terlalu banyak / sintaks rusak; `X-Branch-Context` palsu; URL `ledger/:accountId` + scope; parameter ekspor; kombinasi akses+tanpa `report.consolidated`; id campuran sah+tidak sah (tanpa oracle: respons identik).
- **404 seragam** (muatan identik dengan "tidak ada"), tak ada kebocoran lewat: jumlah baris, paginasi, urutan, total, nama file ekspor, pesan error, kolom komparasi, judul laporan, hasil pencarian, aktivitas dashboard.
- **Pencabutan seketika:** akses cabang / `report.consolidated` / delegasi dicabut saat sesi hidup → request berikutnya berubah; ekspor memvalidasi di awal.
- Lintas perusahaan: id cabang A pada perusahaan B.
- **Mutasi:** pelonggaran sengaja (hilangkan cek akses, abaikan DENY, lewati `report.consolidated`, `scope` dipercaya mentah, label dihilangkan) ⇒ semua harus terdeteksi tes.

### 11.3 Penutupan bypass (jawaban untuk butir 6)
1. **Kompilator:** `AuthorizedScope` bermerek, parameter wajib — panggilan lama tidak lagi terkompilasi.
2. **Registry klasifikasi route** + tes: setiap route terdaftar (hasil `onRoute`) harus ada di registry; route baru tanpa klasifikasi ⇒ gagal.
3. **Tes arsitektur:** allowlist berkas yang boleh menyentuh `journal_entries`/`journal_entry_lines`; ditambah pemeriksaan bahwa setiap fungsi baca keuangan yang diekspor menerima `AuthorizedScope`.
4. **Matriks deny-by-default Phase 1–3 tetap berjalan** (route baru yang sadar-cakupan masuk daftar eksplisit).
5. **Pemeriksaan kontrak respons:** tiap respons S memuat `scope`; UI menolak merender tanpa itu.

### 11.4 Kinerja (anggaran, diukur pada data UAT + dataset sintetis)
| Operasi | Sekarang | Anggaran Phase 5 |
|---|---|---|
| Neraca / Laba Rugi / Ekuitas, satu cakupan | 0,1–0,5 dtk | ≤ 1 dtk |
| Komparasi 7 cabang + Gabungan (BS/IS/EQ) | n/a | ≤ 2 dtk |
| Arus Kas satu cakupan | 3,3–6,4 dtk | ≤ 3 dtk (target), tanpa regresi |
| Dashboard satu cakupan | 9,8–18,4 dtk | **tidak boleh lebih lambat dari sekarang**; target ≤ 5 dtk (butuh optimasi; D8) |
Komparasi Arus Kas & Dashboard hanya dibuka setelah angka anggaran tercapai.

### 11.5 UI & regresi
- Uji UI di Chrome (pola Phase 3): picker, label di layar, tab-isolation (dua tab cabang berbeda), akses dicabut saat laporan terbuka, ekspor berlabel; **uji di jendela Electron** diprioritaskan (H-3) karena Phase 5 sangat UI-intensif.
- Regresi: 814 tes backend harus tetap lulus (dengan golden master tambahan), migrasi 84/84, keamanan 37/37, e2e Phase 3 82/82, UI 29/29; tidak ada yang dilonggarkan.

Perkiraan tambahan: **±110–140 tes baru** (cakupan ±25, matriks keamanan ±45, ketepatan angka ±30, ekspor/label ±15, UI/kinerja ±15).

---

## 12. Rencana UAT

| UAT | Skenario | Data | Bukti diterima bila |
|---|---|---|---|
| U1 | Kompatibilitas: flag OFF | salinan UAT 5 tahun (HQ saja) | semua laporan/ekspor/dashboard identik dengan baseline emas |
| U2 | Satu cabang | dataset sintetis 6 cabang | tiap cabang: BS seimbang; angka cocok dengan jurnal sumber (spot-check manual per akun) |
| U3 | Komparasi + Gabungan | idem | Σ kolom = Gabungan; label & peringatan benar di layar/XLSX/PDF/nama file |
| U4 | Pengguna LIMITED 2 dari 6 cabang | idem | hanya 2 cabang + "Gabungan Cabang Terpilih" berlabel; cabang lain 404; tanpa `report.consolidated` → hanya satu cabang |
| U5 | Pencabutan saat sesi | idem | cabang/permission dicabut → laporan berikutnya ditolak seketika; selector memberi tahu |
| U6 | Cabang INACTIVE/CLOSED historis | idem | laporan masa lalu tetap bisa dibuka dan benar |
| U7 | Ekspor | XLSX/PDF tiap jenis × tiap mode | label cakupan ada; isi = layar |
| U8 | Kinerja | UAT 5 tahun + sintetis | sesuai anggaran 11.4 |
| U9 | Dua tab, dua cabang | UI | masing-masing menampilkan cabangnya (BC-1) |
| U10 | Pemeriksaan keuangan oleh pemilik produk | data riil salinan klien (jika disetujui) | rekonsiliasi dengan laporan Excel klien (komparasi/gabungan) |
Seluruh UAT memakai **salinan**; data produksi dan port 4000 tidak disentuh.

---

## 13. Risiko & ketergantungan

| # | Risiko | Dampak | Kemungkinan | Mitigasi |
|---|---|---|---|---|
| R1 | **Kinerja** (Dashboard 10–18 dtk, Arus Kas 3–6 dtk saat ini; komparasi mengalikannya) | Fitur tak layak pakai | **Pasti bila tidak ditangani** | agregasi set-based; anggaran 11.4; Dashboard/CF komparasi ditunda sampai anggaran tercapai; optimasi dipisah dengan golden master |
| R2 | Endpoint terlewat/terlupa (bypass) | Kebocoran data antar-cabang | sedang | tipe bermerek + registry + tes arsitektur + matriks + mutasi |
| R3 | Regresi angka karena menyentuh 12 titik SQL | Laporan keuangan salah | sedang | SQL identik tanpa cakupan; golden master byte-per-byte; 814 tes |
| R4 | UI menampilkan data cabang A berlabel B (tab/cache) | Keputusan salah | sedang | `scope` pada respons + kunci query bercakupan + BC-1 |
| R5 | Label Gabungan hilang di ekspor | Salah baca laporan | rendah-sedang | label wajib di tipe dokumen; tes XLSX/PDF/nama file |
| R6 | Perubahan perilaku akun ALL-scope tanpa `report.consolidated` saat flag ON | Pengguna lama kehilangan tampilan total | pasti pada aktivasi | D1; rollout terkontrol; dokumentasi; flag OFF sampai disetujui |
| R7 | Semantik akuntansi per cabang (Modal di Pusat, RE-BRIDGE, antar-cabang belum eliminasi) disalahpahami | Salah tafsir | sedang | label & penjelasan UI; "tidak dieliminasi"; selisih rekonsiliasi ditampilkan; eliminasi di Phase 7 |
| R8 | Arus Kas: transfer antar-cabang diklasifikasi tak jelas | Arus kas cabang menyesatkan | rendah (Phase 6 belum ada) | dicatat; diselesaikan Phase 6/7 |
| R9 | Perluasan lingkup (Report Group) | Jadwal/risiko akuntansi | sedang | dipisah, persetujuan terpisah (D5) |
| R10 | Master counterparty lintas cabang terlihat oleh user LIMITED | Privasi nama vendor/pelanggan | sedang | D4; saldo tetap tersaring |
| R11 | Rute legacy master-DB (`/api/c/…`) tidak sadar-cabang | Jalur data lama | rendah (bukan `company.db`) | tidak disentuh; masuk backlog kunci/putus |
| R12 | Kebocoran sisi-kanal (jumlah, urutan, nama file, pesan error, waktu respons) | Bocor keberadaan cabang | rendah-sedang | 404 identik; tes khusus (11.2); label hanya cabang sah |
| R13 | Pencabutan akses saat laporan/ekspor sedang berjalan | Hasil lama tetap terkirim | rendah | validasi di awal request; didokumentasikan (Q.4) |
| R14 | Hardening backlog (H-1/2/3) menumpuk | Rilis tertunda | sedang | tidak dihapus; **H-3 (uji UI Electron) disarankan dimajukan** karena Phase 5 UI-intensif |
| R15 | Migrasi indeks pada data klien | Risiko data | rendah | bersyarat; jalur upgrade ber-backup + integrity check; idempoten |

**Ketergantungan:** Phase 3 baseline (selesai); Phase 2 dimensi jurnal (selesai). **Tidak bergantung** Phase 6. Phase 7 bergantung pada Phase 5 dan 6. Report Group independen.

---

## 14. Keputusan yang saya minta (dengan rekomendasi)

| # | Pertanyaan | Rekomendasi |
|---|---|---|
| **D1** | Saat flag ON dan tanpa parameter, default = **cabang aktif**; akun ALL-scope tanpa `report.consolidated` hanya satu cabang per laporan — setuju (perubahan hanya saat flag ON)? | **Setuju** (sesuai Q.2/Z.6) |
| **D2** | Nama Gabungan seluruh cabang sebelum eliminasi: **"Gabungan Seluruh Cabang — saldo antar-cabang belum dieliminasi"**; "Konsolidasi Perusahaan" baru di Phase 7? | **Setuju** |
| **D3** | Analisis rasio, Proyeksi, Pajak: dibuka per cabang (indikatif) atau tetap level perusahaan (ALL + `report.consolidated`, LIMITED ditolak)? | **Level perusahaan dulu** (pajak sejatinya level perusahaan; kurangi permukaan) |
| **D4** | Master counterparty (nama vendor/pelanggan) bersama seperti COA; hanya **saldo** yang tersaring? | **Ya** (lebih sederhana; privasi per cabang = permintaan terpisah) |
| **D5** | **Report Group** (hierarki Laba Bruto Operasional, dst.) dikeluarkan dari Phase 5 menjadi persetujuan terpisah? | **Ya, dipisah** (mengubah struktur laporan & skema; risiko akuntansi berbeda) |
| **D6** | Delegasi `view_branch_reports`: tetap informasional (sesuai Revisi 5 O.3 — "sudah ikut `report.read` + akses") dan **tidak pernah memperluas** cakupan? | **Ya** (diuji sebagai tidak-memperluas) |
| **D7** | Setujui **BC-1** (cabang aktif per tab via `sessionStorage`) dan **BC-2** (penambahan daftar sadar-cabang)? | **Setujui keduanya** |
| **D8** | Kinerja: boleh memasukkan optimasi agregasi set-based (dengan golden master) sebagai bagian 5B, dan menunda komparasi Dashboard/Arus Kas sampai anggaran tercapai? | **Ya** |
| **D9** | Log audit: tetap **ALL-scope saja** pada Phase 5 (LIMITED ditolak); aktivitas dashboard disaring `branch_id`? | **Ya** |
| **D10** | Urutan: 5.0 → 5A → review → 5B → review → 5C, masing-masing gerbang sendiri; H-3 (uji UI Electron) dimajukan sebelum 5B? | **Ya** |

---

## 15. Urutan kerja yang diusulkan (setelah persetujuan)

1. **5.0** — golden master + ukuran kinerja + dataset sintetis + registry klasifikasi route (belum mengubah perilaku). *Gerbang:* baseline tercatat, tes arsitektur hijau.
2. **5A** — `resolveReportScope`, `AuthorizedScope`, 12 titik SQL, semua endpoint S, ekspor berlabel, `scope` pada respons, UI picker/label minimal, BC-1/BC-2. *Gerbang:* golden master identik, matriks keamanan, mutasi, UI, build, installer, e2e Electron.
3. **5B** — agregasi set-based, Komparasi/Gabungan, label, rekonsiliasi, "tidak dieliminasi". *Gerbang:* anggaran kinerja, Σ = Gabungan, UAT U2–U8.
4. **5C** — Previous/Mutasi/Growth, Laba Tahun Lalu vs Berjalan. *Gerbang:* invarian `RE-BRIDGE`.
5. Laporan fase + pembaruan baseline (log perubahan) setelah tiap gerbang.

**Yang tidak dikerjakan:** Phase 6 (antar-cabang), Phase 7 (eliminasi), Report Group (menunggu D5), aktivasi `multi_branch_enabled`, perubahan fondasi Phase 3 di luar BC-1/BC-2, penghapusan item backlog hardening.

---

**STOP.** Tidak ada kode yang ditulis atau diubah untuk dokumen ini (kecuali berkas dokumentasi baseline di `docs/baseline/`). Menunggu persetujuan dan jawaban D1–D10.
