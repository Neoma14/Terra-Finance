import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama

import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib, { type Knex } from "knex";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { daysUntilExpiry, getLicenseStatus, inspectLicense, replaceLicense } from "./service.js";
import { computeInstanceFingerprint } from "./fingerprint.js";
import { licenseRoutes } from "./routes.js";
import { attachAuthUser } from "../../middleware/auth-guard.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";

/**
 * Perpanjang lisensi dari dalam aplikasi: sisa hari, pemeriksaan kunci tanpa
 * menyimpan, penggantian atomik. Kunci diterbitkan dengan keypair UJI (bukan
 * private key vendor); service menerima publicKey opsional untuk itu.
 */
const kp = crypto.generateKeyPairSync("ed25519");
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function issue(client: string, expiry: string | null, devices = 1): string {
  const payload = { v: 2, lid: "TFL-" + crypto.randomBytes(8).toString("hex").toUpperCase(), client, product: "TERRA FINANCE", expiry, devices, issued: new Date().toISOString() };
  const p = b64(JSON.stringify(payload));
  return `TFO2-${p}.${b64(crypto.sign(null, Buffer.from(p, "utf8"), kp.privateKey))}`;
}
const dayStr = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * 86_400_000).toISOString().slice(0, 10);
const NOW = Date.parse("2026-10-06T10:00:00Z");
const opts = { publicKey: kp.publicKey, now: NOW };

describe("daysUntilExpiry", () => {
  it("Lifetime = null; hari ini = 0; besok = 1; kemarin negatif", () => {
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry("2026-10-06", NOW)).toBe(0); // berakhir 23:59 UTC hari ini
    expect(daysUntilExpiry("2026-10-07", NOW)).toBe(1);
    expect(daysUntilExpiry("2026-11-05", NOW)).toBe(30);
    expect(daysUntilExpiry("2026-10-05", NOW)).toBeLessThan(0);
    expect(daysUntilExpiry("2026-10-06", Date.parse("2026-10-07T00:00:01Z"))).toBe(-1);
  });
});

describe("Perpanjang lisensi (service)", () => {
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
  const install = (key: string, client: string) =>
    db("license").insert({ id: crypto.randomUUID(), license_key: key, client_name: client, instance_fingerprint: computeInstanceFingerprint(), status: "active" });

  it("status membawa daysRemaining: aktif 20 hari, berakhir hari ini, expired, lifetime", async () => {
    await install(issue("PT A", "2026-10-26"), "PT A");
    let st = await getLicenseStatus(db, opts);
    expect(st.status).toBe("active");
    expect(st.daysRemaining).toBe(20);

    await db("license").del();
    await install(issue("PT A", "2026-10-06"), "PT A");
    st = await getLicenseStatus(db, opts);
    expect(st.status).toBe("active");
    expect(st.daysRemaining).toBe(0);

    await db("license").del();
    await install(issue("PT A", "2026-09-30"), "PT A");
    st = await getLicenseStatus(db, opts);
    expect(st.status).toBe("expired");
    expect(st.daysRemaining).toBeLessThan(0);

    await db("license").del();
    await install(issue("PT A", null), "PT A");
    st = await getLicenseStatus(db, opts);
    expect(st.status).toBe("active");
    expect(st.daysRemaining).toBeNull();
  });

  it("inspect: kunci valid menampilkan isi, tanpa menyimpan apa pun", async () => {
    await install(issue("PT ABDI WARDHANA", "2026-09-30"), "PT ABDI WARDHANA");
    const before = await db("license").select();
    const r = await inspectLicense(db, issue("pt  abdi   wardhana", "2027-10-06", 2), opts);
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.payload.expiry).toBe("2027-10-06");
    expect(r.payload.devices).toBe(2);
    expect(r.sameClient).toBe(true); // beda huruf besar/kecil & spasi ganda tidak dianggap beda
    expect(r.expired).toBe(false);
    expect(r.shorterThanCurrent).toBe(false);
    expect(r.daysRemaining).toBe(365);
    expect(await db("license").select()).toEqual(before);
  });

  it("inspect: klien berbeda, lebih singkat dari lisensi terpasang, sudah expired", async () => {
    await install(issue("PT A", null), "PT A");
    const other = await inspectLicense(db, issue("PT B", "2027-01-01"), opts);
    expect(other.valid && other.sameClient).toBe(false);
    expect(other.valid && other.shorterThanCurrent).toBe(true); // Lifetime -> bertanggal
    const old = await inspectLicense(db, issue("PT A", "2026-01-01"), opts);
    expect(old.valid && old.expired).toBe(true);
  });

  it("inspect: kunci palsu/diubah/sampah -> valid:false dengan alasan", async () => {
    const good = issue("PT A", null);
    const [head, sig] = good.split(".");
    const tampered = JSON.parse(Buffer.from(head.slice(5), "base64url").toString("utf8"));
    tampered.expiry = "2099-01-01";
    for (const bad of ["", "sampah", "TFO2-palsu.palsu", `TFO2-${b64(JSON.stringify(tampered))}.${sig}`]) {
      const r = await inspectLicense(db, bad, opts);
      expect(r.valid).toBe(false);
    }
    const foreign = crypto.generateKeyPairSync("ed25519");
    expect((await inspectLicense(db, good, { publicKey: foreign.publicKey, now: NOW })).valid).toBe(false);
  });

  it("perpanjangan: lisensi expired diganti kunci baru -> status active, data lisensi lama terganti", async () => {
    await install(issue("PT A", "2026-09-30"), "PT A");
    expect((await getLicenseStatus(db, opts)).status).toBe("expired");
    const payload = await replaceLicense(db, issue("PT A", "2027-10-06"), opts);
    expect(payload.expiry).toBe("2027-10-06");
    const st = await getLicenseStatus(db, opts);
    expect(st.status).toBe("active");
    expect(st.daysRemaining).toBe(365);
    expect(await db("license").count<{ c: number }[]>("* as c")).toEqual([{ c: 1 }]);
  });

  it("penggantian ditolak (palsu / sudah expired) -> lisensi lama TETAP utuh", async () => {
    const current = issue("PT A", "2026-12-31");
    await install(current, "PT A");
    await expect(replaceLicense(db, "TFO2-palsu.palsu", opts)).rejects.toThrow();
    await expect(replaceLicense(db, issue("PT A", "2026-01-01"), opts)).rejects.toThrow(/sudah berakhir/);
    const rows = await db("license").select("license_key");
    expect(rows).toEqual([{ license_key: current }]);
  });

  it("penggantian atomik: gagal menyimpan -> lisensi lama tidak hilang", async () => {
    const current = issue("PT A", "2026-12-31");
    await install(current, "PT A");
    // Paksa insert gagal: kolom client_name NOT NULL tidak bisa dilanggar via service, jadi pakai kunci yang sama
    // (license_key UNIQUE). Jika delete sudah terjadi di luar transaksi, lisensi lama hilang; di dalam transaksi tidak.
    await db.raw("create trigger fail_insert before insert on license begin select raise(abort, 'gagal'); end");
    await expect(replaceLicense(db, issue("PT A", "2027-01-01"), opts)).rejects.toThrow();
    expect(await db("license").select("license_key")).toEqual([{ license_key: current }]);
  });
});

describe("Perpanjang lisensi (HTTP): hanya admin", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const m = knexLib(masterKnexfile);
    await m.migrate.latest();
    await m.destroy();
    app = Fastify();
    app.register(cookiePlugin);
    app.register(attachAuthUser);
    app.register(licenseRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  async function user(role: "admin" | "staff") {
    const id = crypto.randomUUID();
    await masterDb("users").insert({ id, email: `${id}@t.local`, password_hash: "x", full_name: "U", role });
    return (await createSession(id, {})).token;
  }

  it("anonim 401, staff 403, admin bisa memeriksa; kunci tidak valid -> valid:false", async () => {
    const adminToken = await user("admin");
    const staffToken = await user("staff");
    const body = { licenseKey: "TFO2-palsu.palsu" };
    expect((await app.inject({ method: "POST", url: "/api/license/inspect", payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/license/inspect", payload: body, cookies: { [SESSION_COOKIE]: staffToken } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/license/inspect", payload: body, cookies: { [SESSION_COOKIE]: adminToken } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().inspection.valid).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/license/inspect", payload: {}, cookies: { [SESSION_COOKIE]: adminToken } })).statusCode).toBe(400);
  });

  it("replace: anonim 401, staff 403, kunci palsu 400; status publik memuat daysRemaining", async () => {
    const staffToken = await user("staff");
    const adminToken = await user("admin");
    const body = { licenseKey: "TFO2-palsu.palsu" };
    expect((await app.inject({ method: "POST", url: "/api/license/replace", payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/license/replace", payload: body, cookies: { [SESSION_COOKIE]: staffToken } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/license/replace", payload: body, cookies: { [SESSION_COOKIE]: adminToken } })).statusCode).toBe(400);
    const st = await app.inject({ method: "GET", url: "/api/license/status" });
    expect(st.statusCode).toBe(200);
    expect(st.json().license).toHaveProperty("daysRemaining");
  });
});
