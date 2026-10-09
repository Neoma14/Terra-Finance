import { Client, A, rec } from "./lib.mjs";
const o = new Client("o"); await o.login("owner@terra-nusantara.test", "Uat#Owner2026");
const cf = (await o.get(`${A()}/reports/cash-flow?fromDate=2025-01-01&toDate=2025-12-31`)).json;
const noisy = [cf.operating.amount, cf.investing.amount, cf.financing.amount, cf.netChangeInCash].some((v) => v !== Math.round(v));
rec("BUG-CF-FLOAT", "accounting", "Arus Kas menampilkan nilai rupiah pecahan/noise floating-point dan mengalokasikan kas pada jurnal campuran secara pro-rata (pembelian gedung Rp800jt dibiayai pinjaman Rp300jt: investasi -483,6jt dan pendanaan -136,4jt)", !noisy, `2025: operasi ${cf.operating.amount}, investasi ${cf.investing.amount}, pendanaan ${cf.financing.amount}`, "MEDIUM");
process.exit(0);
