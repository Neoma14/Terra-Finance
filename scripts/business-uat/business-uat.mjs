// Runner utama UAT bisnis terkontrol. Pemakaian: node scripts/business-uat/business-uat.mjs <folder-kerja>
import { results, saveResults, record } from "./lib.mjs";
import { makeCtx } from "./ctx.mjs";
import { envScenarios } from "./sc-env.mjs";
import { accessScenarios } from "./sc-access.mjs";
import { ibScenarios } from "./sc-ib.mjs";
import { reportScenarios } from "./sc-reports.mjs";
import { failScenarios } from "./sc-fail.mjs";

const ctx = await makeCtx();
try {
  await envScenarios(ctx);
  const e0 = results.filter((r) => r.id === "E0");
  if (e0.some((r) => r.status !== "PASS")) { console.log("E0 GAGAL: isolasi/pemulihan tidak terbukti, transaksi UAT TIDAK dilanjutkan"); }
  else {
    ctx.baseline = ctx.snap(); ctx.done = [];
    await accessScenarios(ctx);
    await ibScenarios(ctx);
    await reportScenarios(ctx);
    await failScenarios(ctx);
  }
} finally {
  saveResults("business-uat-results");
  await ctx.srv.stop?.();
  const f = results.filter((r) => r.status !== "PASS");
  console.log(`\nTOTAL ${results.length} skenario, tidak PASS: ${f.length}`);
  process.exit(0);
}
