import "../company-journal/__fixtures__/legacy-db-env.js"; // harus import pertama

import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import knexLib from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { authRoutes, SESSION_COOKIE } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { hashPassword } from "./password.js";
import { createSession } from "./session-service.js";
import {
  LoginThrottle,
  LIMIT_PAIR,
  LIMIT_IP,
  THROTTLE_BLOCK_MS,
  THROTTLE_WINDOW_MS,
  loginThrottle,
} from "./login-throttle.js";
import { buildAllowedOrigins, corsOriginCallback, registerOriginGuard } from "../../lib/cors-policy.js";
import { rateCategory, registerRateLimit } from "../../lib/rate-limit-policy.js";
import { toDataUri, sniffImageKind } from "../../lib/image-upload.js";

const PASSWORD = "Correct-Horse-1";

async function migrateMaster() {
  const db = knexLib(masterKnexfile);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

async function makeUser(role: "admin" | "staff" = "staff") {
  const id = crypto.randomUUID();
  const email = `${id}@test.local`;
  await masterDb("users").insert({ id, email, password_hash: await hashPassword(PASSWORD), full_name: "U", role });
  return { id, email };
}

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(multipart);
  app.register(attachAuthUser);
  app.register(authRoutes);
  return app;
}

async function login(app: FastifyInstance, email: string, password: string, ip = "10.0.0.1") {
  return app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: ip, payload: { email, password } });
}

async function authEvents(email: string) {
  return masterDb("audit_log").where({ actor_label: email }).andWhere("action", "like", "auth.%").orderBy("created_at");
}

describe("UAT-006 login throttle (unit, jam palsu)", () => {
  it("tidak memblokir sebelum batas, memblokir di batas, bebas setelah cooldown", () => {
    let t = 1_000_000;
    const th = new LoginThrottle(() => t);
    for (let i = 0; i < LIMIT_PAIR - 1; i++) th.recordFailure("1.1.1.1", "a@x.com");
    expect(th.check("1.1.1.1", "a@x.com").blocked).toBe(false);
    th.recordFailure("1.1.1.1", "a@x.com");
    const d = th.check("1.1.1.1", "a@x.com");
    expect(d.blocked).toBe(true);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    t += THROTTLE_BLOCK_MS + 1;
    expect(th.check("1.1.1.1", "a@x.com").blocked).toBe(false);
  });

  it("identifier dinormalisasi (huruf besar/spasi/NFKC) -- tidak bisa dihindari dengan variasi tulisan", () => {
    const th = new LoginThrottle(() => 5);
    for (let i = 0; i < LIMIT_PAIR; i++) th.recordFailure("1.1.1.1", i % 2 ? " A@X.com " : "ａ@x.com");
    expect(th.check("1.1.1.1", "a@x.com").blocked).toBe(true);
  });

  it("IP lain / identifier lain tidak ikut terblokir oleh satu pasangan", () => {
    const th = new LoginThrottle(() => 5);
    for (let i = 0; i < LIMIT_PAIR; i++) th.recordFailure("1.1.1.1", "a@x.com");
    expect(th.check("2.2.2.2", "a@x.com").blocked).toBe(false);
    expect(th.check("1.1.1.1", "b@x.com").blocked).toBe(false);
  });

  it("password spraying dari satu IP ke banyak akun diblokir di level IP", () => {
    const th = new LoginThrottle(() => 5);
    for (let i = 0; i < LIMIT_IP; i++) th.recordFailure("9.9.9.9", `user${i}@x.com`);
    expect(th.check("9.9.9.9", "baru@x.com").blocked).toBe(true);
    expect(th.check("8.8.8.8", "baru@x.com").blocked).toBe(false);
  });

  it("kegagalan lama keluar dari jendela; sukses mereset pasangan", () => {
    let t = 0;
    const th = new LoginThrottle(() => t);
    for (let i = 0; i < LIMIT_PAIR - 1; i++) th.recordFailure("1.1.1.1", "a@x.com");
    t += THROTTLE_WINDOW_MS + 1;
    th.recordFailure("1.1.1.1", "a@x.com");
    expect(th.check("1.1.1.1", "a@x.com").blocked).toBe(false);
    for (let i = 0; i < LIMIT_PAIR - 2; i++) th.recordFailure("1.1.1.1", "a@x.com");
    th.recordSuccess("1.1.1.1", "a@x.com");
    th.recordFailure("1.1.1.1", "a@x.com");
    expect(th.check("1.1.1.1", "a@x.com").blocked).toBe(false);
  });

  it("instance baru (restart server) tidak membawa blokir", () => {
    const th = new LoginThrottle(() => 5);
    for (let i = 0; i < LIMIT_PAIR; i++) th.recordFailure("1.1.1.1", "a@x.com");
    expect(th.check("1.1.1.1", "a@x.com").blocked).toBe(true);
    expect(new LoginThrottle(() => 5).check("1.1.1.1", "a@x.com").blocked).toBe(false);
  });
});

describe("UAT-006/007 login HTTP + audit", { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    await migrateMaster();
    app = buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => loginThrottle.reset());

  it("login benar -> 200 + audit LOGIN_SUCCESS tanpa credential", async () => {
    const u = await makeUser();
    const res = await login(app, u.email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const ev = await authEvents(u.email);
    expect(ev.map((e) => e.action)).toEqual(["auth.login_success"]);
    const raw = JSON.stringify(ev);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toMatch(/konsultan_session|token/i);
    expect(JSON.parse(ev[0].after_json)).toMatchObject({ success: true, reason: "OK" });
  });

  it("password salah 1x -> 401 generik + audit LOGIN_FAILED, password tidak tersimpan", async () => {
    const u = await makeUser();
    const res = await login(app, u.email, "Wrong-Password-9");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Email atau password salah" });
    const ev = await authEvents(u.email);
    expect(ev.map((e) => e.action)).toEqual(["auth.login_failed"]);
    expect(JSON.stringify(ev)).not.toContain("Wrong-Password-9");
    expect(JSON.parse(ev[0].after_json)).toMatchObject({ success: false, reason: "INVALID_CREDENTIALS" });
  });

  it("user tidak ada vs password salah: response identik (tidak ada enumeration)", async () => {
    const u = await makeUser();
    const wrongPw = await login(app, u.email, "Wrong-Password-9");
    const noUser = await login(app, `nobody-${crypto.randomUUID()}@test.local`, "Wrong-Password-9");
    expect(noUser.statusCode).toBe(wrongPw.statusCode);
    expect(noUser.body).toBe(wrongPw.body);
  });

  it("password salah berulang -> 429 generik; akun valid & tidak valid diperlakukan sama; password benar pun ditolak saat diblokir", async () => {
    const u = await makeUser();
    const ghost = `ghost-${crypto.randomUUID()}@test.local`;
    for (let i = 0; i < LIMIT_PAIR; i++) {
      await login(app, u.email, "Wrong-Password-9");
      await login(app, ghost, "Wrong-Password-9");
    }
    const real = await login(app, u.email, PASSWORD);
    const none = await login(app, ghost, PASSWORD);
    expect(real.statusCode).toBe(429);
    expect(none.statusCode).toBe(429);
    expect(real.body).toBe(none.body);
    expect(real.headers["retry-after"]).toBeDefined();
    const ev = await authEvents(u.email);
    expect(ev.some((e) => JSON.parse(e.after_json).reason === "THROTTLED")).toBe(true);
  });

  it("user lain (identifier dan IP lain) tetap bisa login saat satu akun diblokir", async () => {
    const victim = await makeUser();
    const other = await makeUser();
    for (let i = 0; i < LIMIT_PAIR; i++) await login(app, victim.email, "Wrong-Password-9");
    expect((await login(app, victim.email, PASSWORD)).statusCode).toBe(429);
    expect((await login(app, other.email, PASSWORD)).statusCode).toBe(200);
    expect((await login(app, victim.email, PASSWORD, "10.0.0.77")).statusCode).toBe(200);
  });

  it("login normal (beberapa salah ketik lalu benar) tidak kena false positive dan mereset counter", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT_PAIR - 1; i++) await login(app, u.email, "Wrong-Password-9");
    expect((await login(app, u.email, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < LIMIT_PAIR - 1; i++) await login(app, u.email, "Wrong-Password-9");
    expect((await login(app, u.email, PASSWORD)).statusCode).toBe(200);
  });

  it("restart server (throttle baru) tidak mengunci akun permanen", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT_PAIR; i++) await login(app, u.email, "Wrong-Password-9");
    expect((await login(app, u.email, PASSWORD)).statusCode).toBe(429);
    loginThrottle.reset(); // setara proses baru: state hanya di memori
    expect((await login(app, u.email, PASSWORD)).statusCode).toBe(200);
  });

  it("logout -> audit LOGOUT; sesi tidak dapat dipakai lagi", async () => {
    const u = await makeUser();
    const res = await login(app, u.email, PASSWORD);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { [SESSION_COOKIE]: cookie.value } });
    expect(out.statusCode).toBe(200);
    const ev = await authEvents(u.email);
    expect(ev.map((e) => e.action)).toEqual(["auth.login_success", "auth.logout"]);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie.value } });
    expect(me.statusCode).toBe(401);
  });

  it("auto-logout idle 15 menit -> SESSION_EXPIRED tercatat tepat sekali", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id, {});
    await masterDb("sessions").where({ user_id: u.id }).update({ last_activity_at: new Date(Date.now() - 16 * 60_000).toISOString() });
    for (let i = 0; i < 3; i++) {
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: token } });
      expect(me.statusCode).toBe(401);
    }
    const ev = (await authEvents(u.email)).filter((e) => e.action === "auth.session_expired");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].after_json).reason).toBe("IDLE_TIMEOUT");
  });

  it("sesi yang masih aktif TIDAK dicatat expired", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id, {});
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: token } });
    expect(me.statusCode).toBe(200);
    expect((await authEvents(u.email)).filter((e) => e.action === "auth.session_expired")).toHaveLength(0);
  });

  it("audit_log tidak bisa diubah/dihapus (trigger database), termasuk oleh kode aplikasi", async () => {
    const u = await makeUser();
    await login(app, u.email, "Wrong-Password-9");
    await expect(masterDb("audit_log").where({ actor_label: u.email }).update({ action: "x" })).rejects.toThrow(/append-only/);
    await expect(masterDb("audit_log").where({ actor_label: u.email }).delete()).rejects.toThrow(/append-only/);
  });

  it("GET /api/auth/audit hanya untuk admin sistem; staff ditolak; tak ada endpoint tulis", async () => {
    const admin = await makeUser("admin");
    const staff = await makeUser("staff");
    const a = await createSession(admin.id, {});
    const s = await createSession(staff.id, {});
    const ok = await app.inject({ method: "GET", url: "/api/auth/audit?limit=5", cookies: { [SESSION_COOKIE]: a.token } });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json().events)).toBe(true);
    expect(JSON.stringify(ok.json())).not.toMatch(/password_hash|token_hash/);
    const no = await app.inject({ method: "GET", url: "/api/auth/audit", cookies: { [SESSION_COOKIE]: s.token } });
    expect(no.statusCode).toBe(403);
    const anon = await app.inject({ method: "GET", url: "/api/auth/audit" });
    expect(anon.statusCode).toBe(401);
    for (const method of ["DELETE", "PUT", "PATCH", "POST"] as const) {
      const w = await app.inject({ method, url: "/api/auth/audit", cookies: { [SESSION_COOKIE]: a.token } });
      expect([404, 405]).toContain(w.statusCode);
    }
  });
});

describe("UAT-008 CORS / origin", () => {
  let app: FastifyInstance;
  const allowed = buildAllowedOrigins({ nodeEnv: "production", port: 4000, extra: "https://app.example.com, * ,not a url" });

  beforeAll(async () => {
    app = Fastify();
    await app.register(cors, { origin: corsOriginCallback(allowed), credentials: true });
    registerOriginGuard(app, allowed);
    app.get("/api/data", async () => ({ secret: 1 }));
    app.post("/api/data", async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (origin?: string) =>
    app.inject({ method: "GET", url: "/api/data", headers: { host: "127.0.0.1:4000", ...(origin !== undefined ? { origin } : {}) } });

  it("tanpa Origin (same-origin/non-browser) -> 200 tanpa header CORS", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("origin app sendiri (loopback:port) dan origin terkonfigurasi -> diizinkan, dipantulkan persis (bukan *)", async () => {
    for (const o of ["http://127.0.0.1:4000", "http://localhost:4000", "https://app.example.com"]) {
      const r = await get(o);
      expect(r.statusCode).toBe(200);
      expect(r.headers["access-control-allow-origin"]).toBe(o);
      expect(r.headers["access-control-allow-credentials"]).toBe("true");
    }
  });

  it("origin sembarang, null, malformed, skema aneh, port lain -> 403 dan TANPA header CORS", async () => {
    for (const o of ["https://evil.example", "null", "not a url", "javascript:alert(1)", "file://", "http://localhost", "http://127.0.0.1", "http://localhost:9999", "https://app.example.com.evil.io"]) {
      const r = await get(o);
      expect(r.statusCode, o).toBe(403);
      expect(r.headers["access-control-allow-origin"], o).toBeUndefined();
      expect(r.body).not.toContain("secret");
    }
  });

  it("mutasi dari origin asing ditolak (tidak sampai handler)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/data", headers: { host: "127.0.0.1:4000", origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
  });

  it("wildcard di konfigurasi diabaikan; allowlist dev menyertakan 5173 hanya di non-production", () => {
    expect(allowed.has("*")).toBe(false);
    expect(allowed.has("http://localhost:5173")).toBe(false);
    expect(buildAllowedOrigins({ nodeEnv: "development", port: 4000 }).has("http://localhost:5173")).toBe(true);
  });

  it("preflight dari origin asing tidak mendapat izin", async () => {
    const r = await app.inject({
      method: "OPTIONS",
      url: "/api/data",
      headers: { host: "127.0.0.1:4000", origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("UAT-010 rate limit per kategori", () => {
  it("klasifikasi kategori", () => {
    expect(rateCategory("GET", "/")).toBe("exempt");
    expect(rateCategory("GET", "/assets/index-abc.js")).toBe("exempt");
    expect(rateCategory("GET", "/api/health")).toBe("exempt");
    expect(rateCategory("POST", "/api/auth/login")).toBe("auth");
    expect(rateCategory("GET", "/api/company-db/x/reports/trial-balance?a=1")).toBe("read");
    expect(rateCategory("POST", "/api/company-db/x/journals")).toBe("mutation");
    expect(rateCategory("POST", "/api/company-db/x/journal-import/commit")).toBe("heavy");
    expect(rateCategory("POST", "/api/company-db/x/users")).toBe("mutation");
    expect(rateCategory("POST", "/api/company-db/x/opening-balance-import/preview")).toBe("heavy");
    expect(rateCategory("GET", "/api/company-db/x/journal-import/history")).toBe("read");
  });

  it("navigasi cepat SPA (aset + ratusan GET) tidak pernah kena 429; mutasi tetap dibatasi dan tidak mengganggu baca", async () => {
    const app = Fastify();
    await registerRateLimit(app);
    app.get("/assets/a.js", async () => "js");
    app.get("/api/health", async () => ({ ok: true }));
    app.get("/api/r", async () => ({ ok: true }));
    app.post("/api/m", async () => ({ ok: true }));
    app.post("/api/auth/login", async () => ({ ok: true }));
    await app.ready();

    for (let i = 0; i < 500; i++) {
      expect((await app.inject({ method: "GET", url: "/assets/a.js" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    }
    for (let i = 0; i < 400; i++) expect((await app.inject({ method: "GET", url: "/api/r" })).statusCode).toBe(200);

    let mutation429 = 0;
    for (let i = 0; i < 130; i++) if ((await app.inject({ method: "POST", url: "/api/m" })).statusCode === 429) mutation429++;
    expect(mutation429).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/r" })).statusCode).toBe(200); // baca tidak terganggu

    let auth429 = 0;
    for (let i = 0; i < 40; i++) if ((await app.inject({ method: "POST", url: "/api/auth/login" })).statusCode === 429) auth429++;
    expect(auth429).toBeGreaterThan(0);
    const limited = await app.inject({ method: "POST", url: "/api/auth/login" });
    // server.ts setErrorHandler meneruskan `message` ini sebagai `error` ke klien.
    expect(limited.json().message).toMatch(/Terlalu banyak permintaan/);
    await app.close();
  });
});

describe("UAT-009 avatar / gambar", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16, 3)]);

  it("PNG/JPEG/WEBP valid diterima (ekstensi + MIME + magic bytes sepakat)", () => {
    expect(toDataUri(png, "image/png", "a.png")).toMatch(/^data:image\/png;base64,/);
    expect(toDataUri(jpg, "image/jpeg", "a.JPG")).toMatch(/^data:image\/jpeg;base64,/);
    expect(toDataUri(jpg, "image/jpeg", "a.jpeg")).toMatch(/^data:image\/jpeg;base64,/);
    expect(toDataUri(webp, "image/webp", "a.webp")).toMatch(/^data:image\/webp;base64,/);
    expect(sniffImageKind(png)).toBe("png");
  });

  it("SVG, HTML, JS, PHP, EXE ditolak (MIME)", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const [mime, name, buf] of [
      ["image/svg+xml", "a.svg", svg],
      ["text/html", "a.html", Buffer.from("<html><script>alert(1)</script></html>")],
      ["application/javascript", "a.js", Buffer.from("alert(1)")],
      ["application/x-php", "a.php", Buffer.from("<?php system($_GET[1]); ?>")],
      ["application/x-msdownload", "a.exe", Buffer.from("MZ\x90\x00")],
    ] as const) {
      expect(() => toDataUri(buf, mime, name), name).toThrow();
    }
  });

  it("menyamar: SVG berlabel image/png dan berekstensi .png ditolak lewat magic bytes", () => {
    expect(() => toDataUri(Buffer.from("<svg onload=alert(1)></svg>"), "image/png", "a.png")).toThrow(/bukan gambar/);
    expect(() => toDataUri(Buffer.from("<html></html>"), "image/jpeg", "a.jpg")).toThrow();
  });

  it("ekstensi tidak cocok / ganda / tanpa ekstensi ditolak", () => {
    expect(() => toDataUri(png, "image/png", "a.svg")).toThrow();
    expect(() => toDataUri(png, "image/png", "a.png.exe")).toThrow();
    expect(() => toDataUri(png, "image/png", "avatar")).toThrow();
    expect(() => toDataUri(png, "image/png", "a.jpg")).toThrow(/tidak sesuai/);
    expect(() => toDataUri(jpg, "image/png", "a.png")).toThrow(/bukan gambar/);
  });

  it("polyglot (magic bytes PNG + <script> di dalam) ditolak; ukuran > 500KB ditolak", () => {
    expect(() => toDataUri(Buffer.concat([png, Buffer.from("<script>alert(1)</script>")]), "image/png", "a.png")).toThrow(/konten aktif/);
    expect(() => toDataUri(Buffer.concat([png, Buffer.alloc(501 * 1024)]), "image/png", "a.png")).toThrow(/Ukuran/);
  });

  it("endpoint avatar: SVG ditolak 400 dan tidak tersimpan; PNG valid diterima", async () => {
    await migrateMaster();
    const app = buildApp();
    await app.ready();
    const u = await makeUser();
    const { token } = await createSession(u.id, {});

    const form = (name: string, mime: string, data: Buffer) => {
      const boundary = "----b" + crypto.randomUUID();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
    };

    const bad = form("a.svg", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    const r1 = await app.inject({ method: "POST", url: "/api/auth/me/avatar", cookies: { [SESSION_COOKIE]: token }, headers: bad.headers, payload: bad.body });
    expect(r1.statusCode).toBe(400);
    expect((await masterDb("users").where({ id: u.id }).first()).avatar_url).toBeNull();

    const good = form("a.png", "image/png", png);
    const r2 = await app.inject({ method: "POST", url: "/api/auth/me/avatar", cookies: { [SESSION_COOKIE]: token }, headers: good.headers, payload: good.body });
    expect(r2.statusCode).toBe(200);
    expect((await masterDb("users").where({ id: u.id }).first()).avatar_url).toMatch(/^data:image\/png;base64,/);
    await app.close();
  });
});
