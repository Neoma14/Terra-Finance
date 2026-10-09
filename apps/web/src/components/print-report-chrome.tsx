import type { IndustryTemplate } from "@konsultan/shared";
import { CompanyLogo } from "./avatar.js";

/**
 * Header & footer cetak/PDF SERAGAM dipakai semua laporan tabel biasa (Buku
 * Besar, Chart of Accounts, Kartu Hutang/Piutang, Rasio, Estimasi Pajak,
 * Riwayat Jurnal) -- meniru struktur laporan referensi yang diberikan user
 * (jam+tanggal cetak di kiri atas, nama perusahaan & judul laporan di
 * tengah, rentang tanggal di bawahnya), TAPI dengan identitas TERRA (logo
 * TERRA kecil + nama TERRA) berdampingan dengan logo PERUSAHAAN KLIEN, dan
 * footer copyright TERRA supaya jelas laporan dibuat lewat aplikasi ini.
 *
 * Laporan Neraca/Laba-Rugi/Arus Kas/Perubahan Modal (tab "Laporan"
 * Dashboard) PUNYA layout sendiri (lihat print-statement-report.tsx, sudah
 * ada sidebar navy dgn identitas TERRA) -- komponen ini TIDAK dipakai di
 * situ, tapi prinsip yang sama (logo perusahaan + copyright TERRA) juga
 * diterapkan di sana secara terpisah.
 */
/** Letterhead ringkas tapi "berdesain" -- strip gradien navy->cyan sebagai
 * aksen, identitas perusahaan (logo+nama) di kiri, judul laporan + badge
 * periode di kanan, ditutup garis navy tebal. Dipakai SERAGAM di semua
 * laporan cetak (termasuk Neraca/Laba-Rugi/Ekuitas/Arus-Kas, lihat
 * print-statement-report.tsx) supaya satu identitas visual konsisten,
 * bukan lagi kolom sidebar navy penuh (makan banyak ruang cetak) atau cuma
 * teks polos rata-tengah (terlalu flat/tidak "berkelas"). */
export function PrintReportHeader({
  companyName,
  companyLogoUrl,
  industryTemplate,
  reportTitle,
  rangeLabel,
}: {
  companyName: string;
  companyLogoUrl?: string | null;
  industryTemplate: IndustryTemplate;
  reportTitle: string;
  rangeLabel?: string;
}) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="hidden print:mb-4 print:block">
      <div className="mb-1.5 flex items-center justify-between text-[7px] uppercase tracking-wider text-ink/35">
        <span>Dicetak {timeStr} WIB</span>
        <span>{dateStr}</span>
      </div>
      <div className="mb-2.5 h-[3px] w-full rounded-full bg-[#262030]" />
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <CompanyLogo industryTemplate={industryTemplate} logoUrl={companyLogoUrl} size={32} />
          <div>
            <p className="text-[12.5px] font-bold leading-tight text-heading">{companyName}</p>
            <p className="text-[7px] font-semibold uppercase tracking-wider text-ink/35">Laporan Keuangan</p>
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-[16px] font-bold leading-tight" style={{ color: "#1C2B3A" }}>
            {reportTitle}
          </h2>
          {rangeLabel && (
            <span
              className="mt-1 inline-block rounded-full px-2.5 py-[3px] text-[7.5px] font-semibold"
              style={{ background: "#F5E8DE", color: "#A55D35" }}
            >
              {rangeLabel}
            </span>
          )}
        </div>
      </div>
      <div className="mt-2.5 border-b-2" style={{ borderColor: "#1C2B3A" }} />
    </div>
  );
}

/** Identitas TERRA CUKUP di sini (footer), tidak diulang di header -- supaya
 * header laporan tetap fokus ke identitas klien/judul laporan. */
export function PrintReportFooter() {
  return (
    <div className="hidden print:mt-5 print:block">
      <div className="mb-1.5 h-px w-full bg-[#262030]" style={{ opacity: 0.25 }} />
      <p className="text-center text-[7.5px] text-ink/40">
        TERRA FINANCE -- Analisis Keuangan &amp; Pajak Multi-Klien &copy; {new Date().getFullYear()}
      </p>
    </div>
  );
}
