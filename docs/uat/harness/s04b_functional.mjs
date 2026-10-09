import fs from "node:fs";
import { S, Client, A, rec, note, state, saveState, dbA, Database, DATA, ymd } from "./lib.mjs";
import { code } from "./gen.mjs";

const { accId } = state();
const mk = async (e, p = "Uat#Pass2026") => { const c = new Client(e); await c.login(e, p); return c; };
const owner = await mk("owner@terra-nusantara.test", "Uat#Owner2026");
const admin = await mk("admin@terra-nusantara.test"), acct = await mk("akuntan@terra-nusantara.test"), staf = await mk("staf@terra-nusantara.test"), viewer = await mk("viewer@terra-nusantara.test"), pen = await mk("penyusup@pembanding.test");
const t = (id, area, name, cond, detail = "", sev = "MEDIUM") => rec(id, area, name, cond, detail, sev);
const st = (r) => `status ${r.status}${r.json?.error ? " " + r.json.error : ""}`;
const today = ymd(new Date(Date.now() + 7 * 3600e3)); // WIB
const addDays = (d, n) => ymd(new Date(Date.parse(d + "T00:00:00Z") + n * 864e5));

// ===== 1. Company list / add company
{
  const lo = (await owner.get("/api/company-db")).json.companies.map((c) => c.slug).sort();
  t("CO-list-owner", "company", "Owner melihat Company A dan B", lo.includes("pt-terra-nusantara") && lo.includes("pt-pembanding"), lo.join(","));
  const la = (await acct.get("/api/company-db")).json.companies.map((c) => c.slug); t("CO-list-acct", "company", "Akuntan hanya melihat Company A", la.length === 1 && la[0] === "pt-terra-nusantara", la.join(","), "HIGH");
  const lp = (await pen.get("/api/company-db")).json.companies.map((c) => c.slug); t("CO-list-pen", "company", "User Company B hanya melihat Company B", lp.length === 1 && lp[0] === "pt-pembanding", lp.join(","), "HIGH");
  const mkc = (b) => owner.post("/api/company-db", { currency: "IDR", fiscalYearStartMonth: 1, ...b });
  let r = await mkc({ name: "PT UJI TAMBAH", slug: "pt-uji-tambah" }); t("CO-add", "company", "Add Company valid", r.status === 201, st(r));
  r = await mkc({ name: "PT UJI TAMBAH 2", slug: "pt-uji-tambah" }); t("CO-add-dup", "company", "Add Company slug duplikat ditolak", r.status === 409 || r.status === 400, st(r));
  r = await mkc({ name: "", slug: "pt-kosong" }); t("CO-add-empty", "company", "Add Company nama kosong ditolak", r.status === 400, st(r));
  for (const bad of ["A B", "../evil", "UPPERCASE", "a/b", "..\\x", "x".repeat(200), "a%2fb", "-awal"]) { r = await mkc({ name: "X", slug: bad }); t("CO-slug-" + Buffer.from(bad).toString("hex").slice(0, 8), "company", `slug tidak aman "${bad.slice(0, 20)}" ditolak`, r.status === 400 || r.status === 409, st(r), "HIGH"); }
  r = await mkc({ name: "N".repeat(300), slug: "pt-nama-panjang" }); note("CO-longname", "company", "nama perusahaan 300 karakter", `status ${r.status}`);
  r = await mkc({ name: "<img src=x onerror=alert(1)>PT XSS", slug: "pt-xss-uji" }); t("CO-xss-store", "company", "nama perusahaan berisi HTML disimpan apa adanya (dirender aman di UI, diuji di tahap browser)", r.status === 201, st(r), "LOW");
  r = await viewer.post("/api/company-db", { name: "Viewer Co", slug: "viewer-co", currency: "IDR", fiscalYearStartMonth: 1 }); note("CO-add-viewer", "company", "viewer (user biasa/staff) membuat perusahaan baru", st(r));
}
// ===== 2. Profile
{
  let r = await viewer.get(`${A()}/profile`); t("PR-read", "profile", "Viewer membaca profil", r.status === 200, st(r));
  r = await owner.patch(`${A()}/profile`, { city: "Bandar Lampung", phone: "0721-123456" }); t("PR-upd", "profile", "Owner mengubah profil", r.status === 200, st(r));
  r = await admin.patch(`${A()}/profile`, { city: "Bandar Lampung" }); t("PR-upd-admin", "profile", "Admin mengubah profil", r.status === 200, st(r));
  r = await acct.patch(`${A()}/profile`, { city: "X" }); t("PR-upd-acct", "profile", "Akuntan TIDAK boleh ubah profil (403)", r.status === 403, st(r), "HIGH");
  r = await viewer.patch(`${A()}/profile`, { city: "X" }); t("PR-upd-view", "profile", "Viewer TIDAK boleh ubah profil (403)", r.status === 403, st(r), "HIGH");
  for (const [n, b] of [["mata uang 2 huruf", { currency: "ID" }], ["bulan fiskal 13", { fiscalYearStartMonth: 13 }], ["bulan fiskal 0", { fiscalYearStartMonth: 0 }], ["nama kosong", { name: "" }], ["bulan fiskal teks", { fiscalYearStartMonth: "a" }]]) { r = await owner.patch(`${A()}/profile`, b); t("PR-inv-" + n.replace(/\W/g, ""), "profile", `profil tidak valid: ${n}`, r.status === 400, st(r)); }
}
// ===== 3. COA CRUD
let a1, a2;
{
  const cr = (c, b = {}) => acct.post(`${A()}/accounts`, { code: c, name: "Akun Uji " + c, accountTypeCode: "ASSET", normalBalance: "debit", ...b });
  let r = await cr("9001"); a1 = r.json?.accountId; t("COA-create", "coa", "COA create valid", r.status === 201, st(r));
  r = await cr("9001"); t("COA-dup", "coa", "COA kode duplikat 409", r.status === 409, st(r));
  r = await cr(""); t("COA-empty", "coa", "COA kode kosong ditolak", r.status === 400, st(r));
  r = await cr("9003", { accountTypeCode: "XXX" }); t("COA-badtype", "coa", "COA tipe tidak dikenal ditolak", r.status === 404 || r.status === 400, st(r));
  r = await cr("9004", { normalBalance: "kiri" }); t("COA-badnb", "coa", "COA saldo normal salah ditolak", r.status === 400, st(r));
  r = await cr("9005", { name: "N".repeat(5000) }); note("COA-longname", "coa", "nama akun 5000 karakter", st(r));
  r = await cr("90 06"); note("COA-space", "coa", "kode akun mengandung spasi", st(r));
  r = await cr("9007", { name: "<script>alert('xss')</script>" }); a2 = r.json?.accountId; t("COA-xss-store", "coa", "nama akun berisi script disimpan (render aman diuji di browser)", r.status === 201, st(r), "LOW");
  r = await staf.post(`${A()}/accounts`, { code: "9008", name: "x", accountTypeCode: "ASSET", normalBalance: "debit" }); t("COA-staf", "coa", "STAFF tidak boleh membuat akun (403)", r.status === 403, st(r), "HIGH");
  r = await viewer.get(`${A()}/accounts?pageSize=5`); t("COA-read-view", "coa", "Viewer boleh membaca COA", r.status === 200, st(r));
  r = await acct.patch(`${A()}/accounts/${a1}`, { name: "Akun Uji Diubah" }); t("COA-upd", "coa", "COA update nama", r.status === 200, st(r));
  r = await acct.patch(`${A()}/accounts/${a1}`, { normalBalance: "credit" }); t("COA-upd-nb-unused", "coa", "COA ubah saldo normal pada akun belum dipakai", r.status === 200, st(r));
  r = await acct.patch(`${A()}/accounts/${accId[code.kas("MTR")]}`, { normalBalance: "credit" }); t("COA-upd-nb-used", "coa", "COA ubah saldo normal akun yang sudah dipakai ditolak (409)", r.status === 409, st(r), "HIGH");
  r = await acct.patch(`${A()}/accounts/${a1}`, { parentAccountId: a1 }); t("COA-cycle-self", "coa", "akun menjadi induk dirinya sendiri ditolak", r.status === 400 || r.status === 409, st(r));
  r = await acct.patch(`${A()}/accounts/${a2}`, { parentAccountId: a1 }); const r2 = await acct.patch(`${A()}/accounts/${a1}`, { parentAccountId: a2 }); t("COA-cycle", "coa", "struktur induk melingkar ditolak", r2.status === 400 || r2.status === 409, st(r2));
  r = await acct.patch(`${A()}/accounts/${a1}`, { parentAccountId: "tidak-ada" }); t("COA-parent-404", "coa", "induk tidak ada ditolak", r.status === 404 || r.status === 400, st(r));
  r = await acct.del(`${A()}/accounts/${a1}`); t("COA-delete", "coa", "COA tidak punya delete (akun berhistori tidak boleh dihapus)", r.status === 404 || r.status === 405, st(r));
  r = await acct.patch(`${A()}/accounts/${a2}`, { isActive: false }); t("COA-deact", "coa", "COA nonaktifkan", r.status === 200, st(r));
  r = await viewer.get(`${A()}/accounts?search=Kas&pageSize=100`); t("COA-search", "coa", "COA pencarian 'Kas' memuat 5 akun kas cabang", (r.json?.accounts ?? []).filter((a) => a.name.startsWith("Kas ")).length === 5, `${(r.json?.accounts ?? []).length} hasil`);
  r = await viewer.get(`${A()}/accounts?page=abc&pageSize=-5`); t("COA-badpage", "coa", "parameter halaman tidak valid ditangani (tidak 500)", r.status < 500, st(r));
  r = await viewer.get(`${A()}/accounts?pageSize=100000`); t("COA-bigpage", "coa", "pageSize raksasa dibatasi", r.status === 200 && (r.json?.accounts ?? []).length <= 1000, `${(r.json?.accounts ?? []).length}`);
  // lock
  r = await acct.post(`${A()}/accounts/${a1}/lock`); t("LOCK-acct", "coa", "Akuntan tidak boleh lock akun (403)", r.status === 403, st(r), "HIGH");
  r = await admin.post(`${A()}/accounts/${a1}/lock`); t("LOCK-admin", "coa", "Admin boleh lock akun", r.status === 200, st(r));
}
// ===== 4. Periode untuk uji jurnal 2026
await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "2026-01-01", toDate: "2026-12-31" });
const per = Object.fromEntries((await owner.get(`${A()}/periods`)).json.periods.map((p) => [p.startDate.slice(0, 7), p]));
{
  let r = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "2026-01-01", toDate: "2026-12-31" }); t("PE-idem", "periods", "generate-monthly ulang idempoten", r.status === 201 && r.json.created === 0, JSON.stringify(r.json).slice(0, 100));
  r = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "2026-05-01", toDate: "2026-01-01" }); t("PE-badrange", "periods", "rentang periode terbalik ditolak", r.status === 400, st(r));
  r = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "abc", toDate: "def" }); t("PE-baddate", "periods", "tanggal periode tidak valid ditolak", r.status === 400, st(r));
  r = await acct.post(`${A()}/periods/generate-monthly`, { fromDate: "2027-01-01", toDate: "2027-01-31" }); t("PE-perm", "periods", "Akuntan tidak boleh generate periode (403)", r.status === 403, st(r), "HIGH");
  r = await viewer.get(`${A()}/periods/${per["2026-02"].id}/closing-check`); note("PE-closing-check", "periods", "closing-check periode (read)", st(r));
}
// ===== 5. Jurnal: aturan bisnis
const kas = accId[code.kas("PST")], pend = accId[code.pend("PST")];
const pid = per["2026-02"].id; const D = "2026-02-10";
const L2 = (n = 1000) => [{ accountId: kas, debit: n, credit: 0 }, { accountId: pend, debit: 0, credit: n }];
const J = (c, o = {}) => c.post(`${A()}/journal`, { referenceNo: o.ref ?? "UJ-" + Math.random().toString(36).slice(2, 9), periodId: o.pid ?? pid, entryDate: o.date ?? D, lines: o.lines ?? L2(), description: o.desc ?? "uji", ...(o.extra ?? {}) });
{
  let r = await J(staf, { ref: "UJ-A" }); const idA = r.json?.journalId; t("JR-create", "journal", "STAFF membuat Draft", r.status === 201, st(r));
  r = await staf.put(`${A()}/journal/${idA}`, { referenceNo: "UJ-A", periodId: pid, entryDate: D, lines: L2(2000) }); t("JR-edit-draft", "journal", "edit Draft (PUT)", r.status === 200, st(r)); const idA2 = r.json?.journalId;
  r = await staf.del(`${A()}/journal/${idA2}`); t("JR-del-draft", "journal", "hapus Draft", r.status === 200, st(r));
  r = await J(acct, { ref: "UJ-B" }); const idB = r.json?.journalId;
  r = await staf.post(`${A()}/journal/${idB}/post`); t("JR-post-staf", "journal", "STAFF tidak boleh Post (403)", r.status === 403, st(r), "HIGH");
  r = await viewer.post(`${A()}/journal`, { referenceNo: "UJ-V", periodId: pid, entryDate: D, lines: L2() }); t("JR-create-viewer", "journal", "VIEWER tidak boleh membuat jurnal (403)", r.status === 403, st(r), "HIGH");
  r = await acct.post(`${A()}/journal/${idB}/post`); t("JR-post", "journal", "Akuntan Post", r.status === 200, st(r));
  r = await acct.post(`${A()}/journal/${idB}/post`); t("JR-post-twice", "journal", "Post dua kali ditolak (409)", r.status === 409, st(r));
  r = await acct.put(`${A()}/journal/${idB}`, { referenceNo: "UJ-B", periodId: pid, entryDate: D, lines: L2(5) }); t("JR-edit-posted", "journal", "jurnal Posted tidak boleh diedit (409)", r.status === 409, st(r), "HIGH");
  r = await acct.del(`${A()}/journal/${idB}`); t("JR-del-posted", "journal", "jurnal Posted tidak boleh dihapus (409)", r.status === 409, st(r), "HIGH");
  r = await staf.post(`${A()}/journal/reversal`, { referenceNo: "UJ-B", entryDate: D, reason: "x" }); t("JR-rev-staf", "journal", "STAFF tidak boleh Reversal (403)", r.status === 403, st(r), "HIGH");
  r = await acct.post(`${A()}/journal/reversal`, { referenceNo: "UJ-B", entryDate: D, reason: "uji" }); t("JR-rev", "journal", "Reversal", r.status === 200, st(r));
  r = await acct.post(`${A()}/journal/reversal`, { referenceNo: "UJ-B", entryDate: D, reason: "lagi" }); t("JR-rev-twice", "journal", "Reversal ganda ditolak (409)", r.status === 409, st(r), "HIGH");
  r = await acct.post(`${A()}/journal/${idB}/reverse`, { reason: "lagi" }); t("JR-rev-twice-id", "journal", "Reversal ganda lewat route lama ditolak", r.status === 409, st(r), "HIGH");
  r = await J(acct, { ref: "UJ-D" }); r = await acct.post(`${A()}/journal/reversal`, { referenceNo: "UJ-D", entryDate: D, reason: "x" }); t("JR-rev-draft", "journal", "Draft tidak bisa direversal", r.status === 409, st(r));
  // tanggal
  r = await J(acct, { date: addDays(today, 1), pid: per[addDays(today, 1).slice(0, 7)].id }); t("JR-future", "journal", "tanggal besok ditolak", r.status === 400, st(r), "HIGH");
  r = await J(acct, { date: "2999-01-01" }); t("JR-future-far", "journal", "tanggal 2999 ditolak", r.status === 400, st(r), "HIGH");
  r = await J(acct, { date: "2026-02-30" }); t("JR-baddate", "journal", "tanggal 2026-02-30 ditolak", r.status === 400, st(r));
  r = await J(acct, { date: "10/02/2026" }); t("JR-baddate2", "journal", "format tanggal salah ditolak", r.status === 400, st(r));
  r = await J(acct, { date: "2026-03-05" }); t("JR-outperiod", "journal", "tanggal di luar periode ditolak", r.status === 400, st(r));
  // balance & nominal
  r = await J(acct, { lines: [{ accountId: kas, debit: 1000, credit: 0 }, { accountId: pend, debit: 0, credit: 999 }] }); t("JR-unbal", "journal", "jurnal tidak balance ditolak", r.status === 400, st(r), "HIGH");
  r = await J(acct, { lines: [{ accountId: kas, debit: 0, credit: 0 }, { accountId: pend, debit: 0, credit: 0 }] }); t("JR-zero", "journal", "jurnal nol ditolak", r.status === 400, st(r));
  r = await J(acct, { lines: [{ accountId: kas, debit: -100, credit: 0 }, { accountId: pend, debit: 0, credit: -100 }] }); t("JR-neg", "journal", "nominal negatif ditolak", r.status === 400, st(r), "HIGH");
  r = await J(acct, { lines: [{ accountId: kas, debit: 1000, credit: 1000 }] }); t("JR-both", "journal", "satu baris debit & kredit sekaligus (1 baris) ditolak/ditangani", r.status === 400, st(r));
  r = await J(acct, { lines: [{ accountId: kas, debit: 500, credit: 500 }, { accountId: pend, debit: 700, credit: 700 }] }); note("JR-both-2", "journal", "dua baris masing-masing debit=kredit (balance semu)", st(r) + " -- aturan 'satu baris hanya debit ATAU kredit' ditegakkan di import, belum tentu di API manual");
  r = await J(acct, { lines: [] }); t("JR-nolines", "journal", "tanpa baris ditolak", r.status === 400, st(r));
  r = await J(acct, { lines: [{ accountId: kas, debit: 0.5, credit: 0 }, { accountId: pend, debit: 0, credit: 0.5 }] }); note("JR-frac", "journal", "nominal pecahan 0.5", st(r));
  r = await J(acct, { lines: [{ accountId: kas, debit: 9e15, credit: 0 }, { accountId: pend, debit: 0, credit: 9e15 }], ref: "UJ-HUGE" }); note("JR-huge", "journal", "nominal 9e15 (di atas batas aman bilangan bulat JS)", st(r));
  r = await J(acct, { lines: [{ accountId: kas, debit: 9999999999999, credit: 0 }, { accountId: pend, debit: 0, credit: 9999999999999 }], ref: "UJ-BIG" }); t("JR-big", "journal", "nominal besar wajar (Rp 9,99 triliun) diterima", r.status === 201, st(r), "LOW");
  r = await J(acct, { ref: "" }); t("JR-emptyref", "journal", "nomor referensi kosong ditolak", r.status === 400, st(r));
  r = await J(acct, { ref: "R".repeat(500) }); note("JR-longref", "journal", "nomor referensi 500 karakter", st(r));
  r = await J(acct, { ref: "UJ-B" }); t("JR-dupref", "journal", "nomor referensi duplikat ditolak", r.status === 409, st(r));
  r = await J(acct, { lines: [{ accountId: "tidak-ada", debit: 1, credit: 0 }, { accountId: pend, debit: 0, credit: 1 }] }); t("JR-badacc", "journal", "akun tidak ada ditolak", r.status === 404 || r.status === 400, st(r));
  r = await J(acct, { lines: [{ accountId: a2, debit: 1, credit: 0 }, { accountId: pend, debit: 0, credit: 1 }] }); t("JR-inactive", "journal", "akun nonaktif ditolak", r.status === 409, st(r), "HIGH");
  r = await J(acct, { lines: [{ accountId: a1, debit: 1, credit: 0 }, { accountId: pend, debit: 0, credit: 1 }] }); t("JR-locked", "journal", "akun terkunci ditolak", r.status === 409, st(r), "HIGH");
  // mass assignment
  r = await J(acct, { ref: "UJ-MASS", extra: { status: "POSTED", createdBy: "orang-lain", postedBy: "orang-lain", companyId: "x", isAdmin: true, role: "OWNER", is_opening_balance: true, source: "import", posted_at: "2000-01-01" } });
  const db = dbA(); const row = db.prepare("select status, created_by, posted_by, is_opening_balance, source from journal_entries where reference_no='UJ-MASS'").get(); db.close();
  const me = (await acct.get("/api/auth/me")).json.user.id;
  t("MASS-journal", "security", "mass assignment jurnal: status/createdBy/postedBy/isOpening diabaikan", r.status === 201 && row?.status === "DRAFT" && row?.created_by === me && !row?.posted_by && !row?.is_opening_balance, JSON.stringify(row), "HIGH");
  // periode terkunci
  r = await owner.post(`${A()}/periods/${per["2026-01"].id}/lock`, {}); t("PE-lock", "periods", "kunci periode Jan 2026 (Owner)", r.status === 200, st(r));
  r = await J(acct, { pid: per["2026-01"].id, date: "2026-01-10" }); t("JR-lockedperiod", "journal", "jurnal ke periode LOCKED ditolak", r.status === 409, st(r), "HIGH");
  // backdate
  r = await acct.put(`${A()}/journal-settings`, { maxBackdateDays: 7 }); t("BD-perm", "journal", "Akuntan tidak boleh ubah batas backdate (403)", r.status === 403, st(r), "HIGH");
  r = await owner.put(`${A()}/journal-settings`, { maxBackdateDays: 7 }); t("BD-set", "journal", "Owner set backdate 7 hari", r.status === 200, st(r));
  const mkd = (n) => { const d = addDays(today, -n); return { date: d, pid: per[d.slice(0, 7)].id }; };
  r = await J(acct, mkd(0)); t("BD-0", "journal", "tanggal hari ini diterima", r.status === 201, st(r));
  r = await J(acct, mkd(7)); t("BD-7", "journal", "today-7 diterima", r.status === 201, st(r));
  r = await J(acct, mkd(8)); t("BD-8", "journal", "today-8 ditolak", r.status === 400, st(r), "HIGH");
  r = await owner.put(`${A()}/journal-settings`, { maxBackdateDays: -3 }); t("BD-neg", "journal", "backdate negatif ditolak", r.status === 400, st(r));
  r = await owner.put(`${A()}/journal-settings`, { maxBackdateDays: null }); t("BD-reset", "journal", "backdate dikosongkan", r.status === 200, st(r));
  // sumber kebenaran: draft jurnal tidak masuk ledger
}
// ===== 6. Hutang/Piutang
{
  let r = await acct.post(`${A()}/counterparties`, { type: "customer", code: "C-UAT-1", name: "PT Pelanggan Uji" }); t("CP-create", "counterparty", "buat customer", r.status === 201, st(r));
  r = await acct.post(`${A()}/counterparties`, { type: "customer", code: "C-UAT-1", name: "Dup" }); t("CP-dup", "counterparty", "kode customer duplikat ditolak", r.status === 409 || r.status === 400, st(r));
  r = await acct.post(`${A()}/counterparties`, { type: "alien", code: "Z", name: "Z" }); t("CP-badtype", "counterparty", "tipe tidak valid ditolak", r.status === 400, st(r));
  r = await acct.post(`${A()}/counterparties`, { type: "vendor", code: "", name: "" }); t("CP-empty", "counterparty", "input kosong ditolak", r.status === 400, st(r));
  r = await viewer.get(`${A()}/counterparties?type=customer`); t("CP-read", "counterparty", "daftar customer", r.status === 200, st(r));
  r = await viewer.get(`${A()}/counterparties/balances?type=customer`); t("CP-bal", "counterparty", "saldo piutang per customer", r.status === 200, st(r));
}
// ===== 7. Menu baca lain
for (const [id, name, path] of [["MN-dash", "Dashboard", `/dashboard?fromDate=2025-01-01&toDate=2025-12-31`], ["MN-tax1", "Pajak: pengaturan", `/tax-settings`], ["MN-tax2", "Pajak: ringkasan", `/tax-summary?fromDate=2025-01-01&toDate=2025-12-31`], ["MN-ana", "Analisis", `/analysis?fromDate=2025-01-01&toDate=2025-12-31`], ["MN-proj", "Proyeksi", `/projection?asOfDate=2025-12-31&monthsAhead=6`], ["MN-audit", "Audit Log", `/audit-log?page=1&pageSize=20`], ["MN-ob", "Opening Balance", `/opening-balance`], ["MN-jl", "Daftar jurnal", `/journals?page=1&pageSize=20`], ["MN-jh", "Riwayat import jurnal", `/journal-import/history`], ["MN-ah", "Riwayat import COA", `/accounts-import/history`], ["MN-types", "Tipe akun", `/account-types`], ["MN-access", "Pengguna perusahaan", `/access`]]) {
  const r = await owner.get(`${A()}${path}`); t(id, "menu", `menu ${name} (data 5 tahun) merespons 200`, r.status === 200, st(r));
}
for (const [id, name, path] of [["MN-bm", "Benchmark", "/api/benchmark?from=2025-01-01&to=2025-12-31"], ["MN-users", "Pengguna aplikasi", "/api/users"], ["MN-lic", "Lisensi", "/api/license/status"], ["MN-me", "Profil saya", "/api/auth/me"], ["MN-legacy-co", "Daftar perusahaan (legacy)", "/api/companies"]]) { const r = await owner.get(path); t(id, "menu", `menu ${name} merespons 200`, r.status === 200, st(r)); }
const tx = await owner.get(`${A()}/audit-log?page=1&pageSize=200`); const acts = new Set((tx.json?.entries ?? tx.json?.items ?? tx.json?.logs ?? []).map((x) => x.action)); note("AUD-actions", "audit", "aksi yang tercatat di audit log perusahaan (200 terbaru)", [...acts].join(", "));
saveState({ a1, a2, per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.id])) });
console.log("FUNCTIONAL SELESAI"); process.exit(0);
