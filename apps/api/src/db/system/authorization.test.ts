import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { deleteCompanyAccess, grantCompanyAccess } from "./company-access.js";
import { ensureSystemIdentity } from "./identity-bridge.js";
import { grantBranchAccess } from "./user-branch-access.js";
import {
  AuthorizationBoundaryError,
  assertBranchAccessBoundary,
  assertDelegationBoundary,
  assertOverrideBoundary,
  canActOnBranch,
  canRevokeDelegation,
  createDelegation,
  delegatedBranchIds,
  getManageBranchInfoScope,
  getManageUsersScope,
  hasBasePermission,
  listBasePermissions,
  listDelegations,
  listOverrides,
  loadActiveOverrides,
  resolveActiveDelegation,
  revokeDelegation,
  revokePermissionOverride,
  setPermissionOverride,
  type ActiveDelegation,
  type AuthzActor,
  type AuthzTarget,
} from "./authorization.js";
import {
  COMPANY_ROLES,
  DELEGATION_CAPABILITIES,
  DELEGATION_MAX_ROLES,
  OVERRIDABLE_PERMISSIONS,
  PERMISSIONS,
  PREPARED_PERMISSIONS,
  hasPermission,
  isOverridablePermission,
  type CompanyRole,
  type DelegationCapability,
  type DelegationMaxRole,
  type Permission,
} from "./rbac.js";
import type { SystemActorContext } from "./system-audit.js";

const none = new Set<Permission>();

function delegationOf(caps: DelegationCapability[], branches: string[], maxRole: DelegationMaxRole = "STAFF"): ActiveDelegation {
  return { id: "dlg-1", grantorAccessId: "acc-OWNER", capabilities: new Set(caps), branchIds: new Set(branches), maxRole, expiresAt: null };
}
function actorOf(role: CompanyRole, extra: Partial<AuthzActor> = {}): AuthzActor {
  return {
    accessId: `acc-${role}`,
    systemUserId: `usr-${role}`,
    companyId: "co-1",
    role,
    branchScope: "ALL",
    allowedBranchIds: null,
    grants: none,
    denies: none,
    delegation: null,
    ...extra,
  };
}
function limited(role: CompanyRole, access: string[], delegation: ActiveDelegation | null, extra: Partial<AuthzActor> = {}): AuthzActor {
  return actorOf(role, { branchScope: "LIMITED", allowedBranchIds: access, delegation, ...extra });
}
function targetOf(role: CompanyRole, extra: Partial<AuthzTarget> = {}): AuthzTarget {
  return { accessId: `tgt-${role}`, userId: `tu-${role}`, companyId: "co-1", role, branchScope: "LIMITED", branchIds: [], ...extra };
}
const branches = new Set(["b1", "b2", "b3"]);
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as AuthorizationBoundaryError).code;
  }
  return "OK";
};

describe("rbac Phase 3 (koreksi Revisi 5): permission & konstanta delegasi", () => {
  it("OWNER penuh; delegation.manage HANYA OWNER (ADMIN tidak otomatis); default interbranch sesuai tabel", () => {
    for (const p of PERMISSIONS) expect(hasPermission("OWNER", p)).toBe(true);
    for (const role of COMPANY_ROLES) expect(hasPermission(role, "delegation.manage"), role).toBe(role === "OWNER");
    expect(hasPermission("STAFF", "interbranch.create")).toBe(true);
    expect(hasPermission("STAFF", "interbranch.approve")).toBe(false);
    expect(hasPermission("ACCOUNTANT", "interbranch.approve")).toBe(true);
    expect(hasPermission("ADMIN", "interbranch.approve")).toBe(true);
    expect(hasPermission("VIEWER", "interbranch.read")).toBe(false);
  });
  it("daftar override tertutup; permission Phase 5/6 berstatus prepared; kapabilitas delegasi = 4 tetap, max_role tak pernah ADMIN/OWNER", () => {
    expect([...OVERRIDABLE_PERMISSIONS].sort()).toEqual(["interbranch.approve", "interbranch.create", "interbranch.read", "interbranch.reverse", "report.consolidated"]);
    expect([...PREPARED_PERMISSIONS].sort()).toEqual([...OVERRIDABLE_PERMISSIONS].sort());
    for (const p of PERMISSIONS) if (!p.startsWith("interbranch.") && p !== "report.consolidated") expect(isOverridablePermission(p), p).toBe(false);
    expect([...DELEGATION_CAPABILITIES]).toEqual(["manage_users", "manage_branch_info", "view_branch_reports", "inter_branch"]);
    expect([...DELEGATION_MAX_ROLES]).toEqual(["VIEWER", "STAFF", "ACCOUNTANT"]);
  });
});

describe("evaluasi permission efektif (murni)", () => {
  it("Effective = (role + GRANT) - DENY; OWNER tak terpengaruh override; GRANT non-override diabaikan", () => {
    expect(hasBasePermission({ role: "STAFF", grants: new Set<Permission>(["interbranch.approve"]), denies: none }, "interbranch.approve")).toBe(true);
    expect(hasBasePermission({ role: "ACCOUNTANT", grants: none, denies: new Set<Permission>(["interbranch.approve"]) }, "interbranch.approve")).toBe(false);
    expect(hasBasePermission({ role: "ACCOUNTANT", grants: new Set<Permission>(["interbranch.approve"]), denies: new Set<Permission>(["interbranch.approve"]) }, "interbranch.approve")).toBe(false);
    expect(hasBasePermission({ role: "OWNER", grants: none, denies: new Set<Permission>(["interbranch.approve"]) }, "interbranch.approve")).toBe(true);
    expect(hasBasePermission({ role: "STAFF", grants: new Set<Permission>(["users.manage", "backup.restore"]), denies: none }, "users.manage")).toBe(false);
    const list = listBasePermissions({ role: "STAFF", grants: new Set<Permission>(["interbranch.reverse"]), denies: new Set<Permission>(["interbranch.create"]) }, PERMISSIONS);
    expect(list).toContain("interbranch.reverse");
    expect(list).not.toContain("interbranch.create");
  });
  it("canActOnBranch = akses cabang DAN permission efektif; delegasi TIDAK menambah permission", () => {
    const admin = limited("ADMIN", ["b1"], null);
    expect(canActOnBranch(admin, "interbranch.approve", "b1")).toBe(true);
    expect(canActOnBranch(admin, "interbranch.approve", "b2")).toBe(false);
    expect(canActOnBranch(admin, "interbranch.approve", null)).toBe(false);
    expect(canActOnBranch({ ...admin, allowedBranchIds: [] }, "interbranch.approve", "b1")).toBe(false);
    expect(canActOnBranch(actorOf("ADMIN"), "interbranch.approve", "b9")).toBe(true);
    // STAFF dengan delegasi inter_branch tetap TIDAK dapat menyetujui (irisan dengan permission peran)
    const staff = limited("STAFF", ["b1"], delegationOf(["inter_branch"], ["b1"]));
    expect(canActOnBranch(staff, "interbranch.approve", "b1")).toBe(false);
  });
});

describe("cakupan pengelolaan (Revisi 5: irisan delegasi x akses x permission peran)", () => {
  it("ALL = wewenang peran; LIMITED tanpa delegasi = tidak punya jalur; dengan delegasi = irisan", () => {
    expect(getManageUsersScope(actorOf("ADMIN"))).toMatchObject({ all: true });
    expect(getManageUsersScope(limited("ADMIN", ["b1", "b2"], null))).toBeNull();
    const a = limited("ADMIN", ["b1", "b2"], delegationOf(["manage_users"], ["b1", "b3"], "STAFF"));
    const scope = getManageUsersScope(a)!;
    expect(scope.all).toBe(false);
    expect([...scope.branchIds]).toEqual(["b1"]); // b3 tidak diakses, b2 tidak didelegasikan
    expect(scope.maxRole).toBe("STAFF");
  });
  it("menyusut: akses cabang berkurang, kapabilitas tak dimiliki, permission peran tak ada, role turun", () => {
    const d = delegationOf(["manage_users", "manage_branch_info"], ["b1", "b2"]);
    expect([...delegatedBranchIds(limited("ADMIN", ["b1", "b2"], d), "manage_users")].sort()).toEqual(["b1", "b2"]);
    expect([...delegatedBranchIds(limited("ADMIN", ["b2"], d), "manage_users")]).toEqual(["b2"]);
    expect(delegatedBranchIds(limited("ADMIN", [], d), "manage_users").size).toBe(0);
    expect(delegatedBranchIds(limited("ADMIN", ["b1"], delegationOf(["inter_branch"], ["b1"])), "manage_users").size).toBe(0);
    // ACCOUNTANT tidak punya user_branch.manage / branch.manage -> kapabilitas tak berefek
    expect(delegatedBranchIds(limited("ACCOUNTANT", ["b1"], d), "manage_users").size).toBe(0);
    expect(delegatedBranchIds(limited("ACCOUNTANT", ["b1"], d), "manage_branch_info").size).toBe(0);
    // DENY/permission peran hilang -> berhenti
    expect(getManageBranchInfoScope(limited("ADMIN", ["b1"], d))!.all).toBe(false);
    expect(getManageBranchInfoScope(limited("STAFF", ["b1"], d))).toBeNull();
    expect(getManageBranchInfoScope(actorOf("ADMIN"))).toMatchObject({ all: true });
    expect(getManageBranchInfoScope(actorOf("ACCOUNTANT"))).toBeNull();
  });
  it("kapabilitas prepared (view_branch_reports, inter_branch) tidak memberi kewenangan administratif", () => {
    const a = limited("ADMIN", ["b1"], delegationOf(["view_branch_reports", "inter_branch"], ["b1"]));
    expect(getManageUsersScope(a)).toBeNull();
    expect(getManageBranchInfoScope(a)).toBeNull();
  });
});

describe("aturan batas pengelolaan akses & override", () => {
  const withDelegation = (access: string[], dBranches: string[], maxRole: DelegationMaxRole = "STAFF") => limited("ADMIN", access, delegationOf(["manage_users"], dBranches, maxRole));
  it("akses cabang: tanpa delegasi ditolak; cabang di luar cakupan delegasi ditolak; peran > max_role ditolak; user ALL ditolak", () => {
    const t = targetOf("STAFF");
    expect(codeOf(() => assertBranchAccessBoundary(limited("ADMIN", ["b1"], null), t, ["b1"]))).toBe("DELEGATION_REQUIRED");
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1", "b2"], ["b1"]), t, ["b1"]))).toBe("OK");
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1", "b2"], ["b1"]), t, ["b2"]))).toBe("BRANCH_OUT_OF_SCOPE"); // diakses tetapi tidak didelegasikan
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1"], ["b1", "b2"]), t, ["b2"]))).toBe("BRANCH_OUT_OF_SCOPE"); // didelegasikan tetapi tak diakses
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1"], ["b1"], "STAFF"), targetOf("ACCOUNTANT"), ["b1"]))).toBe("ROLE_EXCEEDS_DELEGATION");
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1"], ["b1"], "ACCOUNTANT"), targetOf("ACCOUNTANT"), ["b1"]))).toBe("OK");
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1"], ["b1"]), targetOf("STAFF", { branchScope: "ALL" }), ["b1"]))).toBe("TARGET_OUT_OF_SCOPE");
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1"], ["b1"]), targetOf("OWNER"), ["b1"]))).toBe("OWNER_PROTECTED");
    expect(codeOf(() => assertBranchAccessBoundary(withDelegation(["b1"], ["b1"]), targetOf("STAFF", { accessId: "acc-ADMIN" }), ["b1"]))).toBe("SELF_MODIFICATION");
    // ALL tidak terpengaruh
    expect(codeOf(() => assertBranchAccessBoundary(actorOf("ADMIN"), t, ["b3"]))).toBe("OK");
  });
  it("override: non-overridable, diri sendiri, OWNER, role lebih tinggi, permission tak dimiliki, VIEWER, scope delegasi", () => {
    const owner = actorOf("OWNER");
    const admin = actorOf("ADMIN");
    expect(codeOf(() => assertOverrideBoundary(owner, targetOf("STAFF"), "users.manage", "GRANT", "set"))).toBe("PERMISSION_NOT_OVERRIDABLE");
    expect(codeOf(() => assertOverrideBoundary(admin, targetOf("STAFF", { accessId: admin.accessId }), "interbranch.read", "GRANT", "set"))).toBe("SELF_MODIFICATION");
    expect(codeOf(() => assertOverrideBoundary(admin, targetOf("OWNER"), "interbranch.read", "DENY", "set"))).toBe("OWNER_PROTECTED");
    expect(codeOf(() => assertOverrideBoundary(actorOf("ACCOUNTANT"), targetOf("ADMIN"), "interbranch.read", "DENY", "set"))).toBe("ROLE_RANK_EXCEEDED");
    expect(codeOf(() => assertOverrideBoundary(actorOf("ADMIN", { denies: new Set<Permission>(["interbranch.approve"]) }), targetOf("STAFF"), "interbranch.approve", "GRANT", "set"))).toBe("PERMISSION_NOT_HELD");
    expect(codeOf(() => assertOverrideBoundary(owner, targetOf("VIEWER"), "interbranch.approve", "GRANT", "set"))).toBe("READ_ONLY_ROLE");
    expect(codeOf(() => assertOverrideBoundary(owner, targetOf("VIEWER"), "interbranch.read", "GRANT", "set"))).toBe("OK");
    // LIMITED: tanpa delegasi tidak ada jalur; dengan delegasi: semua cabang target harus di dalam cakupan efektif
    expect(codeOf(() => assertOverrideBoundary(limited("ADMIN", ["b1"], null), targetOf("STAFF", { branchIds: ["b1"] }), "interbranch.read", "GRANT", "set"))).toBe("DELEGATION_REQUIRED");
    const d = limited("ADMIN", ["b1", "b2"], delegationOf(["manage_users"], ["b1"]));
    expect(codeOf(() => assertOverrideBoundary(d, targetOf("STAFF", { branchIds: ["b1"] }), "interbranch.read", "GRANT", "set"))).toBe("OK");
    expect(codeOf(() => assertOverrideBoundary(d, targetOf("STAFF", { branchIds: ["b1", "b2"] }), "interbranch.read", "GRANT", "set"))).toBe("TARGET_OUT_OF_SCOPE");
    expect(codeOf(() => assertOverrideBoundary(d, targetOf("ACCOUNTANT", { branchIds: ["b1"] }), "interbranch.read", "GRANT", "set"))).toBe("ROLE_EXCEEDS_DELEGATION");
    // mencabut DENY menambah kemampuan -> aktor harus memegangnya
    const denied = actorOf("ADMIN", { denies: new Set<Permission>(["interbranch.approve"]) });
    expect(codeOf(() => assertOverrideBoundary(denied, targetOf("STAFF"), "interbranch.approve", "DENY", "revoke"))).toBe("PERMISSION_NOT_HELD");
    expect(codeOf(() => assertOverrideBoundary(denied, targetOf("STAFF"), "interbranch.approve", "GRANT", "revoke"))).toBe("OK");
  });
});

describe("aturan batas delegasi (Revisi 5)", () => {
  const input = (o: Record<string, unknown> = {}) => ({ capabilities: ["manage_users"], maxRole: "STAFF", branchIds: ["b1"], ...o }) as Parameters<typeof assertDelegationBoundary>[2];
  const owner = actorOf("OWNER");
  it("hanya OWNER (delegation.manage) dapat membuat delegasi; ADMIN ALL & ADMIN LIMITED tidak", () => {
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input(), branches))).toBe("OK");
    expect(codeOf(() => assertDelegationBoundary(actorOf("ADMIN"), targetOf("ACCOUNTANT"), input({ capabilities: ["inter_branch"] }), branches))).toBe("PERMISSION_NOT_HELD");
    expect(codeOf(() => assertDelegationBoundary(limited("ADMIN", ["b1"], null), targetOf("ACCOUNTANT"), input({ capabilities: ["inter_branch"] }), branches))).toBe("PERMISSION_NOT_HELD");
    expect(codeOf(() => assertDelegationBoundary(actorOf("ACCOUNTANT"), targetOf("STAFF"), input(), branches))).toBe("PERMISSION_NOT_HELD");
  });
  it("kedalaman 1: penerima delegasi tidak membuat delegasi, walau (hipotetis) memegang delegation.manage", () => {
    const recipient = limited("ADMIN", ["b1"], delegationOf(["manage_users"], ["b1"]), { grants: none });
    expect(codeOf(() => assertDelegationBoundary(recipient, targetOf("ACCOUNTANT"), input({ maxRole: "STAFF" }), branches))).toBe("DELEGATION_DEPTH_EXCEEDED");
  });
  it("target: bukan OWNER/diri sendiri, peran harus ADMIN/ACCOUNTANT, tidak di atas aktor", () => {
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("OWNER"), input(), branches))).toBe("OWNER_PROTECTED");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN", { accessId: owner.accessId }), input(), branches))).toBe("SELF_MODIFICATION");
    for (const r of ["STAFF", "VIEWER"] as CompanyRole[]) expect(codeOf(() => assertDelegationBoundary(owner, targetOf(r), input({ capabilities: ["inter_branch"], maxRole: "VIEWER" }), branches)), r).toBe("ROLE_NOT_ELIGIBLE");
  });
  it("kapabilitas: harus dari 4 tetap, tidak kosong, berlaku bagi peran penerima", () => {
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ capabilities: [] }), branches))).toBe("CAPABILITY_INVALID");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ capabilities: ["manage_users", "buat_apa_saja"] }), branches))).toBe("CAPABILITY_INVALID");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ capabilities: ["users.manage"] }), branches))).toBe("CAPABILITY_INVALID"); // permission bukan kapabilitas
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ACCOUNTANT"), input({ capabilities: ["manage_users"] }), branches))).toBe("CAPABILITY_NOT_APPLICABLE");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ACCOUNTANT"), input({ capabilities: ["manage_branch_info"] }), branches))).toBe("CAPABILITY_NOT_APPLICABLE");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ACCOUNTANT"), input({ capabilities: ["view_branch_reports", "inter_branch"], maxRole: "STAFF" }), branches))).toBe("OK");
    for (const c of DELEGATION_CAPABILITIES) expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ capabilities: [c] }), branches)), c).toBe("OK");
  });
  it("max_role: VIEWER/STAFF/ACCOUNTANT, selalu di bawah peran penerima, tak pernah ADMIN/OWNER", () => {
    for (const m of ["ADMIN", "OWNER", "SUPERADMIN", ""]) expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ maxRole: m }), branches)), m).toBe("MAX_ROLE_INVALID");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ maxRole: "ACCOUNTANT" }), branches))).toBe("OK");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ACCOUNTANT"), input({ capabilities: ["inter_branch"], maxRole: "ACCOUNTANT" }), branches))).toBe("MAX_ROLE_INVALID"); // setara penerima
  });
  it("cakupan: tidak pernah ALL, tidak kosong, cabang harus ada & dalam cakupan pemberi", () => {
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ scopeAll: true, branchIds: [] }), branches))).toBe("SCOPE_ALL_NOT_ALLOWED");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ scopeAll: true, branchIds: ["b1"] }), branches))).toBe("SCOPE_ALL_NOT_ALLOWED");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ branchIds: [] }), branches))).toBe("SCOPE_EMPTY");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ branchIds: ["b1", "hantu"] }), branches))).toBe("BRANCH_OUT_OF_SCOPE");
    expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ branchIds: ["b1", "b2", "b3"] }), branches))).toBe("OK");
  });
  it("delegasi tidak dapat memperluas cakupan pemberi: pemberi ber-scope LIMITED hanya dapat memberi subset akses miliknya", () => {
    // pemberi hipotetis (mis. peran OWNER yang kelak dibatasi) dengan akses b1,b2 saja
    const narrowGrantor = limited("OWNER", ["b1", "b2"], null);
    expect(codeOf(() => assertDelegationBoundary(narrowGrantor, targetOf("ADMIN"), input({ branchIds: ["b1", "b2"] }), branches))).toBe("OK");
    expect(codeOf(() => assertDelegationBoundary(narrowGrantor, targetOf("ADMIN"), input({ branchIds: ["b3"] }), branches))).toBe("BRANCH_OUT_OF_SCOPE");
    expect(codeOf(() => assertDelegationBoundary(narrowGrantor, targetOf("ADMIN"), input({ branchIds: ["b1", "b3"] }), branches))).toBe("BRANCH_OUT_OF_SCOPE");
  });
  it("masa berlaku: masa depan, maksimum 366 hari", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    for (const [exp, expected] of [["2026-05-31T00:00:00Z", "INVALID_EXPIRY"], ["bukan-tanggal", "INVALID_EXPIRY"], ["2028-01-01T00:00:00Z", "INVALID_EXPIRY"], ["2026-07-01T00:00:00Z", "OK"]] as const) {
      expect(codeOf(() => assertDelegationBoundary(owner, targetOf("ADMIN"), input({ expiresAt: exp }), branches, now)), exp).toBe(expected);
    }
  });
  it("pencabutan: OWNER, pemberi, atau penerima sendiri; selain itu tidak", () => {
    const d = { id: "d", grantorAccessId: "g", granteeAccessId: "r" } as any;
    expect(canRevokeDelegation(actorOf("OWNER"), d)).toBe(true);
    expect(canRevokeDelegation(actorOf("ADMIN", { accessId: "g" }), d)).toBe(true);
    expect(canRevokeDelegation(actorOf("ADMIN", { accessId: "r" }), d)).toBe(true);
    expect(canRevokeDelegation(actorOf("ADMIN", { accessId: "x" }), d)).toBe(false);
  });
});

describe("skema & trigger System DB (S0014-S0016) + layanan", () => {
  let tmpFile: string;
  let db: Knex;
  let company: string;
  let other: string;
  const auditActor: SystemActorContext = { actorType: "user", actorId: "owner-1", actorLabel: "Owner" };
  const access: Record<string, { accessId: string; userId: string }> = {};

  async function addUser(key: string, role: CompanyRole, companyId = company, scope: "ALL" | "LIMITED" = "LIMITED") {
    const userId = await ensureSystemIdentity(db, { id: crypto.randomUUID(), email: `${key}@test.local`, fullName: key, role: "admin", avatarUrl: null });
    const accessId = crypto.randomUUID();
    await grantCompanyAccess(db, { id: accessId, systemUserId: userId, companyId, role, branchScope: scope });
    access[key] = { accessId, userId };
    return access[key];
  }
  const asActor = (key: string, role: CompanyRole, extra: Partial<AuthzActor> = {}): AuthzActor => ({
    accessId: access[key].accessId,
    systemUserId: access[key].userId,
    companyId: company,
    role,
    branchScope: "ALL",
    allowedBranchIds: null,
    grants: none,
    denies: none,
    delegation: null,
    ...extra,
  });
  const asTarget = (key: string, role: CompanyRole, extra: Partial<AuthzTarget> = {}): AuthzTarget => ({
    accessId: access[key].accessId,
    userId: access[key].userId,
    companyId: company,
    role,
    branchScope: "LIMITED",
    branchIds: [],
    ...extra,
  });
  const ids = new Set(["b1", "b2"]);
  const delegate = (granteeKey: string, role: CompanyRole, o: Record<string, unknown> = {}) =>
    createDelegation(db, asActor("owner", "OWNER"), auditActor, asTarget(granteeKey, role), { capabilities: ["manage_users"], maxRole: "STAFF", branchIds: ["b1"], ...o } as any, ids);

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `terra-authz-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = knexLib({ ...baseKnexConfig, connection: { filename: tmpFile } });
    await db.migrate.latest();
    await db.raw("PRAGMA foreign_keys = ON");
    company = crypto.randomUUID();
    other = crypto.randomUUID();
    for (const [id, slug] of [[company, "pt-a"], [other, "pt-b"]] as const) {
      await db("companies_registry").insert({ id, slug, name: slug, database_path: `/tmp/${slug}/company.db`, status: "active" });
    }
    await addUser("owner", "OWNER", company, "ALL");
    await addUser("admin", "ADMIN");
    await addUser("admin2", "ADMIN");
    await addUser("acct", "ACCOUNTANT");
    await addUser("staff", "STAFF");
    await addUser("outsider", "ADMIN", other);
  });
  afterEach(async () => {
    await db.destroy();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("override: tulis, ganti, cabut; riwayat utuh; DENY pada OWNER ditolak DB; tanpa DELETE/ubah identitas", async () => {
    const owner = asActor("owner", "OWNER");
    const t = asTarget("staff", "STAFF");
    expect((await setPermissionOverride(db, owner, auditActor, t, "interbranch.approve", "GRANT", "r1")).replaced).toBe(false);
    expect((await loadActiveOverrides(db, t.accessId)).grants.has("interbranch.approve")).toBe(true);
    expect((await setPermissionOverride(db, owner, auditActor, t, "interbranch.approve", "DENY", "r2")).replaced).toBe(true);
    const ov = await loadActiveOverrides(db, t.accessId);
    expect(ov.grants.size).toBe(0);
    expect(ov.denies.has("interbranch.approve")).toBe(true);
    await expect(setPermissionOverride(db, owner, auditActor, t, "interbranch.approve", "DENY", "r3")).rejects.toThrow(/sudah aktif/);
    await revokePermissionOverride(db, owner, auditActor, t, "interbranch.approve", "selesai");
    expect((await listOverrides(db, t.accessId)).length).toBe(0);
    expect((await listOverrides(db, t.accessId, { includeRevoked: true })).map((r) => [r.effect, r.status])).toEqual([["GRANT", "REVOKED"], ["DENY", "REVOKED"]]);
    await expect(db("access_permission_overrides").insert({ id: "x1", company_id: company, access_id: access.owner.accessId, permission: "interbranch.read", effect: "DENY" })).rejects.toThrow(/OWNER/);
    await expect(db("access_permission_overrides").insert({ id: "x2", company_id: company, access_id: t.accessId, permission: "users.manage", effect: "GRANT" })).rejects.toThrow();
    await expect(db("access_permission_overrides").where({ access_id: t.accessId }).delete()).rejects.toThrow(/tidak boleh dihapus/);
    await expect(db("access_permission_overrides").where({ access_id: t.accessId }).update({ effect: "GRANT" })).rejects.toThrow(/Identitas override/);
    await expect(db("access_permission_overrides").insert({ id: "x3", company_id: other, access_id: t.accessId, permission: "interbranch.read", effect: "GRANT" })).rejects.toThrow(/perusahaan yang berbeda/);
  });

  it("delegasi Revisi 5: simpan kapabilitas+cabang+max_role, satu aktif per penerima, audit lengkap, pencabutan", async () => {
    const { id } = await delegate("admin", "ADMIN", { capabilities: ["manage_users", "inter_branch"], branchIds: ["b1", "b2"], maxRole: "ACCOUNTANT", reason: "cuti" });
    const [row] = await listDelegations(db, company, { granteeAccessId: access.admin.accessId });
    expect(row).toMatchObject({ id, maxRole: "ACCOUNTANT", live: true, reason: "cuti" });
    expect(row.capabilities.sort()).toEqual(["inter_branch", "manage_users"]);
    expect(row.branchIds.sort()).toEqual(["b1", "b2"]);
    await expect(delegate("admin", "ADMIN")).rejects.toThrow(/sudah memiliki delegasi aktif/);
    const resolved = await resolveActiveDelegation(db, company, { accessId: access.admin.accessId, role: "ADMIN" });
    expect(resolved).toMatchObject({ id, maxRole: "ACCOUNTANT" });
    expect([...resolved!.capabilities].sort()).toEqual(["inter_branch", "manage_users"]);
    const audit = await db("system_audit_log").where({ action: "delegation.created" }).first();
    expect(JSON.parse(audit.after_json)).toMatchObject({ maxRole: "ACCOUNTANT", branchIds: ["b1", "b2"], grantorAccessId: access.owner.accessId });
    await revokeDelegation(db, asActor("owner", "OWNER"), auditActor, id, "selesai");
    expect(await resolveActiveDelegation(db, company, { accessId: access.admin.accessId, role: "ADMIN" })).toBeNull();
    await expect(revokeDelegation(db, asActor("owner", "OWNER"), auditActor, id, null)).rejects.toThrow(/tidak ditemukan/);
    await expect(revokeDelegation(db, asActor("owner", "OWNER", { companyId: other }), auditActor, id, null)).rejects.toThrow(/tidak ditemukan/);
    // setelah dicabut dapat dibuat lagi (riwayat tetap)
    await delegate("admin", "ADMIN");
    expect((await listDelegations(db, company, { granteeAccessId: access.admin.accessId, includeInactive: true })).length).toBe(2);
  });

  it("delegasi menyusut bila peran penerima turun di bawah syarat atau tak lagi di atas max_role", async () => {
    await delegate("admin", "ADMIN", { maxRole: "ACCOUNTANT" });
    const resolve = (role: CompanyRole) => resolveActiveDelegation(db, company, { accessId: access.admin.accessId, role });
    expect(await resolve("ADMIN")).not.toBeNull();
    expect(await resolve("ACCOUNTANT")).toBeNull(); // max_role ACCOUNTANT tak lagi di bawah peran penerima
    expect(await resolve("STAFF")).toBeNull(); // tak memenuhi syarat penerima
    expect(await resolve("OWNER")).toBeNull();
  });

  it("delegasi menyusut: pemberi kehilangan delegation.manage / dinonaktifkan; kedaluwarsa", async () => {
    const { id } = await delegate("admin2", "ADMIN");
    const resolve = () => resolveActiveDelegation(db, company, { accessId: access.admin2.accessId, role: "ADMIN" });
    expect(await resolve()).not.toBeNull();
    await db("company_access").where({ id: access.owner.accessId }).update({ role: "ADMIN" }); // pemberi tak lagi memegang delegation.manage
    expect(await resolve()).toBeNull();
    await db("company_access").where({ id: access.owner.accessId }).update({ role: "OWNER", status: "SUSPENDED" });
    expect(await resolve()).toBeNull();
    await db("company_access").where({ id: access.owner.accessId }).update({ status: "ACTIVE" });
    expect(await resolve()).not.toBeNull();
    await db("delegations").where({ id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await resolve()).toBeNull();
    expect((await listDelegations(db, company, { granteeAccessId: access.admin2.accessId })).length).toBe(0);
    // pasangan kedaluwarsa tidak menghalangi delegasi baru
    await delegate("admin2", "ADMIN");
    expect(await resolve()).not.toBeNull();
    expect((await db("system_audit_log").where({ action: "delegation.expired" }).count({ c: "*" }).first()) as any).toMatchObject({ c: 1 });
  });

  it("trigger & CHECK delegasi: penerima ADMIN/ACCOUNTANT, max_role < peran, minimal satu kapabilitas, perusahaan sama, tak ubah isi, tak dihapus langsung", async () => {
    const base = { company_id: company, grantor_access_id: access.owner.accessId, can_manage_users: 1, max_role: "STAFF" };
    await expect(db("delegations").insert({ id: "t1", ...base, grantee_access_id: access.staff.accessId })).rejects.toThrow(/ADMIN atau ACCOUNTANT|max_role/);
    await expect(db("delegations").insert({ id: "t2", ...base, grantor_access_id: access.admin.accessId, grantee_access_id: access.admin.accessId })).rejects.toThrow(/dua user berbeda/);
    await expect(db("delegations").insert({ id: "t2b", ...base, grantee_access_id: access.owner.accessId })).rejects.toThrow(); // OWNER tidak menerima delegasi
    await expect(db("delegations").insert({ id: "t3", ...base, grantee_access_id: access.outsider.accessId })).rejects.toThrow(/perusahaan yang sama/);
    await expect(db("delegations").insert({ id: "t4", ...base, grantee_access_id: access.acct.accessId, max_role: "ACCOUNTANT" })).rejects.toThrow(/max_role/);
    await expect(db("delegations").insert({ id: "t5", ...base, grantee_access_id: access.admin.accessId, max_role: "ADMIN" })).rejects.toThrow();
    await expect(db("delegations").insert({ id: "t6", ...base, grantee_access_id: access.admin.accessId, can_manage_users: 0 })).rejects.toThrow();
    const { id } = await delegate("admin", "ADMIN");
    await expect(db("delegations").where({ id }).update({ max_role: "VIEWER" })).rejects.toThrow(/Isi delegasi/);
    await expect(db("delegations").where({ id }).update({ can_inter_branch: 1 })).rejects.toThrow(/Isi delegasi/);
    await expect(db("delegation_branches").where({ delegation_id: id }).update({ branch_id: "zz" })).rejects.toThrow(/tidak dapat diubah/);
    await expect(db("delegations").where({ id }).delete()).rejects.toThrow(/tidak boleh dihapus/);
    // aplikasi: delegasi ke ACCOUNTANT dengan max_role setara ditolak oleh aturan batas; ke ADMIN dengan ACCOUNTANT sah
    await expect(delegate("acct", "ACCOUNTANT", { capabilities: ["inter_branch"], maxRole: "ACCOUNTANT" })).rejects.toThrow(/Peran maksimum/);
  });

  it("mencabut akses perusahaan PEMBERI atau PENERIMA tidak terhalang (cascade) dan jejak audit tetap ada", async () => {
    await delegate("admin", "ADMIN");
    await delegate("admin2", "ADMIN");
    await deleteCompanyAccess(db, access.admin.accessId); // penerima
    expect((await db("delegations").where({ grantee_access_id: access.admin.accessId }).count({ c: "*" }).first()) as any).toMatchObject({ c: 0 });
    await deleteCompanyAccess(db, access.owner.accessId); // pemberi
    expect((await db("delegations").count({ c: "*" }).first()) as any).toMatchObject({ c: 0 });
    expect((await db("delegation_branches").count({ c: "*" }).first()) as any).toMatchObject({ c: 0 });
    expect((await db("system_audit_log").where({ action: "delegation.created" }).count({ c: "*" }).first()) as any).toMatchObject({ c: 2 });
  });

  it("migrasi S0016: delegasi model lama diarsipkan (tidak hilang), idempoten rollback/migrate", async () => {
    const tables = (await db.raw("SELECT name FROM sqlite_master WHERE type='table'")).map((r: { name: string }) => r.name);
    for (const t of ["access_permission_overrides", "delegations", "delegation_branches", "delegations_p3_archive", "delegation_branches_p3_archive"]) expect(tables).toContain(t);
    // dari keadaan S0015 (model lama) dengan baris nyata -> S0016 mengarsipkan, bukan membuang
    const old = path.join(os.tmpdir(), `terra-authz-old-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const oldDb = knexLib({ ...baseKnexConfig, connection: { filename: old } });
    try {
      const all = (await oldDb.migrate.list())[1] as Array<{ file: string }>;
      const total = all.length;
      for (let i = 0; i < total - 1; i++) await oldDb.migrate.up(); // sampai S0015
      expect(((await oldDb.migrate.currentVersion()) as string)).toBe("S0015");
      await oldDb.raw("PRAGMA foreign_keys = ON");
      const co = crypto.randomUUID();
      await oldDb("companies_registry").insert({ id: co, slug: "x", name: "x", database_path: "/tmp/x", status: "active" });
      const u1 = await ensureSystemIdentity(oldDb, { id: crypto.randomUUID(), email: "o@t.l", fullName: "o", role: "admin", avatarUrl: null });
      const u2 = await ensureSystemIdentity(oldDb, { id: crypto.randomUUID(), email: "p@t.l", fullName: "p", role: "admin", avatarUrl: null });
      await grantCompanyAccess(oldDb, { id: "a1", systemUserId: u1, companyId: co, role: "OWNER" });
      await grantCompanyAccess(oldDb, { id: "a2", systemUserId: u2, companyId: co, role: "ADMIN" });
      await oldDb("delegations").insert({ id: "d-old", company_id: co, grantor_access_id: "a1", grantee_access_id: "a2", permission: "interbranch.approve", scope_all: 0 });
      await oldDb("delegation_branches").insert({ delegation_id: "d-old", branch_id: "b1" });
      await oldDb.migrate.up(); // S0016
      expect((await oldDb("delegations_p3_archive").select("id")).map((r: { id: string }) => r.id)).toEqual(["d-old"]);
      expect((await oldDb("delegation_branches_p3_archive").count({ c: "*" }).first()) as any).toMatchObject({ c: 1 });
      expect((await oldDb("delegations").count({ c: "*" }).first()) as any).toMatchObject({ c: 0 });
      await oldDb.migrate.down(); // kembali ke model lama utuh
      expect((await oldDb("delegations").select("id", "permission")).map((r: { id: string }) => r.id)).toEqual(["d-old"]);
      await oldDb.migrate.latest();
      expect((await oldDb("delegations_p3_archive").count({ c: "*" }).first()) as any).toMatchObject({ c: 1 });
    } finally {
      await oldDb.destroy();
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
  });
});
