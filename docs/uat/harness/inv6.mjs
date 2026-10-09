import { Client, A, rec, note, state, dbA } from "./lib.mjs";
import { code } from "./gen.mjs";
const { accId, per, a1 } = state();
const owner = new Client("o"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026");
const acct = new Client("a"); await acct.login("akuntan@terra-nusantara.test", "Uat#Pass2026");
const admin = new Client("ad"); await admin.login("admin@terra-nusantara.test", "Uat#Pass2026");
const st = (r) => `status ${r.status}${r.json?.error ? " " + r.json.error.slice(0, 80) : ""}`;
const target = per["2026-06"];
let r = await owner.post(`${A()}/periods/${target}/lock`, {}); console.log("lock", st(r));
r = await owner.post(`${A()}/periods/${target}/close`, {}); rec("PE-close2", "periods", "periode LOCKED -> CLOSED", r.status === 200, st(r), "MEDIUM");
const j = await acct.post(`${A()}/journal`, { referenceNo: "AFTER-CLOSE-2", periodId: target, entryDate: "2026-06-10", lines: [{ accountId: accId[code.kas("PST")], debit: 1, credit: 0 }, { accountId: accId[code.pend("PST")], debit: 0, credit: 1 }] });
rec("PE-closed-journal2", "business-logic", "jurnal ke periode CLOSED ditolak (409)", j.status === 409, st(j), "HIGH");
const rv = await acct.post(`${A()}/journal/reversal`, { referenceNo: "BIG-100", entryDate: "2026-06-05", reason: "uji" }); console.log("reversal di periode closed (BIG-100?)", st(rv));
// reversal jurnal dalam periode closed
const d = dbA(); const cand = d.prepare("select reference_no r, entry_date e from journal_entries where period_id = ? and status='POSTED' and reference_no like 'BIG-%' limit 1").get(target); d.close();
if (cand) { const rr = await acct.post(`${A()}/journal/reversal`, { referenceNo: cand.r, entryDate: String(cand.e).slice(0, 10), reason: "uji closed" }); rec("PE-closed-reversal", "business-logic", "reversal jurnal di periode CLOSED ditolak (409)", rr.status === 409, st(rr), "HIGH"); }
const imp = await acct.post(`${A()}/accounts/${a1}/lock`); void imp;
// unlock + audit
r = await admin.post(`${A()}/accounts/${a1}/unlock`); rec("LOCK-unlock", "coa", "Admin unlock akun", r.status === 200, st(r), "MEDIUM");
const d2 = dbA(); const au = d2.prepare("select count(*) c from company_audit_log where action='account.unlock'").get().c; d2.close();
rec("AUDIT-unlock2", "audit", "unlock akun tercatat di audit log", au >= 1, `${au} baris`, "MEDIUM");
// login/logout tidak diaudit -> temuan
rec("BUG-AUDIT-LOGIN", "audit", "login/logout pengguna biasa TIDAK tercatat di audit log (hanya administrator.login); percobaan login gagal juga tidak tercatat", false, "aksi audit yang ada: setup.complete, user.*, company.access.*, administrator.login, dst; tidak ada user.login/user.logout/login_failed", "MEDIUM");
process.exit(0);
