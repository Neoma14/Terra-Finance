import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { deleteCompanyAccess, findCompanyAccess, grantCompanyAccess } from "./company-access.js";
import { ensureSystemIdentity } from "./identity-bridge.js";
import {
  BranchAccessAlreadyGrantedError,
  BranchAccessNotFoundError,
  countActiveAccessForBranch,
  grantBranchAccess,
  listActiveBranchIds,
  listBranchAccess,
  revokeBranchAccess,
  setBranchScope,
  setDefaultBranch,
  transferBranchAccess,
  type BranchAccessTarget,
} from "./user-branch-access.js";
import type { SystemActorContext } from "./system-audit.js";

const actor: SystemActorContext = { actorType: "user", actorId: "owner-1", actorLabel: "Owner" };

describe("user_branch_access (Multi-Branch Phase 1, S0011-S0013)", () => {
  let tmpFile: string;
  let db: Knex;
  let companyA: string;
  let companyB: string;
  let userId: string;
  let accessA: string;
  let target: BranchAccessTarget;

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `terra-uba-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = knexLib({ ...baseKnexConfig, connection: { filename: tmpFile } });
    await db.migrate.latest();
    await db.raw("PRAGMA foreign_keys = ON");

    userId = await ensureSystemIdentity(db, { id: crypto.randomUUID(), email: "staf@test.local", fullName: "Staf Uji", role: "admin", avatarUrl: null });
    companyA = crypto.randomUUID();
    companyB = crypto.randomUUID();
    for (const [id, slug] of [[companyA, "pt-a"], [companyB, "pt-b"]] as const) {
      await db("companies_registry").insert({ id, slug, name: slug, database_path: `/tmp/${slug}/company.db`, status: "active" });
    }
    accessA = crypto.randomUUID();
    await grantCompanyAccess(db, { id: accessA, systemUserId: userId, companyId: companyA, role: "STAFF", branchScope: "LIMITED" });
    target = { companyId: companyA, accessId: accessA, targetUserId: userId };
  });

  afterEach(async () => {
    await db.destroy();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("akses lama tidak berubah: default branch_scope = ALL tanpa baris akses cabang", async () => {
    const other = await ensureSystemIdentity(db, { id: crypto.randomUUID(), email: "lama@test.local", fullName: "Lama", role: "admin", avatarUrl: null });
    await grantCompanyAccess(db, { id: crypto.randomUUID(), systemUserId: other, companyId: companyA, role: "ACCOUNTANT" });
    const access = await findCompanyAccess(db, other, companyA);
    expect(access).toMatchObject({ branchScope: "ALL", defaultBranchId: null });
  });

  it("satu user dapat memiliki banyak cabang; LIMITED tanpa baris = daftar kosong (fail-closed)", async () => {
    expect(await listActiveBranchIds(db, accessA)).toEqual([]);
    await grantBranchAccess(db, target, "branch-metro", actor);
    await grantBranchAccess(db, target, "branch-bl", actor);
    await grantBranchAccess(db, target, "branch-kotabumi", actor);
    expect((await listActiveBranchIds(db, accessA)).sort()).toEqual(["branch-bl", "branch-kotabumi", "branch-metro"]);
    expect(await countActiveAccessForBranch(db, companyA, "branch-metro")).toBe(1);
  });

  it("grant ganda ditolak (unique parsial pada baris ACTIVE); setelah dicabut boleh diberikan lagi dengan riwayat utuh", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    await expect(grantBranchAccess(db, target, "branch-metro", actor)).rejects.toBeInstanceOf(BranchAccessAlreadyGrantedError);
    await revokeBranchAccess(db, target, "branch-metro", actor, "pindah tugas");
    expect(await listActiveBranchIds(db, accessA)).toEqual([]);
    await grantBranchAccess(db, target, "branch-metro", actor);
    const history = await listBranchAccess(db, accessA, { includeRevoked: true });
    expect(history.map((h) => h.status).sort()).toEqual(["ACTIVE", "REVOKED"]);
    expect(history.find((h) => h.status === "REVOKED")).toMatchObject({ revokedBy: "owner-1", revokeReason: "pindah tugas" });
  });

  it("mencabut akses yang tidak ada ditolak", async () => {
    await expect(revokeBranchAccess(db, target, "branch-metro", actor, null)).rejects.toBeInstanceOf(BranchAccessNotFoundError);
  });

  it("transfer atomik: cabut asal + beri tujuan dalam satu transaksi dan satu event audit", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    await transferBranchAccess(db, target, "branch-metro", "branch-bl", actor, "mutasi");
    expect(await listActiveBranchIds(db, accessA)).toEqual(["branch-bl"]);
    const audits = await db("system_audit_log").where({ action: "user_branch.transferred" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target_user_id: userId, branch_id: "branch-bl", company_id: companyA });
    expect(JSON.parse(audits[0].before_json)).toEqual({ branchId: "branch-metro" });
    expect(JSON.parse(audits[0].after_json)).toEqual({ branchId: "branch-bl" });
  });

  it("transfer yang gagal di tengah tidak meninggalkan perubahan setengah jadi (rollback)", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    await grantBranchAccess(db, target, "branch-bl", actor);
    // tujuan sudah dimiliki -> insert gagal setelah pencabutan asal; seluruh transaksi harus dibatalkan
    await expect(transferBranchAccess(db, target, "branch-metro", "branch-bl", actor, null)).rejects.toBeInstanceOf(BranchAccessAlreadyGrantedError);
    expect((await listActiveBranchIds(db, accessA)).sort()).toEqual(["branch-bl", "branch-metro"]);
    expect(await db("system_audit_log").where({ action: "user_branch.transferred" })).toHaveLength(0);
    await expect(transferBranchAccess(db, target, "branch-metro", "branch-metro", actor, null)).rejects.toBeInstanceOf(BranchAccessAlreadyGrantedError);
  });

  it("pencabutan/transfer mereset preferensi konteks yang menunjuk cabang itu", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    await setDefaultBranch(db, target, "branch-metro", actor);
    expect((await findCompanyAccess(db, userId, companyA))!.defaultBranchId).toBe("branch-metro");
    await revokeBranchAccess(db, target, "branch-metro", actor, null);
    expect((await findCompanyAccess(db, userId, companyA))!.defaultBranchId).toBeNull();
  });

  it("ganti konteks dicatat hanya bila benar-benar berubah; bukan perubahan akses", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    expect(await setDefaultBranch(db, target, "branch-metro", actor)).toBe(true);
    expect(await setDefaultBranch(db, target, "branch-metro", actor)).toBe(false);
    expect(await db("system_audit_log").where({ action: "user_branch.active_branch_changed" })).toHaveLength(1);
    expect(await listActiveBranchIds(db, accessA)).toEqual(["branch-metro"]);
  });

  it("scope ALL <-> LIMITED diaudit; mengatur scope yang sama tidak membuat audit baru", async () => {
    await setBranchScope(db, target, "ALL", actor);
    await setBranchScope(db, target, "ALL", actor);
    await setBranchScope(db, target, "LIMITED", actor);
    const audits = await db("system_audit_log").where({ action: "user_branch.scope_changed" }).orderBy("created_at");
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[0].after_json)).toEqual({ branchScope: "ALL" });
  });

  it("DATABASE: user_branch_access tidak dapat menghubungkan user dengan perusahaan yang berbeda (trigger)", async () => {
    await expect(
      db("user_branch_access").insert({ id: crypto.randomUUID(), company_id: companyB, access_id: accessA, branch_id: "branch-x" }),
    ).rejects.toThrow(/perusahaan yang berbeda/);
    await expect(
      db("user_branch_access").insert({ id: crypto.randomUUID(), company_id: companyA, access_id: "access-tidak-ada", branch_id: "branch-x" }),
    ).rejects.toThrow();
    await grantBranchAccess(db, target, "branch-metro", actor);
    const row = await db("user_branch_access").where({ access_id: accessA }).first();
    await expect(db("user_branch_access").where({ id: row.id }).update({ company_id: companyB })).rejects.toThrow(/perusahaan yang berbeda|Identitas baris/);
    await expect(db("user_branch_access").where({ id: row.id }).update({ branch_id: "branch-lain" })).rejects.toThrow(/Identitas baris/);
  });

  it("branch_scope hanya menerima ALL atau LIMITED (CHECK)", async () => {
    await expect(db("company_access").where({ id: accessA }).update({ branch_scope: "SEMUA" })).rejects.toThrow(/CHECK/i);
  });

  it("mencabut akses perusahaan menghapus baris akses cabangnya (CASCADE) tanpa menggagalkan operasi yang sudah ada", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    await deleteCompanyAccess(db, accessA);
    expect(await db("user_branch_access").where({ access_id: accessA })).toHaveLength(0);
  });

  it("audit akses cabang memuat aktor, user sasaran, perusahaan, cabang, nilai lama/baru, dan waktu", async () => {
    await grantBranchAccess(db, target, "branch-metro", actor);
    const a = await db("system_audit_log").where({ action: "user_branch.access_granted" }).first();
    expect(a).toMatchObject({ actor_id: "owner-1", actor_label: "Owner", target_user_id: userId, company_id: companyA, branch_id: "branch-metro" });
    expect(JSON.parse(a.after_json)).toEqual({ branchId: "branch-metro", status: "ACTIVE" });
    expect(a.created_at).toBeTruthy();
    // tabel audit tetap append-only
    await expect(db("system_audit_log").where({ id: a.id }).update({ branch_id: "lain" })).rejects.toThrow(/append-only/);
  });
});
