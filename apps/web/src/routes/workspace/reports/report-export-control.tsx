import { useRef, useState } from "react";
import { companyApi } from "../../../lib/company-api-client.js";

export type ReportExportKind = "balance-sheet" | "income-statement" | "equity" | "cash-flow" | "trial-balance" | "ledger";
type ExportFileType = "xlsx" | "pdf";

const GENERIC_ERROR = "Gagal membuat laporan. Silakan coba lagi.";

/**
 * Dropdown tipe file + tombol Download untuk laporan yang sedang dibuka
 * (TASK-EXPORT). `params` WAJIB berisi filter halaman yang aktif
 * (fromDate/toDate, atau periodId/accountId), supaya file memakai data
 * yang sama dengan layar. Backend tetap menegakkan auth, company access,
 * dan permission report.read -- komponen ini tidak memutuskan akses.
 */
export function ReportExportControl({
  companySlug,
  kind,
  params,
  disabled = false,
}: {
  companySlug: string;
  kind: ReportExportKind;
  params: Record<string, string>;
  disabled?: boolean;
}) {
  const [fileType, setFileType] = useState<ExportFileType>("xlsx");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref (bukan hanya state) supaya double-click cepat sebelum re-render tetap tercegah.
  const inFlight = useRef(false);

  async function handleDownload() {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ ...params, format: fileType }).toString();
      await companyApi.download(`/${companySlug}/reports/export/${kind}?${query}`, `${kind}.${fileType}`);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-ink/60">
        Tipe File
        <select
          className="input-base w-44"
          value={fileType}
          onChange={(e) => setFileType(e.target.value as ExportFileType)}
          disabled={busy}
        >
          <option value="xlsx">Excel (.xlsx)</option>
          <option value="pdf">PDF (.pdf)</option>
        </select>
      </label>
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy || disabled}
        className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
      >
        {busy ? "Downloading..." : "Download"}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
