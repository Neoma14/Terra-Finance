// Regression formal untuk UAT-001, UAT-002, UAT-003 terhadap server dari installer FINAL (setelah perbaikan).
import fs from "node:fs";
import { S, DATA, Client, A, ExcelJS, rec, note, state, dbA, Database, ymd } from "./lib.mjs";
import { code, coaRows } from "./gen.mjs";

const { accId, ids, per } = state(); const names = Object.fromEntries(coaRows().map((r) => [r.c, r.n]));
const mk = async (e, p = "Uat#Pass2026") => { const c = new Client(e); const r = await c.login(e, p); if (r.status !== 200) throw new Error("login " + e + " " + r.status); return c; };
const owner = await mk("owner@terra-nusantara.test", "Uat#Owner2026"), admin = await mk("admin@terra-nusantara.test"), acct = await mk("akuntan@terra-nusantara.test"), viewer = await mk("viewer@terra-nusantara.test"), staf = await mk("staf@terra-nusantara.test"), pen = await mk("penyusup@pembanding.test");
const t = (id, area, name, cond, detail = "", sev = "HIGH") => rec(id, area, name, cond, detail, sev);
const st = (r) => `status ${r.status}${r.json?.error ? " " + String(r.json.error).slice(0, 90) : ""}`;
const sysDb = () => new Database(`${DATA}/terra-system.sqlite`, { readonly: true });
const roleOf = (userId) => { const d = sysDb(); const r = d.prepare("select ca.role, ca.status from company_access ca join companies_registry c on c.id = ca.company_id where c.slug='pt-terra-nusantara' and ca.system_user_id = ?").get(userId); d.close(); return r; };
const accessCount = () => { const d = sysDb(); const n = d.prepare("select count(*) c from company_access ca join companies_registry c on c.id = ca.company_id where c.slug='pt-terra-nusantara'").get().c; d.close(); return n; };
const U = ids; const ADM = U["admin@terra-nusantara.test"], VIEW = U["viewer@terra-nusantara.test"], STAF = U["staf@terra-nusantara.test"], ACC = U["akuntan@terra-nusantara.test"], PEN = U["penyusup@pembanding.test"];
const patch = (c, uid, body) => c.patch(`${A()}/access/${uid}`, body);

// ================= UAT-001
{
  const r1 = await patch(admin, ADM, { role: "OWNER" }); t("U1-1", "UAT-001", "ADMIN -> dirinya sendiri OWNER ditolak (403) dan peran di database tetap ADMIN", r1.status === 403 && roleOf(ADM).role === "ADMIN", `${st(r1)}; db=${roleOf(ADM).role}`, "HIGH");
  const r2 = await patch(admin, VIEW, { role: "OWNER" }); t("U1-2", "UAT-001", "ADMIN -> user lain OWNER ditolak (403), database tetap VIEWER", r2.status === 403 && roleOf(VIEW).role === "VIEWER", `${st(r2)}; db=${roleOf(VIEW).role}`, "HIGH");
  const r3 = await patch(admin, ADM, { role: "ADMIN" }); t("U1-3", "UAT-001", "ADMIN -> dirinya sendiri ADMIN (kebijakan lama: diizinkan)", r3.status === 200, st(r3), "MEDIUM");
  const r4 = await patch(admin, VIEW, { role: "ADMIN" }); t("U1-4", "UAT-001", "ADMIN -> user lain ADMIN (kebijakan lama: diizinkan)", r4.status === 200 && roleOf(VIEW).role === "ADMIN", st(r4), "MEDIUM"); await patch(owner, VIEW, { role: "VIEWER" });
  const r5 = await patch(acct, ACC, { role: "OWNER" }); t("U1-5", "UAT-001", "ACCOUNTANT -> OWNER ditolak (403)", r5.status === 403 && roleOf(ACC).role === "ACCOUNTANT", `${st(r5)}; db=${roleOf(ACC).role}`, "HIGH");
  const r6 = await patch(viewer, VIEW, { role: "OWNER" }); t("U1-6", "UAT-001", "VIEWER -> OWNER ditolak (403)", r6.status === 403 && roleOf(VIEW).role === "VIEWER", `${st(r6)}; db=${roleOf(VIEW).role}`, "HIGH");
  const r6b = await patch(staf, STAF, { role: "OWNER" }); t("U1-6b", "UAT-001", "STAFF -> OWNER ditolak (403)", r6b.status === 403 && roleOf(STAF).role === "STAFF", st(r6b), "HIGH");
  const r7 = await patch(owner, STAF, { role: "OWNER" }); const r7b = await patch(owner, STAF, { role: "STAFF" }); t("U1-7", "UAT-001", "OWNER menaikkan lalu menurunkan peran user lain (diizinkan)", r7.status === 200 && r7b.status === 200 && roleOf(STAF).role === "STAFF", `${st(r7)} / ${st(r7b)}`, "HIGH");
  // 8. tampering
  const before = JSON.stringify([roleOf(VIEW), roleOf(ADM)]); const bad = [];
  for (const body of [{ role: "owner" }, { role: "OWNER " }, { role: " OWNER" }, { role: "Owner" }, { role: ["OWNER"] }, { role: { v: "OWNER" } }, { role: null }, { Role: "OWNER" }, { roles: ["OWNER"] }, { role: "OWNER\u0000" }, { role: "ＯＷＮＥＲ" }]) { const r = await patch(admin, VIEW, body); if (r.status < 400) bad.push(JSON.stringify(body)); }
  const dup = await admin.req("PATCH", `${A()}/access/${VIEW}`, { body: '{"role":"VIEWER","role":"OWNER"}' }); if (dup.status < 400) bad.push("duplikat kunci"); const dup2 = await admin.req("PATCH", `${A()}/access/${VIEW}`, { body: '{"role":"OWNER","role":"VIEWER"}' }); note("U1-8-dup2", "UAT-001", "kunci role ganda (terakhir=VIEWER) diproses sebagai VIEWER yang sah", st(dup2));
  await patch(owner, VIEW, { role: "VIEWER" });
  const ext = await patch(admin, VIEW, { role: "STAFF", isAdmin: true, permissions: ["*"], companyId: "x", status: "ACTIVE", systemUserId: ADM }); if (ext.status !== 200 || roleOf(VIEW).role !== "STAFF") bad.push("field tambahan mengubah hal lain"); await patch(owner, VIEW, { role: "VIEWER" });
  t("U1-8", "UAT-001", "manipulasi body role ('owner','OWNER ','Owner', array, objek, null, huruf lebar-penuh, kunci ganda, field tambahan) tidak pernah menghasilkan OWNER", bad.length === 0 && roleOf(VIEW).role === "VIEWER" && roleOf(ADM).role === "ADMIN", bad.join("; "), "HIGH");
  // 9. database tidak berubah saat ditolak (grant, status, revoke)
  const cnt0 = accessCount(); const g = await admin.post(`${A()}/access`, { userId: PEN, role: "OWNER" }); t("U1-9a", "UAT-001", "ADMIN memberi OWNER ke user di luar perusahaan ditolak (403), tidak ada baris akses baru", g.status === 403 && accessCount() === cnt0, `${st(g)}; baris ${cnt0} -> ${accessCount()}`, "HIGH");
  const g2 = await admin.post(`${A()}/access`, { userId: PEN, role: "STAFF" }); t("U1-9b", "UAT-001", "ADMIN tetap boleh memberi peran STAFF (fungsi sah tidak rusak)", g2.status === 201, st(g2), "MEDIUM"); await owner.del(`${A()}/access/${PEN}`);
  const ownerId = (await owner.get("/api/auth/me")).json.user.id;
  const s1 = await admin.patch(`${A()}/access/${ownerId}/status`, { status: "SUSPENDED" }); const d1 = await admin.del(`${A()}/access/${ownerId}`); const p1 = await patch(admin, ownerId, { role: "VIEWER" });
  t("U1-10", "UAT-001", "ADMIN tidak dapat menangguhkan / mencabut / menurunkan OWNER (semua 403); OWNER tetap ACTIVE", s1.status === 403 && d1.status === 403 && p1.status === 403 && roleOf(ownerId).status === "ACTIVE" && roleOf(ownerId).role === "OWNER", `${s1.status}/${d1.status}/${p1.status}`, "HIGH");
  const probe = await owner.get(`${A()}/profile`); t("U1-11", "UAT-001", "OWNER tetap berfungsi normal setelah semua percobaan", probe.status === 200, st(probe), "HIGH");
}

// ================= UAT-002
{
  const kas = accId[code.kas("PST")], pend = accId[code.pend("PST")], pid = per["2026-02"];
  const jc = () => { const d = dbA(); const o = { j: d.prepare("select count(*) c from journal_entries").get().c, l: d.prepare("select count(*) c from journal_entry_lines").get().c, a: d.prepare("select count(*) c from company_audit_log").get().c }; d.close(); return o; };
  const mkj = (c, ref, lines, date = "2026-02-10") => c.post(`${A()}/journal`, { referenceNo: ref, periodId: pid, entryDate: date, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });
  const rid = Math.random().toString(36).slice(2, 6);
  let b0 = jc(); let r = await mkj(acct, `U2-A-${rid}`, [[kas, 100000, 0], [pend, 0, 100000]]); t("U2-A", "UAT-002", "debit 100.000 = kredit 100.000 diterima (201)", r.status === 201, st(r), "HIGH");
  const idA = r.json?.journalId; const pa = await acct.post(`${A()}/journal/${idA}/post`); t("U2-A-post", "UAT-002", "jurnal seimbang bisa di-Post", pa.status === 200, st(pa), "HIGH");
  b0 = jc(); r = await mkj(acct, `U2-B-${rid}`, [[kas, 100000, 0], [pend, 0, 99999]]); t("U2-B", "UAT-002", "debit 100.000 vs kredit 99.999 ditolak (400); header/baris/audit tidak bertambah", r.status === 400 && JSON.stringify(jc()) === JSON.stringify(b0), `${st(r)}; ${JSON.stringify(b0)} -> ${JSON.stringify(jc())}`, "HIGH");
  b0 = jc(); r = await mkj(acct, `U2-C-${rid}`, [[kas, 99999, 0], [pend, 0, 100000]]); t("U2-C", "UAT-002", "debit 99.999 vs kredit 100.000 ditolak (400), database tidak berubah", r.status === 400 && JSON.stringify(jc()) === JSON.stringify(b0), st(r), "HIGH");
  b0 = jc(); r = await mkj(acct, `U2-D-${rid}`, [[kas, 100000, 0], [pend, 0, 100000], [kas, 1, 0]]); t("U2-D", "UAT-002", "baris tambahan merusak keseimbangan ditolak (400)", r.status === 400 && JSON.stringify(jc()) === JSON.stringify(b0), st(r), "HIGH");
  // E: bypass frontend -- draft tak seimbang disusupkan langsung ke database lalu dicoba di-Post lewat API
  const dbw = dbA(false); const eid = "uat-e-" + rid; dbw.prepare("insert into journal_entries (id, entry_date, period_id, reference_no, status, source) values (?,?,?,?, 'DRAFT','manual')").run(eid, "2026-02-11", pid, `U2-E-${rid}`);
  dbw.prepare("insert into journal_entry_lines (id, journal_entry_id, account_id, debit, credit, line_order) values (?,?,?,?,?,0)").run("uat-e1-" + rid, eid, kas, 100000, 0); dbw.prepare("insert into journal_entry_lines (id, journal_entry_id, account_id, debit, credit, line_order) values (?,?,?,?,?,1)").run("uat-e2-" + rid, eid, pend, 0, 99999); dbw.close();
  const pe = await acct.post(`${A()}/journal/${eid}/post`); const dbr = dbA(); const stE = dbr.prepare("select status from journal_entries where id=?").get(eid).status; dbr.close();
  t("U2-E", "UAT-002", "draft tak seimbang yang menyusup (bypass frontend/validasi awal) TIDAK bisa di-Post; status tetap DRAFT", pe.status === 400 && stE === "DRAFT", `${st(pe)}; status=${stE}`, "HIGH");
  b0 = jc(); r = await mkj(acct, `U2-F-${rid}`, [[kas, 9999999999999, 0], [pend, 0, 9999999999998]]); t("U2-F", "UAT-002", "nominal besar (Rp 9,99 triliun) selisih Rp 1 ditolak (400)", r.status === 400 && JSON.stringify(jc()) === JSON.stringify(b0), st(r), "HIGH");
  r = await mkj(acct, `U2-F2-${rid}`, [[kas, 9999999999999, 0], [pend, 0, 9999999999999]]); t("U2-F2", "UAT-002", "nominal besar yang persis seimbang diterima", r.status === 201, st(r), "MEDIUM");
  // G reversal
  const rv = await acct.post(`${A()}/journal/reversal`, { referenceNo: `U2-A-${rid}`, entryDate: "2026-02-10", reason: "uji reversal" }); const dg = dbA(); const sums = dg.prepare("select sum(l.debit) d, sum(l.credit) c from journal_entry_lines l join journal_entries j on j.id=l.journal_entry_id where j.reference_no = ?").get(`U2-A-${rid}-REV`); dg.close();
  t("U2-G", "UAT-002", "reversal jurnal seimbang tetap seimbang & mengikuti aturan reversal", rv.status === 200 && sums.d === sums.c && sums.d === 100000, `${st(rv)}; D ${sums.d} K ${sums.c}`, "HIGH");
  // H import
  const jbuf = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal"); ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]); for (const x of rows) ws.addRow(x); return Buffer.from(await wb.xlsx.writeBuffer()); };
  const ub = await jbuf([[code.kas("MTR"), "2026-02-12", `U2-H-${rid}`, "x", "x", 100000, null], [code.pend("MTR"), "2026-02-12", `U2-H-${rid}`, "x", "x", null, 99999]]); b0 = jc();
  const pv = await acct.upload(`${A()}/journal-import/preview`, "u.xlsx", ub); const cm = await acct.upload(`${A()}/journal-import/commit`, "u.xlsx", ub);
  t("U2-H", "UAT-002", "import jurnal tak seimbang: preview ERROR, commit ditolak (400), database tidak berubah", pv.status === 200 && pv.json.errorCount === 1 && pv.json.canCommit === false && cm.status === 400 && JSON.stringify(jc()) === JSON.stringify(b0), `${st(pv)} err=${pv.json?.errorCount}; commit ${cm.status}`, "HIGH");
  // laporan tetap sehat
  const tb = await owner.get(`${A()}/trial-balance?periodId=${pid}`), bs = await owner.get(`${A()}/reports/balance-sheet?fromDate=2021-01-01&toDate=2026-02-28`), ds = await owner.get(`${A()}/dashboard?fromDate=2026-02-01&toDate=2026-02-28`);
  t("U2-reports", "UAT-002", "Trial Balance seimbang, Neraca & Dashboard HTTP 200 (tidak ada 500 akibat satu jurnal invalid)", tb.json?.isBalanced === true && bs.status === 200 && ds.status === 200, `TB ${tb.json?.isBalanced}, BS ${bs.status}, Dashboard ${ds.status}`, "HIGH");
  // saldo awal import tak seimbang (Company B)
  const B = (p) => `/api/company-db/pt-pembanding${p}`;
  const r0 = await pen.get(B("/opening-balance-import/template"), { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r0.buf); const ws = wb.getWorksheet("Saldo Awal"); ws.getCell("B3").value = "2025-01-01"; for (let i = ws.rowCount; i >= 13; i--) ws.getRow(i).values = []; ws.getRow(13).values = ["1100", "Kas B", 100000, null, ""]; ws.getRow(14).values = ["3100", "Modal B", null, 99999, ""];
  const obb = Buffer.from(await wb.xlsx.writeBuffer()); const ob = await pen.upload(B("/opening-balance-import/commit"), "ob.xlsx", obb); t("U2-OB", "UAT-002", "import Saldo Awal selisih Rp 1 ditolak (400)", ob.status === 400, st(ob), "HIGH");
}

// ================= UAT-003
{
  const kas = accId[code.kas("PST")], pend = accId[code.pend("PST")];
  const jc = () => { const d = dbA(); const n = d.prepare("select count(*) c from journal_entries").get().c; d.close(); return n; };
  const pFeb = per["2026-02"]; const rid = Math.random().toString(36).slice(2, 6);
  const mkd = (c, date, pid = pFeb) => c.post(`${A()}/journal`, { referenceNo: `U3-${date}-${rid}`, periodId: pid, entryDate: date, lines: [{ accountId: kas, debit: 10, credit: 0 }, { accountId: pend, debit: 0, credit: 10 }] });
  await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "2024-01-01", toDate: "2025-12-31" });
  const periods = (await owner.get(`${A()}/periods`)).json.periods; const pid = (m) => periods.find((p) => p.startDate.startsWith(m))?.id;
  const cases = [["2026-02-28", pFeb, true], ["2026-02-29", pFeb, false], ["2026-02-30", pFeb, false], ["2026-04-31", per["2026-04"], false], ["2026-06-31", per["2026-06"], false], ["2024-02-29", pid("2024-02"), true], ["2025-02-29", pid("2025-02"), false], ["2026-13-01", pFeb, false], ["2026-02-3", pFeb, false], ["26-02-10", pFeb, false], ["2026/02/10", pFeb, false]];
  for (const [d, p, ok] of cases) {
    const b = jc(); const r = await mkd(acct, d, p);
    // 2026-06 berstatus CLOSED di uji lain; untuk tanggal tidak nyata penolakan harus 400 (validasi tanggal lebih dulu dari aturan periode)
    if (d === "2026-02-28" && r.status === 201) await acct.post(`${A()}/journal/${r.json.journalId}/post`);
    const pass = ok ? r.status === 201 : r.status === 400 && jc() === b;
    t("U3-api-" + d.replace(/\W/g, ""), "UAT-003", `jurnal manual tanggal ${d} ${ok ? "diterima (tanggal nyata)" : "ditolak 400 dan tidak tersimpan"}`, pass, st(r), "HIGH");
  }
  // import
  const jbuf = async (date, ref) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Jurnal"); ws.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]); ws.addRow([code.kas("MTR"), date, ref, "x", "x", 500, null]); ws.addRow([code.pend("MTR"), date, ref, "x", "x", null, 500]); return Buffer.from(await wb.xlsx.writeBuffer()); };
  for (const d of ["2026-02-30", "2025-02-29", "2026-04-31", "2026-06-31", "2026-02-3", "1/2/2026"]) {
    const buf = await jbuf(d, `U3I-${rid}-${d.replace(/\W/g, "")}`); const b = jc(); const pv = await acct.upload(`${A()}/journal-import/preview`, "u.xlsx", buf); const cm = await acct.upload(`${A()}/journal-import/commit`, "u.xlsx", buf);
    const shifted = (() => { const x = dbA(); const n = x.prepare("select count(*) c from journal_entries where reference_no like ?").get(`U3I-${rid}-%`).c; x.close(); return n; })();
    t("U3-imp-" + d.replace(/\W/g, ""), "UAT-003", `import tanggal ${d}: preview ERROR, commit 400, 0 perubahan database`, pv.status === 200 && pv.json.errorCount === 1 && pv.json.canCommit === false && cm.status === 400 && jc() === b && shifted === 0, `${st(pv)} err=${pv.json?.errorCount} ${(pv.json?.transactions?.[0]?.issues ?? []).join("; ").slice(0, 90)}; commit ${cm.status}`, "HIGH");
  }
  for (const d of ["2026-02-28"]) { const buf = await jbuf(d, `U3I-OK-${rid}`); const pv = await acct.upload(`${A()}/journal-import/preview`, "u.xlsx", buf); const cm = await acct.upload(`${A()}/journal-import/commit`, "u.xlsx", buf); t("U3-imp-ok", "UAT-003", "import tanggal nyata 2026-02-28 tetap valid & tersimpan tepat pada tanggalnya", pv.json?.validCount === 1 && cm.status === 200 && (() => { const x = dbA(); const r = x.prepare("select entry_date e from journal_entries where reference_no=?").get(`U3I-OK-${rid}`); x.close(); return String(r?.e).slice(0, 10) === "2026-02-28"; })(), st(cm), "HIGH"); }
  // jalur lain
  const e = encodeURIComponent; const chk = async (id, name, p) => { const r = await owner.get(`${A()}${p}`); t(id, "UAT-003", name, r.status === 400, st(r), "HIGH"); };
  for (const bad of ["2025-02-30", "2025", "1/1/2025", "' OR '1'='1"]) {
    await chk("U3-dash-" + bad.length, `dashboard tanggal '${bad}' -> 400`, `/dashboard?fromDate=${e(bad)}&toDate=${e(bad)}`);
    await chk("U3-bs-" + bad.length, `Neraca tanggal '${bad}' -> 400 (bukan 500/alarm palsu)`, `/reports/balance-sheet?fromDate=${e(bad)}&toDate=${e(bad)}`);
    await chk("U3-is-" + bad.length, `Laba Rugi tanggal '${bad}' -> 400`, `/reports/income-statement?fromDate=${e(bad)}&toDate=${e(bad)}`);
  }
  await chk("U3-cf", "Arus Kas tanggal 2025-02-30 -> 400", `/reports/cash-flow?fromDate=2025-02-30&toDate=2025-12-31`);
  await chk("U3-eq", "Ekuitas tanggal 2025-02-30 -> 400", `/reports/equity?fromDate=2025-01-01&toDate=2025-02-30`);
  await chk("U3-ledger", "Ledger tanggal 2025-02-30 -> 400", `/ledger/${accId[code.bca]}?fromDate=2025-02-30&toDate=2025-12-31`);
  await chk("U3-export", "Export laporan tanggal 2025-02-30 -> 400", `/reports/export/income-statement?format=xlsx&fromDate=2025-02-30&toDate=2025-12-31`);
  await chk("U3-analysis", "Analisis tanggal 2025-02-30 -> 400", `/analysis?fromDate=2025-02-30&toDate=2025-12-31`);
  await chk("U3-tax", "Pajak tanggal 2025-02-30 -> 400", `/tax-summary?fromDate=2025-02-30&toDate=2025-12-31`);
  await chk("U3-proj", "Proyeksi asOfDate 2025-02-30 -> 400", `/projection?asOfDate=2025-02-30&monthsAhead=3`);
  await chk("U3-audit", "Audit log fromDate 2025-02-30 -> 400", `/audit-log?fromDate=2025-02-30`);
  await chk("U3-journals", "Daftar jurnal filter fromDate 2025-02-30 -> 400", `/journals?fromDate=2025-02-30`);
  const gp = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "2027-02-30", toDate: "2027-03-31" }); t("U3-period", "UAT-003", "generate periode dengan tanggal 2027-02-30 -> 400", gp.status === 400, st(gp), "HIGH");
  const gp2 = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "abc", toDate: "def" }); t("U3-period2", "UAT-003", "generate periode dengan 'abc' -> 400 (dulu 201 dengan created 0)", gp2.status === 400, st(gp2), "MEDIUM");
  const rv = await acct.post(`${A()}/journal/reversal`, { referenceNo: `U3-2026-02-28-${rid}`, entryDate: "2026-02-30", reason: "x" }); t("U3-reversal", "UAT-003", "reversal dengan tanggal 2026-02-30 -> 400", rv.status === 400, st(rv), "HIGH");
  const rv2 = await acct.post(`${A()}/journal/reversal`, { referenceNo: `U3-2026-02-28-${rid}`, entryDate: "2026-02-28", reason: "uji reversal tanggal sah" }); t("U3-reversal-ok", "UAT-003", "reversal dengan tanggal asli yang sah tetap berhasil", rv2.status === 200, st(rv2), "HIGH");
  const ob = await pen.get(`/api/company-db/pt-pembanding/opening-balance`); void ob;
  // saldo awal import dgn tanggal tidak nyata (Company B)
  const B = (p) => `/api/company-db/pt-pembanding${p}`; const r0 = await pen.get(B("/opening-balance-import/template"), { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r0.buf); const ws = wb.getWorksheet("Saldo Awal"); ws.getCell("B3").value = "2025-02-30"; for (let i = ws.rowCount; i >= 13; i--) ws.getRow(i).values = []; ws.getRow(13).values = ["1100", "Kas B", 100, null, ""]; ws.getRow(14).values = ["3100", "Modal B", null, 100, ""];
  const obr = await pen.upload(B("/opening-balance-import/commit"), "ob.xlsx", Buffer.from(await wb.xlsx.writeBuffer())); t("U3-ob", "UAT-003", "import Saldo Awal tanggal 2025-02-30 ditolak (400)", obr.status === 400, st(obr), "HIGH");
  const obm = await pen.post(B("/opening-balance"), { entryDate: "2025-02-30", periodId: "x", lines: [] }); t("U3-ob-manual", "UAT-003", "Saldo Awal manual tanggal 2025-02-30 -> 400", obm.status === 400, st(obm), "HIGH");
}
console.log("REGRESSION-HIGH SELESAI"); process.exit(0);
