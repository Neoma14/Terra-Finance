import { Client, A, ExcelJS } from "./lib.mjs";
const c = new Client("o"); await c.login("owner@terra-nusantara.test", "Uat#Owner2026");
for (const [n, p] of [["coa", "accounts-import/template"], ["ob", "opening-balance-import/template"], ["jr", "journal-import/template"]]) {
  const r = await c.get(`${A()}/${p}`, { raw: true }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0]; console.log("==", n);
  for (let i = 6; i <= Math.min(14, ws.rowCount); i++) console.log("  ", i, JSON.stringify(ws.getRow(i).values.slice(1)));
  const ref = wb.worksheets[1]; if (n === "coa") for (let i = 1; i <= ref.rowCount; i++) console.log("  ref", JSON.stringify(ref.getRow(i).values.slice(1)));
}
process.exit(0);
