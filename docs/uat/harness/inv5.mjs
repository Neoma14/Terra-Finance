import { Client, A, rec, note, state, Database, DATA } from "./lib.mjs";
const { ids } = state();
const owner = new Client("o"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const admin = new Client("a"); await admin.login("admin@terra-nusantara.test", "Uat#Pass2026");
const anon = new Client("x");
// 1. brute force yang benar (password >= 8 karakter)
let codes = []; for (let i = 0; i < 30; i++) { const x = await anon.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "salah-tebakan-" + i }, { noStore: true }); codes.push(x.status); }
const ok = await anon.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" }, { noStore: true });
rec("AU-bruteforce2", "authn", "30 percobaan password salah beruntun pada akun Owner: tidak ada penguncian akun/jeda (login benar tetap 200 sesudahnya)", ok.status !== 200 || codes.includes(429), `status percobaan: ${[...new Set(codes)].join(",")}; login benar sesudahnya = ${ok.status}`, "MEDIUM");
// 2. eskalasi ADMIN -> OWNER
const rows = async () => (await owner.get(`${A()}/access`)).json;
let r = await admin.patch(`${A()}/access/${ids["admin@terra-nusantara.test"]}`, { role: "OWNER" }); const after = JSON.stringify(await rows()).includes('"OWNER"');
const roleNow = (await rows()); const me = (roleNow.users ?? roleNow.access ?? roleNow.items ?? []).find((u) => u.email === "admin@terra-nusantara.test" || u.userId === ids["admin@terra-nusantara.test"]);
console.log("admin self-escalation:", r.status, JSON.stringify(me));
rec("BUG-PRIV-ADMIN-OWNER", "authz", "ADMIN dapat menaikkan perannya sendiri menjadi OWNER (eskalasi hak; memutus pemisahan OWNER-only untuk backup/restore)", r.status !== 200 && r.status !== 204, `PATCH access (self) -> status ${r.status}; peran sesudahnya: ${me?.role}`, "HIGH");
const probe = await admin.post(`${A()}/accounts/tidak-ada/lock`); console.log("admin lock probe", probe.status);
// pulihkan
const rr = await owner.patch(`${A()}/access/${ids["admin@terra-nusantara.test"]}`, { role: "ADMIN" }); console.log("restore", rr.status);
// 3. ADMIN memberi OWNER ke user lain (viewer)
r = await admin.patch(`${A()}/access/${ids["viewer@terra-nusantara.test"]}`, { role: "OWNER" });
rec("BUG-PRIV-ADMIN-GRANT", "authz", "ADMIN dapat memberikan peran OWNER kepada user lain", r.status !== 200, `PATCH access (viewer->OWNER) oleh ADMIN -> status ${r.status}`, "HIGH");
await owner.patch(`${A()}/access/${ids["viewer@terra-nusantara.test"]}`, { role: "VIEWER" });
// 4. ADMIN menurunkan/mencabut OWNER
r = await admin.patch(`${A()}/access/${(await owner.get("/api/auth/me")).json.user.id}`, { role: "VIEWER" });
rec("BUG-PRIV-ADMIN-DEMOTE", "authz", "ADMIN dapat menurunkan peran OWNER perusahaan", r.status !== 200, `PATCH access (owner->VIEWER) oleh ADMIN -> status ${r.status} ${r.json?.error ?? ""}`, "HIGH");
const chk = await owner.get(`${A()}/profile`); console.log("owner masih bisa akses:", chk.status);
const fix = await owner.patch(`${A()}/access/${(await owner.get("/api/auth/me")).json.user.id}`, { role: "OWNER" }); console.log("owner fix", fix.status);
// 5. tanggal lenient
rec("BUG-DATE-LENIENT", "validation", "Endpoint laporan/dashboard menerima tanggal non-ISO ('2025', '1/1/2025', \"' OR '1'='1\") -> HTTP 500 'Invalid time value' atau alarm palsu 'Balance Sheet tidak seimbang' (mis. 2025-02-30)", false, "GET dashboard/balance-sheet?fromDate=2025-02-30 -> 500 'Balance Sheet tidak seimbang'; fromDate=2025 -> 500; income-statement tidak menolak (200)", "MEDIUM");
rec("BUG-CP-FILTER", "validation", "counterparties?type=<tidak valid> mengabaikan filter dan mengembalikan semua data (bukan 400)", false, "type=admin'-- -> 200 seluruh daftar", "LOW");
process.exit(0);
