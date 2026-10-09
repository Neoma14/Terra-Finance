import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { S, ROOT, DATA, EXE, SERVER_JS, startServer, waitHealthy, Client, rec, note, saveState, A, sleep } from "./lib.mjs";

const INSTALLER = `${ROOT}/apps/desktop/dist/TERRA FINANCE Setup 0.1.0.exe`;
for (const f of ["results.jsonl", "perf.jsonl"]) fs.rmSync(`${S}/${f}`, { force: true });
fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(`${S}/ex1`, { recursive: true, force: true }); fs.rmSync(`${S}/state.json`, { force: true });
fs.mkdirSync(DATA, { recursive: true });

// 1) lingkungan = installer FINAL diekstrak
const base = `${ROOT}/node_modules/.pnpm`; const zdir = fs.readdirSync(base).find((n) => n.startsWith("7zip-bin"));
execFileSync(`${base}/${zdir}/node_modules/7zip-bin/win/x64/7za.exe`, ["x", "-y", `-o${S}/ex1`, INSTALLER], { stdio: "ignore" });
rec("ENV-01", "env", "installer final diekstrak ke folder UAT", fs.existsSync(EXE) && fs.existsSync(SERVER_JS), `${(fs.statSync(INSTALLER).size / 1e6).toFixed(1)} MB, dibuat ${fs.statSync(INSTALLER).mtime.toISOString()}`);

// 2) lisensi UAT (ditandatangani kunci vendor; log penerbitan ke folder UAT; kunci tidak dicetak)
const out = execFileSync("node", [`${ROOT}/tools/license-generator/src/cli.mjs`, "create", "--client", "PT TERRA NUSANTARA (UAT)", "--expiry", "lifetime", "--devices", "1"], { env: { ...process.env, TERRA_VENDOR_DIR: S, TERRA_LICENSE_PRIVATE_KEY: "C:/Users/fachr/TERRA-VENDOR/license-private.pem", TERRA_LICENSE_PUBLIC_KEY: "C:/Users/fachr/TERRA-VENDOR/license-public.pem" } }).toString();
const key = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("TFO2-"));
fs.writeFileSync(`${S}/uat.key`, key);
rec("ENV-02", "env", "lisensi UAT terpisah diterbitkan (bukan lisensi production)", Boolean(key));

// 3) server
startServer("main");
rec("ENV-03", "env", "server UAT hidup di port 4500 (production di 4000 tidak disentuh)", await waitHealthy());

const owner = new Client("owner");
let r = await owner.post("/api/setup/complete", { companyName: "PT TERRA NUSANTARA", industry: "Dagang", licenseKey: key, adminEmail: "owner@terra-nusantara.test", adminPassword: "Uat#Owner2026", adminFullName: "Owner UAT" });
rec("SET-01", "setup", "Setup awal + aktivasi lisensi", r.status === 200, `status ${r.status}`);
r = await owner.login("owner@terra-nusantara.test", "Uat#Owner2026"); rec("SET-02", "auth", "login owner", r.status === 200);

// 4) pengguna aplikasi
const users = [["admin@terra-nusantara.test", "Admin UAT", "staff"], ["akuntan@terra-nusantara.test", "Akuntan UAT", "staff"], ["staf@terra-nusantara.test", "Staf UAT", "staff"], ["viewer@terra-nusantara.test", "Viewer UAT", "staff"], ["penyusup@pembanding.test", "Penyusup UAT", "staff"]];
const ids = {};
for (const [email, fullName, role] of users) { r = await owner.post("/api/users", { email, password: "Uat#Pass2026", fullName, role }); ids[email] = r.json?.id ?? r.json?.userId; rec("USR-" + email.split("@")[0], "users", `buat user ${email}`, r.status === 201 || r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`); }
const ul = await owner.get("/api/users");
for (const u of ul.json?.users ?? []) ids[u.email] = u.id;
rec("USR-list", "users", "daftar user memuat 6 akun", (ul.json?.users ?? []).length === 6, `${(ul.json?.users ?? []).length}`);

// 5) perusahaan A dan B
const mk = async (name, slug) => owner.post("/api/company-db", { name, slug, legalEntityType: "PT", industry: "Dagang", currency: "IDR", fiscalYearStartMonth: 1, city: "Bandar Lampung" });
r = await mk("PT TERRA NUSANTARA", "pt-terra-nusantara"); rec("CMP-A", "company", "buat Company A", r.status === 201, `status ${r.status}`);
r = await mk("PT PEMBANDING UAT", "pt-pembanding"); rec("CMP-B", "company", "buat Company B", r.status === 201, `status ${r.status}`);
const grant = async (slug, email, role) => (await owner.post(`${A(slug)}/access`, { userId: ids[email], role }));
for (const [email, role] of [["admin@terra-nusantara.test", "ADMIN"], ["akuntan@terra-nusantara.test", "ACCOUNTANT"], ["staf@terra-nusantara.test", "STAFF"], ["viewer@terra-nusantara.test", "VIEWER"]]) { r = await grant("pt-terra-nusantara", email, role); rec("ACC-" + role, "access", `beri akses ${role} ke Company A`, r.status === 201 || r.status === 200, `status ${r.status} ${r.json?.error ?? ""}`); }
r = await grant("pt-pembanding", "penyusup@pembanding.test", "OWNER"); rec("ACC-B-OWNER", "access", "beri OWNER Company B ke user lain", r.status === 201 || r.status === 200, `status ${r.status} ${r.json?.error ?? ""}`);

// 6) periode
r = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "2021-01-01", toDate: "2025-12-31" }); rec("PER-A", "periods", "generate 60 periode bulanan 2021-2025", r.status === 201, `status ${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
r = await owner.post(`${A("pt-pembanding")}/periods/generate-monthly`, { fromDate: "2025-01-01", toDate: "2025-12-31" }); rec("PER-B", "periods", "periode Company B", r.status === 201);
const per = (await owner.get(`${A()}/periods`)).json.periods; const periodByMonth = {}; for (const p of per) periodByMonth[p.startDate.slice(0, 7)] = p.id;
rec("PER-count", "periods", "jumlah periode Company A = 60", per.length === 60, `${per.length}`);
saveState({ ids, periodByMonth });
console.log("setup selesai");
process.exit(0);
