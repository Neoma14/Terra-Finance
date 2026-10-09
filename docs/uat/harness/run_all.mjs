import { spawnSync } from "node:child_process";
import fs from "node:fs";
const S = "C:/Users/fachr/AppData/Local/Temp/claude/d--ABDI-Proyek-Aplikasi-TERRA-CORP/9ac415a6-f4b7-4b41-a364-523de9c29d56/scratchpad/uat5";
// "restart" = restart server (memori pembatas login/rate limit direset; sengaja, karena langkah brute-force
// sebelumnya memblokir IP/akun uji sementara -- itu perilaku yang BENAR, bukan bug).
const steps = ["s01_setup", "s02_data", "s03_reconcile", "s04a_perf_export", "s04b_functional", "s04c_imports", "s05a_security", "restart", "s05b_security2", "s10_regression_high", "s11_remaining", "restart", "s12_hardening", "s13_accounting_fix", "restart", "s06_resilience", "s07_ui", "s08_extra"];
fs.writeFileSync(`${S}/runall.status`, "");
for (const st of steps) {
  fs.appendFileSync(`${S}/runall.status`, `START ${st} ${new Date().toISOString()}\n`);
  if (st === "restart") {
    spawnSync("node", [`${S}/srvctl.mjs`, "stop"], { cwd: S, encoding: "utf8" });
    const r = spawnSync("node", [`${S}/srvctl.mjs`, "start", "restart"], { cwd: S, encoding: "utf8" });
    fs.appendFileSync(`${S}/runall.status`, `END restart exit=${r.status} ${r.stdout.trim()}\n`);
    continue;
  }
  const r = spawnSync("node", [`${S}/${st}.mjs`], { cwd: S, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, SKIP_MENUS: "" } });
  fs.writeFileSync(`${S}/${st}.run6.log`, (r.stdout ?? "") + (r.stderr ?? ""));
  fs.appendFileSync(`${S}/runall.status`, `END ${st} exit=${r.status}\n`);
  if (st === "s01_setup" && r.status !== 0) break;
}
fs.appendFileSync(`${S}/runall.status`, "ALL DONE\n");
