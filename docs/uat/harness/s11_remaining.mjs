// Pemeriksaan ulang temuan MEDIUM/LOW yang TIDAK diperbaiki pada tahap ini (kondisional: lulus bila memang sudah beres).
import { Client, A, rec, state } from "./lib.mjs";
const owner = new Client("o"); await owner.login("owner@terra-nusantara.test", "Uat#Owner2026"); const anon = new Client("x");
let codes = []; for (let i = 0; i < 30; i++) { const x = await anon.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "salah-tebakan-" + i }, { noStore: true, noRetry: true }); codes.push(x.status); }
const ok = await anon.post("/api/auth/login", { email: "owner@terra-nusantara.test", password: "Uat#Owner2026" }, { noStore: true, noRetry: true });
rec("AU-bruteforce2", "authn", "30 percobaan password salah beruntun pada akun Owner: tidak ada penguncian akun/jeda (login benar tetap 200 sesudahnya)", ok.status !== 200 || codes.includes(429), `status percobaan: ${[...new Set(codes)].join(",")}; login benar sesudahnya = ${ok.status}`, "MEDIUM");
const cf = (await owner.get(`${A()}/reports/cash-flow?fromDate=2025-01-01&toDate=2025-12-31`)).json;
const noisy = [cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.netChangeInCash].some((v) => v !== Math.round(v));
rec("BUG-CF-FLOAT", "accounting", "Arus Kas: nilai rupiah pecahan/noise floating-point dan alokasi kas pro-rata pada jurnal campuran", !noisy, `2025: operasi ${cf.operating.amount}, investasi ${cf.investing.amount}, pendanaan ${cf.financing.amount}`, "MEDIUM");
const cp = await owner.get(`${A()}/counterparties?type=${encodeURIComponent("admin'--")}`); rec("BUG-CP-FILTER", "validation", "counterparties?type=<tidak valid> mengabaikan filter dan mengembalikan semua data", cp.status === 400, `status ${cp.status}`, "LOW");
const jb = await owner.post(`${A()}/journal`, { referenceNo: "REM-BOTH-" + Date.now(), periodId: state().per["2026-02"], entryDate: "2026-02-10", lines: [{ accountId: state().accId["1111"], debit: 1000, credit: 1000 }] });
rec("JR-both-recheck", "journal", "baris dengan debit dan kredit sekaligus -> 400 (bukan 500)", jb.status === 400, `status ${jb.status}`, "MEDIUM");
process.exit(0);
