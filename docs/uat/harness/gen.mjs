// Generator dataset UAT 5 tahun: PT TERRA NUSANTARA, 5 kantor disimulasikan lewat akun per cabang (TANPA branch_id).
import { rng, lastDay, ymd } from "./lib.mjs";

export const BR = [
  { k: "PST", n: "Kantor Pusat", i: 1, from: "2021-01-01" },
  { k: "MTR", n: "Cabang Metro", i: 2, from: "2021-01-01" },
  { k: "BDL", n: "Cabang Bandar Lampung", i: 3, from: "2022-03-01" },
  { k: "KTB", n: "Cabang Kotabumi", i: 4, from: "2023-04-01" },
  { k: "TBS", n: "Cabang Terbanggi Besar", i: 5, from: "2023-04-01" },
];
const bi = Object.fromEntries(BR.map((b) => [b.k, b]));
const cd = (base, k) => String(base + bi[k].i);
export const code = {
  kas: (k) => cd(1110, k), pend: (k) => cd(4110, k), hpp: (k) => cd(5110, k), gaji: (k) => cd(6110, k),
  aa: (k) => cd(1510, k), ap: (k) => cd(2510, k), // Antarkantor Aktiva/Pasiva terhadap lawan transaksi k
  bca: "1120", mdr: "1130", piut: "1200", pers: "1300", alat: "1400", kend: "1410", gedung: "1420", akum: "1490",
  hut: "2100", hbank: "2200", modal: "3100", listrik: "6200", internet: "6210", transp: "6300", sewa: "6400", ops: "6500", susut: "6600", bunga: "6700",
};

export function coaRows() {
  const rows = [];
  const add = (c, n, tipe, o = {}) => rows.push({ c, n, tipe, kas: o.kas ? "Ya" : "", arus: o.arus ?? "", kartu: o.kartu ?? "", normal: o.normal ?? "" });
  for (const b of BR) add(code.kas(b.k), `Kas ${b.n}`, "Aset", { kas: true, arus: "Operasi" });
  add(code.bca, "Bank BCA", "Aset", { kas: true, arus: "Operasi" }); add(code.mdr, "Bank Mandiri", "Aset", { kas: true, arus: "Operasi" });
  add(code.piut, "Piutang Usaha", "Aset", { arus: "Operasi", kartu: "Piutang" }); add(code.pers, "Persediaan", "Aset", { arus: "Operasi" });
  add(code.alat, "Peralatan", "Aset", { arus: "Investasi" }); add(code.kend, "Kendaraan", "Aset", { arus: "Investasi" }); add(code.gedung, "Gedung", "Aset", { arus: "Investasi" });
  add(code.akum, "Akumulasi Penyusutan", "Aset", { normal: "Kredit" });
  for (const b of BR) add(code.aa(b.k), `Antarkantor Aktiva - ${b.n}`, "Aset", { arus: "Operasi" });
  add(code.hut, "Utang Usaha", "Liabilitas", { arus: "Operasi", kartu: "Hutang" }); add(code.hbank, "Utang Bank", "Liabilitas", { arus: "Pendanaan" });
  for (const b of BR) add(code.ap(b.k), `Antarkantor Pasiva - ${b.n}`, "Liabilitas", { arus: "Operasi" });
  add(code.modal, "Modal Disetor", "Ekuitas", { arus: "Pendanaan" });
  for (const b of BR) add(code.pend(b.k), `Pendapatan Penjualan ${b.n}`, "Pendapatan", { arus: "Operasi" });
  for (const b of BR) add(code.hpp(b.k), `Harga Pokok Penjualan ${b.n}`, "HPP", { arus: "Operasi" });
  for (const b of BR) add(code.gaji(b.k), `Beban Gaji ${b.n}`, "Beban", { arus: "Operasi" });
  for (const [c, n] of [[code.listrik, "Beban Listrik"], [code.internet, "Beban Internet"], [code.transp, "Beban Transportasi"], [code.sewa, "Beban Sewa"], [code.ops, "Beban Operasional"], [code.susut, "Beban Penyusutan"], [code.bunga, "Beban Bunga"]]) add(c, n, "Beban", { arus: "Operasi" });
  return rows;
}
export const OB = [
  [code.bca, 950e6, 0], [code.mdr, 300e6, 0], [code.kas("PST"), 50e6, 0], [code.kas("MTR"), 25e6, 0], [code.pers, 400e6, 0], [code.alat, 150e6, 0], [code.gedung, 600e6, 0],
  [code.akum, 0, 100e6], [code.hut, 0, 125e6], [code.modal, 0, 2250e6],
];

const G = { 2021: 1.0, 2022: 1.5, 2023: 2.1, 2024: 2.7, 2025: 3.3 };
const r1000 = (x) => Math.max(1000, Math.round(x / 1000) * 1000);

export function generate(seed = 20260505) {
  const R = rng(seed); const pick = (a) => a[Math.floor(R() * a.length)]; const between = (a, b) => a + R() * (b - a);
  const txs = []; const seq = {};
  const T = (date, k, type, desc, lines, flags = {}) => {
    const y = date.slice(0, 4); seq[k + y] = (seq[k + y] ?? 0) + 1;
    txs.push({ ref: `${k}-${y}-${String(seq[k + y]).padStart(5, "0")}`, date, k, type, desc: `[${k}] ${desc}`, lines: lines.map(([c, d, cr, tag]) => ({ c, d: Math.round(d), cr: Math.round(cr), br: tag ?? k })), ...flags });
  };
  const dim = {}; // utang usaha belum dibayar per cabang, piutang belum ditagih per cabang
  const credPurch = {}; const credSales = {};
  for (let y = 2021; y <= 2025; y++) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0"); const ld = lastDay(y, m); const g = G[y];
      const day = (a, b) => `${y}-${mm}-${String(Math.min(ld, Math.floor(between(a, b + 1)))).padStart(2, "0")}`;
      const monthStart = `${y}-${mm}-01`;
      for (const b of BR) {
        if (monthStart < b.from.slice(0, 7) + "-01") continue;
        const k = b.k; const key = `${k}${y}${m}`;
        const scale = (k === "PST" ? 0.6 : 1) * g;
        let sumHpp = 0; let sumCash = 0;
        // penjualan tunai (multi-line: sebagian bank)
        const nSales = Math.max(2, Math.round((k === "PST" ? 2 : 4) * g));
        for (let i = 0; i < nSales; i++) {
          const amt = r1000(R() < 0.06 ? between(40e6, 140e6) : R() < 0.12 ? between(1000, 15000) : between(1.5e6, 18e6) * (0.8 + g / 5));
          const hpp = r1000(amt * between(0.58, 0.7)); sumHpp += hpp;
          const d = day(1, ld);
          if (R() < 0.35) { const bankPart = r1000(amt * 0.5); T(d, k, "SC", `Penjualan tunai/transfer ${k}`, [[code.kas(k), amt - bankPart, 0], [code.bca, bankPart, 0, k], [code.pend(k), 0, amt], [code.hpp(k), hpp, 0], [code.pers, 0, hpp]]); sumCash += amt - bankPart; }
          else { T(d, k, "SC", `Penjualan tunai ${k}`, [[code.kas(k), amt, 0], [code.pend(k), 0, amt], [code.hpp(k), hpp, 0], [code.pers, 0, hpp]]); sumCash += amt; }
        }
        // penjualan kredit -> piutang, ditagih bulan berikutnya
        if (["PST", "MTR", "KTB"].includes(k)) {
          const nCred = Math.max(1, Math.round(2 * g)); let tot = 0;
          for (let i = 0; i < nCred; i++) { const amt = r1000(between(4e6, 30e6) * (0.8 + g / 5)); const hpp = r1000(amt * 0.64); tot += amt; sumHpp += hpp; T(day(1, ld), k, "SR", `Penjualan kredit ${k}`, [[code.piut, amt, 0], [code.pend(k), 0, amt], [code.hpp(k), hpp, 0], [code.pers, 0, hpp]]); }
          credSales[key] = tot;
        }
        const prevKey = (() => { const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; return `${k}${py}${pm}`; })();
        if (credSales[prevKey]) { const rc = r1000(credSales[prevKey] * between(0.8, 1)); T(day(5, 20), k, "RC", `Penerimaan piutang ${k}`, [[code.bca, rc, 0, k], [code.piut, 0, rc]]); }
        // pembelian persediaan
        const purch = r1000(sumHpp * between(1.0, 1.08)); const pCredit = r1000(purch * 0.35), pBank = r1000(purch * 0.4), pKas = purch - pCredit - pBank;
        T(day(2, 12), k, "PU", `Pembelian persediaan (kredit) ${k}`, [[code.pers, pCredit, 0], [code.hut, 0, pCredit]]);
        T(day(10, 20), k, "PU", `Pembelian persediaan (bank) ${k}`, [[code.pers, pBank, 0], [code.bca, 0, pBank, k]]);
        T(day(15, 25), k, "PU", `Pembelian persediaan lokal tunai ${k}`, [[code.pers, pKas, 0], [code.kas(k), 0, pKas]]); sumCash -= pKas;
        credPurch[key] = pCredit;
        if (credPurch[prevKey]) { const vp = r1000(credPurch[prevKey] * between(0.85, 1)); T(day(8, 22), k, "VP", `Pembayaran vendor ${k}`, [[code.hut, vp, 0], [code.bca, 0, vp, k]]); }
        // biaya
        const rev = sumHpp / 0.64;
        const li = r1000(rev * 0.012 + 300000), nt = 500000, tr = r1000(rev * 0.025), op = r1000(rev * 0.03), tr2 = r1000(rev * 0.012);
        T(day(3, 10), k, "EX", `Listrik & internet ${k}`, [[code.listrik, li, 0], [code.internet, nt, 0], [code.kas(k), 0, li + nt]]); sumCash -= li + nt;
        T(day(5, 25), k, "EX", `Biaya transportasi ${k}`, [[code.transp, tr, 0], [code.kas(k), 0, tr]]); sumCash -= tr;
        T(day(5, 25), k, "EX", `Biaya transportasi tambahan ${k}`, [[code.transp, tr2, 0], [code.kas(k), 0, tr2]]); sumCash -= tr2;
        T(day(1, ld), k, "EX", `Biaya operasional ${k}`, [[code.ops, op, 0], [code.kas(k), 0, op]]); sumCash -= op;
        if (k === "PST" || R() < 0.5) { const sw = r1000(between(2e6, 4e6) * (k === "PST" ? 3 : 1)); T(`${y}-${mm}-01`, k, "EX", `Sewa ${k}`, [[code.sewa, sw, 0], [code.bca, 0, sw, k]]); }
        // gaji akhir bulan (multi-line: gaji + potongan dibayar bank)
        const gj = r1000(rev * 0.1 + 4e6 * (k === "PST" ? 3 : 1)); const gt = r1000(gj * 0.93);
        T(`${y}-${mm}-${ld}`, k, "PY", `Gaji bulan ${mm}/${y} ${k}`, [[code.gaji(k), gj, 0], [code.bca, 0, gt, k], [code.hut, 0, gj - gt]]);
        // setor kas ke bank
        const dep = r1000(Math.max(0, sumCash) * 0.9); if (dep > 0) T(`${y}-${mm}-${ld}`, k, "BT", `Setor kas ke bank ${k}`, [[code.bca, dep, 0, k], [code.kas(k), 0, dep]]);
        // hari-hari khusus: 31/12 dan 01/01 (transaksi nominal kecil/besar)
        if (m === 12) T(`${y}-12-31`, k, "SC", `Penjualan akhir tahun ${k}`, [[code.kas(k), 2500000, 0], [code.pend(k), 0, 2500000], [code.hpp(k), 1600000, 0], [code.pers, 0, 1600000]]);
        if (m === 1) T(`${y}-01-01`, k, "SC", `Penjualan awal tahun ${k}`, [[code.kas(k), 1750000, 0], [code.pend(k), 0, 1750000], [code.hpp(k), 1100000, 0], [code.pers, 0, 1100000]]);
        if (m === 1 && y > 2021) T(`${y}-01-01`, k, "EX", `Biaya awal tahun ${k}`, [[code.ops, 15000, 0], [code.kas(k), 0, 15000]]);
        // dua transaksi pada tanggal yang sama (kecil + besar)
        T(`${y}-${mm}-15`, k, "SC", `Penjualan kecil ${k}`, [[code.kas(k), 12500, 0], [code.pend(k), 0, 12500], [code.hpp(k), 8000, 0], [code.pers, 0, 8000]]);
        { const big = r1000(between(60e6, 95e6) * (0.7 + g / 5)); T(`${y}-${mm}-15`, k, "SC", `Penjualan besar ${k}`, [[code.kas(k), big, 0], [code.pend(k), 0, big]]); sumCash += big; }
      }
      // pusat: transfer bank, penyusutan, bunga
      { const tb = r1000(between(20e6, 80e6)); T(`${y}-${mm}-${String(Math.min(ld, 12)).padStart(2, "0")}`, "PST", "BT", "Transfer antar bank BCA ke Mandiri", [[code.mdr, tb, 0], [code.bca, 0, tb]]); }
      if (y >= 2022 || m >= 6) T(`${y}-${mm}-${ld}`, "PST", "DP", "Penyusutan aset", [[code.susut, y < 2023 ? 4200000 : y < 2025 ? 9500000 : 15500000, 0], [code.akum, 0, y < 2023 ? 4200000 : y < 2025 ? 9500000 : 15500000]]);
      if (y > 2023 || (y === 2023 && m >= 7)) T(`${y}-${mm}-${ld}`, "PST", "IN", "Bunga pinjaman bank", [[code.bunga, 8500000, 0], [code.bca, 0, 8500000]]);
    }
  }
  // transaksi khusus: modal, aset, pinjaman
  const S1 = (date, k, type, desc, lines) => T(date, k, type, desc, lines);
  S1("2023-02-10", "PST", "EQ", "Tambahan modal disetor", [[code.bca, 500e6, 0], [code.modal, 0, 500e6]]);
  S1("2023-06-05", "PST", "LN", "Penarikan pinjaman bank", [[code.bca, 1000e6, 0], [code.hbank, 0, 1000e6]]);
  S1("2023-07-12", "PST", "AS", "Pembelian kendaraan operasional", [[code.kend, 350e6, 0], [code.bca, 0, 200e6], [code.hbank, 0, 150e6]]);
  S1("2025-03-20", "PST", "AS", "Pembelian peralatan (kantor cabang baru)", [[code.alat, 120e6, 0], [code.mdr, 0, 120e6]]);
  S1("2025-09-18", "PST", "AS", "Pembelian gedung gudang", [[code.gedung, 800e6, 0], [code.bca, 0, 500e6], [code.hbank, 0, 300e6]]);
  S1("2024-12-30", "PST", "ST", "Pelunasan sebagian utang bank", [[code.hbank, 200e6, 0], [code.bca, 0, 200e6]]);
  // transaksi antar kantor: pengirim X, penerima Y. Dua sisi dalam SATU jurnal (4 baris).
  const IO = (date, from, to, amt, desc) => T(date, from, "IO", `${desc}: ${from} -> ${to}`, [
    [code.aa(to), amt, 0, from],                          // piutang antarkantor milik pengirim terhadap penerima
    [from === "PST" ? code.bca : code.kas(from), 0, amt, from],
    [to === "PST" ? code.bca : code.kas(to), amt, 0, to],
    [code.ap(from), 0, amt, to],                          // utang antarkantor milik penerima terhadap pengirim
  ]);
  const io = [
    ["2021-01-20", "PST", "MTR", 100e6], ["2021-07-15", "MTR", "PST", 40e6],
    ["2022-03-01", "PST", "BDL", 150e6], ["2022-11-10", "BDL", "PST", 60e6], ["2022-12-31", "MTR", "PST", 25e6],
    ["2023-04-03", "MTR", "KTB", 80e6], ["2023-04-10", "KTB", "TBS", 30e6], ["2023-09-12", "PST", "MTR", 75e6], ["2023-12-28", "BDL", "PST", 45e6],
    ["2024-02-05", "PST", "BDL", 90e6], ["2024-06-17", "KTB", "TBS", 20e6], ["2024-10-21", "MTR", "KTB", 35e6],
    ["2025-01-02", "PST", "MTR", 60e6], ["2025-05-14", "BDL", "PST", 55e6], ["2025-08-26", "MTR", "KTB", 28e6], ["2025-11-07", "KTB", "TBS", 12e6], ["2025-12-30", "MTR", "PST", 33e6],
  ];
  for (const [d, f, t, a] of io) IO(d, f, t, a, "Transfer antar kantor");
  return txs.filter((t) => t.lines.length >= 2 && t.lines.every((l) => l.d >= 0 && l.cr >= 0) && t.lines.reduce((s, l) => s + l.d, 0) === t.lines.reduce((s, l) => s + l.cr, 0) && t.lines.reduce((s, l) => s + l.d, 0) > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref < b.ref ? -1 : 1));
}
