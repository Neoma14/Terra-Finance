import "dotenv/config";
import { z } from "zod";

const DEV_SESSION_SECRET_DEFAULT = "terra-finance-offline-default-session-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  // Wajib >=32 karakter tapi PUNYA DEFAULT (beda dari versi online) --
  // instalasi offline harus tetap bisa jalan tanpa developer sempat setup
  // .env manual di komputer klien; nilai acak per-instalasi idealnya
  // di-generate oleh main.js Electron saat first-run & disimpan di
  // userData, bukan dipakai default ini di produksi.
  SESSION_SECRET: z
    .string()
    .min(32)
    .default(DEV_SESSION_SECRET_DEFAULT),
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Lokasi file database SQLite -- diisi oleh main.js Electron (userData
  // path per-OS), fallback ke folder lokal ./data saat dijalankan sbg
  // proses biasa (dev server tanpa Electron).
  DB_FILE_PATH: z.string().optional(),
  // Lokasi file System Database (ADR-001, lihat db/system/index.ts) --
  // TERPISAH dari DB_FILE_PATH (yang masih menunjuk ke terra-finance.sqlite
  // shared-DB lama, dipertahankan apa adanya sampai Company DB foundation
  // selesai & migrasi data existing dijalankan). main.js BELUM diubah utk
  // mengisi variabel ini (foundation-only task, lihat TASK-DB-ARCH-002) --
  // fallback ke folder lokal ./data saat dijalankan tanpa Electron.
  SYSTEM_DB_FILE_PATH: z.string().optional(),
  // Root folder tempat seluruh company.db berada (Data/<slug>/company.db,
  // ADR-001) -- dibaca db/company/company-resolver.ts. Belum diisi main.js
  // Electron (TASK-DB-ARCH-007 masih foundation/API-only, bukan production
  // cutover) -- fallback ke folder lokal ./data/companies saat dev/test.
  COMPANY_DATA_ROOT: z.string().optional(),
  // Diisi main.js Electron di produksi, menunjuk ke folder `apps/web/dist`
  // yang sudah di-build -- server ini lalu JUGA menyajikan frontend-nya
  // sendiri (satu proses, satu origin). Kosong = frontend dilayani Vite
  // dev server terpisah (`pnpm dev`, lihat vite.config.ts).
  STATIC_WEB_DIR: z.string().optional(),
  // Daftar origin tambahan yang boleh memanggil API (dipisah koma), mis. saat
  // API dibuka lewat LAN. Kosong = hanya loopback. Wildcard "*" diabaikan.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export const env = envSchema.parse(process.env);

// Produksi (Electron) WAJIB memakai SESSION_SECRET acak per-instalasi dari
// main.js -- default publik di source tidak boleh dipakai untuk menandatangani sesi.
if (env.NODE_ENV === "production" && env.SESSION_SECRET === DEV_SESSION_SECRET_DEFAULT) {
  throw new Error("SESSION_SECRET produksi tidak boleh memakai nilai default. Set secret per-instalasi.");
}
export type Env = typeof env;
