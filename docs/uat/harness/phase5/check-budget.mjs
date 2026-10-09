// PHASE 5.0 -- pemeriksa anggaran kinerja. Membandingkan hasil http-baseline.mjs yang baru dengan baseline 5.0.
//   node check-budget.mjs <hasil-baru.json> [--baseline=docs/uat/phase5/http-baseline.json]
// Aturan "tanpa regresi" (gerbang 5A): median <= max(1.20 x baseline, baseline + 25 ms) dan p95 <= max(1.30 x baseline, baseline + 50 ms) (kebisingan antar-ulang kode yang SAMA terukur ±10-20%).
// Dataset/endpoint yang ada pada baseline namun hilang pada hasil baru dianggap GAGAL (fail-closed).
import fs from "node:fs";
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const baseFile = (args.find((a) => a.startsWith("--baseline=")) ?? "--baseline=D:/ABDI/Proyek Aplikasi/Codex/TERRA-Finance-Offline/docs/uat/phase5/http-baseline.json").split("=")[1];
const base = JSON.parse(fs.readFileSync(baseFile, "utf8"));
const now = JSON.parse(fs.readFileSync(file, "utf8"));
let fail = 0, n = 0;
for (const [ds, run] of Object.entries(now.runs)) {
  for (const [ep, m] of Object.entries(run.endpoints)) {
    const b = base.runs[ds]?.endpoints[ep];
    if (!b) continue;
    n++;
    const okMed = m.medianMs <= Math.max(b.medianMs * 1.2, b.medianMs + 25);
    const okP95 = m.p95Ms <= Math.max(b.p95Ms * 1.3, b.p95Ms + 50);
    const okStatus = m.status === 200;
    if (!(okMed && okP95 && okStatus)) { fail++; console.log(`FAIL ${ds} ${ep}: median ${m.medianMs} (maks ${Math.round(Math.max(b.medianMs * 1.2, b.medianMs + 25))}) p95 ${m.p95Ms} (maks ${Math.round(Math.max(b.p95Ms * 1.3, b.p95Ms + 50))}) status ${m.status}`); }
  }
}
for (const [ds, run] of Object.entries(base.runs)) for (const ep of Object.keys(run.endpoints)) if (now.runs[ds] && !now.runs[ds].endpoints[ep]) { fail++; console.log(`FAIL ${ds} ${ep}: hilang pada hasil baru`); }
console.log(`${n - fail}/${n} dalam anggaran`);
process.exit(fail ? 1 : 0);
