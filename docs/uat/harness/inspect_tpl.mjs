import { Client, A, ExcelJS } from "./lib.mjs";
const c = new Client("o"); await c.login("owner@terra-nusantara.test", "Uat#Owner2026");
for (const [n, p] of [["coa", "accounts-import/template"], ["ob", "opening-balance-import/template"], ["jr", "journal-import/template"]]) {
  const r = await c.get(`${A()}/${p}`, { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf);
  console.log("==", n, r.status, wb.worksheets.map((w) => w.name).join(","));
  for (const ws of wb.worksheets.slice(0, 2)) { console.log(" sheet", ws.name); for (let i = 1; i <= Math.min(6, ws.rowCount); i++) console.log("  ", i, JSON.stringify(ws.getRow(i).values.slice(1))); }
}
process.exit(0);
