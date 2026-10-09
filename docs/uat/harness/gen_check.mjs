import { generate, OB, code, BR } from "./gen.mjs";
const txs = generate();
console.log("transaksi:", txs.length, "baris:", txs.reduce((s, t) => s + t.lines.length, 0));
const by = {}; for (const t of txs) by[t.date.slice(0, 4)] = (by[t.date.slice(0, 4)] ?? 0) + 1; console.log(by);
const types = {}; for (const t of txs) types[t.type] = (types[t.type] ?? 0) + 1; console.log(types);
// saldo kas/bank per akhir bulan
const bal = {}; for (const [c, d, k] of OB) bal[c] = (bal[c] ?? 0) + d - k; let neg = [];
let mi = ""; const cashCodes = [code.bca, code.mdr, ...BR.map((b) => code.kas(b.k)), code.pers];
for (const t of txs) { for (const l of t.lines) bal[l.c] = (bal[l.c] ?? 0) + l.d - l.cr; const m = t.date.slice(0, 7); if (m !== mi) { mi = m; } }
const eod = {}; // cek negatif per akhir tahun saja secara cepat
let run = {}; for (const [c, d, k] of OB) run[c] = (run[c] ?? 0) + d - k;
for (const t of txs) { for (const l of t.lines) run[l.c] = (run[l.c] ?? 0) + l.d - l.cr; for (const c of cashCodes) if (run[c] < 0 && !neg.find((x) => x[0] === c)) neg.push([c, t.date, Math.round(run[c])]); }
console.log("akun kas/bank/persediaan pernah negatif:", JSON.stringify(neg));
console.log("saldo akhir bca,mdr,pers:", Math.round(bal[code.bca]), Math.round(bal[code.mdr]), Math.round(bal[code.pers]));
const dup = new Set(); for (const t of txs) { if (dup.has(t.ref)) console.log("DUP", t.ref); dup.add(t.ref); }
const aa = BR.reduce((s, b) => s + (bal[code.aa(b.k)] ?? 0), 0), ap = BR.reduce((s, b) => s + (bal[code.ap(b.k)] ?? 0), 0); console.log("antarkantor aktiva", aa, "pasiva", -ap);
