import "../company-journal/__fixtures__/legacy-db-env.js"; // reuse fixture TASK-DB-ARCH-007/010 -- harus import pertama
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyAccessRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess } from "../../db/system/company-access.js";
import type { CompanyRole } from "../../db/system/rbac.js";

async function migrateMasterDb(): Promise<void> {
  const db = knexLib(masterKnexfile);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

async function migrateSystemDb(): Promise<void> {
  const db = knexLib(systemKnexfile);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

interface TestUser {
  id: string;
  email: string;
  fullName: string;
  token: string;
}

async function createTestUserAndToken(label: string): Promise<TestUser> {
  const userId = crypto.randomUUID();
  const email = `${userId}@test.local`;
  await masterDb("users").insert({ id: userId, email, password_hash: "x", full_name: label, role: "admin" });
  const { token } = await createSession(userId, {});
  return { id: userId, email, fullName: label, token };
}

async function registerCompany(slug: string): Promise<string> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  await db.migrate.latest();
  await db.destroy();

  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({ id: companyId, slug, name: slug, database_path: dbPath, status: "active", schema_version: 12, last_migration_status: "READY" });
  return companyId;
}

async function grantAccess(user: TestUser, companyId: string, role: CompanyRole, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const systemUserId = await ensureSystemIdentity(systemDb, { id: user.id, email: user.email, fullName: user.fullName, role: "admin", avatarUrl: null });
  await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId, companyId, role });
  if (status === "SUSPENDED") await systemDb("company_access").where({ system_user_id: systemUserId, company_id: companyId }).update({ status });
  return systemUserId;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(companyAccessRoutes);
  return app;
}

describe("Company Access Management (TASK-DB-ARCH-011 Part A)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await migrateMasterDb();
    await migrateSystemDb();
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  let companyId: string;
  let slug: string;
  let owner: TestUser;

  beforeEach(async () => {
    slug = `authz-mgmt-${crypto.randomUUID().slice(0, 8)}`;
    companyId = await registerCompany(slug);
    owner = await createTestUserAndToken("Owner Utama");
    await grantAccess(owner, companyId, "OWNER");
  });

  afterEach(async () => {
    await systemDb("company_access").where({ company_id: companyId }).del();
    await systemDb("companies_registry").where({ id: companyId }).del();
    fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, slug), { recursive: true, force: true });
  });

  it("GET access list -- OWNER bisa lihat, berisi nama/email dari masterDb (bukan system_users basah)", async () => {
    const staff = await createTestUserAndToken("Staff Satu");
    await grantAccess(staff, companyId, "STAFF");

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/access`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toHaveLength(2);
    const staffRow = body.users.find((u: any) => u.userId === staff.id);
    expect(staffRow.name).toBe("Staff Satu");
    expect(staffRow.email).toBe(staff.email);
    expect(staffRow.role).toBe("STAFF");
    // §8: tidak boleh ada password/hash/token di response manapun.
    expect(JSON.stringify(body)).not.toMatch(/password|token|secret/i);
  });

  it("GET access list -- STAFF (tanpa users.manage) DITOLAK 403", async () => {
    const staff = await createTestUserAndToken("Staff Dua");
    await grantAccess(staff, companyId, "STAFF");

    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/access`, cookies: { [SESSION_COOKIE]: staff.token } });
    expect(res.statusCode).toBe(403);
  });

  it("POST grant -- OWNER berhasil memberi akses user baru", async () => {
    const newUser = await createTestUserAndToken("User Baru");
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/access`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { userId: newUser.id, role: "ACCOUNTANT" },
    });
    expect(res.statusCode).toBe(201);

    const audit = await systemDb("system_audit_log").where({ action: "company.access.granted", company_id: companyId }).first();
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.after_json).targetUserId).toBe(newUser.id);
  });

  it("POST grant -- TASK-022: boleh pakai email (bukan cuma id) krn requester (company OWNER/ADMIN) umumnya BUKAN installation admin, jadi tidak bisa pakai /api/users utk cari id", async () => {
    const newUser = await createTestUserAndToken("User Lewat Email");
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/access`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { userId: newUser.email, role: "VIEWER" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().userId).toBe(newUser.id); // response selalu id kanonis, bukan echo raw input

    const list = await app.inject({ method: "GET", url: `/api/company-db/${slug}/access`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(list.json().users.some((u: any) => u.email === newUser.email && u.role === "VIEWER")).toBe(true);
  });

  it("POST grant -- email yang tidak terdaftar di instalasi ini = 404 (bukan 500)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/access`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { userId: "tidak-ada@test.local", role: "VIEWER" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET access list -- TASK-022 company isolation: owner Company A TIDAK BISA lihat daftar pengguna Company B (404, bukan data leak)", async () => {
    const otherSlug = `authz-mgmt-other-${crypto.randomUUID().slice(0, 8)}`;
    const otherCompanyId = await registerCompany(otherSlug);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/company-db/${otherSlug}/access`,
        cookies: { [SESSION_COOKIE]: owner.token }, // token owner Company A, bukan Company B
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await systemDb("company_access").where({ company_id: otherCompanyId }).del();
      await systemDb("companies_registry").where({ id: otherCompanyId }).del();
      fs.rmSync(path.join(TEST_COMPANY_DATA_ROOT, otherSlug), { recursive: true, force: true });
    }
  });

  it("POST grant -- duplicate (user sudah punya access) = 409", async () => {
    const staff = await createTestUserAndToken("Staff Tiga");
    await grantAccess(staff, companyId, "STAFF");

    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/access`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { userId: staff.id, role: "VIEWER" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST grant -- role arbitrary ('ROOT') ditolak 400", async () => {
    const newUser = await createTestUserAndToken("User Root Coba");
    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/access`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { userId: newUser.id, role: "ROOT" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST grant -- STAFF (tanpa users.manage) tidak bisa grant siapa pun = 403", async () => {
    const staff = await createTestUserAndToken("Staff Empat");
    await grantAccess(staff, companyId, "STAFF");
    const target = await createTestUserAndToken("Target");

    const res = await app.inject({
      method: "POST",
      url: `/api/company-db/${slug}/access`,
      cookies: { [SESSION_COOKIE]: staff.token },
      payload: { userId: target.id, role: "VIEWER" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH role -- OWNER mengubah role STAFF jadi ACCOUNTANT, audit tercatat", async () => {
    const staff = await createTestUserAndToken("Staff Lima");
    await grantAccess(staff, companyId, "STAFF");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${staff.id}`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { role: "ACCOUNTANT" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("ACCOUNTANT");

    const audit = await systemDb("system_audit_log").where({ action: "company.access.role_changed", company_id: companyId }).first();
    expect(JSON.parse(audit.before_json).oldRole).toBe("STAFF");
    expect(JSON.parse(audit.after_json).newRole).toBe("ACCOUNTANT");
  });

  it("PATCH role -- self-permission: role di body tidak bisa dipakai requester utk menaikkan diri sendiri (requester tetap dicek via company_access, bukan body)", async () => {
    const staff = await createTestUserAndToken("Staff Enam");
    await grantAccess(staff, companyId, "STAFF");

    // Staff mencoba PATCH role DIRINYA SENDIRI jadi OWNER -- tapi staff
    // sendiri tidak punya users.manage, jadi requirePermission menolak
    // SEBELUM request.body.role bahkan diproses.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${staff.id}`,
      cookies: { [SESSION_COOKIE]: staff.token },
      payload: { role: "OWNER" },
    });
    expect(res.statusCode).toBe(403);

    const access = await systemDb("company_access").where({ system_user_id: staff.id, company_id: companyId }).first();
    expect(access.role).toBe("STAFF"); // tidak berubah
  });

  it("PATCH role -- downgrade OWNER terakhir aktif DITOLAK 409", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${owner.id}`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { role: "STAFF" },
    });
    expect(res.statusCode).toBe(409);

    const access = await systemDb("company_access").where({ system_user_id: owner.id, company_id: companyId }).first();
    expect(access.role).toBe("OWNER"); // tidak berubah
  });

  it("PATCH role -- downgrade OWNER berhasil kalau ADA OWNER lain yang aktif", async () => {
    const secondOwner = await createTestUserAndToken("Owner Kedua");
    await grantAccess(secondOwner, companyId, "OWNER");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${owner.id}`,
      cookies: { [SESSION_COOKIE]: secondOwner.token },
      payload: { role: "ADMIN" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH status -- suspend STAFF berhasil, audit 'company.access.suspended' tercatat", async () => {
    const staff = await createTestUserAndToken("Staff Tujuh");
    await grantAccess(staff, companyId, "STAFF");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${staff.id}/status`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { status: "SUSPENDED" },
    });
    expect(res.statusCode).toBe(200);

    const audit = await systemDb("system_audit_log").where({ action: "company.access.suspended", company_id: companyId }).first();
    expect(audit).toBeDefined();
  });

  it("Setelah SUSPENDED -- user tetap authenticated tapi company access DITOLAK (401 tidak terjadi, tapi company-level 404)", async () => {
    const staff = await createTestUserAndToken("Staff Delapan");
    await grantAccess(staff, companyId, "STAFF", "SUSPENDED");

    // User tetap bisa autentikasi (sesi valid) -- tapi requireCompanyAccess
    // menolak krn status SUSPENDED (perilaku existing TASK-010, diuji
    // ulang di sini sbg konfirmasi §13).
    const res = await app.inject({ method: "GET", url: `/api/company-db/${slug}/access`, cookies: { [SESSION_COOKIE]: staff.token } });
    expect(res.statusCode).not.toBe(401); // authenticated
    expect(res.statusCode).toBe(404); // tapi company access ditolak
  });

  it("PATCH status -- suspend OWNER terakhir aktif DITOLAK 409", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${owner.id}/status`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { status: "SUSPENDED" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("PATCH status -- activate kembali STAFF yang SUSPENDED", async () => {
    const staff = await createTestUserAndToken("Staff Sembilan");
    await grantAccess(staff, companyId, "STAFF", "SUSPENDED");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/company-db/${slug}/access/${staff.id}/status`,
      cookies: { [SESSION_COOKIE]: owner.token },
      payload: { status: "ACTIVE" },
    });
    expect(res.statusCode).toBe(200);

    const audit = await systemDb("system_audit_log").where({ action: "company.access.activated", company_id: companyId }).first();
    expect(audit).toBeDefined();
  });

  it("DELETE revoke -- OWNER mencabut akses STAFF, audit 'revoked' tercatat", async () => {
    const staff = await createTestUserAndToken("Staff Sepuluh");
    await grantAccess(staff, companyId, "STAFF");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/company-db/${slug}/access/${staff.id}`,
      cookies: { [SESSION_COOKIE]: owner.token },
    });
    expect(res.statusCode).toBe(200);

    const remaining = await systemDb("company_access").where({ system_user_id: staff.id, company_id: companyId });
    expect(remaining).toHaveLength(0);
    const audit = await systemDb("system_audit_log").where({ action: "company.access.revoked", company_id: companyId }).first();
    expect(audit).toBeDefined();
  });

  it("DELETE revoke -- OWNER terakhir aktif TIDAK BISA dicabut, 409", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/company-db/${slug}/access/${owner.id}`, cookies: { [SESSION_COOKIE]: owner.token } });
    expect(res.statusCode).toBe(409);

    const stillThere = await systemDb("company_access").where({ system_user_id: owner.id, company_id: companyId });
    expect(stillThere).toHaveLength(1);
  });

  it("DELETE revoke -- OWNER pertama BISA dicabut kalau ada OWNER kedua (contoh instruksi §15)", async () => {
    const secondOwner = await createTestUserAndToken("Owner Ketiga");
    await grantAccess(secondOwner, companyId, "OWNER");

    const res = await app.inject({ method: "DELETE", url: `/api/company-db/${slug}/access/${owner.id}`, cookies: { [SESSION_COOKIE]: secondOwner.token } });
    expect(res.statusCode).toBe(200);
  });

  describe("UAT-001 -- anti eskalasi hak (ADMIN tidak boleh menjadi / membuat OWNER)", () => {
    const roleOf = async (u: TestUser) => (await systemDb("company_access").where({ system_user_id: u.id, company_id: companyId }).first()).role;
    const statusOf = async (u: TestUser) => (await systemDb("company_access").where({ system_user_id: u.id, company_id: companyId }).first()).status;
    const patch = (actor: TestUser, target: TestUser, payload: unknown) => app.inject({ method: "PATCH", url: `/api/company-db/${slug}/access/${target.id}`, cookies: { [SESSION_COOKIE]: actor.token }, payload: payload as object });
    let admin: TestUser, admin2: TestUser, viewer: TestUser, staff: TestUser, accountant: TestUser;
    beforeEach(async () => {
      admin = await createTestUserAndToken("Admin Satu"); await grantAccess(admin, companyId, "ADMIN");
      admin2 = await createTestUserAndToken("Admin Dua"); await grantAccess(admin2, companyId, "ADMIN");
      viewer = await createTestUserAndToken("Viewer"); await grantAccess(viewer, companyId, "VIEWER");
      staff = await createTestUserAndToken("Staff"); await grantAccess(staff, companyId, "STAFF");
      accountant = await createTestUserAndToken("Akuntan"); await grantAccess(accountant, companyId, "ACCOUNTANT");
    });

    it("1) ADMIN -> dirinya sendiri OWNER = 403, database tidak berubah", async () => {
      const r = await patch(admin, admin, { role: "OWNER" }); expect(r.statusCode).toBe(403); expect(await roleOf(admin)).toBe("ADMIN");
    });
    it("2) ADMIN -> user lain OWNER = 403, database tidak berubah", async () => {
      const r = await patch(admin, viewer, { role: "OWNER" }); expect(r.statusCode).toBe(403); expect(await roleOf(viewer)).toBe("VIEWER");
    });
    it("3-4) ADMIN -> ADMIN (diri sendiri & user lain) mengikuti kebijakan lama: diizinkan", async () => {
      expect((await patch(admin, admin, { role: "ADMIN" })).statusCode).toBe(200);
      expect((await patch(admin, viewer, { role: "ADMIN" })).statusCode).toBe(200); expect(await roleOf(viewer)).toBe("ADMIN");
    });
    it("5-6) ACCOUNTANT dan VIEWER -> OWNER = 403 (tidak punya users.manage), tidak berubah", async () => {
      expect((await patch(accountant, accountant, { role: "OWNER" })).statusCode).toBe(403); expect(await roleOf(accountant)).toBe("ACCOUNTANT");
      expect((await patch(viewer, viewer, { role: "OWNER" })).statusCode).toBe(403); expect(await roleOf(viewer)).toBe("VIEWER");
    });
    it("7) OWNER boleh menjadikan user lain OWNER dan mengubah peran sah lain", async () => {
      expect((await patch(owner, staff, { role: "OWNER" })).statusCode).toBe(200); expect(await roleOf(staff)).toBe("OWNER");
      expect((await patch(owner, viewer, { role: "ACCOUNTANT" })).statusCode).toBe(200);
    });
    it("8) manipulasi body: 'owner', 'OWNER ', 'Owner', peran tambahan, array, null = ditolak, tidak berubah", async () => {
      for (const body of [{ role: "owner" }, { role: "OWNER " }, { role: " OWNER" }, { role: "Owner" }, { role: ["ADMIN", "OWNER"] }, { role: null }, { Role: "OWNER" }, { roles: ["OWNER"] }]) {
        const r = await patch(admin, viewer, body); expect(r.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400); expect(await roleOf(viewer)).toBe("VIEWER");
      }
      // field tambahan di samping peran sah: diabaikan, peran sah dipakai
      const ok = await patch(admin, viewer, { role: "STAFF", isAdmin: true, permissions: ["*"], companyId: "x" }); expect(ok.statusCode).toBe(200); expect(await roleOf(viewer)).toBe("STAFF");
      // JSON dengan kunci role ganda: yang terakhir yang dipakai server DAN dicek otorisasinya (tidak ada celah parser-ganda)
      const dup = await app.inject({ method: "PATCH", url: `/api/company-db/${slug}/access/${viewer.id}`, cookies: { [SESSION_COOKIE]: admin.token }, headers: { "content-type": "application/json" }, payload: '{"role":"VIEWER","role":"OWNER"}' });
      expect(dup.statusCode).toBe(403); expect(await roleOf(viewer)).toBe("STAFF");
    });
    it("9) POST grant OWNER oleh ADMIN = 403 dan tidak ada baris akses baru", async () => {
      const newbie = await createTestUserAndToken("Baru"); const before = await systemDb("company_access").where({ company_id: companyId }).count<{ c: number }[]>("* as c");
      const r = await app.inject({ method: "POST", url: `/api/company-db/${slug}/access`, cookies: { [SESSION_COOKIE]: admin.token }, payload: { userId: newbie.id, role: "OWNER" } });
      expect(r.statusCode).toBe(403);
      const after = await systemDb("company_access").where({ company_id: companyId }).count<{ c: number }[]>("* as c"); expect(after[0].c).toBe(before[0].c);
      const okAdmin = await app.inject({ method: "POST", url: `/api/company-db/${slug}/access`, cookies: { [SESSION_COOKIE]: admin.token }, payload: { userId: newbie.id, role: "STAFF" } }); expect(okAdmin.statusCode).toBe(201);
    });
    it("10) ADMIN tidak boleh menurunkan, menangguhkan, atau mencabut OWNER (bahkan bila ada OWNER lain)", async () => {
      const owner2 = await createTestUserAndToken("Owner Dua"); await grantAccess(owner2, companyId, "OWNER");
      expect((await patch(admin, owner2, { role: "VIEWER" })).statusCode).toBe(403); expect(await roleOf(owner2)).toBe("OWNER");
      const sus = await app.inject({ method: "PATCH", url: `/api/company-db/${slug}/access/${owner2.id}/status`, cookies: { [SESSION_COOKIE]: admin.token }, payload: { status: "SUSPENDED" } }); expect(sus.statusCode).toBe(403); expect(await statusOf(owner2)).toBe("ACTIVE");
      const del = await app.inject({ method: "DELETE", url: `/api/company-db/${slug}/access/${owner2.id}`, cookies: { [SESSION_COOKIE]: admin.token } }); expect(del.statusCode).toBe(403);
      expect(await systemDb("company_access").where({ system_user_id: owner2.id, company_id: companyId }).first()).toBeTruthy();
      // OWNER tetap boleh
      expect((await patch(owner, owner2, { role: "ADMIN" })).statusCode).toBe(200);
    });
    it("11) penolakan tidak menulis audit 'role_changed'", async () => {
      const before = await systemDb("system_audit_log").where({ action: "company.access.role_changed", company_id: companyId }).count<{ c: number }[]>("* as c");
      await patch(admin, viewer, { role: "OWNER" });
      const after = await systemDb("system_audit_log").where({ action: "company.access.role_changed", company_id: companyId }).count<{ c: number }[]>("* as c"); expect(after[0].c).toBe(before[0].c);
    });
    it("canManageRole: tabel kebijakan", async () => {
      const { canManageRole } = await import("../../db/system/rbac.js");
      expect(canManageRole("ADMIN", "ADMIN", "OWNER")).toBe(false); expect(canManageRole("ADMIN", "OWNER", "ADMIN")).toBe(false); expect(canManageRole("ADMIN", null, "OWNER")).toBe(false);
      expect(canManageRole("ADMIN", "VIEWER", "ADMIN")).toBe(true); expect(canManageRole("OWNER", "OWNER", "OWNER")).toBe(true); expect(canManageRole("ACCOUNTANT", "STAFF", "ADMIN")).toBe(false);
    });
  });
});
