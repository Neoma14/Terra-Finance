import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { findCompanyAccess, grantCompanyAccess, listAccessibleCompanies } from "./company-access.js";
import { ensureSystemIdentity } from "./identity-bridge.js";

function freshTmpFile(): string {
  return path.join(os.tmpdir(), `terra-company-access-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function openSystemDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}

describe("company_access (S0010, TASK-DB-ARCH-010)", () => {
  let tmpFile: string;
  let db: Knex;
  let systemUserId: string;
  let companyId: string;

  beforeEach(async () => {
    tmpFile = freshTmpFile();
    db = openSystemDbAt(tmpFile);
    await db.migrate.latest();

    systemUserId = await ensureSystemIdentity(db, {
      id: crypto.randomUUID(),
      email: "user@test.local",
      fullName: "User Uji",
      role: "admin",
      avatarUrl: null,
    });

    companyId = crypto.randomUUID();
    await db("companies_registry").insert({
      id: companyId,
      slug: "pt-uji",
      name: "PT Uji",
      database_path: "/tmp/pt-uji/company.db",
      status: "active",
    });
  });

  afterEach(async () => {
    await db.destroy();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("grantCompanyAccess + findCompanyAccess -- role & status tersimpan benar", async () => {
    await grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId, companyId, role: "ACCOUNTANT" });
    const access = await findCompanyAccess(db, systemUserId, companyId);
    expect(access).toBeDefined();
    expect(access!.role).toBe("ACCOUNTANT");
    expect(access!.status).toBe("ACTIVE"); // default
  });

  it("unique (system_user_id, company_id) -- grant kedua utk pasangan sama ditolak", async () => {
    await grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId, companyId, role: "OWNER" });
    await expect(
      grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId, companyId, role: "VIEWER" }),
    ).rejects.toThrow();
  });

  it("FK system_user_id harus valid -- menolak id yang tidak ada di system_users", async () => {
    await expect(
      grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId: "tidak-ada", companyId, role: "OWNER" }),
    ).rejects.toThrow();
  });

  it("FK company_id harus valid -- menolak id yang tidak ada di companies_registry", async () => {
    await expect(
      grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId, companyId: "tidak-ada", role: "OWNER" }),
    ).rejects.toThrow();
  });

  it("CHECK role -- menolak nilai di luar OWNER/ADMIN/ACCOUNTANT/STAFF/VIEWER", async () => {
    await expect(
      db("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: companyId, role: "SUPERUSER" }),
    ).rejects.toThrow();
  });

  it("CHECK status -- menolak nilai di luar ACTIVE/SUSPENDED", async () => {
    await expect(
      db("company_access").insert({
        id: crypto.randomUUID(),
        system_user_id: systemUserId,
        company_id: companyId,
        role: "VIEWER",
        status: "PENDING",
      }),
    ).rejects.toThrow();
  });

  it("listAccessibleCompanies -- hanya company dgn access ACTIVE + registry active", async () => {
    await grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId, companyId, role: "OWNER" });

    const suspendedCompanyId = crypto.randomUUID();
    await db("companies_registry").insert({ id: suspendedCompanyId, slug: "pt-suspended", name: "PT Suspended", database_path: "/tmp/x/company.db", status: "active" });
    await db("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: suspendedCompanyId, role: "VIEWER", status: "SUSPENDED" });

    const inactiveRegistryCompanyId = crypto.randomUUID();
    await db("companies_registry").insert({ id: inactiveRegistryCompanyId, slug: "pt-archived", name: "PT Archived", database_path: "/tmp/y/company.db", status: "archived" });
    await db("company_access").insert({ id: crypto.randomUUID(), system_user_id: systemUserId, company_id: inactiveRegistryCompanyId, role: "OWNER", status: "ACTIVE" });

    const result = await listAccessibleCompanies(db, systemUserId);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("pt-uji");
  });
});
