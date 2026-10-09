import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useTaxSettings, useTaxSummary, useUpdateTaxSettings } from "../../../features/workspace/use-tax.js";
import { DashboardDateFilter, presetToRange, type DatePreset } from "../dashboard/dashboard-date-filter.js";

const VAT_STATUS_OPTIONS = [
  { value: "kena_pajak", label: "PKP (Kena Pajak)" },
  { value: "non_pkp", label: "Non-PKP" },
];

/**
 * Pajak (TASK-023 §7) -- PENGGANTI UI legacy `/c/:slug/tax`. "Dasar
 * pengenaan" HANYA angka revenue periode terpilih, dari Income Statement
 * yang sama dgn Dashboard/Laporan Keuangan -- TIDAK ADA pajak terhutang
 * dihitung di sini (tidak ada tax engine, §7 instruksi eksplisit: jangan
 * mengarang tarif). Bagian bawah adalah referensi pajak perusahaan
 * (status PPN, fasilitas UMKM, catatan) yang BISA diedit OWNER/ADMIN.
 */
export function TaxPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const canEdit = company.role === "OWNER" || company.role === "ADMIN";
  const [preset, setPreset] = useState<DatePreset>("this_month");
  const [range, setRange] = useState(() => presetToRange("this_month"));

  const summaryQuery = useTaxSummary(company.slug, range.fromDate, range.toDate);
  const settingsQuery = useTaxSettings(company.slug);
  const update = useUpdateTaxSettings(company.slug);

  const [vatStatus, setVatStatus] = useState("kena_pajak");
  const [umkmYears, setUmkmYears] = useState(3);
  const [legalFormNote, setLegalFormNote] = useState("");
  const [vatDescription, setVatDescription] = useState("");
  const [vatLegalBasis, setVatLegalBasis] = useState("");
  const [generalNotes, setGeneralNotes] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const s = settingsQuery.data?.settings;
    if (!s) return;
    setVatStatus(s.vatStatus);
    setUmkmYears(s.umkmFacilityYears);
    setLegalFormNote(s.legalFormNote);
    setVatDescription(s.vatDescription);
    setVatLegalBasis(s.vatLegalBasis);
    setGeneralNotes(s.generalNotes.join("\n"));
  }, [settingsQuery.data?.settings]);

  async function handleSave() {
    await update.mutateAsync({
      vatStatus,
      umkmFacilityYears: umkmYears,
      legalFormNote,
      vatDescription,
      vatLegalBasis,
      generalNotes: generalNotes.split("\n").map((s) => s.trim()).filter(Boolean),
    });
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 2500);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Pajak</h1>
        <p className="text-sm text-ink/50">Ringkasan dasar pengenaan dan referensi pajak {company.name}.</p>
      </div>

      <DashboardDateFilter
        preset={preset}
        fromDate={range.fromDate}
        toDate={range.toDate}
        onChange={(next) => {
          setPreset(next.preset);
          setRange({ fromDate: next.fromDate, toDate: next.toDate });
        }}
      />

      <Card className="p-4">
        {summaryQuery.isLoading ? (
          <p className="text-sm text-ink/40">Memuat...</p>
        ) : summaryQuery.isError ? (
          <p className="text-sm text-rose-600">{(summaryQuery.error as Error).message}</p>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink/50">Dasar Pengenaan (Pendapatan Periode Ini)</p>
              <p className="text-lg font-bold tabular-nums text-heading">{formatIDR(summaryQuery.data?.revenue ?? 0)}</p>
            </div>
            <p className="max-w-xs text-right text-xs text-ink/40">
              Angka ini bukan pajak terhutang -- hitung besaran pajak sesuai konsultasi dengan konsultan pajak/kantor pajak.
            </p>
          </div>
        )}
      </Card>

      {settingsQuery.isLoading && <Card className="p-6 text-sm text-ink/40">Memuat pengaturan...</Card>}
      {settingsQuery.isError && <Card className="p-6 text-sm text-rose-600">{(settingsQuery.error as Error).message}</Card>}

      {!settingsQuery.isLoading && !settingsQuery.isError && (
        <Card className="max-w-2xl p-6">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink/40">Referensi Pajak</h3>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Status PPN</label>
              <select value={vatStatus} onChange={(e) => setVatStatus(e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60">
                {VAT_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Sisa Tahun Fasilitas UMKM</label>
              <input type="number" min={0} value={umkmYears} onChange={(e) => setUmkmYears(Number(e.target.value))} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </div>
          </div>

          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Catatan Bentuk Legalitas</label>
            <textarea value={legalFormNote} onChange={(e) => setLegalFormNote(e.target.value)} disabled={!canEdit} rows={2} className="input-base w-full disabled:opacity-60" />
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Deskripsi PPN</label>
              <textarea value={vatDescription} onChange={(e) => setVatDescription(e.target.value)} disabled={!canEdit} rows={2} className="input-base w-full disabled:opacity-60" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink/60">Dasar Hukum PPN</label>
              <textarea value={vatLegalBasis} onChange={(e) => setVatLegalBasis(e.target.value)} disabled={!canEdit} rows={2} className="input-base w-full disabled:opacity-60" />
            </div>
          </div>

          <div className="mb-5">
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Catatan Umum (satu baris per catatan)</label>
            <textarea value={generalNotes} onChange={(e) => setGeneralNotes(e.target.value)} disabled={!canEdit} rows={4} className="input-base w-full disabled:opacity-60" />
          </div>

          {update.isError && <p className="mb-3 text-sm text-rose-600">{(update.error as Error).message}</p>}
          {savedAt && <p className="mb-3 text-sm text-emerald-600">✓ Referensi pajak disimpan.</p>}

          {canEdit ? (
            <button type="button" disabled={update.isPending} onClick={handleSave} className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
              {update.isPending ? "Menyimpan..." : "Simpan Referensi Pajak"}
            </button>
          ) : (
            <p className="text-xs text-ink/40">Hanya OWNER/ADMIN yang dapat mengubah referensi pajak.</p>
          )}
        </Card>
      )}
    </div>
  );
}
