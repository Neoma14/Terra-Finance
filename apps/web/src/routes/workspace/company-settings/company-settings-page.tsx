import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import { addDaysIso } from "../../../lib/date.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useCompanyProfile, useUpdateCompanyProfile } from "../../../features/workspace/use-company-profile.js";
import { useJournalSettings, useUpdateJournalSettings } from "../../../features/workspace/use-journal.js";

const MONTH_LABELS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/**
 * Pengaturan Perusahaan (TASK-023 §13) -- BEDA dari global Settings
 * (`/settings`, akun user/tema, tetap terpisah). Ini subset konfigurasi
 * akuntansi dari tabel yang SAMA dgn Profil Perusahaan (`company_profile`)
 * -- currency & bulan mulai tahun fiskal, satu-satunya field operasional
 * yang memang ada di skema. Field lain (identitas/alamat) ada di menu
 * "Perusahaan", BUKAN diduplikasi di sini.
 */
/** Pengaturan Jurnal: batas backdate. Hanya OWNER/ADMIN yang dapat mengubah
 * (ditegakkan di server); semua peran dapat melihat. */
function JournalSettingsCard({ companySlug, canEdit }: { companySlug: string; canEdit: boolean }) {
  const { data } = useJournalSettings(companySlug);
  const update = useUpdateJournalSettings(companySlug);
  const [days, setDays] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDays(data.maxBackdateDays === null ? "" : String(data.maxBackdateDays));
  }, [data]);

  const parsed = days.trim() === "" ? null : Number(days);
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650);
  const changed = data && parsed !== data.maxBackdateDays;

  async function handleSave() {
    await update.mutateAsync(parsed);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <Card className="max-w-md p-6">
      <h2 className="mb-1 text-base font-bold text-heading">Pengaturan Jurnal</h2>
      <p className="mb-4 text-xs text-ink/50">Tanggal jurnal tidak boleh melewati hari ini. Batas mundur (backdate) dapat diatur di sini.</p>
      <label className="mb-1.5 block text-xs font-medium text-ink/60">Maksimal Backdate (hari)</label>
      <input
        type="number"
        min={0}
        max={3650}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        disabled={!canEdit}
        placeholder="Kosong = tanpa batas"
        className="input-base w-full disabled:opacity-60"
      />
      <p className="mt-1 text-xs text-ink/40">
        {data
          ? parsed === null
            ? `Saat ini tanpa batas mundur. Tanggal maksimal: hari ini (${data.today}).`
            : `Tanggal jurnal yang boleh dibuat: ${addDaysIso(data.today, -parsed)} s/d ${data.today} (hari ini).`
          : ""}
      </p>
      {invalid && <p className="mt-2 text-sm text-rose-600">Isi bilangan bulat 0 sampai 3650, atau kosongkan.</p>}
      {update.isError && <p className="mt-2 text-sm text-rose-600">{(update.error as Error).message}</p>}
      {saved && <p className="mt-2 text-sm text-emerald-600">✓ Pengaturan jurnal disimpan.</p>}
      {canEdit ? (
        <button
          type="button"
          disabled={!changed || invalid || update.isPending}
          onClick={handleSave}
          className="mt-4 rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
        >
          {update.isPending ? "Menyimpan..." : "Simpan"}
        </button>
      ) : (
        <p className="mt-3 text-xs text-ink/40">Hanya Owner/Admin yang dapat mengubah pengaturan ini.</p>
      )}
    </Card>
  );
}

export function CompanySettingsPage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const { data, isLoading, isError, error } = useCompanyProfile(company.slug);
  const update = useUpdateCompanyProfile(company.slug);
  const canEdit = company.role === "OWNER" || company.role === "ADMIN";

  const [currency, setCurrency] = useState("IDR");
  const [fiscalMonth, setFiscalMonth] = useState(1);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data?.profile) {
      setCurrency(data.profile.currency);
      setFiscalMonth(data.profile.fiscalYearStartMonth);
    }
  }, [data?.profile]);

  async function handleSave() {
    await update.mutateAsync({ currency, fiscalYearStartMonth: fiscalMonth });
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 2500);
  }

  const changed = data?.profile && (data.profile.currency !== currency || data.profile.fiscalYearStartMonth !== fiscalMonth);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Pengaturan Perusahaan</h1>
        <p className="text-sm text-ink/50">Konfigurasi dasar akuntansi untuk {company.name}.</p>
      </div>

      {isLoading && <Card className="p-6 text-sm text-ink/40">Memuat...</Card>}
      {isError && <Card className="p-6 text-sm text-rose-600">{(error as Error).message}</Card>}

      {!isLoading && !isError && (
        <Card className="max-w-md p-6">
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Mata Uang</label>
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} disabled={!canEdit} maxLength={3} className="input-base w-full disabled:opacity-60" />
            <p className="mt-1 text-xs text-ink/40">Kode mata uang ISO 3 huruf, mis. IDR.</p>
          </div>

          <div className="mb-5">
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Bulan Mulai Tahun Fiskal</label>
            <select value={fiscalMonth} onChange={(e) => setFiscalMonth(Number(e.target.value))} disabled={!canEdit} className="input-base w-full disabled:opacity-60">
              {MONTH_LABELS.map((label, i) => (
                <option key={i + 1} value={i + 1}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink/40">Berlaku untuk periode fiskal yang dibuat setelah pengaturan ini disimpan.</p>
          </div>

          {update.isError && <p className="mb-3 text-sm text-rose-600">{(update.error as Error).message}</p>}
          {savedAt && <p className="mb-3 text-sm text-emerald-600">✓ Pengaturan disimpan.</p>}

          {canEdit ? (
            <button
              type="button"
              disabled={!changed || update.isPending}
              onClick={handleSave}
              className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
            >
              {update.isPending ? "Menyimpan..." : "Simpan Pengaturan"}
            </button>
          ) : (
            <p className="text-xs text-ink/40">Hanya OWNER/ADMIN yang dapat mengubah pengaturan ini.</p>
          )}
        </Card>
      )}
      <JournalSettingsCard companySlug={company.slug} canEdit={canEdit} />
    </div>
  );
}
