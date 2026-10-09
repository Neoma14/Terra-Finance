import { Client, A, dbA, state, note, rec } from "./lib.mjs";
const owner = new Client("o"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const acct = new Client("a"); await acct.login("akuntan@terra-nusantara.test", "Uat#Pass2026");
let r = await owner.post(`${A()}/periods/generate-monthly`, { fromDate: "abc", toDate: "def" }); console.log("generate abc:", r.status, JSON.stringify(r.json));
let db = dbA(); console.log("periods:", db.prepare("select count(*) c from periods").get().c, db.prepare("select label,start_date from periods where label like '%NaN%' or label like '%Invalid%' limit 3").all());
console.log("unbalanced journals:", db.prepare("select je.reference_no r, je.status s, sum(jel.debit)-sum(jel.credit) d from journal_entries je join journal_entry_lines jel on jel.journal_entry_id=je.id group by je.id having abs(d) > 0.0001").all());
const un = db.prepare("select je.id, je.reference_no r from journal_entries je join journal_entry_lines jel on jel.journal_entry_id=je.id group by je.id having abs(sum(jel.debit)-sum(jel.credit)) > 0.0001 and je.status='DRAFT'").all(); db.close();
// uji dampak: POST jurnal selisih Rp1 (+ satu lagi) lalu cek TB/BS bulan itu
for (const u of un) { const p = await acct.post(`${A()}/journal/${u.id}/post`); console.log("post", u.r, p.status, JSON.stringify(p.json).slice(0, 100)); }
const per = state().per;
const tb = await owner.get(`${A()}/trial-balance?periodId=${per["2026-02"]}`); console.log("TB Feb2026:", tb.status, tb.json?.isBalanced, tb.json?.totalDebit, tb.json?.totalCredit, tb.json?.difference);
const bs = await owner.get(`${A()}/reports/balance-sheet?fromDate=2021-01-01&toDate=2026-02-28`); console.log("BS Feb2026:", bs.status, bs.json?.isBalanced, bs.json?.balanceDifference, JSON.stringify(bs.json).slice(0, 120));
const dash = await owner.get(`${A()}/dashboard?fromDate=2026-02-01&toDate=2026-02-28`); console.log("dashboard:", dash.status, JSON.stringify(dash.json).slice(0, 150));
process.exit(0);
