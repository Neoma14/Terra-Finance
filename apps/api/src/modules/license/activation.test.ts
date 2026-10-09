import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { activateLicense, getLicenseStatus, isLicenseUsable, replaceLicense } from "./service.js";

describe("Aktivasi & status lisensi (DB)", () => {
  let db: Knex;

  beforeEach(async () => {
    db = knexLib({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    await db.schema.createTable("license", (t) => {
      t.string("id").primary();
      t.string("license_key").notNullable().unique();
      t.string("client_name").notNullable();
      t.string("instance_fingerprint").notNullable();
      t.timestamp("activated_at").notNullable().defaultTo(db.fn.now());
      t.timestamp("expires_at");
      t.string("status").notNullable().defaultTo("active");
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("tanpa lisensi: status not activated dan API bisnis tidak boleh jalan", async () => {
    const status = await getLicenseStatus(db);
    expect(status.activated).toBe(false);
    expect(await isLicenseUsable(db)).toBe(false);
  });

  it("aktivasi dengan kunci palsu/format salah ditolak dan tidak menyimpan apa pun", async () => {
    await expect(activateLicense(db, "TFO2-palsu.sig")).rejects.toThrow();
    await expect(activateLicense(db, "TFO-LAMA-XXXX-XXXX-XXXX-XXXX-DEADBEEF")).rejects.toThrow();
    expect(await db("license").count<{ c: number }[]>("* as c")).toEqual([{ c: 0 }]);
  });

  it("lisensi yang tersimpan tetapi rusak (diubah langsung di DB) -> status invalid, bukan usable", async () => {
    await db("license").insert({
      id: crypto.randomUUID(),
      license_key: "TFO2-eyJ2IjoyfQ.AAAA",
      client_name: "PT PALSU",
      instance_fingerprint: "x",
      status: "active",
    });
    const status = await getLicenseStatus(db);
    expect(status.activated).toBe(true);
    expect(status.status).toBe("invalid");
    expect(await isLicenseUsable(db)).toBe(false);
  });

  it("penggantian lisensi dengan kunci palsu ditolak dan lisensi lama tetap utuh", async () => {
    await db("license").insert({
      id: crypto.randomUUID(),
      license_key: "TFO2-LAMA.LAMA",
      client_name: "PT LAMA",
      instance_fingerprint: "x",
      status: "active",
    });
    await expect(replaceLicense(db, "TFO2-PALSU.PALSU")).rejects.toThrow();
    const rows = await db("license").select("license_key");
    expect(rows).toEqual([{ license_key: "TFO2-LAMA.LAMA" }]);
  });
});
