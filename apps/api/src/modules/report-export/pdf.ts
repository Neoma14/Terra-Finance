import PDFDocument from "pdfkit";
import type { DocRow, ReportDocument } from "./document.js";

const NAVY = "#1C2B3A";
const BAND = "#EAF1F7";
const MUTED = "#6B7280";
const RULE = "#9CA3AF";
const MARGIN = 40;
const FONT_SIZE = 9;
const CELL_PADDING = 4;

const idrFormatter = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });

/** Format SAMA dengan UI (`lib/format.ts` formatIDR): "Rp 1.000", negatif "-Rp 1.000". */
export function formatIdr(value: number): string {
  // `value + 0` mengubah -0 menjadi 0 supaya tidak tampil "-Rp 0".
  return idrFormatter.format(value + 0).replace(/ /g, " ");
}

/** Font standar PDF (Helvetica, WinAnsi) hanya punya glyph Latin-1. En dash
 * "–" (rentang periode) diganti "-"; karakter lain di luar Latin-1 diganti
 * "?" supaya tidak tampil sebagai kotak/"�" yang rusak. */
export function pdfSafe(text: string): string {
  return text.replace(/–/g, "-").replace(/[^\u0000-ÿ]/g, "?");
}

function cellText(value: string | number | null, type: "text" | "number"): string {
  if (value === null) return "";
  if (type === "number" && typeof value === "number") return formatIdr(value);
  return pdfSafe(String(value));
}

/** Render model dokumen ke PDF A4. Tabel panjang otomatis berlanjut ke
 * halaman berikutnya dengan header kolom diulang. `compress` hanya
 * dimatikan di test (supaya teks bisa dicari di dalam byte PDF). */
export function renderPdf(doc: ReportDocument, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: 0, left: MARGIN, right: MARGIN },
      bufferPages: true,
      compress: options.compress ?? true,
      info: { Title: `${doc.companyName} - ${doc.title}`, Author: "TERRA FINANCE", Creator: "TERRA FINANCE" },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const pageWidth = pdf.page.width - MARGIN * 2;
    const pageBottom = pdf.page.height - 60;
    const totalWeight = doc.columns.reduce((sum, c) => sum + c.width, 0);
    const widths = doc.columns.map((c) => (c.width / totalWeight) * pageWidth);
    const xs = widths.reduce<number[]>((acc, w, i) => [...acc, i === 0 ? MARGIN : acc[i - 1] + widths[i - 1]], []);

    function drawTitleBlock() {
      pdf.font("Helvetica-Bold").fontSize(14).fillColor(NAVY).text(pdfSafe(doc.companyName), MARGIN, MARGIN, { width: pageWidth });
      pdf.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text(pdfSafe(doc.title), { width: pageWidth });
      pdf.font("Helvetica").fontSize(9).fillColor(MUTED).text(pdfSafe(`Periode: ${doc.periodLabel}`), { width: pageWidth });
      if (doc.scopeLabel) {
        pdf.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text(pdfSafe(`Cakupan: ${doc.scopeLabel.title}`), { width: pageWidth });
        for (const warning of doc.scopeLabel.warnings) pdf.font("Helvetica").fontSize(8).fillColor(MUTED).text(pdfSafe(`Catatan: ${warning}`), { width: pageWidth });
      }
      pdf.moveDown(0.8);
    }

    function drawTableHeader(y: number): number {
      const height = 20;
      pdf.rect(MARGIN, y, pageWidth, height).fill(NAVY);
      doc.columns.forEach((col, i) => {
        pdf.font("Helvetica-Bold").fontSize(FONT_SIZE).fillColor("#FFFFFF").text(col.header, xs[i] + CELL_PADDING, y + 6, {
          width: widths[i] - CELL_PADDING * 2,
          align: col.align,
          lineBreak: false,
        });
      });
      return y + height;
    }

    function rowHeight(row: DocRow): number {
      let max = 0;
      doc.columns.forEach((col, i) => {
        const text = cellText(row.cells[i] ?? null, col.type);
        if (!text) return;
        pdf.font(row.style === "subtotal" || row.style === "total" || row.style === "section" ? "Helvetica-Bold" : "Helvetica").fontSize(FONT_SIZE);
        const h = pdf.heightOfString(text, { width: widths[i] - CELL_PADDING * 2 });
        max = Math.max(max, h);
      });
      return Math.max(max, FONT_SIZE) + 8;
    }

    function drawRow(row: DocRow, y: number, height: number) {
      if (row.style === "section") pdf.rect(MARGIN, y, pageWidth, height).fill(BAND);
      doc.columns.forEach((col, i) => {
        const text = cellText(row.cells[i] ?? null, col.type);
        const bold = row.style === "subtotal" || row.style === "total" || row.style === "section";
        const color = row.style === "section" ? NAVY : row.style === "note" ? MUTED : "#111827";
        pdf
          .font(row.style === "note" ? "Helvetica-Oblique" : bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(FONT_SIZE)
          .fillColor(color)
          .text(text, xs[i] + CELL_PADDING, y + 4, { width: widths[i] - CELL_PADDING * 2, align: col.align });
      });
      if (row.style === "subtotal" || row.style === "total") {
        pdf.moveTo(MARGIN, y).lineTo(MARGIN + pageWidth, y).lineWidth(row.style === "total" ? 1 : 0.5).strokeColor(RULE).stroke();
      }
    }

    drawTitleBlock();
    let y = drawTableHeader(pdf.y);
    for (const row of doc.rows) {
      const h = rowHeight(row);
      if (y + h > pageBottom) {
        pdf.addPage();
        y = drawTableHeader(MARGIN);
      }
      drawRow(row, y, h);
      y += h;
    }

    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf
        .font("Helvetica")
        .fontSize(8)
        .fillColor(MUTED)
        .text(pdfSafe(`TERRA FINANCE  |  ${doc.companyName}  |  Halaman ${i + 1} dari ${range.count}`), MARGIN, pdf.page.height - 36, {
          width: pageWidth,
          align: "center",
          lineBreak: false,
        });
    }

    pdf.end();
  });
}
