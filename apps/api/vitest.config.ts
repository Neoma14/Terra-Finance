import { defineConfig } from "vitest/config";

// Minimal vitest foundation -- repo tidak punya test suite sama sekali
// sebelum TASK-DB-ARCH-002 (dikonfirmasi saat audit TASK-DB-ARCH-001: nol
// file *.test.ts, nol vitest.config.* di seluruh workspace). Config ini
// sengaja sederhana; diperluas nanti kalau test suite tumbuh (coverage,
// setup file global, dst).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
