// Menyiapkan salinan data UAT untuk uji UI Inter-Branch (JANGAN diarahkan ke data produksi/klien): nyalakan multi-cabang, buat cabang Metro & BL, akun antarkantor, persona, dan sesi.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORK = path.resolve(process.argv[2]); // folder kerja (data uji + personas.json)
const C = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const W = `${WORK}/data`;
process.env.DB_FILE_PATH = `${W}/terra-finance.sqlite`;
process.env.SYSTEM_DB_FILE_PATH = `${W}/terra-system.sqlite`;
process.env.COMPANY_DATA_ROOT = `${W}/companies`;
process.env.NODE_ENV = "production";
process.env.SESSION_SECRET = crypto.createHash("sha256").update("ui").digest("hex");
const imp = (p) => import(pathToFileURL(`${C}/apps/api/dist/${p}`).href);

const { masterDb } = await imp("db/master/index.js");
const { systemDb } = await imp("db/system/index.js");
const { createSession } = await imp("modules/auth/session-service.js");
const { hashPassword } = await imp("modules/auth/password.js");
const { ensureSystemIdentity } = await imp("db/system/identity-bridge.js");
const { grantCompanyAccess } = await imp("db/system/company-access.js");
const { grantBranchAccess } = await imp("db/system/user-branch-access.js");
const { createCompanyDb } = await imp("db/company/index.js");
const { createBranch, setMultiBranchEnabled } = await imp("db/company/branch-service.js");
const { createInterBranchAccountPair } = await imp("db/company/account-policy-service.js");

// Kata sandi uji (hanya untuk persona di salinan data uji) agar alur login sungguhan dapat diuji, mis. di jendela Electron.
const PASSWORD = "Uji-Antar-Cabang-1";
const actor = { actorType: "user", actorId: "seed", actorLabel: "Seed" };
const reg = async (slug) => (await systemDb("companies_registry").where({ slug }).first());
const A = await reg("pt-terra-nusantara");
const B = await reg("pt-pembanding");

const db = createCompanyDb(`${W}/companies/pt-terra-nusantara/company.db`);
await setMultiBranchEnabled(db, true, actor);
const metro = (await createBranch(db, { code: "MTR", name: "Cabang Metro" }, actor)).id;
const bl = (await createBranch(db, { code: "BDL", name: "Cabang Bandar Lampung" }, actor)).id;
for (const accountTypeCode of ["ASSET", "LIABILITY"]) await createInterBranchAccountPair(db, { branchAId: metro, branchBId: bl, accountTypeCode, confirm: true }, actor);
await db.destroy();

async function persona(label, companyRow, role, scope, branchIds = []) {
  const id = crypto.randomUUID();
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 6)}@ui.test`;
  await masterDb("users").insert({ id, email, password_hash: await hashPassword(PASSWORD), full_name: label, role: "admin" });
  const { token } = await createSession(id, {});
  await ensureSystemIdentity(systemDb, { id, email, fullName: label, role: "admin", avatarUrl: null });
  const accessId = crypto.randomUUID();
  await grantCompanyAccess(systemDb, { id: accessId, systemUserId: id, companyId: companyRow.id, role, branchScope: scope });
  for (const branchId of branchIds) await grantBranchAccess(systemDb, { companyId: companyRow.id, accessId, targetUserId: id }, branchId, { actorType: "system", actorLabel: "seed" });
  return { id, token, role, label, email, password: PASSWORD };
}

const owner = await persona("Pemilik UI", A, "OWNER", "ALL");
const maker = await persona("Maker Metro", A, "ACCOUNTANT", "LIMITED", [metro]);
const approver = await persona("Approver BDL", A, "ACCOUNTANT", "LIMITED", [bl]);
const adminBoth = await persona("Admin Dua Cabang", A, "ADMIN", "LIMITED", [metro, bl]);
const staffBl = await persona("Staf BDL", A, "STAFF", "LIMITED", [bl]);
const viewer = await persona("Viewer", A, "VIEWER", "ALL");
const noBranch = await persona("Tanpa Cabang", A, "ACCOUNTANT", "LIMITED", []);
const offOwner = await persona("Pemilik Nonaktif", B, "OWNER", "ALL");
fs.writeFileSync(`${WORK}/personas.json`, JSON.stringify({ metro, bl, personas: { owner, maker, approver, adminBoth, staffBl, viewer, noBranch, offOwner } }, null, 1));
await masterDb.destroy();
await systemDb.destroy();
console.log("seed ok", { metro, bl });
