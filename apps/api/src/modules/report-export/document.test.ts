import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  balanceSheetDocument,
  buildFileBase,
  formatPeriodRange,
  slugForFileName,
  type ReportDocument,
} from "./document.js";
import { formatIdr, renderPdf } from "./pdf.js";
import { renderXlsx } from "./xlsx.js";
import { resolveReportScope } from "../../db/company/report-scope.js";

const base = { companyName: "PT ABDI WARDHANA", periodLabel: formatPeriodRange("2026-01-01", "2026-01-31"), scopeLabel: null, fileBase: "x" };

function sampleDocument(lineCount = 3): ReportDocument {
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    accountId: `id-${i}`,
    accountCode: String(1000 + i),
    accountName: `Akun ${i}`,
    amount: 1000 * (i + 1),
  }));
  const section = (label: string, total: number) => ({ label, lines, total });
  return balanceSheetDocument(
    {
      period: { fromDate: "2026-01-01", toDate: "2026-01-31" },
      assets: section("Assets", 6000),
      liabilities: { label: "Liabilities", lines: [], total: 0 },
      equity: section("Equity", 6000),
      totalAssets: 6000,
      totalLiabilities: 0,
      totalEquity: 6000,
      balanceDifference: 0,
      isBalanced: true,
    },
    base,
  );
}

describe("format tanggal dan nama file", () => {
  it("periode ditulis dalam bahasa Indonesia", () => {
    expect(formatPeriodRange("2026-01-01", "2026-01-31")).toBe("01 Januari 2026 - 31 Januari 2026");
  });

  it("nama file aman: diakritik dihapus, karakter selain huruf/angka jadi '-'", () => {
    expect(slugForFileName("PT Ábdi/Wardhana: #1")).toBe("PT-Abdi-Wardhana-1");
  });

  it("pola nama file sesuai spesifikasi: PT-ABDI-WARDHANA-Neraca-2026-01-01-2026-01-31", () => {
    expect(buildFileBase("PT ABDI WARDHANA", "balance-sheet", "2026-01-01", "2026-01-31")).toBe(
      "PT-ABDI-WARDHANA-Neraca-2026-01-01-2026-01-31",
    );
  });
});

describe("format angka", () => {
  it("sama dengan UI (formatIDR): 'Rp 1.000' dan negatif '-Rp 1.000'", () => {
    expect(formatIdr(1000)).toBe("Rp 1.000");
    expect(formatIdr(-1000)).toBe("-Rp 1.000");
    expect(formatIdr(0)).toBe("Rp 0");
  });
});

describe("Excel (.xlsx)", () => {
  it("file dapat dibaca kembali: header, periode, dan angka tersimpan sebagai number", async () => {
    const buffer = await renderXlsx(sampleDocument());
    const wb = new ExcelJS.Workbook();
    // ExcelJS mengetik Buffer dari versi @types/node lama; cast hanya utk tipe, data tidak berubah.
    await wb.xlsx.load(buffer as never); // tipe Buffer ExcelJS berbeda dgn @types/node; data tidak berubah
    const sheet = wb.worksheets[0];
    expect(sheet.getCell(1, 1).value).toBe("PT ABDI WARDHANA");
    expect(sheet.getCell(2, 1).value).toBe("Neraca (Balance Sheet)");
    expect(sheet.getCell(3, 1).value).toBe("Periode: 01 Januari 2026 - 31 Januari 2026");

    const values: unknown[] = [];
    sheet.eachRow((row) => values.push(row.getCell(3).value));
    expect(values).toContain(1000);
    expect(values).toContain(6000);
  });
});

/** Ambil teks yang ditampilkan dari PDF: pdfkit menulis teks sbg string hex
 * di dalam operator TJ, jadi dekode potongan-potongan itu lalu gabungkan. */
function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const blocks = [...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) =>
    [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""),
  );
  return blocks.join("\n");
}

describe("PDF", () => {
  // compress:false hanya di test supaya isi content stream bisa dibaca.
  it("nama perusahaan, judul, periode, dan angka muncul di PDF", async () => {
    const buffer = await renderPdf(sampleDocument(), { compress: false });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = extractPdfText(buffer);
    expect(text).toContain("PT ABDI WARDHANA");
    expect(text).toContain("Neraca (Balance Sheet)");
    expect(text).toContain("Periode: 01 Januari 2026 - 31 Januari 2026");
    expect(text).not.toMatch(/[–—]/);
    expect(text).toContain("Rp 6.000");
  });

  it("label gabungan (belum dieliminasi, bukan konsolidasi final) muncul di PDF DAN XLSX; tanpa em/en dash di teks apa pun", async () => {
    const br = (id: string, name: string, head = false) => ({ id, code: id.toUpperCase(), name, status: "ACTIVE", isHeadOffice: head });
    const all = [br("hq", "Kantor Pusat", true), br("m", "Metro"), br("b", "Bandar Lampung")];
    const scope = resolveReportScope({ multiBranchEnabled: true, allBranches: all, accessible: all, context: all[1], canConsolidate: true, rawScope: "all" });
    const doc = { ...sampleDocument(), scopeLabel: scope.label };
    const pdfText = extractPdfText(await renderPdf(doc, { compress: false }));
    expect(pdfText).toContain("Cakupan: Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi");
    expect(pdfText).toContain("bukan laporan konsolidasi final");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderXlsx(doc)) as never);
    const cells: string[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? ""))));
    expect(cells.some((c) => c === "Cakupan: Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi")).toBe(true);
    expect(cells.some((c) => /bukan laporan konsolidasi final/.test(c))).toBe(true);
    expect([pdfText, ...cells].join(" ")).not.toMatch(/[–—]/);
    const selected = resolveReportScope({ multiBranchEnabled: true, allBranches: all, accessible: all, context: all[1], canConsolidate: true, rawScope: "selected:m,b" });
    expect(JSON.stringify(selected.label)).not.toMatch(/[–—]/);
  });

  it("tabel panjang berlanjut ke halaman berikutnya (footer nomor halaman dari beberapa halaman)", async () => {
    const buffer = await renderPdf(sampleDocument(160), { compress: false });
    const pageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(2);
    expect(extractPdfText(buffer)).toContain(`Halaman 2 dari ${pageCount}`);
  });
});
