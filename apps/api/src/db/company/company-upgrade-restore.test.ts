import "../../modules/company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama
import { TEST_COMPANY_DATA_ROOT } from "../../modules/company-journal/__fixtures__/legacy-db-env.js";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import knexLib from "knex";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const integrity = vi.hoisted(() => ({ responses: [] as Array<{ integrityOk: boolean; integrityMessages: string[]; foreignKeyViolations: number }> }));
vi.mock("./db-integrity.js", () => ({
  checkDatabaseIntegrity: async () => integrity.responses.shift() ?? { integrityOk: true, integrityMessages: ["ok"], foreignKeyViolations: 0 },
}));

import systemKnexfile from "../system/knexfile.js";
import { systemDb } from "../system/index.js";
import companyKnexfile from "./knexfile.js";
import { upgradeExistingCompanyDatabases } from "./company-upgrade.js";

const OK = { integrityOk: true, integrityMessages: ["ok"], foreignKeyViolations: 0 };

async function makeOldCompany(slug: string): Promise<string> {
  // satu company per tes: upgrade memproses SEMUA company terdaftar, jadi sisa tes sebelumnya dikosongkan
  await systemDb("companies_registry").del();
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const old = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  try {
    for (let i = 0; i < 13; i++) await old.migrate.up();
    const typeId = (await old("account_types").first("id")).id;
    await old("accounts").insert({ id: "acc-1", code: "1000", name: "Kas", account_type_id: typeId, normal_balance: "debit" });
  } finally {
    await old.destroy();
  }
  await systemDb("companies_registry").insert({ id: crypto.randomUUID(), slug, name: slug, database_path: dbPath, status: "active", schema_version: 13, last_migration_status: "READY" });
  return dbPath;
}

async function hasBranches(dbPath: string): Promise<boolean> {
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  try {
    return await db.schema.hasTable("branches");
  } finally {
    await db.destroy();
  }
}

describe("Upgrade company.db: pemeriksaan integritas, pemulihan dari salinan, dan penolakan migrasi pada DB rusak", () => {
  beforeAll(async () => {
    const db = knexLib(systemKnexfile);
    try {
      await db.migrate.latest();
    } finally {
      await db.destroy();
    }
  });
  afterAll(async () => {
    await systemDb.destroy();
  });

  it("integritas SESUDAH migrasi gagal -> file dikembalikan dari salinan .pre-C0014 (skema & data lama utuh) dan tidak melempar", async () => {
    const dbPath = await makeOldCompany("pulihkan");
    integrity.responses.push(OK, { integrityOk: false, integrityMessages: ["row 5 missing from index"], foreignKeyViolations: 0 });
    await expect(upgradeExistingCompanyDatabases()).resolves.toBeUndefined();
    expect(await hasBranches(dbPath)).toBe(false); // dikembalikan ke skema lama
    const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
    try {
      expect((await db("accounts").where({ id: "acc-1" }).first()).name).toBe("Kas");
    } finally {
      await db.destroy();
    }
    expect(fs.existsSync(`${dbPath}.pre-C0014`)).toBe(true);
  });

  it("pelanggaran foreign key BARU akibat migrasi juga memicu pemulihan", async () => {
    const dbPath = await makeOldCompany("pulihkan-fk");
    integrity.responses.push(OK, { integrityOk: true, integrityMessages: ["ok"], foreignKeyViolations: 3 });
    await upgradeExistingCompanyDatabases();
    expect(await hasBranches(dbPath)).toBe(false);
  });

  it("DB yang sudah rusak SEBELUM migrasi tidak dimigrasi (data tidak diperparah)", async () => {
    const dbPath = await makeOldCompany("sudah-rusak");
    integrity.responses.push({ integrityOk: false, integrityMessages: ["database disk image is malformed"], foreignKeyViolations: 0 });
    await upgradeExistingCompanyDatabases();
    expect(await hasBranches(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.pre-C0014`)).toBe(false); // tidak ada migrasi -> tidak perlu salinan baru
  });

  it("DB sehat dimigrasi normal ketika pemeriksaan bersih", async () => {
    integrity.responses.length = 0;
    const dbPath = await makeOldCompany("sehat");
    await upgradeExistingCompanyDatabases();
    expect(await hasBranches(dbPath)).toBe(true);
  });
});
