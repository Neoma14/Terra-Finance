import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import baseKnexConfig from "./knexfile.js";
import { ensureSystemIdentity } from "./identity-bridge.js";

function freshTmpFile(): string {
  return path.join(os.tmpdir(), `terra-identity-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function openSystemDbAt(filePath: string): Knex {
  return knexLib({ ...baseKnexConfig, connection: { filename: filePath } });
}

describe("Identity Bridge (TASK-DB-ARCH-010, Option A)", () => {
  let tmpFile: string;
  let db: Knex;

  beforeEach(async () => {
    tmpFile = freshTmpFile();
    db = openSystemDbAt(tmpFile);
    await db.migrate.latest();
  });

  afterEach(async () => {
    await db.destroy();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  const legacyUser = {
    id: crypto.randomUUID(),
    email: "konsultan@test.local",
    fullName: "Konsultan Uji",
    role: "admin",
    avatarUrl: null,
  };

  it("membuat baris system_users dgn id YANG SAMA PERSIS dgn legacy user id (mapping deterministik)", async () => {
    const systemUserId = await ensureSystemIdentity(db, legacyUser);
    expect(systemUserId).toBe(legacyUser.id);

    const row = await db("system_users").where({ id: legacyUser.id }).first();
    expect(row).toBeDefined();
    expect(row.email).toBe(legacyUser.email);
    expect(row.full_name).toBe(legacyUser.fullName);
  });

  it("idempotent -- panggilan kedua tidak membuat baris duplikat / tidak error", async () => {
    await ensureSystemIdentity(db, legacyUser);
    await ensureSystemIdentity(db, legacyUser);

    const rows = await db("system_users").where({ id: legacyUser.id });
    expect(rows).toHaveLength(1);
  });

  it("sinkron ringan: email/fullName berubah di legacy -> ikut diperbarui di system_users (bukan password/role)", async () => {
    await ensureSystemIdentity(db, legacyUser);
    const changed = { ...legacyUser, email: "email-baru@test.local", fullName: "Nama Baru" };
    await ensureSystemIdentity(db, changed);

    const row = await db("system_users").where({ id: legacyUser.id }).first();
    expect(row.email).toBe("email-baru@test.local");
    expect(row.full_name).toBe("Nama Baru");
  });

  it("password_hash BUKAN hash asli yang bisa dipakai login -- system_users tidak jadi auth kedua", async () => {
    await ensureSystemIdentity(db, legacyUser);
    const row = await db("system_users").where({ id: legacyUser.id }).first();
    expect(row.password_hash).toBe("LEGACY_MANAGED_IDENTITY_NO_LOGIN");
  });

  it("dua legacy user berbeda -> dua baris system_users berbeda, id tidak tertukar", async () => {
    const userB = { ...legacyUser, id: crypto.randomUUID(), email: "lain@test.local", fullName: "User Lain" };
    const idA = await ensureSystemIdentity(db, legacyUser);
    const idB = await ensureSystemIdentity(db, userB);
    expect(idA).not.toBe(idB);
    expect(idA).toBe(legacyUser.id);
    expect(idB).toBe(userB.id);
  });
});
