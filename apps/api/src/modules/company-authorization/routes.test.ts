import "../company-journal/__fixtures__/legacy-db-env.js"; // HARUS import pertama (mengarahkan semua DB ke folder temp)
import { TEST_COMPANY_DATA_ROOT } from "../company-journal/__fixtures__/legacy-db-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { attachAuthUser, requireAuth } from "../../middleware/auth-guard.js";
import { BRANCH_AWARE_ROUTES } from "../../middleware/branch-authority.js";
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import companyKnexfile from "../../db/company/knexfile.js";
import { createCompanyDb } from "../../db/company/index.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { ensureSystemIdentity } from "../../db/system/identity-bridge.js";
import { grantCompanyAccess } from "../../db/system/company-access.js";
import { grantBranchAccess } from "../../db/system/user-branch-access.js";
import { canActOnBranch, resetBoundaryAuditThrottleForTests } from "../../db/system/authorization.js";
import type { Permission } from "../../db/system/rbac.js";
import { createBranch, setMultiBranchEnabled } from "../../db/company/branch-service.js";

import { companyBranchesRoutes } from "../company-branches/routes.js";
import { companyAccessRoutes } from "../company-access/routes.js";
import { companyJournalRoutes } from "../company-journal/routes.js";
import { companyAuthorizationRoutes } from "./routes.js";

type Role = "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";
interface TestUser {
  id: string;
  email: string;
  fullName: string;
  token: string;
  accessId: string;
}

const migrate = async (config: Knex.Config) => {
  const db = knexLib(config);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
};

async function createCompany(slug: string): Promise<{ companyId: string; dbPath: string }> {
  const dbPath = path.join(TEST_COMPANY_DATA_ROOT, slug, "company.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const m = knexLib({ ...companyKnexfile, connection: { filename: dbPath } });
  try {
    await m.migrate.latest();
    await m("company_profile").insert({ id: crypto.randomUUID(), name: slug });
  } finally {
    await m.destroy();
  }
  const companyId = crypto.randomUUID();
  await systemDb("companies_registry").insert({ id: companyId, slug, name: slug, database_path: dbPath, status: "active", schema_version: 18, last_migration_status: "READY" });
  return { companyId, dbPath };
}

const setup = { actorType: "system" as const, actorLabel: "setup" };
const actor = { actorType: "user" as const, actorId: "setup", actorLabel: "Setup" };

describe("Otorisasi & delegasi multi-cabang HTTP (Phase 3, delegasi Revisi 5)", () => {
  let app: FastifyInstance;
  let companyA: string;
  let companyB: string;
  let dbA: Knex;
  let dbB: Knex;
  let hq: string, metro: string, bandar: string, kotabumi: string, bBranch: string;
  let owner: TestUser, adminAll: TestUser, outsider: TestUser, userB: TestUser;

  const A = (suffix: string) => `/api/company-db/company-a${suffix}`;
  const B = (suffix: string) => `/api/company-db/company-b${suffix}`;
  const json = (res: { payload: string }) => JSON.parse(res.payload);
  const call = (user: TestUser | null, method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({ method: method as "GET", url, cookies: user ? { [SESSION_COOKIE]: user.token } : undefined, headers: opts.headers, payload: opts.payload as any });

  /** Membuat user baru (unik per tes) di perusahaan A atau B. */
  async function mkUser(label: string, role: Role, scope: "ALL" | "LIMITED", branchIds: string[] = [], companyId = companyA): Promise<TestUser> {
    const id = crypto.randomUUID();
    const email = `${id}@test.local`;
    await masterDb("users").insert({ id, email, password_hash: "x", full_name: label, role: "admin" });
    const { token } = await createSession(id, {});
    await ensureSystemIdentity(systemDb, { id, email, fullName: label, role: "admin", avatarUrl: null });
    const accessId = crypto.randomUUID();
    await grantCompanyAccess(systemDb, { id: accessId, systemUserId: id, companyId, role, branchScope: scope });
    for (const branchId of branchIds) await grantBranchAccess(systemDb, { companyId, accessId, targetUserId: id }, branchId, setup);
    return { id, email, fullName: label, token, accessId };
  }

  const probe = async (user: TestUser, permission: string, branchId: string | null) => {
    const res = await call(user, "GET", A(`/probe/${permission}/${branchId ?? "none"}`));
    expect(res.statusCode).toBe(200);
    return json(res).allowed as boolean;
  };
  const me = async (user: TestUser) => json(await call(user, "GET", A("/authorization/me")));
  const putOverride = (by: TestUser, target: TestUser, permission: string, effect: "GRANT" | "DENY", reason = "uji") =>
    call(by, "PUT", A(`/access/${target.id}/permission-overrides/${permission}`), { payload: { effect, reason } });
  const delegate = (by: TestUser, grantee: TestUser, body: Record<string, unknown> = {}) =>
    call(by, "POST", A("/delegations"), { payload: { granteeUserId: grantee.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro], ...body } });
  /** ADMIN LIMITED dengan akses cabang `access` dan delegasi OWNER `caps` pada `dBranches`. */
  async function mkDelegatedAdmin(label: string, access: string[], dBranches: string[], caps: string[] = ["manage_users"], maxRole = "STAFF"): Promise<TestUser> {
    const admin = await mkUser(label, "ADMIN", "LIMITED", access);
    const res = await delegate(owner, admin, { capabilities: caps, branchIds: dBranches, maxRole });
    expect(res.statusCode, label).toBe(201);
    return admin;
  }
  const grantBranch = (by: TestUser, target: TestUser, branchId: string) => call(by, "POST", A(`/access/${target.id}/branches`), { payload: { branchId } });
  const audit = (action: string, targetUserId?: string) => {
    const q = systemDb("system_audit_log").where({ action, company_id: companyA });
    if (targetUserId) q.where({ target_user_id: targetUserId });
    return q.select("*");
  };

  beforeAll(async () => {
    await migrate(masterKnexfile);
    await migrate(systemKnexfile);

    app = Fastify();
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    for (const r of [companyBranchesRoutes, companyAuthorizationRoutes, companyAccessRoutes, companyJournalRoutes]) app.register(r);

    // Probe uji: jalur guard SUNGGUHAN (requireCompanyAccess) lalu canActOnBranch dengan konteks akses nyata.
    const probePath = "/api/company-db/:companySlug/probe/:permission/:branchId";
    (BRANCH_AWARE_ROUTES as Set<string>).add(`GET ${probePath}`);
    app.get<{ Params: { companySlug: string; permission: string; branchId: string } }>(probePath, { preHandler: [requireAuth, requireCompanyAccess] }, async (request) => ({
      allowed: canActOnBranch(request.companyAccess!, request.params.permission as Permission, request.params.branchId === "none" ? null : request.params.branchId),
    }));
    await app.ready();

    const a = await createCompany("company-a");
    companyA = a.companyId;
    dbA = createCompanyDb(a.dbPath);
    await setMultiBranchEnabled(dbA, true, actor);
    hq = (await dbA("branches").where({ is_head_office: 1 }).first()).id;
    metro = (await createBranch(dbA, { code: "METRO", name: "Cabang Metro" }, actor)).id;
    bandar = (await createBranch(dbA, { code: "BL", name: "Bandar Lampung" }, actor)).id;
    kotabumi = (await createBranch(dbA, { code: "KOTABUMI", name: "Cabang Kotabumi" }, actor)).id;

    const b = await createCompany("company-b");
    companyB = b.companyId;
    dbB = createCompanyDb(b.dbPath);
    await setMultiBranchEnabled(dbB, true, actor);
    bBranch = (await createBranch(dbB, { code: "ASING", name: "Cabang Perusahaan B" }, actor)).id;

    owner = await mkUser("owner", "OWNER", "ALL");
    adminAll = await mkUser("admin-semua", "ADMIN", "ALL");
    outsider = await mkUser("owner-b", "OWNER", "ALL", [], companyB);
    userB = await mkUser("staf-b", "STAFF", "LIMITED", [bBranch], companyB);
  });

  afterAll(async () => {
    await app.close();
    await dbA.destroy();
    await dbB.destroy();
    await masterDb.destroy();
    await systemDb.destroy();
  });

  // =============================================================== AKSES CABANG USER
  describe("akses cabang user", () => {
    it("administrator ALL berwenang menambah satu, lalu beberapa akses cabang; daftar mencerminkannya", async () => {
      const staff = await mkUser("staf", "STAFF", "LIMITED");
      expect((await grantBranch(adminAll, staff, metro)).statusCode).toBe(201);
      expect((await grantBranch(adminAll, staff, bandar)).statusCode).toBe(201);
      expect((await grantBranch(owner, staff, kotabumi)).statusCode).toBe(201);
      const list = json(await call(owner, "GET", A(`/access/${staff.id}/branches`)));
      expect(list.branches.filter((b: any) => b.status === "ACTIVE").map((b: any) => b.branchId).sort()).toEqual([bandar, kotabumi, metro].sort());
      expect((await grantBranch(owner, staff, metro)).statusCode).toBe(409);
    });

    it("pencabutan akses berlaku pada request berikutnya walau sesi masih hidup (header konteks, daftar, jurnal)", async () => {
      const staff = await mkUser("staf-sesi", "ACCOUNTANT", "LIMITED", [metro, bandar]);
      const withMetro = { "x-branch-context": metro };
      expect((await call(staff, "GET", A("/branches"), { headers: withMetro })).statusCode).toBe(200);
      expect((await call(staff, "GET", A(`/branches/${metro}`))).statusCode).toBe(200);
      expect(await probe(staff, "journal.read", metro)).toBe(true);
      expect((await call(owner, "DELETE", A(`/access/${staff.id}/branches/${metro}`), { payload: { reason: "pindah tugas" } })).statusCode).toBe(200);
      const after = await call(staff, "GET", A("/branches"), { headers: withMetro });
      expect(after.statusCode).toBe(403);
      expect(json(after).code).toBe("BRANCH_CONTEXT_INVALID");
      expect((await call(staff, "GET", A(`/branches/${metro}`))).statusCode).toBe(404);
      expect((await call(staff, "GET", A("/journals"), { headers: withMetro })).statusCode).toBe(403);
      expect(await probe(staff, "journal.read", metro)).toBe(false);
      expect(await probe(staff, "journal.read", bandar)).toBe(true);
      expect(json(await call(staff, "GET", A("/branches"))).branches.map((b: any) => b.code)).toEqual(["BL"]);
    });

    it("ADMIN LIMITED TANPA delegasi tidak punya jalur pengelolaan sama sekali (akses, override, daftar user) -- tidak ada kewenangan administratif otomatis", async () => {
      const adminLtd = await mkUser("admin-tanpa-delegasi", "ADMIN", "LIMITED", [metro, bandar]);
      const staff = await mkUser("staf-t1", "STAFF", "LIMITED");
      for (const res of [
        await grantBranch(adminLtd, staff, metro),
        await call(adminLtd, "GET", A(`/access/${staff.id}/branches`)),
        await call(adminLtd, "DELETE", A(`/access/${staff.id}/branches/${metro}`)),
        await call(adminLtd, "POST", A(`/access/${staff.id}/branches/transfer`), { payload: { fromBranchId: metro, toBranchId: bandar } }),
        await putOverride(adminLtd, staff, "interbranch.read", "GRANT"),
        await call(adminLtd, "GET", A("/authorization/users")),
        await call(adminLtd, "PATCH", A(`/branches/${metro}`), { payload: { name: "Metro Baru" } }),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(json(res).code).toBe("DELEGATION_REQUIRED");
      }
      expect(json(await call(adminLtd, "GET", A("/branch-context"))).capabilities).toMatchObject({ manageBranchAccess: false, manageBranchInfo: false, manageDelegations: false });
    });

    it("ADMIN LIMITED DENGAN delegasi manage_users mengelola akses hanya pada irisan delegasi x akses", async () => {
      const adminLtd = await mkDelegatedAdmin("admin-dlg", [metro, bandar, kotabumi], [metro, bandar]);
      const staff = await mkUser("staf-target", "STAFF", "LIMITED");
      expect((await grantBranch(adminLtd, staff, metro)).statusCode).toBe(201);
      expect((await call(adminLtd, "POST", A(`/access/${staff.id}/branches/transfer`), { payload: { fromBranchId: metro, toBranchId: bandar } })).statusCode).toBe(200);
      // diakses tetapi tidak didelegasikan (Kotabumi), Kantor Pusat, id palsu -> 404 seragam
      const k = await grantBranch(adminLtd, staff, kotabumi);
      const h = await grantBranch(adminLtd, staff, hq);
      const f = await grantBranch(adminLtd, staff, "palsu");
      expect([k.statusCode, h.statusCode, f.statusCode]).toEqual([404, 404, 404]);
      expect(k.payload).toBe(f.payload);
      expect((await call(adminLtd, "DELETE", A(`/access/${staff.id}/branches/${kotabumi}`))).statusCode).toBe(404);
      // diri sendiri, OWNER, user ber-scope ALL, mengubah scope
      expect((await grantBranch(adminLtd, adminLtd, bandar)).statusCode).toBe(403);
      expect((await grantBranch(adminLtd, owner, metro)).statusCode).toBe(403);
      const allUser = await mkUser("staf-semua", "STAFF", "ALL");
      const touch = await grantBranch(adminLtd, allUser, metro);
      expect([touch.statusCode, json(touch).code]).toEqual([403, "TARGET_OUT_OF_SCOPE"]);
      expect((await call(adminLtd, "PUT", A(`/access/${staff.id}/branch-scope`), { payload: { scope: "ALL" } })).statusCode).toBe(403);
      // peran target di atas max_role (STAFF)
      const acct = await mkUser("akuntan-target", "ACCOUNTANT", "LIMITED");
      const over = await grantBranch(adminLtd, acct, metro);
      expect([over.statusCode, json(over).code]).toEqual([403, "ROLE_EXCEEDS_DELEGATION"]);
      // user di luar cakupan: cabang Kotabumi saja -> bagian itu tidak tersentuh, daftar menyembunyikannya
      const mixed = await mkUser("staf-campur", "STAFF", "LIMITED", [metro, kotabumi]);
      const list = json(await call(adminLtd, "GET", A(`/access/${mixed.id}/branches`)));
      expect(list.branches.map((b: any) => b.branchId)).toEqual([metro]);
      const view = json(await call(adminLtd, "GET", A(`/authorization/users/${mixed.id}`))).user;
      expect([view.branches.map((b: any) => b.code), view.hiddenBranchCount]).toEqual([["METRO"], 1]);
    });

    it("delegasi tidak memperluas cakupan: delegasi mencakup Bandar tetapi akses admin hanya Metro -> Bandar tetap tertutup", async () => {
      const adminLtd = await mkDelegatedAdmin("admin-irisan", [metro], [metro, bandar]);
      const staff = await mkUser("staf-irisan", "STAFF", "LIMITED");
      expect((await grantBranch(adminLtd, staff, metro)).statusCode).toBe(201);
      expect((await grantBranch(adminLtd, staff, bandar)).statusCode).toBe(404);
      const m = await me(adminLtd);
      expect(m.delegation.effectiveBranchIds.manage_users).toEqual([metro]);
    });

    it("STAFF/ACCOUNTANT/VIEWER tidak dapat mengelola akses cabang", async () => {
      const target = await mkUser("target", "STAFF", "LIMITED");
      for (const role of ["STAFF", "ACCOUNTANT", "VIEWER"] as Role[]) {
        const u = await mkUser(`u-${role}`, role, "ALL");
        expect((await grantBranch(u, target, metro)).statusCode).toBe(403);
      }
    });
  });

  // =============================================================== KONTEKS CABANG AKTIF
  describe("cabang aktif: pemalsuan lewat header, URL, body, query", () => {
    it("semua jalur pemalsuan ditolak server walau UI/local storage menyatakan lain", async () => {
      const staff = await mkUser("staf-ctx", "ACCOUNTANT", "LIMITED", [metro]);
      const h = await call(staff, "GET", A("/journals"), { headers: { "x-branch-context": kotabumi } });
      expect(h.statusCode).toBe(403);
      expect(json(h).code).toBe("BRANCH_CONTEXT_INVALID");
      expect((await call(staff, "GET", A("/branch-context"), { headers: { "x-branch-context": "id-palsu" } })).statusCode).toBe(403);
      expect((await call(staff, "GET", A(`/branches/${kotabumi}`))).statusCode).toBe(404);
      expect((await call(staff, "PUT", A("/branch-context"), { payload: { branchId: kotabumi } })).statusCode).toBe(404);
      expect((await call(staff, "GET", A(`/journals?branchId=${kotabumi}`))).statusCode).toBe(404);
      const b = await call(staff, "POST", A("/journal"), {
        payload: { referenceNo: "X-1", periodId: "p", entryDate: "2026-01-01", branchId: kotabumi, lines: [{ accountId: "a", debit: 1, credit: 0 }, { accountId: "b", debit: 0, credit: 1 }] },
      });
      expect(b.statusCode).toBe(404);
    });
  });

  // =============================================================== OVERRIDE PERMISSION
  describe("permission override (GRANT / DENY)", () => {
    it("GRANT memberi permission yang tidak dimiliki role; DENY mencabut permission role; role tidak berubah", async () => {
      const staff = await mkUser("staf-grant", "STAFF", "LIMITED", [metro]);
      const acct = await mkUser("akuntan-deny", "ACCOUNTANT", "LIMITED", [metro]);
      expect((await me(staff)).permissions).not.toContain("interbranch.approve");
      expect((await me(acct)).permissions).toContain("interbranch.approve");
      expect((await putOverride(owner, staff, "interbranch.approve", "GRANT")).statusCode).toBe(201);
      expect((await putOverride(adminAll, acct, "interbranch.approve", "DENY")).statusCode).toBe(201);
      const s = await me(staff);
      expect(s.role).toBe("STAFF");
      expect(s.grants).toEqual(["interbranch.approve"]);
      const a = await me(acct);
      expect(a.role).toBe("ACCOUNTANT");
      expect(a.denies).toEqual(["interbranch.approve"]);
      expect(await probe(staff, "interbranch.approve", metro)).toBe(true);
      expect(await probe(staff, "interbranch.approve", kotabumi)).toBe(false);
      expect(await probe(acct, "interbranch.approve", metro)).toBe(false);
    });

    it("pencabutan override berlaku pada request berikutnya tanpa logout", async () => {
      const staff = await mkUser("staf-revoke-ov", "STAFF", "LIMITED", [metro]);
      await putOverride(owner, staff, "interbranch.approve", "GRANT");
      expect(await probe(staff, "interbranch.approve", metro)).toBe(true);
      expect((await call(owner, "DELETE", A(`/access/${staff.id}/permission-overrides/interbranch.approve`), { payload: { reason: "selesai" } })).statusCode).toBe(200);
      expect(await probe(staff, "interbranch.approve", metro)).toBe(false);
      expect((await call(owner, "DELETE", A(`/access/${staff.id}/permission-overrides/interbranch.approve`))).statusCode).toBe(404);
    });

    it("permission administratif TIDAK dapat di-override (hanya mengikuti role)", async () => {
      const staff = await mkUser("staf-adm", "STAFF", "LIMITED", [metro]);
      for (const p of ["users.manage", "user_branch.manage", "branch.close", "branch.reopen", "backup.restore", "company.update", "account.lock", "delegation.manage", "journal.post"]) {
        const res = await putOverride(owner, staff, p, "GRANT");
        expect(res.statusCode, p).toBe(403);
        expect(json(res).code).toBe("PERMISSION_NOT_OVERRIDABLE");
      }
      expect((await me(staff)).grants).toEqual([]);
    });

    it("aturan batas: diri sendiri, OWNER, permission yang tak dimiliki, VIEWER hanya baca", async () => {
      const staff = await mkUser("staf-b1", "STAFF", "ALL");
      const viewer = await mkUser("viewer", "VIEWER", "LIMITED", [metro]);
      const self = await putOverride(adminAll, adminAll, "interbranch.read", "GRANT");
      expect([self.statusCode, json(self).code]).toEqual([403, "SELF_MODIFICATION"]);
      const own = await putOverride(adminAll, owner, "interbranch.approve", "DENY");
      expect([own.statusCode, json(own).code]).toEqual([403, "OWNER_PROTECTED"]);
      expect((await putOverride(owner, owner, "interbranch.approve", "DENY")).statusCode).toBe(403);
      const v = await putOverride(owner, viewer, "interbranch.approve", "GRANT");
      expect([v.statusCode, json(v).code]).toEqual([403, "READ_ONLY_ROLE"]);
      expect((await putOverride(owner, viewer, "interbranch.read", "GRANT")).statusCode).toBe(201);
      const adminX = await mkUser("admin-x", "ADMIN", "ALL");
      expect((await putOverride(owner, adminX, "interbranch.approve", "DENY")).statusCode).toBe(201);
      const give = await putOverride(adminX, staff, "interbranch.approve", "GRANT");
      expect([give.statusCode, json(give).code]).toEqual([403, "PERMISSION_NOT_HELD"]);
      expect((await putOverride(staff, viewer, "interbranch.read", "GRANT")).statusCode).toBe(403);
      await expect(
        systemDb("access_permission_overrides").insert({ id: crypto.randomUUID(), company_id: companyA, access_id: owner.accessId, permission: "interbranch.approve", effect: "DENY" }),
      ).rejects.toThrow(/OWNER tidak dapat dibatasi/);
    });

    it("admin LIMITED berdelegasi: override hanya untuk user dalam cakupan delegasi dan peran <= max_role; tanpa delegasi tidak ada jalur", async () => {
      const adminLtd = await mkDelegatedAdmin("admin-ov", [metro, bandar], [metro]);
      const inScope = await mkUser("staf-in", "STAFF", "LIMITED", [metro]);
      const unassigned = await mkUser("staf-kosong", "STAFF", "LIMITED");
      const bandarOnly = await mkUser("staf-bandar", "STAFF", "LIMITED", [bandar]); // diakses admin, tetapi tak didelegasikan
      const mixed = await mkUser("staf-mixed", "STAFF", "LIMITED", [metro, kotabumi]);
      const allScope = await mkUser("staf-all", "STAFF", "ALL");
      const acct = await mkUser("akuntan-ov", "ACCOUNTANT", "LIMITED", [metro]);
      expect((await putOverride(adminLtd, inScope, "interbranch.approve", "GRANT")).statusCode).toBe(201);
      expect((await putOverride(adminLtd, unassigned, "interbranch.create", "DENY")).statusCode).toBe(201);
      const expectDenied = async (t: TestUser, code: string) => {
        const res = await putOverride(adminLtd, t, "interbranch.read", "GRANT");
        expect([res.statusCode, json(res).code]).toEqual([403, code]);
      };
      await expectDenied(bandarOnly, "TARGET_OUT_OF_SCOPE");
      await expectDenied(mixed, "TARGET_OUT_OF_SCOPE");
      await expectDenied(allScope, "TARGET_OUT_OF_SCOPE");
      await expectDenied(acct, "ROLE_EXCEEDS_DELEGATION");
    });
  });

  // =============================================================== DELEGASI (REVISI 5)
  describe("delegasi Revisi 5: 4 kapabilitas tetap + max_role + cabang", () => {
    it("hanya OWNER yang membuat delegasi: ADMIN (ALL maupun LIMITED), ACCOUNTANT, STAFF ditolak", async () => {
      const target = await mkUser("admin-target", "ADMIN", "LIMITED", [metro]);
      const adminLtd = await mkUser("admin-ltd-pembuat", "ADMIN", "LIMITED", [metro]);
      for (const u of [adminAll, adminLtd, await mkUser("akuntan-pembuat", "ACCOUNTANT", "ALL"), await mkUser("staf-pembuat", "STAFF", "ALL")]) {
        expect((await delegate(u, target)).statusCode).toBe(403);
      }
      expect((await me(adminAll)).permissions).not.toContain("delegation.manage");
      expect((await me(owner)).permissions).toContain("delegation.manage");
      expect((await delegate(owner, target)).statusCode).toBe(201);
    });

    it("OWNER mendelegasikan: efektif = delegasi x akses cabang x permission peran; peran tidak berubah", async () => {
      const admin = await mkUser("admin-eff", "ADMIN", "LIMITED", [metro, bandar]);
      expect((await delegate(owner, admin, { capabilities: ["manage_users", "manage_branch_info", "view_branch_reports", "inter_branch"], branchIds: [metro, kotabumi], maxRole: "ACCOUNTANT" })).statusCode).toBe(201);
      const m = await me(admin);
      expect(m.role).toBe("ADMIN");
      expect(m.delegation.capabilities.sort()).toEqual(["inter_branch", "manage_branch_info", "manage_users", "view_branch_reports"]);
      expect(m.delegation.maxRole).toBe("ACCOUNTANT");
      expect(m.delegation.effectiveBranchIds.manage_users).toEqual([metro]); // Kotabumi tidak diakses
      expect(m.delegation.effectiveBranchIds.manage_branch_info).toEqual([metro]);
      expect(m.preparedPermissions).toEqual(expect.arrayContaining(["interbranch.approve", "report.consolidated"]));
      expect(m.permissions).not.toContain("delegation.manage");
    });

    it("kapabilitas manage_branch_info: ubah info cabang delegasi (bukan urutan/status), cabang lain 404, tanpa delegasi 403", async () => {
      const admin = await mkDelegatedAdmin("admin-info", [metro, bandar], [metro], ["manage_branch_info"]);
      const ok = await call(admin, "PATCH", A(`/branches/${metro}`), { payload: { name: "Cabang Metro", address: "Jl. Baru 1", phone: "0725-1" } });
      expect(ok.statusCode).toBe(200);
      expect((await dbA("branches").where({ id: metro }).first()).address).toBe("Jl. Baru 1");
      expect((await call(admin, "PATCH", A(`/branches/${bandar}`), { payload: { address: "x" } })).statusCode).toBe(404); // diakses tetapi tak didelegasikan
      expect((await call(admin, "PATCH", A(`/branches/${hq}`), { payload: { address: "x" } })).statusCode).toBe(404);
      const sort = await call(admin, "PATCH", A(`/branches/${metro}`), { payload: { sortOrder: 3 } });
      expect([sort.statusCode, json(sort).code]).toEqual([403, "DELEGATION_SCOPE_EXCEEDED"]);
      // kapabilitas ini tidak membuka pengelolaan user maupun perubahan status cabang
      expect((await grantBranch(admin, await mkUser("t", "STAFF", "LIMITED"), metro)).statusCode).toBe(403);
      expect((await call(admin, "POST", A(`/branches/${metro}/status`), { payload: { to: "INACTIVE" } })).statusCode).toBe(403);
      expect(json(await call(admin, "GET", A("/branch-context"))).capabilities).toMatchObject({ manageBranchInfo: true, manageBranchAccess: false });
    });

    it("kapabilitas prepared (view_branch_reports, inter_branch) tersimpan & terbaca tetapi tidak memberi kewenangan administratif", async () => {
      const admin = await mkDelegatedAdmin("admin-prep", [metro], [metro], ["view_branch_reports", "inter_branch"]);
      const t = await mkUser("t-prep", "STAFF", "LIMITED");
      expect((await grantBranch(admin, t, metro)).statusCode).toBe(403);
      expect((await call(admin, "PATCH", A(`/branches/${metro}`), { payload: { address: "x" } })).statusCode).toBe(403);
      expect((await me(admin)).delegation.capabilities.sort()).toEqual(["inter_branch", "view_branch_reports"]);
    });

    it("pelanggaran batas: kapabilitas/max_role/cakupan/penerima/masa berlaku -> ditolak dengan kode tegas", async () => {
      const admin = await mkUser("admin-v", "ADMIN", "LIMITED", [metro]);
      const code = async (p: Promise<{ statusCode: number; payload: string }>) => {
        const r = await p;
        return [r.statusCode, json(r).code];
      };
      // ALL_BRANCH dan cabang tak sah
      expect(await code(delegate(owner, admin, { scopeAll: true, branchIds: [] }))).toEqual([403, "SCOPE_ALL_NOT_ALLOWED"]);
      expect(await code(delegate(owner, admin, { scopeAll: true, branchIds: [metro] }))).toEqual([403, "SCOPE_ALL_NOT_ALLOWED"]);
      expect(await code(delegate(owner, admin, { branchIds: [] }))).toEqual([403, "SCOPE_EMPTY"]);
      expect(await code(delegate(owner, admin, { branchIds: ["tidak-ada"] }))).toEqual([403, "BRANCH_OUT_OF_SCOPE"]);
      expect(await code(delegate(owner, admin, { branchIds: [bBranch] }))).toEqual([403, "BRANCH_OUT_OF_SCOPE"]); // cabang perusahaan lain
      // kapabilitas bukan permission bebas
      for (const c of ["users.manage", "backup.restore", "delegation.manage", "interbranch.approve", "owner"]) {
        expect(await code(delegate(owner, admin, { capabilities: [c] })), c).toEqual([403, "CAPABILITY_INVALID"]);
      }
      expect(await code(delegate(owner, admin, { capabilities: [] }))).toEqual([403, "CAPABILITY_INVALID"]);
      // max_role
      for (const m of ["ADMIN", "OWNER", "SUPERADMIN"]) expect(await code(delegate(owner, admin, { maxRole: m })), m).toEqual([403, "MAX_ROLE_INVALID"]);
      // penerima
      expect(await code(delegate(adminAll, owner))).toEqual([403, undefined]);
      expect(await code(delegate(owner, owner))).toEqual([403, "SELF_MODIFICATION"]);
      expect(await code(delegate(owner, await mkUser("staf-pen", "STAFF", "LIMITED", [metro])))).toEqual([403, "ROLE_NOT_ELIGIBLE"]);
      expect(await code(delegate(owner, await mkUser("viewer-pen", "VIEWER", "LIMITED", [metro])))).toEqual([403, "ROLE_NOT_ELIGIBLE"]);
      const acct = await mkUser("akuntan-pen", "ACCOUNTANT", "LIMITED", [metro]);
      expect(await code(delegate(owner, acct, { capabilities: ["manage_users"], maxRole: "STAFF" }))).toEqual([403, "CAPABILITY_NOT_APPLICABLE"]);
      expect(await code(delegate(owner, acct, { capabilities: ["inter_branch"], maxRole: "ACCOUNTANT" }))).toEqual([403, "MAX_ROLE_INVALID"]);
      expect((await delegate(owner, acct, { capabilities: ["inter_branch"], maxRole: "STAFF" })).statusCode).toBe(201);
      // lintas perusahaan / tidak dikenal
      expect((await delegate(owner, userB)).statusCode).toBe(404);
      expect((await delegate(owner, { id: "tidak-ada" } as TestUser)).statusCode).toBe(404);
      // masa berlaku
      expect(await code(delegate(owner, admin, { expiresAt: new Date(Date.now() - 1000).toISOString() }))).toEqual([403, "INVALID_EXPIRY"]);
      expect(await code(delegate(owner, admin, { expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() }))).toEqual([403, "INVALID_EXPIRY"]);
      // satu delegasi aktif per penerima
      expect((await delegate(owner, admin)).statusCode).toBe(201);
      expect((await delegate(owner, admin)).statusCode).toBe(409);
    });

    it("kedalaman 1: penerima delegasi tidak dapat mendelegasikan lagi", async () => {
      const recipient = await mkDelegatedAdmin("admin-penerima", [metro], [metro], ["manage_users", "manage_branch_info"]);
      const other = await mkUser("admin-lain", "ADMIN", "LIMITED", [metro]);
      expect((await delegate(recipient, other)).statusCode).toBe(403);
      expect((await call(recipient, "GET", A("/delegations"))).statusCode).toBe(200);
      expect((await me(recipient)).canDelegate).toBe(false);
      expect((await me(other)).delegation).toBeNull();
    });

    it("delegasi tidak dapat menaikkan role / memberi akses di luar cakupan: eskalasi ditolak", async () => {
      const admin = await mkDelegatedAdmin("admin-esk", [metro], [metro], ["manage_users", "manage_branch_info"], "ACCOUNTANT");
      const staff = await mkUser("staf-esk", "STAFF", "LIMITED", [metro]);
      // pengelolaan user perusahaan (peran) tetap hanya scope ALL
      for (const r of [
        await call(admin, "PATCH", A(`/access/${staff.id}`), { payload: { role: "ADMIN" } }),
        await call(admin, "PATCH", A(`/access/${admin.id}`), { payload: { role: "OWNER" } }),
        await call(admin, "POST", A("/access"), { payload: { userId: userB.id, role: "ADMIN" } }),
        await call(admin, "PUT", A(`/access/${staff.id}/branch-scope`), { payload: { scope: "ALL" } }),
        await call(admin, "POST", A("/delegations"), { payload: { granteeUserId: staff.id, capabilities: ["inter_branch"], maxRole: "VIEWER", branchIds: [metro] } }),
      ]) expect(r.statusCode).toBe(403);
      // ADMIN ALL tidak dapat menjadikan siapa pun OWNER; STAFF tidak dapat menjadikan ADMIN
      expect((await call(adminAll, "PATCH", A(`/access/${staff.id}`), { payload: { role: "OWNER" } })).statusCode).toBe(403);
      expect((await call(adminAll, "PATCH", A(`/access/${adminAll.id}`), { payload: { role: "OWNER" } })).statusCode).toBe(403);
      expect((await call(staff, "PATCH", A(`/access/${staff.id}`), { payload: { role: "ADMIN" } })).statusCode).toBe(403);
      expect((await me(admin)).role).toBe("ADMIN");
      expect((await me(staff)).role).toBe("STAFF");
    });

    it("pencabutan delegasi berlaku seketika; siapa yang berwenang mencabut", async () => {
      const admin = await mkDelegatedAdmin("admin-cabut", [metro], [metro]);
      const outsiderAdmin = await mkUser("admin-kota", "ADMIN", "LIMITED", [kotabumi]);
      const staff = await mkUser("staf-cabut", "STAFF", "LIMITED");
      expect((await grantBranch(admin, staff, metro)).statusCode).toBe(201);
      const id = (await me(admin)).delegation.id as string;
      // pihak lain tidak melihatnya sama sekali
      expect((await call(outsiderAdmin, "DELETE", A(`/delegations/${id}`))).statusCode).toBe(404);
      expect((await call(adminAll, "DELETE", A(`/delegations/${id}`))).statusCode).toBe(404);
      expect(json(await call(outsiderAdmin, "GET", A("/delegations"))).delegations).toEqual([]);
      // OWNER mencabut -> request berikutnya (sesi sama) kehilangan kewenangan
      expect((await call(owner, "DELETE", A(`/delegations/${id}`), { payload: { reason: "kembali" } })).statusCode).toBe(200);
      const after = await grantBranch(admin, await mkUser("staf-cabut2", "STAFF", "LIMITED"), metro);
      expect([after.statusCode, json(after).code]).toEqual([403, "DELEGATION_REQUIRED"]);
      expect((await me(admin)).delegation).toBeNull();
      expect((await call(owner, "DELETE", A(`/delegations/${id}`))).statusCode).toBe(404);
      // penerima boleh melepas; pemberi (OWNER) boleh mencabut yang baru
      const d2 = json(await delegate(owner, admin)).id as string;
      expect((await call(admin, "DELETE", A(`/delegations/${d2}`))).statusCode).toBe(200);
      const d3 = json(await delegate(owner, admin)).id as string;
      expect((await call(owner, "DELETE", A(`/delegations/${d3}`))).statusCode).toBe(200);
      // delegasi perusahaan lain tidak dapat dicabut dari perusahaan ini
      expect((await call(outsider, "DELETE", B(`/delegations/${d3}`))).statusCode).toBe(404);
    });

    it("delegasi menyusut otomatis: akses cabang penerima dicabut, penerima dinonaktifkan, role penerima turun, kedaluwarsa", async () => {
      const admin = await mkDelegatedAdmin("admin-susut", [metro, bandar], [metro, bandar]);
      const staff = async () => grantBranch(admin, await mkUser("t-susut", "STAFF", "LIMITED"), bandar);
      expect((await staff()).statusCode).toBe(201);
      await call(owner, "DELETE", A(`/access/${admin.id}/branches/${bandar}`)); // akses cabang berkurang
      expect((await staff()).statusCode).toBe(404);
      expect((await me(admin)).delegation.effectiveBranchIds.manage_users).toEqual([metro]);
      // role turun ke ACCOUNTANT (max_role STAFF masih di bawah, tetapi permission peran user_branch.manage hilang)
      await call(owner, "PATCH", A(`/access/${admin.id}`), { payload: { role: "ACCOUNTANT" } });
      const r = await grantBranch(admin, await mkUser("t-susut2", "STAFF", "LIMITED"), metro);
      expect(r.statusCode).toBe(403); // ACCOUNTANT tidak punya user_branch.manage: kapabilitas manage_users tak berlaku (irisan)
      await call(owner, "PATCH", A(`/access/${admin.id}`), { payload: { role: "ADMIN" } });
      expect((await grantBranch(admin, await mkUser("t-susut3", "STAFF", "LIMITED"), metro)).statusCode).toBe(201); // pulih: delegasi masih aktif
      // kedaluwarsa dievaluasi saat request
      const dlg = (await me(admin)).delegation.id as string;
      await systemDb("delegations").where({ id: dlg }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
      expect((await grantBranch(admin, await mkUser("t-susut4", "STAFF", "LIMITED"), metro)).statusCode).toBe(403);
      expect((await me(admin)).delegation).toBeNull();
      expect((await delegate(owner, admin)).statusCode).toBe(201); // pasangan kedaluwarsa tidak menghalangi yang baru
      expect((await audit("delegation.expired", admin.id)).length).toBe(1);
      // penerima dinonaktifkan -> tidak dapat bertindak sama sekali
      await call(owner, "PATCH", A(`/access/${admin.id}/status`), { payload: { status: "SUSPENDED" } });
      expect((await call(admin, "GET", A("/authorization/me"))).statusCode).toBe(404);
    });

    it("mencabut akses perusahaan PENERIMA berhasil dan delegasinya ikut hilang", async () => {
      const admin = await mkDelegatedAdmin("admin-dicabut", [metro], [metro]);
      expect((await call(owner, "DELETE", A(`/access/${admin.id}`))).statusCode).toBe(200);
      expect((await systemDb("delegations").where({ grantee_access_id: admin.accessId }).count({ c: "*" }).first()) as any).toMatchObject({ c: 0 });
    });

    it("daftar delegasi: OWNER melihat semua, penerima hanya miliknya; cabang di luar akses pembaca disembunyikan", async () => {
      const admin = await mkDelegatedAdmin("admin-list", [metro], [metro, kotabumi]);
      const other = await mkDelegatedAdmin("admin-list2", [kotabumi], [kotabumi]);
      const ownerView = json(await call(owner, "GET", A("/delegations"))).delegations;
      expect(ownerView.map((d: any) => d.grantee.userId)).toEqual(expect.arrayContaining([admin.id, other.id]));
      const mine = json(await call(admin, "GET", A("/delegations"))).delegations;
      expect(mine).toHaveLength(1);
      expect([mine[0].direction, mine[0].branchIds, mine[0].hiddenBranchCount]).toEqual(["received", [metro], 1]);
    });

    it("pelanggaran berulang yang identik dicatat sekali dalam jendela pembatasan (tidak membanjiri audit)", async () => {
      resetBoundaryAuditThrottleForTests();
      const target = await mkUser("target-banjir", "ADMIN", "LIMITED", [metro]);
      const count = async () => Number(((await systemDb("system_audit_log").where({ action: "security.authorization_boundary_denied", actor_id: owner.id }).count({ c: "*" }).first()) as any).c);
      const before = await count();
      for (let i = 0; i < 5; i++) expect((await delegate(owner, target, { branchIds: ["tidak-ada"] })).statusCode).toBe(403);
      await new Promise((r) => setTimeout(r, 100));
      expect((await count()) - before).toBe(1);
    });
  });

  // =============================================================== LINTAS PERUSAHAAN
  describe("lintas perusahaan", () => {
    it("Company A tidak dapat memberi akses cabang, override, atau delegasi kepada user Company B, dan sebaliknya", async () => {
      expect((await grantBranch(owner, userB, metro)).statusCode).toBe(404);
      expect((await putOverride(owner, userB, "interbranch.approve", "GRANT")).statusCode).toBe(404);
      expect((await delegate(owner, userB)).statusCode).toBe(404);
      const staffA = await mkUser("staf-a-lintas", "STAFF", "LIMITED", [metro]);
      expect((await call(outsider, "POST", B(`/access/${staffA.id}/branches`), { payload: { branchId: bBranch } })).statusCode).toBe(404);
      expect((await call(outsider, "POST", B(`/access/${userB.id}/branches`), { payload: { branchId: metro } })).statusCode).toBe(404);
      expect((await delegate(outsider, userB)).statusCode).toBe(404); // URL A: outsider bukan anggota A
      const adminB = await mkUser("admin-b", "ADMIN", "LIMITED", [bBranch], companyB);
      const viaB = await call(outsider, "POST", B("/delegations"), { payload: { granteeUserId: adminB.id, capabilities: ["manage_users"], maxRole: "STAFF", branchIds: [metro] } });
      expect([viaB.statusCode, json(viaB).code]).toEqual([403, "BRANCH_OUT_OF_SCOPE"]); // id cabang A tidak dikenal di perusahaan B
      expect((await call(outsider, "GET", A("/authorization/me"))).statusCode).toBe(404);
      expect((await call(outsider, "GET", A("/delegations"))).statusCode).toBe(404);
      // izin yang pernah diberikan di A tidak terbawa ke B
      const both = await mkUser("admin-dua-perusahaan", "ADMIN", "LIMITED", [metro]);
      await delegate(owner, both);
      await putOverride(owner, both, "interbranch.reverse", "DENY");
      await grantCompanyAccess(systemDb, { id: crypto.randomUUID(), systemUserId: both.id, companyId: companyB, role: "ADMIN", branchScope: "LIMITED" });
      const inB = json(await call(both, "GET", B("/authorization/me")));
      expect(inB.delegation).toBeNull();
      expect(inB.denies).toEqual([]);
      const forgedInB = await call(both, "POST", B(`/access/${userB.id}/branches`), { payload: { branchId: bBranch } });
      expect([forgedInB.statusCode, json(forgedInB).code]).toEqual([403, "DELEGATION_REQUIRED"]); // delegasi A tidak berlaku di B
    });

    it("trigger database menolak baris override/delegasi yang menghubungkan perusahaan berbeda", async () => {
      await expect(
        systemDb("access_permission_overrides").insert({ id: crypto.randomUUID(), company_id: companyB, access_id: owner.accessId, permission: "interbranch.read", effect: "GRANT" }),
      ).rejects.toThrow(/perusahaan yang berbeda/);
      await expect(
        systemDb("delegations").insert({ id: crypto.randomUUID(), company_id: companyA, grantor_access_id: owner.accessId, grantee_access_id: userB.accessId, can_manage_users: 1, max_role: "STAFF" }),
      ).rejects.toThrow();
    });
  });

  // =============================================================== VISIBILITAS DAFTAR USER
  describe("daftar user untuk pengelolaan", () => {
    it("OWNER melihat semua; admin berdelegasi hanya user LIMITED beririsan/belum bercabang dengan peran <= max_role", async () => {
      const adminLtd = await mkDelegatedAdmin("admin-vis", [metro], [metro]);
      const sMetro = await mkUser("vis-metro", "STAFF", "LIMITED", [metro]);
      const sKota = await mkUser("vis-kota", "STAFF", "LIMITED", [kotabumi]);
      const sNone = await mkUser("vis-none", "STAFF", "LIMITED");
      const sAll = await mkUser("vis-all", "STAFF", "ALL");
      const aMetro = await mkUser("vis-akuntan", "ACCOUNTANT", "LIMITED", [metro]);
      const full = json(await call(owner, "GET", A("/authorization/users"))).users.map((u: any) => u.userId);
      for (const u of [sMetro, sKota, sNone, sAll, adminLtd, owner, aMetro]) expect(full).toContain(u.id);
      const limited = json(await call(adminLtd, "GET", A("/authorization/users"))).users.map((u: any) => u.userId);
      expect(limited).toEqual(expect.arrayContaining([sMetro.id, sNone.id, adminLtd.id]));
      for (const u of [sKota, sAll, owner, aMetro]) expect(limited, u.fullName).not.toContain(u.id);
      expect((await call(adminLtd, "GET", A(`/authorization/users/${sKota.id}`))).statusCode).toBe(404);
      expect((await call(await mkUser("vis-staff", "STAFF", "ALL"), "GET", A("/authorization/users"))).statusCode).toBe(403);
    });
  });

  // =============================================================== AUDIT
  describe("audit trail", () => {
    it("setiap aksi sensitif tercatat lengkap (aktor, target, aksi, kapabilitas, cabang, waktu, alasan) tanpa rahasia", async () => {
      const admin = await mkUser("admin-audit", "ADMIN", "LIMITED");
      await grantBranch(owner, admin, metro);
      await call(owner, "DELETE", A(`/access/${admin.id}/branches/${metro}`), { payload: { reason: "audit-cabut" } });
      await putOverride(owner, admin, "interbranch.read", "DENY", "audit-override");
      await call(owner, "DELETE", A(`/access/${admin.id}/permission-overrides/interbranch.read`), { payload: { reason: "audit-override-cabut" } });
      const d = json(await delegate(owner, admin, { capabilities: ["manage_users", "inter_branch"], maxRole: "ACCOUNTANT", reason: "audit-delegasi" })).id as string;
      await call(owner, "DELETE", A(`/delegations/${d}`), { payload: { reason: "audit-delegasi-cabut" } });
      const expectRow = async (action: string, reason?: string) => {
        const rows = await audit(action, admin.id);
        expect(rows.length, action).toBeGreaterThanOrEqual(1);
        const r = rows[rows.length - 1];
        expect(r.actor_id).toBe(owner.id);
        expect(r.actor_label).toBe("owner");
        expect(r.target_user_id).toBe(admin.id);
        expect(r.company_id).toBe(companyA);
        expect(r.created_at).toBeTruthy();
        if (reason) expect(r.reason).toBe(reason);
        return r;
      };
      expect((await expectRow("user_branch.access_granted")).branch_id).toBe(metro);
      expect((await expectRow("user_branch.access_revoked", "audit-cabut")).branch_id).toBe(metro);
      expect(JSON.parse((await expectRow("permission_override.created", "audit-override")).after_json)).toEqual({ permission: "interbranch.read", effect: "DENY" });
      await expectRow("permission_override.revoked", "audit-override-cabut");
      const created = await expectRow("delegation.created", "audit-delegasi");
      const after = JSON.parse(created.after_json);
      expect(after).toMatchObject({ maxRole: "ACCOUNTANT", branchIds: [metro] });
      expect(after.capabilities.sort()).toEqual(["inter_branch", "manage_users"]);
      expect(created.branch_id).toBe(metro);
      const revoked = await expectRow("delegation.revoked", "audit-delegasi-cabut");
      expect(JSON.parse(revoked.before_json)).toMatchObject({ maxRole: "ACCOUNTANT", branchIds: [metro] });
      const all = (await systemDb("system_audit_log").where({ company_id: companyA }).select("before_json", "after_json", "reason")).map((r: any) => JSON.stringify(r)).join("\n");
      expect(all).not.toMatch(/password|token|secret|cookie/i);
      const any = (await audit("delegation.created"))[0];
      await expect(systemDb("system_audit_log").where({ id: any.id }).update({ reason: "ubah" })).rejects.toThrow();
      await expect(systemDb("system_audit_log").where({ id: any.id }).delete()).rejects.toThrow();
    });

    it("percobaan melampaui batas tercatat sebagai peristiwa keamanan", async () => {
      resetBoundaryAuditThrottleForTests();
      const admin = await mkUser("admin-aud", "ADMIN", "LIMITED", [metro]);
      const before = (await audit("security.authorization_boundary_denied")).length;
      expect((await delegate(owner, admin, { branchIds: [kotabumi, "palsu-aud"] })).statusCode).toBe(403);
      await new Promise((r) => setTimeout(r, 50));
      const rows = await audit("security.authorization_boundary_denied");
      expect(rows.length).toBe(before + 1);
      const last = rows[rows.length - 1];
      expect(last.actor_id).toBe(owner.id);
      expect(JSON.parse(last.after_json)).toMatchObject({ code: "BRANCH_OUT_OF_SCOPE", operation: "delegation.create", capabilities: ["manage_users"] });
    });

    it("kegagalan audit membatalkan perubahan (delegasi tidak tersisa tanpa jejak)", async () => {
      const admin = await mkUser("admin-atomic", "ADMIN", "LIMITED", [metro]);
      await systemDb.raw("CREATE TRIGGER IF NOT EXISTS zz_fail_audit BEFORE INSERT ON system_audit_log WHEN NEW.action = 'delegation.created' BEGIN SELECT RAISE(ABORT, 'audit gagal (uji)'); END;");
      try {
        expect((await delegate(owner, admin)).statusCode).toBe(500);
      } finally {
        await systemDb.raw("DROP TRIGGER IF EXISTS zz_fail_audit");
      }
      expect((await systemDb("delegations").where({ grantee_access_id: admin.accessId }).count({ c: "*" }).first()) as any).toMatchObject({ c: 0 });
      expect((await me(admin)).delegation).toBeNull();
    });
  });

  // =============================================================== OWNER TETAP TERVALIDASI
  describe("aturan OWNER", () => {
    it("OWNER tetap melewati validasi dasar: cabang valid, target valid, perusahaan valid, bukan diri sendiri", async () => {
      const admin = await mkUser("admin-owner-rule", "ADMIN", "LIMITED", [metro]);
      expect(json(await delegate(owner, admin, { branchIds: ["tidak-ada"] })).code).toBe("BRANCH_OUT_OF_SCOPE");
      expect(json(await delegate(owner, admin, { branchIds: [bBranch] })).code).toBe("BRANCH_OUT_OF_SCOPE");
      expect((await delegate(owner, userB)).statusCode).toBe(404);
      expect((await grantBranch(owner, admin, bBranch)).statusCode).toBe(404);
      expect((await grantBranch(owner, owner, metro)).statusCode).toBe(403);
      expect((await putOverride(owner, admin, "backup.restore", "GRANT")).statusCode).toBe(403);
    });
  });

  // =============================================================== MATRIKS
  describe("MATRIKS A: permission efektif x akses cabang (interbranch.approve pada Metro/Bandar/Kotabumi)", () => {
    type Row = { name: string; role: Role; scope: "ALL" | "LIMITED"; access: string[]; revokeAccess?: string[]; override?: "GRANT" | "DENY"; revokeOverride?: boolean; delegation?: string[]; expected: [boolean, boolean, boolean] };
    const rows = (): Row[] => [
      { name: "OWNER (ALL)", role: "OWNER", scope: "ALL", access: [], expected: [true, true, true] },
      { name: "ADMIN ALL", role: "ADMIN", scope: "ALL", access: [], expected: [true, true, true] },
      { name: "ADMIN 1 cabang (Metro)", role: "ADMIN", scope: "LIMITED", access: [metro], expected: [true, false, false] },
      { name: "ADMIN 2 cabang (Metro, Bandar)", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], expected: [true, true, false] },
      { name: "ADMIN banyak cabang (3)", role: "ADMIN", scope: "LIMITED", access: [metro, bandar, kotabumi], expected: [true, true, true] },
      { name: "ADMIN tanpa cabang", role: "ADMIN", scope: "LIMITED", access: [], expected: [false, false, false] },
      { name: "ADMIN cabang dicabut (Bandar)", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], revokeAccess: [bandar], expected: [true, false, false] },
      { name: "ADMIN dengan DENY approve", role: "ADMIN", scope: "LIMITED", access: [metro], override: "DENY", expected: [false, false, false] },
      { name: "ACCOUNTANT bawaan 2 cabang", role: "ACCOUNTANT", scope: "LIMITED", access: [metro, bandar], expected: [true, true, false] },
      { name: "ACCOUNTANT DENY dicabut", role: "ACCOUNTANT", scope: "LIMITED", access: [metro], override: "DENY", revokeOverride: true, expected: [true, false, false] },
      { name: "STAFF ALL tanpa override", role: "STAFF", scope: "ALL", access: [], expected: [false, false, false] },
      { name: "STAFF 1 cabang tanpa override", role: "STAFF", scope: "LIMITED", access: [metro], expected: [false, false, false] },
      { name: "STAFF 1 cabang + GRANT", role: "STAFF", scope: "LIMITED", access: [metro], override: "GRANT", expected: [true, false, false] },
      { name: "STAFF 2 cabang + GRANT", role: "STAFF", scope: "LIMITED", access: [metro, bandar], override: "GRANT", expected: [true, true, false] },
      { name: "STAFF banyak cabang + GRANT", role: "STAFF", scope: "LIMITED", access: [metro, bandar, kotabumi], override: "GRANT", expected: [true, true, true] },
      { name: "STAFF tanpa cabang + GRANT", role: "STAFF", scope: "LIMITED", access: [], override: "GRANT", expected: [false, false, false] },
      { name: "STAFF GRANT dicabut", role: "STAFF", scope: "LIMITED", access: [metro], override: "GRANT", revokeOverride: true, expected: [false, false, false] },
      { name: "STAFF GRANT tetapi akses Metro dicabut", role: "STAFF", scope: "LIMITED", access: [metro, bandar], override: "GRANT", revokeAccess: [metro], expected: [false, true, false] },
    ];
    for (const [i] of rows().entries()) {
      it(`matriks A #${i + 1}`, async () => {
        const row = rows()[i];
        const user = await mkUser(`mxa-${i}`, row.role, row.scope, row.access);
        if (row.override) expect((await putOverride(owner, user, "interbranch.approve", row.override)).statusCode, row.name).toBe(row.role === "OWNER" ? 403 : 201);
        if (row.revokeOverride) expect((await call(owner, "DELETE", A(`/access/${user.id}/permission-overrides/interbranch.approve`))).statusCode).toBe(200);
        for (const b of row.revokeAccess ?? []) expect((await call(owner, "DELETE", A(`/access/${user.id}/branches/${b}`))).statusCode).toBe(200);
        const got = [await probe(user, "interbranch.approve", metro), await probe(user, "interbranch.approve", bandar), await probe(user, "interbranch.approve", kotabumi)];
        expect(got, row.name).toEqual(row.expected);
      });
    }
    it("kapabilitas delegasi inter_branch TIDAK memberi permission: STAFF tidak dapat menjadi penerima, ACCOUNTANT/ADMIN tetap mengikuti role+override", async () => {
      const acct = await mkUser("akuntan-ib", "ACCOUNTANT", "LIMITED", [metro]);
      await putOverride(owner, acct, "interbranch.approve", "DENY");
      expect((await delegate(owner, acct, { capabilities: ["inter_branch"], maxRole: "STAFF" })).statusCode).toBe(201);
      expect(await probe(acct, "interbranch.approve", metro)).toBe(false); // DENY tetap menang
    });
  });

  describe("MATRIKS B: kewenangan mengelola akses cabang (menambah akses ke Metro/Bandar/Kotabumi) x peran x delegasi", () => {
    type Row = {
      name: string;
      role: Role;
      scope: "ALL" | "LIMITED";
      access: string[];
      delegation?: { caps: string[]; branches: string[]; maxRole?: string };
      after?: "revoke" | "expire" | "suspendGrantor" | "dropAccessBandar";
      expected: [boolean, boolean, boolean];
    };
    const rows = (): Row[] => [
      { name: "OWNER", role: "OWNER", scope: "ALL", access: [], expected: [true, true, true] },
      { name: "ADMIN ALL tanpa delegasi", role: "ADMIN", scope: "ALL", access: [], expected: [true, true, true] },
      { name: "ADMIN LIMITED tanpa delegasi", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], expected: [false, false, false] },
      { name: "ADMIN LIMITED delegasi Metro", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], delegation: { caps: ["manage_users"], branches: [metro] }, expected: [true, false, false] },
      { name: "ADMIN LIMITED delegasi Metro+Bandar", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], delegation: { caps: ["manage_users"], branches: [metro, bandar] }, expected: [true, true, false] },
      { name: "ADMIN LIMITED delegasi Metro+Bandar tetapi akses hanya Metro", role: "ADMIN", scope: "LIMITED", access: [metro], delegation: { caps: ["manage_users"], branches: [metro, bandar] }, expected: [true, false, false] },
      { name: "ADMIN LIMITED delegasi Metro+Kotabumi, akses Metro+Bandar", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], delegation: { caps: ["manage_users"], branches: [metro, kotabumi] }, expected: [true, false, false] },
      { name: "ADMIN LIMITED delegasi hanya inter_branch/view/info", role: "ADMIN", scope: "LIMITED", access: [metro], delegation: { caps: ["inter_branch", "view_branch_reports", "manage_branch_info"], branches: [metro] }, expected: [false, false, false] },
      { name: "ADMIN LIMITED delegasi dicabut", role: "ADMIN", scope: "LIMITED", access: [metro], delegation: { caps: ["manage_users"], branches: [metro] }, after: "revoke", expected: [false, false, false] },
      { name: "ADMIN LIMITED delegasi kedaluwarsa", role: "ADMIN", scope: "LIMITED", access: [metro], delegation: { caps: ["manage_users"], branches: [metro] }, after: "expire", expected: [false, false, false] },
      { name: "ADMIN LIMITED delegasi Metro+Bandar, akses Bandar dicabut", role: "ADMIN", scope: "LIMITED", access: [metro, bandar], delegation: { caps: ["manage_users"], branches: [metro, bandar] }, after: "dropAccessBandar", expected: [true, false, false] },
      { name: "ACCOUNTANT ALL", role: "ACCOUNTANT", scope: "ALL", access: [], expected: [false, false, false] },
      { name: "STAFF ALL", role: "STAFF", scope: "ALL", access: [], expected: [false, false, false] },
    ];
    for (const [i] of rows().entries()) {
      it(`matriks B #${i + 1}`, async () => {
        const row = rows()[i];
        const user = await mkUser(`mxb-${i}`, row.role, row.scope, row.access);
        let delegationId: string | null = null;
        if (row.delegation) {
          const res = await delegate(owner, user, { capabilities: row.delegation.caps, branchIds: row.delegation.branches, maxRole: row.delegation.maxRole ?? "STAFF" });
          expect(res.statusCode, row.name).toBe(201);
          delegationId = json(res).id;
        }
        if (row.after === "revoke") expect((await call(owner, "DELETE", A(`/delegations/${delegationId}`))).statusCode).toBe(200);
        if (row.after === "expire") await systemDb("delegations").where({ id: delegationId }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
        if (row.after === "dropAccessBandar") await call(owner, "DELETE", A(`/access/${user.id}/branches/${bandar}`));
        const got: boolean[] = [];
        for (const b of [metro, bandar, kotabumi]) {
          const target = await mkUser(`mxb-t-${i}`, "STAFF", "LIMITED");
          got.push((await grantBranch(user, target, b)).statusCode === 201);
        }
        expect(got, row.name).toEqual(row.expected);
      });
    }
  });
});
