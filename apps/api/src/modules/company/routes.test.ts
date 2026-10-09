import "./__fixtures__/test-env.js"; // HARUS import pertama -- lihat komentar di file itu
import { TEST_COMPANY_DATA_ROOT } from "./__fixtures__/test-env.js";

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import knexLib from "knex";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { attachAuthUser } from "../../middleware/auth-guard.js";
import { companyRoutes } from "./routes.js";
import { masterDb } from "../../db/master/index.js";
import masterKnexfile from "../../db/master/knexfile.js";
import { createSession } from "../auth/session-service.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import { systemDb } from "../../db/system/index.js";
import systemKnexfile from "../../db/system/knexfile.js";
import { findCompanyRegistryBySlug } from "../../db/system/companies-registry.js";
import { provisionCompanyDb, CompanyCreationFailedError } from "../../db/company/company-provisioning.js";
import { InvalidCompanySlugError } from "../../db/system/company-db-path.js";
import { createCompanyDb } from "../../db/company/index.js";

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

async function createTestUserAndToken(label: string): Promise<{ userId: string; token: string }> {
  const userId = crypto.randomUUID();
  await masterDb("users").insert({
    id: userId,
    email: `${userId}@test.local`,
    password_hash: "not-used-in-this-test",
    full_name: label,
    role: "admin",
  });
  const { token } = await createSession(userId, {});
  return { userId, token };
}

function buildTestApp(): FastifyInstance {
  const app = Fastify();
  app.register(cookiePlugin);
  app.register(attachAuthUser);
  app.register(companyRoutes);
  return app;
}

function companyDirFor(slug: string): string {
  return path.join(TEST_COMPANY_DATA_ROOT, slug);
}

describe("Company Creation & Registry Flow (TASK-DB-ARCH-008)", () => {
  let app: FastifyInstance;
  let token: string;
  let userLabel: string;
  let userId: string;

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

  beforeEach(async () => {
    userLabel = `Konsultan ${crypto.randomUUID().slice(0, 8)}`;
    const created = await createTestUserAndToken(userLabel);
    token = created.token;
    userId = created.userId;
  });

  // ---- Authentication ----

  it("Test 1: unauthenticated request -> 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/company-db", payload: { name: "X", slug: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("Test 2: authenticated request -> allowed (201)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "PT ABC Indonesia", slug: "pt-abc-indonesia" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.slug).toBe("pt-abc-indonesia");
  });

  // ---- Slug validation ----

  it("Test 3-8: slug validation (valid/uppercase/traversal/slash/backslash/absolute)", async () => {
    const cases: Array<{ slug: string; shouldPass: boolean; label: string }> = [
      { slug: "terra-coffee-metro", shouldPass: true, label: "valid" },
      { slug: "Client-ABDI", shouldPass: false, label: "uppercase ditolak (kontrak existing: lowercase saja)" },
      { slug: "../company-a", shouldPass: false, label: "path traversal" },
      { slug: "company/a", shouldPass: false, label: "forward slash" },
      { slug: "company\\a", shouldPass: false, label: "backslash" },
      { slug: "C:\\database", shouldPass: false, label: "absolute path Windows" },
    ];

    for (const c of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/api/company-db",
        cookies: { [SESSION_COOKIE]: token },
        payload: { name: `Test ${c.label}`, slug: c.slug },
      });
      if (c.shouldPass) {
        expect(res.statusCode, c.label).toBe(201);
      } else {
        expect(res.statusCode, c.label).toBe(400);
        expect(res.json().code, c.label).toBe("COMPANY_SLUG_INVALID");
      }
    }
  });

  // ---- Registry, filesystem, migration, profile (happy path, satu panggilan,
  // beberapa assertion -- menghindari membuat company berulang-ulang utk hal
  // yang sama) ----

  it("Test 9,13,14,17,18,19,20: registry dibuat, folder+company.db+attachments dibuat, C0001-C0012 jalan, profile terisi, DB dapat dibuka lagi", async () => {
    const slug = "cv-maju-bersama";
    const res = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: {
        name: "CV Maju Bersama",
        slug,
        address: "Jl. Contoh No. 1",
        phone: "0812xxxxxxx",
        email: "info@majubersama.test",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();

    // Registry (System DB)
    const registryRow = await findCompanyRegistryBySlug(systemDb, slug);
    expect(registryRow).toBeDefined();
    expect(registryRow!.status).toBe("active");
    expect(registryRow!.lastMigrationStatus).toBe("READY");
    expect(registryRow!.schemaVersion).toBeGreaterThan(0);
    expect(registryRow!.databasePath).toContain(slug);

    // Filesystem
    const companyDir = companyDirFor(slug);
    expect(fs.existsSync(companyDir)).toBe(true);
    expect(fs.existsSync(path.join(companyDir, "company.db"))).toBe(true);
    expect(fs.existsSync(path.join(companyDir, "attachments"))).toBe(true);

    // Migration + tables + company DB bisa dibuka lagi via jalur resmi
    const db = createCompanyDb(path.join(companyDir, "company.db"));
    try {
      const tables = await db("sqlite_master").where({ type: "table" }).select("name");
      const names = new Set(tables.map((t: any) => t.name));
      for (const t of [
        "company_profile",
        "account_types",
        "accounts",
        "periods",
        "counterparties",
        "statement_lines",
        "statement_line_accounts",
        "journal_entries",
        "journal_entry_lines",
        "trial_balance_snapshots",
        "tax_reference_settings",
        "company_audit_log",
      ]) {
        expect(names.has(t), `table ${t} missing`).toBe(true);
      }

      const profile = await db("company_profile").first();
      expect(profile.name).toBe("CV Maju Bersama");
      expect(profile.address).toBe("Jl. Contoh No. 1");
      expect(profile.phone).toBe("0812xxxxxxx");
      expect(profile.email).toBe("info@majubersama.test");
      expect(profile.currency).toBe("IDR"); // default, tidak dikirim di payload -- bukan karangan
      expect(profile.industry_template).toBe("general"); // default
    } finally {
      await db.destroy();
    }

    // system_audit_log mencatat event, actor dari session (bukan dari body)
    const audit = await systemDb("system_audit_log").where({ action: "company.register", entity_id: body.companyId }).first();
    expect(audit).toBeDefined();
    expect(audit.actor_label).toBe(userLabel);
  });

  // ---- Duplicate protection ----

  it("Test 10: duplicate slug ditolak", async () => {
    const slug = "pt-xyz-duplicate";
    const first = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "PT XYZ", slug },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "PT XYZ Lagi", slug },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("COMPANY_ALREADY_EXISTS");
  });

  it("Test 11,16: folder sudah ada tapi registry belum ada -> ditolak, TIDAK diam-diam ditimpa", async () => {
    const slug = "folder-tanpa-registry";
    fs.mkdirSync(companyDirFor(slug), { recursive: true });
    fs.writeFileSync(path.join(companyDirFor(slug), "marker.txt"), "data lama yang tidak boleh hilang");

    const res = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "Percobaan Overwrite", slug },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("COMPANY_DIRECTORY_EXISTS");

    // Folder & marker lama TIDAK terhapus/tertimpa.
    expect(fs.existsSync(path.join(companyDirFor(slug), "marker.txt"))).toBe(true);
    const registryRow = await findCompanyRegistryBySlug(systemDb, slug);
    expect(registryRow).toBeUndefined();
  });

  it("Test 12: registry TIDAK dibuat ketika provisioning gagal (directory-exists case)", async () => {
    const slug = "gagal-provisioning";
    fs.mkdirSync(companyDirFor(slug), { recursive: true });

    await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "Gagal", slug },
    });

    const registryRow = await findCompanyRegistryBySlug(systemDb, slug);
    expect(registryRow).toBeUndefined();
  });

  it("Test 23,25: simulasi kegagalan SETELAH company.db+migration berhasil -> folder dibersihkan, tidak ada state parsial", async () => {
    // provisionCompanyDb dipanggil LANGSUNG (bukan lewat HTTP) dgn
    // `name: null` yang melanggar NOT NULL `company_profile.name` --
    // memaksa kegagalan tepat SETELAH migration sukses (folder+company.db
    // sudah dibuat), menguji code path cleanup yang SAMA PERSIS dgn
    // skenario migration gagal (lihat komentar di company-provisioning.ts:
    // cleanupAndThrow dipanggil utk SEMUA kegagalan pasca-mkdir, bukan
    // hanya migration). Ini BUKAN simulasi migration-file-corrupt (tidak
    // praktis tanpa mengubah migration C0001-C0012, dilarang §22) --
    // dilaporkan transparan sbg keterbatasan di Final Report bagian Q.
    const slug = "simulasi-gagal-insert-profile";
    await expect(
      provisionCompanyDb({
        dataRoot: TEST_COMPANY_DATA_ROOT,
        slug,
        profile: { name: null as unknown as string },
      }),
    ).rejects.toThrow(CompanyCreationFailedError);

    expect(fs.existsSync(companyDirFor(slug))).toBe(false); // folder dibersihkan total
    const registryRow = await findCompanyRegistryBySlug(systemDb, slug);
    expect(registryRow).toBeUndefined();
  });

  // ---- Isolation ----

  it("Test 21,22: company isolation -- company lain & legacy DB tidak terpengaruh", async () => {
    const legacyUsersBefore = await masterDb("users").count("* as c").first();

    const resA = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "Company Isolation A", slug: "isolation-a" },
    });
    const resB = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "Company Isolation B", slug: "isolation-b" },
    });
    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);

    expect(fs.existsSync(companyDirFor("isolation-a"))).toBe(true);
    expect(fs.existsSync(companyDirFor("isolation-b"))).toBe(true);
    const regA = await findCompanyRegistryBySlug(systemDb, "isolation-a");
    const regB = await findCompanyRegistryBySlug(systemDb, "isolation-b");
    expect(regA!.databasePath).not.toBe(regB!.databasePath);

    // Legacy DB (users/sessions, file temp yg merepresentasikan
    // terra-finance.sqlite dlm test ini) tidak bertambah baris SELAIN dari
    // user test yang SENGAJA dibuat beforeEach -- company creation sendiri
    // tidak pernah menulis ke masterDb.
    const legacyUsersAfter = await masterDb("users").count("* as c").first();
    expect(Number((legacyUsersAfter as any).c)).toBe(Number((legacyUsersBefore as any).c) + 0); // tidak berubah krn company creation
  });

  // ---- Security ----

  it("Test 26,27,28: request tidak bisa kontrol path/actor, respons tidak membocorkan detail internal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: {
        name: "Security Test",
        slug: "security-test-co",
        createdBy: "orang-lain-dipaksakan", // field TIDAK ADA di schema -- harus diabaikan
        actorId: "actor-palsu", // idem
        databasePath: "C:\\lokasi\\paksa\\company.db", // idem -- path TIDAK bisa dikontrol client
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();

    const registryRow = await findCompanyRegistryBySlug(systemDb, "security-test-co");
    // TASK-DB-ARCH-010: created_by SEKARANG terisi lewat identity bridge
    // (system_users.id == legacy session user.id) -- BUKAN lagi NULL
    // (gap TASK-008/009 resolved), DAN BUKAN "orang-lain-dipaksakan" dari body.
    expect(registryRow!.createdBy).toBe(userId);
    expect(registryRow!.createdBy).not.toBe("orang-lain-dipaksakan");
    expect(registryRow!.databasePath).toContain("security-test-co");
    expect(registryRow!.databasePath).not.toBe("C:\\lokasi\\paksa\\company.db");

    const audit = await systemDb("system_audit_log").where({ entity_id: body.companyId }).first();
    expect(audit.actor_label).toBe(userLabel); // actor dari session, bukan dari body

    // Error response (uji lewat kasus 409 duplicate) tidak boleh memuat
    // absolute path temp data root.
    const dup = await app.inject({
      method: "POST",
      url: "/api/company-db",
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: "Security Test 2", slug: "security-test-co" },
    });
    expect(dup.payload).not.toContain(TEST_COMPANY_DATA_ROOT);
    expect(dup.payload).not.toMatch(/sqlite|insert into|select .* from/i);
  });

  it("InvalidCompanySlugError ter-ekspor benar (sanity import check)", () => {
    expect(InvalidCompanySlugError).toBeDefined();
  });
});
