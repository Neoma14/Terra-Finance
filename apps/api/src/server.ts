import fs from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { buildAllowedOrigins, corsOriginCallback, registerOriginGuard } from "./lib/cors-policy.js";
import { registerRateLimit } from "./lib/rate-limit-policy.js";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyError } from "fastify";
import knexLib from "knex";
import { env } from "./config/env.js";
import knexConfig from "./db/master/knexfile.js";
import systemKnexConfig from "./db/system/knexfile.js";
import { attachAuthUser } from "./middleware/auth-guard.js";
import { toUserErrorMessage } from "./lib/error-message.js";
import { migrateLegacyCompaniesToNewArchitecture } from "./db/system/legacy-company-migration.js";
import { upgradeExistingCompanyDatabases } from "./db/company/company-upgrade.js";
import { masterDb } from "./db/master/index.js";
import { isLicenseUsable } from "./modules/license/service.js";
import { authRoutes } from "./modules/auth/routes.js";
import { setupRoutes } from "./modules/setup/routes.js";
import { licenseRoutes } from "./modules/license/routes.js";
import { administratorRoutes } from "./modules/administrator/routes.js";
import { usersRoutes } from "./modules/users/routes.js";
import { companiesRoutes } from "./modules/companies/routes.js";
import { accountsRoutes } from "./modules/accounts/routes.js";
import { periodsRoutes } from "./modules/periods/routes.js";
import { journalRoutes } from "./modules/journal/routes.js";
import { ledgerRoutes } from "./modules/ledger/routes.js";
import { counterpartyRoutes } from "./modules/counterparties/routes.js";
import { statementRoutes } from "./modules/statements/routes.js";
import { ratioRoutes } from "./modules/ratios/routes.js";
import { taxRoutes } from "./modules/tax/routes.js";
import { benchmarkRoutes } from "./modules/benchmark/routes.js";
import { companyJournalRoutes } from "./modules/company-journal/routes.js";
import { companyRoutes } from "./modules/company/routes.js";
import { companyAccessRoutes } from "./modules/company-access/routes.js";
import { companyAccountsRoutes } from "./modules/company-accounts/routes.js";
import { companyLedgerRoutes } from "./modules/company-ledger/routes.js";
import { companySearchRoutes } from "./modules/company-search/routes.js";
import { companyPeriodsRoutes } from "./modules/company-periods/routes.js";
import { companyReportsRoutes } from "./modules/company-reports/routes.js";
import { companyDashboardRoutes } from "./modules/company-dashboard/routes.js";
import { companyProfileRoutes } from "./modules/company-profile/routes.js";
import { companyAnalysisRoutes } from "./modules/company-analysis/routes.js";
import { companyCounterpartiesRoutes } from "./modules/company-counterparties/routes.js";
import { companyTaxRoutes } from "./modules/company-tax/routes.js";
import { companyProjectionRoutes } from "./modules/company-projection/routes.js";
import { companyAuditLogRoutes } from "./modules/company-audit-log/routes.js";
import { companyJournalImportRoutes } from "./modules/company-journal-import/routes.js";
import { companyAccountsImportRoutes } from "./modules/company-accounts-import/routes.js";
import { companyOpeningBalanceRoutes } from "./modules/company-opening-balance/routes.js";
import { companyOpeningBalanceImportRoutes } from "./modules/company-opening-balance-import/routes.js";
import { companyBranchesRoutes } from "./modules/company-branches/routes.js";
import { companyInterBranchRoutes } from "./modules/company-inter-branch/routes.js";
import { companyAuthorizationRoutes } from "./modules/company-authorization/routes.js";

/**
 * Jalankan migrasi Knex otomatis SETIAP kali server start -- ini yang
 * membuat update aplikasi (ganti versi installer, dapat migrasi skema
 * baru) tidak butuh langkah manual dari klien ("migrate.latest()" idempotent,
 * no-op kalau sudah paling baru). Pakai koneksi SEMENTARA terpisah dari
 * `masterDb` (bukan `masterDb.migrate.latest()` langsung) karena
 * `knexConfig` di sini murni untuk migrasi (tanpa `pool.afterCreate` utk
 * PRAGMA foreign_keys, yang justru bisa mengganggu proses ALTER TABLE
 * migrasi tertentu di SQLite) -- ditutup lagi setelah selesai.
 */
async function runMigrations(): Promise<void> {
  const migrationDb = knexLib(knexConfig);
  try {
    await migrationDb.migrate.latest();
  } finally {
    await migrationDb.destroy();
  }
}

/** Padanan `runMigrations()` di atas, utk System DB (`terra-system.sqlite`,
 * ADR-001) -- TERPISAH total dari masterDb/terra-finance.sqlite. Baru
 * dibutuhkan nyata sejak TASK-DB-ARCH-008 (companies_registry sekarang
 * punya consumer, `modules/company/routes.ts`). Tidak mengubah
 * runMigrations()/pemilihan database manapun di atas. */
async function runSystemMigrations(): Promise<void> {
  const migrationDb = knexLib(systemKnexConfig);
  try {
    // Salinan pengaman SEBELUM migrasi System DB yang tertunda (mis. S0011 Multi-Branch): satu salinan
    // per migration pertama yang tertunda, tidak menimpa salinan yang sudah ada.
    const [, pending] = await migrationDb.migrate.list();
    if (pending.length > 0) {
      const dbFile = (systemKnexConfig.connection as { filename?: string } | undefined)?.filename;
      if (dbFile && fs.existsSync(dbFile)) {
        const first = String((pending[0] as { file?: string; name?: string }).file ?? (pending[0] as { name?: string }).name ?? "unknown");
        const backup = `${dbFile}.pre-${first.split("_")[0]}`;
        if (!fs.existsSync(backup)) fs.copyFileSync(dbFile, backup);
      }
    }
    await migrationDb.migrate.latest();
  } finally {
    await migrationDb.destroy();
  }
}

export async function startServer(): Promise<{ port: number }> {
  await runMigrations();
  await runSystemMigrations();

  // TASK-020: migrasi SATU KALI (idempoten) company lama (masterDb,
  // TANPA kontrol akses per-user) ke arsitektur baru (company_access
  // per-role) -- lihat komentar lengkap di legacy-company-migration.ts.
  // WAJIB di sini (bukan dipanggil manual sekali oleh developer) supaya
  // SETIAP instalasi klien yang update ke versi ini otomatis bermigrasi,
  // termasuk yang sudah py company lama dari versi sebelumnya.
  await migrateLegacyCompaniesToNewArchitecture();
  await upgradeExistingCompanyDatabases();

  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : true,
  });

  // BUG NYATA (ditemukan via laporan klien sungguhan, import jurnal 3813
  // transaksi): SEMUA 10 route upload file di aplikasi ini (`request.file()`
  // + `file.toBuffer()`, lihat grep "file.toBuffer()") memanggilnya DI LUAR
  // try/catch lokal -- kalau file melebihi limit (`multipart.limits.fileSize`
  // di bawah) atau Busboy/multipart error lain, exception itu TIDAK PERNAH
  // ditangkap route handler, lolos ke default error handler Fastify, dan
  // user melihat JSON mentah teknis apa adanya ("Payload Too Large",
  // "FST_REQ_FILE_TOO_LARGE") -- bukan pesan berbahasa Indonesia yang bisa
  // dipahami, persis spirit `toUserErrorMessage` (lib/error-message.ts) yang
  // SUDAH ada utk kasus serupa di jalur lain. Diperbaiki PUSAT di sini
  // (satu error handler global) drpd menambal 10 lokasi satu-satu -- rute
  // baru yg upload file di masa depan otomatis ikut terlindungi.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);

    if (error.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({
        error: "File yang diupload terlalu besar (maksimal 100MB). Coba pecah jadi beberapa file lebih kecil.",
      });
    }
    if (error.statusCode && error.statusCode < 500) {
      // Error 4xx bawaan Fastify/plugin (body/JSON malformed, dll) --
      // `error.message`-nya sendiri sudah pesan pendek standar library,
      // BUKAN dump SQL/stack trace, jadi aman diteruskan apa adanya.
      return reply.code(error.statusCode).send({ error: error.message });
    }
    return reply.code(500).send({ error: toUserErrorMessage(error) });
  });

  // UAT-008: tidak ada refleksi origin. SPA produksi same-origin tidak butuh
  // CORS; allowlist = loopback (port app, + 5173 di dev) + CORS_ALLOWED_ORIGINS.
  const allowedOrigins = buildAllowedOrigins({ nodeEnv: env.NODE_ENV, port: env.PORT, extra: env.CORS_ALLOWED_ORIGINS });
  await app.register(cors, {
    origin: corsOriginCallback(allowedOrigins),
    credentials: true,
  });
  registerOriginGuard(app, allowedOrigins);
  await app.register(cookie);
  // 20MB (nilai lama) TERBUKTI TIDAK CUKUP lewat laporan klien nyata: file
  // import jurnal 3813 transaksi ditolak "Payload Too Large". Dinaikkan ke
  // 100MB -- app ini jalan OFFLINE di mesin klien sendiri (bukan server
  // publik yg menerima upload dari banyak user tak dikenal), jadi tidak ada
  // concern DoS/bandwidth dari menaikkan limit ini; margin besar dipilih
  // supaya tidak perlu disentuh lagi utk file akuntansi tahunan yg wajar
  // besarnya.
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await registerRateLimit(app);

  // Penegakan lisensi: tanpa lisensi valid (tanda tangan, belum expired,
  // terikat ke mesin ini), seluruh API bisnis ditolak. Rute setup, lisensi,
  // login, Administrator, dan health tetap bisa diakses supaya instalasi
  // bisa diaktivasi/diganti lisensinya.
  const LICENSE_EXEMPT = ["/api/health", "/api/license", "/api/setup", "/api/auth", "/api/administrator"];
  app.addHook("onRequest", async (request, reply) => {
    const url = request.raw.url ?? "";
    if (!url.startsWith("/api/")) return;
    if (LICENSE_EXEMPT.some((p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"))) return;
    if (await isLicenseUsable(masterDb)) return;
    return reply.code(403).send({
      error: "Lisensi TERRA FINANCE belum aktif atau sudah tidak berlaku. Hubungi Terra Teknologi Digital.",
      code: "LICENSE_INVALID",
    });
  });

  await app.register(attachAuthUser);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(licenseRoutes);
  await app.register(administratorRoutes);
  await app.register(usersRoutes);
  await app.register(companiesRoutes);
  await app.register(accountsRoutes);
  await app.register(periodsRoutes);
  await app.register(journalRoutes);
  await app.register(ledgerRoutes);
  await app.register(counterpartyRoutes);
  await app.register(statementRoutes);
  await app.register(ratioRoutes);
  await app.register(taxRoutes);
  await app.register(benchmarkRoutes);
  // TASK-DB-ARCH-007 -- API Company DB (company.db per-perusahaan, ADR-001),
  // BERBEDA dari seluruh route di atas yang masih memakai `masterDb`
  // (terra-finance.sqlite shared-DB lama). Pendaftaran plugin SAJA; tidak
  // mengubah runMigrations()/database selection apa pun di atas.
  await app.register(companyJournalRoutes);
  // TASK-DB-ARCH-008 -- company creation & companies_registry (System DB).
  await app.register(companyRoutes);
  // TASK-DB-ARCH-011 Part A -- company access management (grant/role/suspend/revoke).
  await app.register(companyAccessRoutes);
  // TASK-DB-ARCH-011 Part B -- accounting core API (COA, ledger, trial balance, period lifecycle).
  await app.register(companyAccountsRoutes);
  await app.register(companyLedgerRoutes);
  await app.register(companySearchRoutes);
  await app.register(companyPeriodsRoutes);
  await app.register(companyReportsRoutes);
  await app.register(companyDashboardRoutes);
  await app.register(companyProfileRoutes);
  await app.register(companyAnalysisRoutes);
  await app.register(companyCounterpartiesRoutes);
  await app.register(companyTaxRoutes);
  await app.register(companyProjectionRoutes);
  await app.register(companyAuditLogRoutes);
  await app.register(companyJournalImportRoutes);
  await app.register(companyAccountsImportRoutes);
  await app.register(companyOpeningBalanceRoutes);
  await app.register(companyOpeningBalanceImportRoutes);
  await app.register(companyBranchesRoutes);
  await app.register(companyAuthorizationRoutes);
  await app.register(companyInterBranchRoutes);

  app.get("/api/health", async () => ({ ok: true }));

  // Di produksi (dibungkus Electron), server ini JUGA menyajikan frontend
  // React yang sudah di-build -- satu proses, satu origin, tidak perlu
  // Vite dev server terpisah. `STATIC_WEB_DIR` diisi main.js Electron
  // menunjuk ke `apps/web/dist`; kalau kosong (mis. saat `pnpm dev` biasa
  // tanpa Electron), lewati -- frontend dilayani Vite dev server sendiri
  // di port lain (lihat vite.config.ts proxy `/api`).
  if (env.STATIC_WEB_DIR) {
    await app.register(staticPlugin, { root: env.STATIC_WEB_DIR });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api")) {
        return reply.code(404).send({ error: "Not Found" });
      }
      return reply.sendFile("index.html");
    });
  }

  // 127.0.0.1 SAJA (bukan 0.0.0.0 spt versi online) -- server ini utamanya
  // dipakai oleh renderer Electron di mesin yang sama; kalau nanti mode
  // "beberapa terminal via LAN" diaktifkan, host binding ini yang perlu
  // diubah (di luar cakupan fondasi ini, lihat plan).
  await app.listen({ port: env.PORT, host: "127.0.0.1" });
  return { port: env.PORT };
}

// server.ts SELALU dijalankan sbg entry point langsung (`pnpm dev`,
// `node dist/server.js`, atau child process yang di-spawn main.js
// Electron) -- tidak pernah di-import sbg modul biasa dari kode lain di
// project ini, jadi start langsung di sini, tanpa perlu deteksi
// require.main/import.meta rumit yang gampang salah di Windows.
startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
