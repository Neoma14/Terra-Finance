import { Card } from "../../../components/ui.js";

/** Filter tanggal dipakai SELURUH tab report (TASK-DB-ARCH-017 §10) --
 * satu komponen, bukan 4 implementasi berbeda. Reaktif langsung (ubah
 * tanggal = refetch, lewat react-query queryKey) -- tidak perlu tombol
 * "Apply" terpisah. */
export function ReportDateFilter({
  fromDate,
  toDate,
  onChange,
}: {
  fromDate: string;
  toDate: string;
  onChange: (next: { fromDate: string; toDate: string }) => void;
}) {
  return (
    <Card className="flex flex-wrap items-end gap-3 p-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink/60">Dari Tanggal</label>
        <input type="date" value={fromDate} onChange={(e) => onChange({ fromDate: e.target.value, toDate })} className="input-base" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink/60">Sampai Tanggal</label>
        <input type="date" value={toDate} onChange={(e) => onChange({ fromDate, toDate: e.target.value })} className="input-base" />
      </div>
    </Card>
  );
}
