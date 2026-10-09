import "../../modules/company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama (mengarahkan DB ke folder temp)
import { TEST_COMPANY_DATA_ROOT } from "../../modules/company-journal/__fixtures__/legacy-db-env.js";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import knexLib from "knex";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import systemKnexfile from "../system/knexfile.js";
import { systemDb } from "../system/index.js";
import companyKnexfile from "./knexfile.js";
import { upgradeExistingCompanyDatabases } from "./company-upgrade.js";

const OLD_MIGRATION_COUNT = 12; // C0001..C0012 = skema sebelum C0013

describe("Upgrade company.db yang sudah ada ke skema terbaru", () => {
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

  it("company.db skema lama dinaikkan: kolom baru ada, data lama utuh, salinan .pre-upgrade dibuat, dan idempoten", async () => {
    const slug = "perusahaan-lama";
    const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Buat database PERSIS seperti versi lama: hanya 12 migration pertama
    const old = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
    try {
      for (let i = 0; i < OLD_MIGRATION_COUNT; i++) await old.migrate.up();
      const hasLocked = await old.schema.hasColumn("accounts", "is_locked");
      expect(hasLocked).toBe(false);
      const typeId = (await old("account_types").first("id")).id;
      await old("accounts").insert({ id: "acc-lama", code: "1000", name: "Kas Lama", account_type_id: typeId, normal_balance: "debit" });
      await old("company_profile").insert({ id: "prof-lama", name: "PT Lama" });
    } finally {
      await old.destroy();
    }

    await systemDb("companies_registry").insert({
      id: crypto.randomUUID(),
      slug,
      name: "PT Lama",
      database_path: dbPath,
      status: "active",
      schema_version: 12,
      last_migration_status: "READY",
    });

    await upgradeExistingCompanyDatabases();

    const after = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
    try {
      expect(await after.schema.hasColumn("accounts", "is_locked")).toBe(true);
      expect(await after.schema.hasColumn("company_profile", "max_backdate_days")).toBe(true);
      // data lama utuh, default aman (tidak terkunci, tanpa batas backdate)
      const acc = await after("accounts").where({ id: "acc-lama" }).first();
      expect(acc.name).toBe("Kas Lama");
      expect(Boolean(acc.is_locked)).toBe(false);
      const prof = await after("company_profile").where({ id: "prof-lama" }).first();
      expect(prof.max_backdate_days).toBeNull();
    } finally {
      await after.destroy();
    }

    // salinan sebelum upgrade ada dan masih berskema lama
    const backupPath = `${dbPath}.pre-upgrade`;
    expect(fs.existsSync(backupPath)).toBe(true);
    const bak = knexLib({ ...companyKnexfile, connection: { filename: backupPath } });
    try {
      expect(await bak.schema.hasColumn("accounts", "is_locked")).toBe(false);
    } finally {
      await bak.destroy();
    }

    // idempoten: dijalankan lagi tidak error dan tidak menimpa salinan
    const stamp = fs.statSync(backupPath).mtimeMs;
    await upgradeExistingCompanyDatabases();
    expect(fs.statSync(backupPath).mtimeMs).toBe(stamp);
  });

  it("satu company rusak tidak menghentikan upgrade company lain", async () => {
    // registry menunjuk company yang filenya tidak ada -> dilewati tanpa melempar
    await systemDb("companies_registry").insert({
      id: crypto.randomUUID(),
      slug: "tidak-ada-file",
      name: "Tanpa File",
      database_path: path.join(TEST_COMPANY_DATA_ROOT, "tidak-ada-file", "company.db"),
      status: "active",
      schema_version: 12,
      last_migration_status: "READY",
    });
    await expect(upgradeExistingCompanyDatabases()).resolves.toBeUndefined();
  });
});
