import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CompanyApiError } from "../../lib/company-api-client.js";
import { useCreateCompanyDb, type CreatedCompany } from "../../features/workspace/use-workspace.js";
import { useEscapeToClose } from "../../lib/use-escape-to-close.js";

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function toUserMessage(err: unknown): string {
  if (err instanceof CompanyApiError) {
    if (err.status === 401) return "Sesi Anda sudah berakhir. Silakan login ulang.";
    if (err.status === 403) return "Anda tidak memiliki izin untuk membuat perusahaan.";
    if (err.status === 409) return err.message;
    if (err.status >= 500) return "Perusahaan gagal dibuat karena kesalahan di server. Coba lagi beberapa saat.";
    return err.message;
  }
  return "Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.";
}

export function AddCompanyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (company: CreatedCompany) => void }) {
  useEscapeToClose(onClose);
  const createCompany = useCreateCompanyDb();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("IDR");
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState(1);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Nama perusahaan wajib diisi.");
      return;
    }
    const slug = slugify(trimmed);
    if (!slug) {
      setError("Nama perusahaan harus mengandung huruf atau angka.");
      return;
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      setError("Mata uang harus 3 huruf, misalnya IDR.");
      return;
    }
    try {
      const created = await createCompany.mutateAsync({ name: trimmed, slug, currency, fiscalYearStartMonth });
      onCreated(created);
    } catch (err) {
      setError(toUserMessage(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <form
        onSubmit={handleSubmit}
        className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-line bg-surface"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Tambah Perusahaan</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink" aria-label="Tutup">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
          <div>
            <label htmlFor="company-name" className="mb-1.5 block text-xs font-medium text-ink/60">
              Nama Perusahaan <span className="text-rose-600">*</span>
            </label>
            <input
              id="company-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-base w-full"
              placeholder="mis. PT ABDI WARDHANA"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="company-currency" className="mb-1.5 block text-xs font-medium text-ink/60">
                Mata Uang
              </label>
              <input
                id="company-currency"
                value={currency}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                className="input-base w-full"
              />
            </div>
            <div>
              <label htmlFor="company-fiscal-month" className="mb-1.5 block text-xs font-medium text-ink/60">
                Awal Tahun Fiskal
              </label>
              <select
                id="company-fiscal-month"
                value={fiscalYearStartMonth}
                onChange={(e) => setFiscalYearStartMonth(Number(e.target.value))}
                className="input-base w-full"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-300">{error}</p>}
        </div>

        <div className="flex gap-2 border-t border-line px-6 py-4">
          <button
            type="submit"
            disabled={createCompany.isPending}
            className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
          >
            {createCompany.isPending ? "Membuat perusahaan..." : "Buat Perusahaan"}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            Batal
          </button>
        </div>
      </form>
    </div>
  );
}
