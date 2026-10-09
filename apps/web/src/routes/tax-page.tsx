import type { TaxReferenceUpdateInput, VatStatus } from "@konsultan/shared";
import { AlertTriangle, BadgeCheck, Download, Info, Landmark, Pencil, Plus, Printer, Receipt, Save, ScrollText, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PrintReportFooter, PrintReportHeader } from "../components/print-report-chrome.js";
import { BackToCompanyLink, Card, CardHeader } from "../components/ui.js";
import { useCompanies } from "../features/companies/use-companies.js";
import { usePeriods } from "../features/statements/use-statements.js";
import { useDownloadTaxEstimateExcel, useTaxEstimateRange, useTaxReference, useUpdateTaxReference } from "../features/tax/use-tax.js";
import { formatIDR } from "../lib/format.js";

const VAT_STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  kena_pajak: { label: "Kena PPN Normal", tone: "bg-surface-2 text-heading" },
  dikecualikan: { label: "Bukan Objek PPN", tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  dibebaskan: { label: "Dibebaskan dari PPN", tone: "bg-accent-50 text-accent-600" },
  campuran: { label: "Campuran (Sebagian Kena, Sebagian Tidak)", tone: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
};

/** Estimasi PPh Badan (Normal Pasal 31E vs Final UMKM) & referensi PPN/
 * pemotongan pajak per perusahaan -- sama persis logikanya dgn versi
 * online (routes/tax-page.tsx), termasuk Print/PDF & Download Excel. */
export function TaxPage() {
  const { companySlug = "" } = useParams();
  const { data: companiesData } = useCompanies();
  const company = companiesData?.companies.find((c) => c.slug === companySlug);
  const companyName = company?.name ?? companySlug;
  const { data: periodsData, isLoading: periodsLoading } = usePeriods(companySlug);
  const periods = periodsData?.periods ?? [];
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  useEffect(() => {
    if (!from && !to && periods.length > 0) {
      setFrom(periods[0].startDate.slice(0, 10));
      setTo(periods[0].endDate.slice(0, 10));
    }
  }, [periods, from, to]);

  const { data: refData } = useTaxReference(companySlug);
  const { data: estimateData, isLoading: estimateLoading } = useTaxEstimateRange(companySlug, from, to);
  const updateReference = useUpdateTaxReference(companySlug);
  const downloadExcel = useDownloadTaxEstimateExcel(companySlug);
  const rangeLabel = from && to ? `${from} s/d ${to}` : "";

  const reference = refData?.reference;
  const estimate = estimateData?.estimate;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TaxReferenceUpdateInput | null>(null);

  function startEdit() {
    if (!reference) return;
    setDraft({
      umkmFacilityYears: reference.umkmFacilityYears,
      legalFormNote: reference.legalFormNote,
      vat: { ...reference.vat },
      withholdingNotes: reference.withholdingNotes.map((n) => ({ ...n })),
      generalNotes: [...reference.generalNotes],
    });
    setEditing(true);
  }

  async function handleSave() {
    if (!draft) return;
    await updateReference.mutateAsync(draft);
    setEditing(false);
    setDraft(null);
  }

  if (periodsLoading) return <p className="text-ink/50">Memuat...</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <BackToCompanyLink companySlug={companySlug} />
      </div>
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="vt-page-title text-xl font-bold text-heading">Estimasi Pajak</h1>
          <p className="text-sm text-ink/50">Estimasi PPh Badan untuk rentang tanggal pilihan & referensi peraturan sesuai jenis industri.</p>
        </div>
        {periods.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
              <label className="text-xs font-medium text-ink/50">Dari</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
              <span className="text-ink/30">-</span>
              <label className="text-xs font-medium text-ink/50">Sampai</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              title="Print / Simpan sebagai PDF"
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent"
            >
              <Printer size={14} /> Print / PDF
            </button>
            <button
              type="button"
              onClick={() => from && to && downloadExcel.mutate({ from, to })}
              disabled={!from || !to || downloadExcel.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
            >
              <Download size={14} /> {downloadExcel.isPending ? "Menyiapkan..." : "Download Excel"}
            </button>
          </div>
        )}
      </div>

      {periods.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink/50">
          Belum ada data periode. Posting jurnal dulu lewat menu "Jurnal".
        </Card>
      ) : estimateLoading ? (
        <p className="text-ink/50">Memuat...</p>
      ) : !estimate ? (
        <p className="text-ink/50">Data Kosong</p>
      ) : (
        <div className="print-area flex flex-col gap-6">
          <PrintReportHeader
            companyName={companyName}
            companyLogoUrl={company?.logoUrl}
            industryTemplate={company?.industryTemplate ?? "general"}
            reportTitle="Estimasi Pajak"
            rangeLabel={rangeLabel}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <TaxOptionCard
              title="PPh Badan Normal (Pasal 31E)"
              amount={estimate.pphNormal.amountDue}
              recommended={estimate.recommendation === "normal"}
              rows={estimate.pphNormal.brackets.map((b) => ({
                label: `${b.label} (${(b.rate * 100).toFixed(1)}%)`,
                value: formatIDR(b.amount * b.rate),
              }))}
              footnote={
                estimate.pphNormal.facilityApplied === "full"
                  ? "Fasilitas Pasal 31E penuh (omzet ≤ Rp4,8 miliar) -- tarif efektif 11%."
                  : estimate.pphNormal.facilityApplied === "partial"
                    ? "Fasilitas Pasal 31E sebagian (omzet Rp4,8-50 miliar)."
                    : "Tidak dapat fasilitas Pasal 31E (omzet > Rp50 miliar)."
              }
            />
            <TaxOptionCard
              title="PPh Final UMKM (PP 55/2022)"
              amount={estimate.pphUmkmFinal.amountDue}
              recommended={estimate.recommendation === "umkm_final"}
              disabled={!estimate.pphUmkmFinal.eligible}
              rows={[{ label: `0,5% x Omzet Bruto (${formatIDR(estimate.pphUmkmFinal.grossRevenue)})`, value: formatIDR(estimate.pphUmkmFinal.amountDue) }]}
              footnote={
                estimate.pphUmkmFinal.eligible
                  ? `Berlaku maksimal ${estimate.pphUmkmFinal.facilityYears} tahun pajak sejak terdaftar/pertama kali memenuhi syarat -- opsi PENGGANTI PPh Badan normal, bukan tambahan.`
                  : "Tidak memenuhi syarat (omzet melebihi Rp4,8 miliar/tahun)."
              }
            />
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <p>{estimate.disclaimer}</p>
          </div>
          <PrintReportFooter />
        </div>
      )}

      {reference && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/40">Referensi Peraturan (Bisa Diedit)</h2>
            {!editing ? (
              <button onClick={startEdit} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-heading hover:bg-surface-2">
                <Pencil size={14} /> Edit Referensi
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setEditing(false);
                    setDraft(null);
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-ink/60 hover:bg-surface-2"
                >
                  <X size={14} /> Batal
                </button>
                <button
                  onClick={handleSave}
                  disabled={updateReference.isPending}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
                >
                  <Save size={14} /> {updateReference.isPending ? "Menyimpan..." : "Simpan"}
                </button>
              </div>
            )}
          </div>

          <Card>
            <CardHeader title="Perlakuan PPN" icon={<Receipt size={16} className="text-heading/60" />} />
            <div className="p-5 pt-0">
              {!editing || !draft ? (
                <>
                  <span className={`mb-2 inline-block rounded-full px-2.5 py-1 text-xs font-medium ${VAT_STATUS_LABEL[reference.vat.status].tone}`}>
                    {VAT_STATUS_LABEL[reference.vat.status].label}
                  </span>
                  <p className="mb-2 text-sm text-ink/70">{reference.vat.description}</p>
                  <p className="flex items-center gap-1.5 text-xs text-ink/40">
                    <ScrollText size={12} />
                    Dasar hukum: {reference.vat.legalBasis}
                  </p>
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <select
                    value={draft.vat.status}
                    onChange={(e) => setDraft({ ...draft, vat: { ...draft.vat, status: e.target.value as VatStatus } })}
                    className="input-base w-fit"
                  >
                    {Object.entries(VAT_STATUS_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={draft.vat.description}
                    onChange={(e) => setDraft({ ...draft, vat: { ...draft.vat, description: e.target.value } })}
                    rows={3}
                    className="input-base"
                  />
                  <input
                    value={draft.vat.legalBasis}
                    onChange={(e) => setDraft({ ...draft, vat: { ...draft.vat, legalBasis: e.target.value } })}
                    placeholder="Dasar hukum"
                    className="input-base"
                  />
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Kewajiban Pemotongan Pajak" icon={<BadgeCheck size={16} className="text-heading/60" />} />
            <div className="flex flex-col gap-4 p-5 pt-0">
              {(!editing || !draft ? reference.withholdingNotes : draft.withholdingNotes).map((note, i) => (
                <div key={i} className="rounded-lg border border-line p-3">
                  {!editing || !draft ? (
                    <>
                      <p className="mb-1 text-sm font-semibold text-heading">{note.title}</p>
                      <p className="mb-1.5 text-sm text-ink/70">{note.description}</p>
                      <p className="flex items-center gap-1.5 text-xs text-ink/40">
                        <ScrollText size={12} />
                        {note.legalBasis}
                      </p>
                    </>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <input
                          value={note.title}
                          onChange={(e) => {
                            const notes = [...draft.withholdingNotes];
                            notes[i] = { ...notes[i], title: e.target.value };
                            setDraft({ ...draft, withholdingNotes: notes });
                          }}
                          placeholder="Judul"
                          className="input-base flex-1 font-medium"
                        />
                        <button
                          onClick={() => setDraft({ ...draft, withholdingNotes: draft.withholdingNotes.filter((_, idx) => idx !== i) })}
                          className="text-ink/30 hover:text-rose-500"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <textarea
                        value={note.description}
                        onChange={(e) => {
                          const notes = [...draft.withholdingNotes];
                          notes[i] = { ...notes[i], description: e.target.value };
                          setDraft({ ...draft, withholdingNotes: notes });
                        }}
                        rows={2}
                        className="input-base"
                      />
                      <input
                        value={note.legalBasis}
                        onChange={(e) => {
                          const notes = [...draft.withholdingNotes];
                          notes[i] = { ...notes[i], legalBasis: e.target.value };
                          setDraft({ ...draft, withholdingNotes: notes });
                        }}
                        placeholder="Dasar hukum"
                        className="input-base"
                      />
                    </div>
                  )}
                </div>
              ))}
              {editing && draft && (
                <button
                  onClick={() => setDraft({ ...draft, withholdingNotes: [...draft.withholdingNotes, { title: "", description: "", legalBasis: "" }] })}
                  className="flex w-fit items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <Plus size={14} /> Tambah Kewajiban
                </button>
              )}
              {!editing && reference.withholdingNotes.length === 0 && <p className="text-sm text-ink/40">Belum ada catatan.</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Catatan Umum" icon={<Landmark size={16} className="text-heading/60" />} />
            <div className="flex flex-col gap-3 p-5 pt-0">
              {!editing || !draft ? (
                <ul className="flex flex-col gap-2 text-sm text-ink/70">
                  <li className="flex items-start gap-2">
                    <Info size={14} className="mt-0.5 shrink-0 text-ink/40" />
                    {reference.legalFormNote}
                  </li>
                  {reference.generalNotes.map((note, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Info size={14} className="mt-0.5 shrink-0 text-ink/40" />
                      {note}
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink/60">Catatan Bentuk Badan & Fasilitas UMKM</label>
                    <textarea value={draft.legalFormNote} onChange={(e) => setDraft({ ...draft, legalFormNote: e.target.value })} rows={2} className="input-base" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink/60">Masa Fasilitas UMKM (tahun pajak)</label>
                    <input
                      type="number"
                      value={draft.umkmFacilityYears}
                      onChange={(e) => setDraft({ ...draft, umkmFacilityYears: Number(e.target.value) })}
                      className="input-base w-24"
                    />
                  </div>
                  {draft.generalNotes.map((note, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={note}
                        onChange={(e) => {
                          const notes = [...draft.generalNotes];
                          notes[i] = e.target.value;
                          setDraft({ ...draft, generalNotes: notes });
                        }}
                        className="input-base flex-1"
                      />
                      <button onClick={() => setDraft({ ...draft, generalNotes: draft.generalNotes.filter((_, idx) => idx !== i) })} className="text-ink/30 hover:text-rose-500">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setDraft({ ...draft, generalNotes: [...draft.generalNotes, ""] })}
                    className="flex w-fit items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                  >
                    <Plus size={14} /> Tambah Catatan
                  </button>
                </>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function TaxOptionCard({
  title,
  amount,
  recommended,
  disabled,
  rows,
  footnote,
}: {
  title: string;
  amount: number;
  recommended: boolean;
  disabled?: boolean;
  rows: { label: string; value: string }[];
  footnote: string;
}) {
  return (
    <Card className={`p-5 ${recommended ? "border-accent outline outline-1 outline-accent" : ""} ${disabled ? "opacity-50" : ""}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold text-heading">{title}</h3>
        {recommended && <span className="rounded-full bg-accent-50 px-2.5 py-0.5 text-xs font-medium text-accent-600">Lebih Hemat</span>}
      </div>
      <p className="mb-3 text-2xl font-bold tabular-nums text-heading">{formatIDR(amount)}</p>
      <div className="mb-3 flex flex-col gap-1 text-sm text-ink/60">
        {rows.map((r, i) => (
          <div key={i} className="flex justify-between gap-2">
            <span>{r.label}</span>
            <span className="tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink/40">{footnote}</p>
    </Card>
  );
}
