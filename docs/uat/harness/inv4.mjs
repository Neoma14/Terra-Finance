import { Client, A, rec, state } from "./lib.mjs";
const owner = new Client("o"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const e = encodeURIComponent;
for (const p of ["' OR '1'='1", "2025-13-45", "abc", "1/1/2025", "2025-02-30", "99999-01-01", "2025", ""]) {
  const d = await owner.get(`${A()}/dashboard?fromDate=${e(p)}&toDate=${e(p)}`);
  const i = await owner.get(`${A()}/reports/income-statement?fromDate=${e(p)}&toDate=${e(p)}`);
  const b = await owner.get(`${A()}/reports/balance-sheet?fromDate=${e(p)}&toDate=${e(p)}`);
  console.log(JSON.stringify(p).padEnd(18), "dash", d.status, "IS", i.status, "BS", b.status, (d.json?.error ?? "").slice(0, 60));
}
const cp = await owner.get(`${A()}/counterparties?type=${e("admin'--")}`); console.log("cp-type:", cp.status, cp.text.slice(0, 150));
const pr = await owner.patch(`${A()}/profile`, { tradeName: "' UNION SELECT name FROM sqlite_master --" }); console.log("profile:", pr.status, pr.text.slice(0, 150));
await owner.patch(`${A()}/profile`, { tradeName: null });
process.exit(0);
