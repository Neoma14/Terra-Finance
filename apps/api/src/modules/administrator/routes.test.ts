import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama

import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib from "knex";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { administratorRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";

/**
 * Regression (Final UAT): kunci lisensi TFO2 berisi base64url yang peka
 * huruf besar/kecil. Login Administrator dulu meng-uppercase input sebelum
 * dibandingkan dgn kunci tersimpan, sehingga TIDAK PERNAH cocok.
 */
describe("Administrator login -- pencocokan license key", () => {
  let app: FastifyInstance;
  const storedKey = "TFO2-eyJhQmNEZWZHaElqS2xNbg.c2lHbmFUdVJl";

  beforeAll(async () => {
    const db = knexLib(masterKnexfile);
    try { await db.migrate.latest(); } finally { await db.destroy(); }
    await masterDb("license").del();
    await masterDb("license").insert({ id: crypto.randomUUID(), license_key: storedKey, client_name: "PT UJI", instance_fingerprint: "x", status: "active" });
    app = Fastify();
    app.register(cookiePlugin);
    app.register(administratorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await masterDb("license").del();
    await app.close();
    await masterDb.destroy();
  });

  const login = (licenseKey: string, token: string) => app.inject({ method: "POST", url: "/api/administrator/login", payload: { licenseKey, token } });

  it("kunci yang sama persis (huruf campuran) dikenali -> penolakan berasal dari token, bukan dari kunci", async () => {
    const res = await login(storedKey, "token-bukan-dari-vendor");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Token Administrator salah");
  });

  it("spasi di sekitar kunci (copy-paste) ditoleransi", async () => {
    const res = await login(`  ${storedKey}\n`, "token-bukan-dari-vendor");
    expect(res.json().error).toBe("Token Administrator salah");
  });

  it("kunci lain, termasuk versi huruf besar semua, ditolak sbg tidak cocok", async () => {
    expect((await login(storedKey.toUpperCase(), "x")).json().error).toBe("License key tidak cocok dengan instalasi ini");
    expect((await login("TFO2-LAIN.LAIN", "x")).json().error).toBe("License key tidak cocok dengan instalasi ini");
  });

  it("token palsu tidak pernah menghasilkan sesi Administrator", async () => {
    const res = await login(storedKey, crypto.randomBytes(64).toString("base64url"));
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
