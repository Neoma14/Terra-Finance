// Menyiapkan lingkungan UAT bisnis TERISOLASI dari nol: DB master (salinan, memuat lisensi), DB system BARU, dua perusahaan uji BARU
// (dibuat lewat API resmi), cabang, periode, akun antar-cabang, pengguna uji berhak berbeda, dan data operasional SINTETIS 3 bulan.
//   node scripts/business-uat/prepare-env.mjs <folder-kerja> <folder-backup-uat>
// Tidak menyentuh data pengguna nyata, %APPDATA%\TERRA FINANCE, atau port 4000.
import fs from "node:fs";
import path from "node:path";
import { WORK, DATA, SLUG, SLUG_OFF, COMPANY_DB, PORT, Client, serverEnv, startServer, dist, uid, personasFile } from "./lib.mjs";

const BK = path.resolve(process.argv[3]);
Object.assign(process.env, serverEnv());
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(`${DATA}/companies`, { recursive: true });
const masterSrc = fs.readdirSync(BK).find((n) => /^terra-finance-.*\.sqlite$/.test(n));
fs.copyFileSync(`${BK}/${masterSrc}`, `${DATA}/terra-finance.sqlite`); // DB master: lisensi + pengguna lama (tidak dipakai); DB system dibuat BARU oleh migrasi

const srv = await startServer(PORT, 0, "prep");
const { masterDb } = await dist("db/master/index.js");
const { systemDb } = await dist("db/system/index.js");
const { createSession } = await dist("modules/auth/session-service.js");
const { hashPassword } = await dist("modules/auth/password.js");
const { ensureSystemIdentity } = await dist("db/system/identity-bridge.js");
const { grantCompanyAccess } = await dist("db/system/company-access.js");
const { grantBranchAccess } = await dist("db/system/user-branch-access.js");
const { createCompanyDb } = await dist("db/company/index.js");
const { createDraftJournalEntry, postJournalEntry } = await dist("db/company/journal-service.js");
const { createAccount } = await dist("db/company/account-service.js");
const { createCounterparty } = await dist("db/company/counterparty-service.js");

const PASSWORD = "Uji-Bisnis-Cabang-1";
const personas = {};
async function mkUser(key, label) {
  const id = uid();
  const email = `${key}-${id.slice(0, 6)}@uji-bisnis.test`;
  await masterDb("users").insert({ id, email, password_hash: await hashPassword(PASSWORD), full_name: label, role: "admin" });
  const { token } = await createSession(id, {});
  await ensureSystemIdentity(systemDb, { id, email, fullName: label, role: "admin", avatarUrl: null });
  personas[key] = { id, key, label, email, password: PASSWORD, token };
  return personas[key];
}
for (const [k, l] of [["owner", "Pemilik Uji Bisnis"], ["otherOwner", "Pemilik Perusahaan Satu Cabang"], ["adminAll", "Admin Semua Cabang"], ["adminLim", "Admin Terbatas Metro dan Lampung"], ["acctHQ", "Akuntan Pusat"], ["acctMetro", "Akuntan Metro"], ["acctBL", "Akuntan Lampung"], ["acctBoth", "Akuntan Metro dan Lampung"], ["staffMetro", "Staf Metro"], ["staffBL", "Staf Lampung"], ["viewer", "Viewer Semua Cabang"], ["delegate", "Penerima Delegasi"], ["outsider", "Orang Luar Tanpa Akses"]]) await mkUser(k, l);

const owner = new Client(srv.base, personas.owner.token, "owner");
const other = new Client(srv.base, personas.otherOwner.token, "otherOwner");
const created1 = await owner.post("/api/company-db", { name: "PT UJI BISNIS CABANG (UAT)", slug: SLUG, industryTemplate: "general", fiscalYearStartMonth: 1 });
const created2 = await other.post("/api/company-db", { name: "PT UJI SATU CABANG (UAT)", slug: SLUG_OFF, industryTemplate: "general", fiscalYearStartMonth: 1 });
if (created1.status !== 201 || created2.status !== 201) throw new Error(`gagal membuat perusahaan uji: ${created1.status} ${created1.text} / ${created2.status} ${created2.text}`);
const reg = async (slug) => systemDb("companies_registry").where({ slug }).first();
const c1 = await reg(SLUG), c2 = await reg(SLUG_OFF);

// ---- struktur perusahaan uji 1 melalui API resmi (OWNER)
const A = `/api/company-db/${SLUG}`;
// OWNER menyalakan multi-cabang SECARA SADAR pada perusahaan uji (tidak ada UI untuk ini; PUT /multi-branch khusus OWNER)
const flag = await owner.put(`${A}/multi-branch`, { enabled: true });
if (flag.status !== 200) throw new Error("flag multi-cabang: " + flag.text);
const mkBranch = async (code, name) => {
  const r = await owner.post(`${A}/branches`, { code, name, openedAt: "2026-07-01" });
  if (r.status !== 201) throw new Error(`buat cabang ${code}: ${r.status} ${r.text}`);
  return r.json.id;
};
const hq = (await owner.get(`${A}/branches`)).json.branches.find((b) => b.isHeadOffice).id;
const metro = await mkBranch("MTR", "Cabang Metro");
const bl = await mkBranch("BDL", "Cabang Bandar Lampung");
const per = await owner.post(`${A}/periods/generate-monthly`, { fromDate: "2026-07-01", toDate: "2026-12-31" });
if (per.status !== 201) throw new Error("periode: " + per.text);

// ---- akun tambahan dan penandaan akun (DB uji; melalui layanan akun resmi) sebelum multi-cabang dinyalakan
const db = createCompanyDb(COMPANY_DB(SLUG));
const actor = { actorType: "user", actorId: personas.owner.id, actorLabel: "Pemilik Uji Bisnis" };
// Perusahaan baru dari API resmi belum memiliki bagan akun: dibuat di sini lewat layanan akun resmi (satu COA untuk semua cabang).
const COA = [
  ["1100", "Kas dan Setara Kas", "ASSET", "debit", null, true], ["1200", "Piutang Usaha", "ASSET", "debit", "operating", false], ["1300", "Persediaan", "ASSET", "debit", "operating", false],
  ["2100", "Utang Usaha", "LIABILITY", "credit", "operating", false], ["3100", "Modal Pemilik", "EQUITY", "credit", "financing", false],
  ["4100", "Pendapatan Penjualan", "REVENUE", "credit", "operating", false], ["5100", "Harga Pokok Penjualan", "COGS", "debit", "operating", false],
  ["6100", "Beban Operasional", "EXPENSE", "debit", "operating", false], ["6200", "Beban Gaji", "EXPENSE", "debit", "operating", false], ["6300", "Beban Listrik dan Air", "EXPENSE", "debit", "operating", false],
];
for (const [code, name, type, nb, cf, isCash] of COA) await createAccount(db, { code, name, accountTypeCode: type, normalBalance: nb, cashFlowActivity: cf, isCash, subledgerType: code === "1200" ? "receivable" : code === "2100" ? "payable" : null }, actor);
const acc = Object.fromEntries((await db("accounts").select("id", "code")).map((a) => [a.code, a.id]));

// ---- multi-cabang dinyalakan OWNER (PUT /multi-branch) lalu akun antar-cabang terpandu untuk setiap pasangan
for (const [x, y] of [[hq, metro], [hq, bl], [metro, bl]]) for (const t of ["ASSET", "LIABILITY"]) {
  const r = await owner.post(`${A}/accounts/inter-branch`, { branchAId: x, branchBId: y, accountTypeCode: t, confirm: true });
  if (r.status !== 201 && r.json?.code !== "INTER_BRANCH_ACCOUNT_PLAN_INVALID") throw new Error("akun antar-cabang: " + r.text); // sudah ada = tidak ada akun baru yang perlu dibuat
}

// ---- hak akses pengguna uji (peran + cakupan cabang)
async function grant(key, companyId, role, scope, branchIds = []) {
  const accessId = uid();
  await grantCompanyAccess(systemDb, { id: accessId, systemUserId: personas[key].id, companyId, role, branchScope: scope });
  for (const branchId of branchIds) await grantBranchAccess(systemDb, { companyId, accessId, targetUserId: personas[key].id }, branchId, { actorType: "system", actorLabel: "persiapan UAT" });
}
await grant("adminAll", c1.id, "ADMIN", "ALL");
await grant("adminLim", c1.id, "ADMIN", "LIMITED", [metro, bl]);
await grant("acctHQ", c1.id, "ACCOUNTANT", "LIMITED", [hq]);
await grant("acctMetro", c1.id, "ACCOUNTANT", "LIMITED", [metro]);
await grant("acctBL", c1.id, "ACCOUNTANT", "LIMITED", [bl]);
await grant("acctBoth", c1.id, "ACCOUNTANT", "LIMITED", [metro, bl]);
await grant("staffMetro", c1.id, "STAFF", "LIMITED", [metro]);
await grant("staffBL", c1.id, "STAFF", "LIMITED", [bl]);
await grant("viewer", c1.id, "VIEWER", "ALL");
await grant("delegate", c1.id, "ACCOUNTANT", "LIMITED", [metro]);

// ---- data operasional SINTETIS (Jul-Sep 2026) lewat layanan jurnal resmi: 3 cabang x ~16 jurnal/bulan; deterministik
let seed = 20261009;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const amt = (lo, hi, k = 1) => Math.round(((lo + rnd() * (hi - lo)) * k) / 1000) * 1000;
const periodOf = async (ym) => (await db("periods").where("start_date", `${ym}-01`).first()).id;
const cust = [], vend = [];
for (const n of [1, 2, 3]) { cust.push((await createCounterparty(db, { type: "customer", code: `C-00${n}`, name: ["Toko Maju Jaya", "CV Sinar Lampung", "UD Berkah Tani"][n - 1] }, actor)).id); vend.push((await createCounterparty(db, { type: "vendor", code: `V-00${n}`, name: ["PT Sumber Pangan", "CV Distribusi Sumatera", "UD Grosir Barokah"][n - 1] }, actor)).id); }
let jc = 0;
const journal = async (branch, tag, ymd, desc, lines) => {
  const ym = ymd.slice(0, 7);
  const { id } = await createDraftJournalEntry(db, { entryDate: ymd, periodId: await periodOf(ym), referenceNo: `${tag}-${ym.replace("-", "")}-${String(++jc).padStart(4, "0")}`, description: desc, branchId: branch, lines: lines.map(([a, d, c, cp]) => ({ accountId: acc[a], debit: d, credit: c, counterpartyId: cp ?? null })) }, actor);
  await postJournalEntry(db, { journalEntryId: id }, actor);
};
const day = (ym) => `${ym}-${String(1 + Math.floor(rnd() * 27)).padStart(2, "0")}`;
const branches = [[hq, "PST", 500_000_000], [metro, "MTR", 150_000_000], [bl, "BDL", 120_000_000]];
for (const [b, tag, cap] of branches) await journal(b, tag, "2026-07-01", "Setoran modal awal cabang", [["1100", cap, 0], ["3100", 0, cap]]);
for (const ym of ["2026-07", "2026-08", "2026-09"]) for (const [b, tag, cap] of branches) {
  const scale = cap / 150_000_000;
  for (let i = 0; i < 6; i++) { const v = amt(3_000_000, 15_000_000, scale); await journal(b, tag, day(ym), "Penjualan tunai harian", [["1100", v, 0], ["4100", 0, v]]); }
  for (let i = 0; i < 3; i++) { const v = amt(5_000_000, 20_000_000, scale); await journal(b, tag, day(ym), "Penjualan kredit", [["1200", v, 0, cust[i % 3]], ["4100", 0, v]]); }
  for (let i = 0; i < 2; i++) { const v = amt(2_000_000, 8_000_000, scale); await journal(b, tag, day(ym), "Penerimaan piutang", [["1100", v, 0], ["1200", 0, v, cust[i % 3]]]); }
  for (let i = 0; i < 3; i++) { const v = amt(6_000_000, 18_000_000, scale); await journal(b, tag, day(ym), "Pembelian barang dagang kredit", [["1300", v, 0], ["2100", 0, v, vend[i % 3]]]); }
  for (let i = 0; i < 3; i++) { const v = amt(3_000_000, 9_000_000, scale); await journal(b, tag, day(ym), "Harga pokok penjualan", [["5100", v, 0], ["1300", 0, v]]); }
  for (let i = 0; i < 2; i++) { const v = amt(2_000_000, 6_000_000, scale); await journal(b, tag, day(ym), "Pembayaran utang usaha", [["2100", v, 0, vend[i % 3]], ["1100", 0, v]]); }
  const gaji = amt(8_000_000, 12_000_000, scale);
  await journal(b, tag, day(ym), "Beban gaji karyawan", [["6200", gaji, 0], ["1100", 0, gaji]]);
  await journal(b, tag, day(ym), "Beban listrik dan air", [["6300", 1_250_000, 0], ["1100", 0, 1_250_000]]);
  for (let i = 0; i < 2; i++) { const v = amt(500_000, 2_500_000); await journal(b, tag, day(ym), "Beban operasional lain", [["6100", v, 0], ["1100", 0, v]]); }
}
const ibCount = (await db("accounts").where({ branch_policy: "INTER_BRANCH" }).count({ n: "*" }).first()).n;
if (ibCount !== 6) throw new Error(`akun antar-cabang seharusnya 6 (3 cabang lawan x 2 tipe), ada ${ibCount}`);
await db.destroy();

// ---- perusahaan uji 2 (multi-cabang TIDAK pernah dinyalakan): COA sama + data kecil, hanya Kantor Pusat
{
  const A2 = `/api/company-db/${SLUG_OFF}`;
  const p2 = await other.post(`${A2}/periods/generate-monthly`, { fromDate: "2026-07-01", toDate: "2026-12-31" });
  if (p2.status !== 201) throw new Error("periode 2: " + p2.text);
  const db2 = createCompanyDb(COMPANY_DB(SLUG_OFF));
  const actor2 = { actorType: "user", actorId: personas.otherOwner.id, actorLabel: "Pemilik Perusahaan Satu Cabang" };
  for (const [code, name, type, nb, cf, isCash] of COA) await createAccount(db2, { code, name, accountTypeCode: type, normalBalance: nb, cashFlowActivity: cf, isCash, subledgerType: code === "1200" ? "receivable" : code === "2100" ? "payable" : null }, actor2);
  const acc2 = Object.fromEntries((await db2("accounts").select("id", "code")).map((a) => [a.code, a.id]));
  const pid = async (ym) => (await db2("periods").where("start_date", `${ym}-01`).first()).id;
  const j2 = async (d, desc, lines) => { const { id } = await createDraftJournalEntry(db2, { entryDate: d, periodId: await pid(d.slice(0, 7)), referenceNo: `SC-${d.replace(/-/g, "")}-${++jc}`, description: desc, lines: lines.map(([a2, dr, cr]) => ({ accountId: acc2[a2], debit: dr, credit: cr })) }, actor2); await postJournalEntry(db2, { journalEntryId: id }, actor2); };
  await j2("2026-07-01", "Setoran modal awal", [["1100", 200_000_000, 0], ["3100", 0, 200_000_000]]);
  for (const ym of ["2026-07", "2026-08", "2026-09"]) { await j2(`${ym}-10`, "Penjualan tunai", [["1100", 12_500_000, 0], ["4100", 0, 12_500_000]]); await j2(`${ym}-15`, "Harga pokok penjualan", [["5100", 5_000_000, 0], ["1100", 0, 5_000_000]]); await j2(`${ym}-20`, "Beban operasional", [["6100", 2_000_000, 0], ["1100", 0, 2_000_000]]); }
  await db2.destroy();
}

// ---- bukti identitas lingkungan disimpan di personas.json (dan diverifikasi ulang oleh business-uat.mjs)
fs.writeFileSync(personasFile, JSON.stringify({ hq, metro, bl, accounts: acc, customers: cust, vendors: vend, companies: { [SLUG]: c1.id, [SLUG_OFF]: c2.id }, journals: jc, personas }, null, 1));
await masterDb.destroy();
await systemDb.destroy();
await srv.stop();
console.log("lingkungan siap:", { hq, metro, bl, jurnal: jc, perusahaan: [SLUG, SLUG_OFF] });
