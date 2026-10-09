import fs from "node:fs";
import path from "node:path";
import { S, DATA, Client, A, ExcelJS, rec, note, timed, state, dbA, Database, ymd } from "./lib.mjs";
import { code, coaRows, OB } from "./gen.mjs";

const { accId } = state(); const names = Object.fromEntries(coaRows().map((r) => [r.c, r.n]));
const mk = async (e, p = "Uat#Pass2026") => { const c = new Client(e); await c.login(e, p); return c; };
const owner = await mk("owner@terra-nusantara.test", "Uat#Owner2026"), acct = await mk("akuntan@terra-nusantara.test"), staf = await mk("staf@terra-nusantara.test"), viewer = await mk("viewer@terra-nusantara.test"), pen = await mk("penyusup@pembanding.test");
const t = (id, name, cond, detail = "", sev = "MEDIUM") => rec(id, "import", name, cond, detail, sev);
const jcount = () => { const db = dbA(); const n = db.prepare("select count(*) c from journal_entries").get().c; db.close(); return n; };
async function jbuf(txs, { header = ["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"], sheet = "Jurnal", extraCol = false } = {}) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(sheet); ws.addRow(extraCol ? [...header, "Kolom Asing"] : header);
  for (const x of txs) { for (const l of x.lines) ws.addRow([l[0], x.date, x.ref, names[l[0]] ?? "?", x.desc ?? "uji import", l[1] || null, l[2] || null, ...(extraCol ? ["zzz"] : [])]); ws.addRow([]); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const tx = (ref, date, amt = 100000, a = code.kas("MTR"), b = code.pend("MTR")) => ({ ref, date, lines: [[a, amt, 0], [b, 0, amt]] });
const pv = (c, buf, name = "t.xlsx") => c.upload(`${A()}/journal-import/preview`, name, buf);
const cm = (c, buf, name = "t.xlsx") => c.upload(`${A()}/journal-import/commit`, name, buf);
const st = (r) => `status ${r.status}${r.json?.error ? " " + r.json.error : ""}`;
const today = ymd(new Date(Date.now() + 7 * 3600e3)); const addDays = (d, n) => ymd(new Date(Date.parse(d + "T00:00:00Z") + n * 864e5));
const lines = (r) => (r.json?.transactions ?? []).map((x) => x.status).join(",");

// ---- jurnal: valid -> preview -> commit -> audit
{
  const buf = await jbuf([tx("IMP-OK-1", "2026-03-02"), tx("IMP-OK-2", "2026-03-03", 250000)]);
  const before = jcount(); let r = await pv(acct, buf);
  t("JI-valid-pv", "valid: preview 2 transaksi VALID", r.status === 200 && r.json.validCount === 2 && r.json.canCommit === true, st(r));
  t("JI-valid-nosave", "preview tidak menyimpan apa pun", jcount() === before, `${before} -> ${jcount()}`, "HIGH");
  r = await cm(acct, buf); t("JI-valid-cm", "valid: commit -> 2 jurnal Posted", r.status === 200 && r.json.committedCount === 2 && jcount() === before + 2, st(r) + ` ${JSON.stringify(r.json).slice(0, 80)}`);
  const al = (await owner.get(`${A()}/audit-log?page=1&pageSize=50`)).json; const has = JSON.stringify(al).includes("journal.import"); t("JI-audit", "import tercatat di audit log (journal.import)", has, "", "HIGH");
  r = await pv(acct, buf); t("JI-dup", "duplikat: upload ulang ditandai 'sudah pernah diinput'", r.status === 200 && (r.json.transactions ?? []).every((x) => x.alreadyExists), lines(r));
  r = await cm(acct, buf); t("JI-dup-cm", "duplikat: commit tidak membuat jurnal ganda", (r.status === 400 || r.json?.committedCount === 0) && jcount() === before + 2, st(r), "HIGH");
}
// ---- error cases (semua harus: ERROR di preview, commit ditolak, tidak ada jurnal tersimpan)
const bad = {
  "akun tidak ada": tx("IMP-E1", "2026-03-04", 1000, "0000", code.pend("MTR")),
  "tanggal bukan tanggal": { ...tx("IMP-E2", "bukan-tanggal"), date: "bukan-tanggal" },
  "tanggal 2026-02-30": tx("IMP-E3", "2026-02-30"),
  "tanggal masa depan": tx("IMP-E4", addDays(today, 3)),
  "tidak balance": { ref: "IMP-E5", date: "2026-03-05", lines: [[code.kas("MTR"), 1000, 0], [code.pend("MTR"), 0, 900]] },
  "akun terkunci": tx("IMP-E6", "2026-03-06", 1000, "1100", code.pend("MTR")),
  "periode belum ada": tx("IMP-E7", "2031-01-05"),
  "satu baris saja": { ref: "IMP-E8", date: "2026-03-07", lines: [[code.kas("MTR"), 1000, 0]] },
  "debit & kredit satu baris": { ref: "IMP-E9", date: "2026-03-07", lines: [[code.kas("MTR"), 1000, 1000], [code.pend("MTR"), 0, 0]] },
};
// akun terkunci: gunakan akun 9001 (terkunci di tahap CRUD) -> kode 9001
bad["akun terkunci"] = tx("IMP-E6", "2026-03-06", 1000, "9001", code.pend("MTR"));
for (const [name, x] of Object.entries(bad)) {
  const before = jcount(); const buf = await jbuf([x]); let r = await pv(acct, buf);
  const isErr = r.status === 200 ? (r.json.errorCount ?? 0) > 0 && r.json.canCommit === false : r.status === 400;
  t("JI-bad-" + name.replace(/\W+/g, "").slice(0, 14), `invalid: ${name} -> ERROR di preview`, isErr, st(r) + " " + lines(r) + " " + ((r.json?.transactions?.[0]?.issues ?? []).join("; ").slice(0, 100)), "HIGH");
  const c = await cm(acct, buf); t("JI-badcm-" + name.replace(/\W+/g, "").slice(0, 14), `invalid: ${name} -> commit langsung ditolak (server validasi ulang) & tidak ada data tersimpan`, c.status === 400 && jcount() === before, st(c), "HIGH");
}
// backdate violation
{
  await owner.put(`${A()}/journal-settings`, { maxBackdateDays: 7 });
  const before = jcount(); const buf = await jbuf([tx("IMP-BD", "2026-03-10")]); let r = await pv(acct, buf); const c = await cm(acct, buf);
  t("JI-backdate", "melanggar batas backdate -> ERROR di preview & commit ditolak", (r.json?.errorCount ?? 0) > 0 && c.status === 400 && jcount() === before, st(r) + " | " + (r.json?.transactions?.[0]?.issues ?? []).join("; ").slice(0, 120), "HIGH");
  await owner.put(`${A()}/journal-settings`, { maxBackdateDays: null });
}
// atomicity: 50 valid + 1 invalid
{
  const txs = Array.from({ length: 50 }, (_, i) => tx(`IMP-AT-${i}`, "2026-03-11", 1000 + i)); txs.push(tx("IMP-AT-BAD", "2026-03-11", 1000, "0000", code.pend("MTR")));
  const before = jcount(); const c = await cm(acct, await jbuf(txs)); t("JI-atomic", "atomic: 50 valid + 1 error -> tidak ada yang tersimpan", c.status === 400 && jcount() === before, st(c), "HIGH");
}
// file bermasalah
{
  const before = jcount();
  let r = await pv(acct, Buffer.from("ini bukan excel"), "x.xlsx"); t("JI-malformed", "file bukan Excel (isi teks) -> 400 pesan jelas, tanpa 500", r.status === 400 && /tidak dapat dibaca/i.test(r.json?.error ?? ""), st(r), "HIGH");
  r = await pv(acct, Buffer.alloc(0), "kosong.xlsx"); t("JI-zero", "file 0 byte ditolak (bukan 500)", r.status === 400, st(r), "HIGH");
  const wb = new ExcelJS.Workbook(); wb.addWorksheet("Jurnal").addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]); const emptyBuf = Buffer.from(await wb.xlsx.writeBuffer());
  r = await pv(acct, emptyBuf); t("JI-empty", "Excel hanya header (kosong) -> tidak bisa commit", r.status === 200 ? r.json.canCommit === false : r.status === 400, st(r) + JSON.stringify(r.json?.fileErrors ?? ""), "MEDIUM");
  r = await pv(acct, await jbuf([tx("IMP-S", "2026-03-12")], { sheet: "SheetSalah" })); t("JI-sheet", "nama sheet salah -> ditolak jelas", r.status === 200 ? (r.json.fileErrors ?? []).length > 0 && r.json.canCommit === false : r.status === 400, st(r) + JSON.stringify(r.json?.fileErrors ?? "").slice(0, 80));
  r = await pv(acct, await jbuf([tx("IMP-C", "2026-03-12")], { extraCol: true })); t("JI-extracol", "kolom asing diabaikan (tidak error, tidak crash)", r.status === 200 && r.json.validCount === 1, st(r));
  r = await pv(acct, await jbuf([tx("IMP-H", "2026-03-12")], { header: ["A", "B", "C", "D", "E", "F", "G"] })); t("JI-header", "header salah ditolak jelas", r.status === 200 ? (r.json.fileErrors ?? []).length > 0 : r.status === 400, st(r));
  // formula & teks berbahaya
  const wf = new ExcelJS.Workbook(); const sh = wf.addWorksheet("Jurnal"); sh.addRow(["Kode Akun", "Tgl", "No Jurnal", "Akun Buku Besar", "Keterangan", "Debet", "Kredit"]);
  sh.addRow([code.kas("MTR"), "2026-03-13", "IMP-F", "x", "=HYPERLINK(\"http://evil\",\"klik\")", { formula: "500+500" }, null]); sh.addRow([code.pend("MTR"), "2026-03-13", "IMP-F", "x", "@SUM(1+1)", null, 1000]);
  r = await pv(acct, Buffer.from(await wf.xlsx.writeBuffer())); t("JI-formula", "sel formula/teks '=' tidak menyebabkan crash (status < 500)", r.status < 500, st(r) + " " + lines(r), "HIGH");
  note("JI-formula-detail", "import", "hasil formula di kolom Debet (tanpa cache hasil)", `${lines(r)} ${(r.json?.transactions?.[0]?.issues ?? []).join("; ").slice(0, 100)}`);
  r = await pv(acct, await jbuf([tx("IMP-X", "2026-03-12")]), "../../../evil.xlsx"); t("JI-trav1", "nama file '../../../evil.xlsx' tidak dipakai sebagai path", r.status === 200, st(r), "HIGH");
  r = await cm(acct, await jbuf([tx("IMP-TR", "2026-03-14")]), "..\\..\\windows\\evil.xlsx");
  const hist = (await owner.get(`${A()}/journal-import/history`)).json; const fn = (hist.history ?? []).map((h) => h.fileName ?? h.file_name).filter(Boolean);
  const escaped = [path.join(S, "evil.xlsx"), path.join(DATA, "evil.xlsx"), "C:/evil.xlsx", path.join(S, "..", "evil.xlsx")].filter((p) => fs.existsSync(p));
  t("JI-trav2", "nama file traversal tidak menulis file di luar folder data", escaped.length === 0, `riwayat nama: ${fn.slice(0, 3).join(" | ")}; file liar: ${escaped.length}`, "HIGH");
  t("JI-trav3", "nama file di riwayat tidak mengandung ../ mentah", !fn.some((n) => /\.\.[\\/]/.test(n)), fn.slice(0, 3).join(" | "), "MEDIUM");
  void before;
}
// permission
{
  const buf = await jbuf([tx("IMP-P", "2026-03-15")]);
  let r = await pv(staf, buf); t("JI-perm-staf-pv", "STAFF boleh preview", r.status === 200, st(r));
  r = await cm(staf, buf); t("JI-perm-staf-cm", "STAFF tidak boleh commit import (403)", r.status === 403, st(r), "HIGH");
  r = await pv(viewer, buf); t("JI-perm-view", "VIEWER tidak boleh preview import (403)", r.status === 403, st(r), "HIGH");
  r = await pv(pen, buf); t("JI-perm-other", "user company lain ditolak (404)", r.status === 404, st(r), "CRITICAL");
}
// file besar wajar: 2.000 transaksi
{
  const txs = []; for (let i = 0; i < 2000; i++) txs.push({ ref: `BIG-${i}`, date: `2026-0${3 + (i % 6)}-${String(1 + (i % 27)).padStart(2, "0")}`, lines: [[code.kas("BDL"), 10000 + i, 0], [code.pend("BDL"), 0, 10000 + i]] });
  const buf = await jbuf(txs); const before = jcount();
  const p = await timed("import besar preview 2000", () => pv(acct, buf)); const c = await timed("import besar commit 2000", () => cm(acct, buf));
  t("JI-large", `file besar 2.000 transaksi (${(buf.length / 1e6).toFixed(1)} MB): preview ${p.ms}ms, commit ${c.ms}ms`, p.res.status === 200 && p.res.json.validCount === 2000 && c.res.status === 200 && jcount() === before + 2000, st(c.res), "HIGH");
}
// ---- COA import negatif
{
  const coaBuf = async (rows, sheet = "Akun") => { const r0 = await owner.get(`${A()}/accounts-import/template`, { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r0.buf); const ws = wb.getWorksheet("Akun"); for (let i = ws.rowCount; i >= 13; i--) ws.getRow(i).values = []; rows.forEach((x, i) => { ws.getRow(13 + i).values = x; }); ws.name = sheet; return Buffer.from(await wb.xlsx.writeBuffer()); };
  const cp = (buf) => acct.upload(`${A()}/accounts-import/preview`, "c.xlsx", buf), cc = (buf) => acct.upload(`${A()}/accounts-import/commit`, "c.xlsx", buf);
  const total = async () => (await owner.get(`${A()}/accounts?pageSize=1`)).json.total; const n0 = await total();
  let buf = await coaBuf([["9101", "Akun Impor OK", "Aset", "", "", "Ya", "", "", ""], ["9102", "Akun Impor OK 2", "Beban", "", "", "Ya", "", "", ""]]); let r = await cp(buf);
  t("CI-valid", "COA valid: preview 2 baris valid", r.status === 200 && r.json.canCommit !== false, st(r)); r = await cc(buf); t("CI-valid-cm", "COA valid: commit", r.status === 200 && (await total()) === n0 + 2, st(r));
  r = await cc(buf); t("CI-dup", "COA kode sudah ada dilewati (tidak menimpa, tidak error)", r.status === 200 || r.status === 400, st(r) + " " + JSON.stringify(r.json).slice(0, 100)); t("CI-dup-count", "COA duplikat tidak menambah akun", (await total()) === n0 + 2, `${await total()} vs ${n0 + 2}`, "HIGH");
  for (const [n, rows] of [["tipe tidak dikenal", [["9103", "X", "Alien", "", "", "Ya", "", "", ""]]], ["nama kosong", [["9104", "", "Aset", "", "", "Ya", "", "", ""]]], ["kode kosong", [["", "X", "Aset", "", "", "Ya", "", "", ""]]], ["induk melingkar", [["9105", "A", "Aset", "9106", "", "Ya", "", "", ""], ["9106", "B", "Aset", "9105", "", "Ya", "", "", ""]]], ["kode ganda di file", [["9107", "A", "Aset", "", "", "Ya", "", "", ""], ["9107", "B", "Aset", "", "", "Ya", "", "", ""]]], ["induk tidak ada", [["9108", "A", "Aset", "7777", "", "Ya", "", "", ""]]]]) {
    const before = await total(); const b = await coaBuf(rows); const p = await cp(b); const c = await cc(b);
    t("CI-bad-" + n.replace(/\W+/g, "").slice(0, 12), `COA invalid: ${n} -> ditolak, tidak ada data tersimpan`, (p.status === 400 || p.json?.canCommit === false || (p.json?.errorCount ?? 0) > 0) && (c.status === 400 || (await total()) === before) && (await total()) === before, st(p) + " / " + st(c), "HIGH");
  }
  r = await cp(Buffer.from("bukan excel")); t("CI-malformed", "COA file rusak -> 400 jelas", r.status === 400, st(r), "HIGH");
  r = await cp(await coaBuf([], "Akun")); t("CI-empty", "COA file kosong tidak bisa commit", r.status === 400 || r.json?.canCommit === false, st(r));
  r = await staf.upload(`${A()}/accounts-import/commit`, "c.xlsx", buf); t("CI-perm", "STAFF tidak boleh commit COA (403)", r.status === 403, st(r), "HIGH");
}
// ---- Opening Balance import (Company B = bersih)
{
  const B = (p) => `/api/company-db/pt-pembanding${p}`;
  // COA minimal Company B lewat API
  const ids = {}; for (const [c, n, ty, nb] of [["1100", "Kas B", "ASSET", "debit"], ["3100", "Modal B", "EQUITY", "credit"], ["4100", "Pendapatan B", "REVENUE", "credit"]]) { const r = await pen.post(B("/accounts"), { code: c, name: n, accountTypeCode: ty, normalBalance: nb }); ids[c] = r.json?.accountId; }
  const ob = async (rows, date = "2025-01-01") => { const r0 = await pen.get(B("/opening-balance-import/template"), { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r0.buf); const ws = wb.getWorksheet("Saldo Awal"); ws.getCell("B3").value = date; for (let i = ws.rowCount; i >= 13; i--) ws.getRow(i).values = []; rows.forEach((x, i) => { ws.getRow(13 + i).values = x; }); return Buffer.from(await wb.xlsx.writeBuffer()); };
  const up = (u, path, buf) => u.upload(B(path), "ob.xlsx", buf);
  for (const [n, rows] of [["tidak balance", [["1100", "Kas B", 1000, null, ""], ["3100", "Modal B", null, 900, ""]]], ["akun ganda", [["1100", "Kas B", 500, null, ""], ["1100", "Kas B", 500, null, ""], ["3100", "Modal B", null, 1000, ""]]], ["nominal negatif", [["1100", "Kas B", -1000, null, ""], ["3100", "Modal B", null, -1000, ""]]], ["debit+kredit satu baris", [["1100", "Kas B", 1000, 1000, ""], ["3100", "Modal B", null, 0, ""]]], ["akun tidak ada", [["9999", "?", 1000, null, ""], ["3100", "Modal B", null, 1000, ""]]]]) {
    const b = await ob(rows); const p = await up(pen, "/opening-balance-import/preview", b); const c = await up(pen, "/opening-balance-import/commit", b);
    t("OBI-bad-" + n.replace(/\W+/g, "").slice(0, 12), `Saldo Awal invalid: ${n} -> ditolak`, c.status === 400, st(p) + " / " + st(c), "HIGH");
  }
  const good = await ob([["1100", "Kas B", 5000000, null, ""], ["3100", "Modal B", null, 5000000, ""]]);
  let r = await up(pen, "/opening-balance-import/commit", good); t("OBI-valid", "Saldo Awal valid -> Draft", r.status === 200, st(r));
  r = await up(pen, "/opening-balance-import/commit", good); t("OBI-second", "Saldo Awal kedua selagi yang pertama aktif ditolak", r.status === 400 || r.status === 409, st(r), "HIGH");
  r = await pen.post(B("/opening-balance/post"), {}); t("OBI-post", "Saldo Awal hasil import sudah otomatis Posted (Post kedua = 409)", r.status === 409, st(r));
  r = await pen.post(B("/opening-balance/reverse"), { reason: "UAT koreksi" }); t("OBI-rev", "Reversal Saldo Awal", r.status === 200, st(r));
  r = await up(pen, "/opening-balance-import/commit", good); t("OBI-new", "Saldo Awal baru boleh setelah reversal", r.status === 200, st(r));
  r = await up(owner, "/opening-balance-import/preview", good); t("OBI-cross", "Owner A (tanpa akses B?) -- owner memang punya akses B", r.status === 200 || r.status === 404, st(r), "INFO");
}
// ---- file > batas ukuran
{
  const big = Buffer.alloc(105 * 1024 * 1024, 1); const before = jcount(); let st2 = ""; try { const r = await pv(acct, big, "besar.xlsx"); st2 = `status ${r.status}`; t("JI-oversize", "file 105 MB ditolak tanpa crash", r.status === 413 || r.status === 400, st2, "HIGH"); } catch (e) { st2 = String(e.message); t("JI-oversize", "file 105 MB ditolak tanpa crash", true, "koneksi ditutup server: " + st2, "HIGH"); }
  const h = await fetch("http://127.0.0.1:4500/api/health").then((r) => r.ok).catch(() => false); t("JI-oversize-alive", "server tetap hidup setelah upload 105 MB", h === true && jcount() === before, `health ${h}`, "CRITICAL");
}
console.log("IMPORT SELESAI"); process.exit(0);
