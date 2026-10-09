import fs from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Regression (tes instalasi nyata): di produksi folder instalasi (Program
 * Files) tidak boleh ditulis. knexfile company dulu selalu membuat folder
 * default dev saat di-import sehingga server API mati (EPERM) saat start.
 */
describe("company knexfile -- tidak menulis ke folder instalasi di produksi", () => {
  const original = { env: process.env.NODE_ENV, path: process.env.COMPANY_DB_FILE_PATH };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.NODE_ENV = original.env;
    if (original.path === undefined) delete process.env.COMPANY_DB_FILE_PATH;
    else process.env.COMPANY_DB_FILE_PATH = original.path;
  });

  it("NODE_ENV=production tanpa COMPANY_DB_FILE_PATH: tidak memanggil mkdir sama sekali", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.COMPANY_DB_FILE_PATH;
    vi.resetModules();
    const mkdir = vi.spyOn(fs, "mkdirSync");
    await import("./knexfile.js");
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("di luar produksi (dev/test): folder default tetap dibuat seperti sebelumnya", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.COMPANY_DB_FILE_PATH;
    vi.resetModules();
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);
    await import("./knexfile.js");
    expect(mkdir).toHaveBeenCalledTimes(1);
  });
});
