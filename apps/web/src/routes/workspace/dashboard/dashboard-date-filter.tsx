import { useState } from "react";
import { Card } from "../../../components/ui.js";

/** §23 instruksi: preset tanggal siap pakai + custom range. SEMUA preset
 * dihitung dari tanggal LOKAL browser (bukan UTC) -- `toYMD` memformat
 * manual (bukan `toISOString()`, yang menggeser tanggal sesuai offset
 * timezone & bisa salah hari di dekat tengah malam) supaya konsisten dgn
 * apa yang user lihat di kalender device-nya sendiri. Ini HANYA menghitung
 * rentang tanggal (fromDate/toDate) utk dikirim ke backend -- backend
 * TETAP satu-satunya tempat accounting/fiscal-period logic dijalankan,
 * tidak ada logic baru yang bentrok dgn itu di sini (§23).
 */

export type DatePreset = "today" | "this_week" | "this_month" | "last_month" | "this_quarter" | "this_year" | "last_year" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  today: "Hari Ini",
  this_week: "Minggu Ini",
  this_month: "Bulan Ini",
  last_month: "Bulan Lalu",
  this_quarter: "Kuartal Ini",
  this_year: "Tahun Ini",
  last_year: "Tahun Lalu",
  custom: "Custom",
};

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function presetToRange(preset: DatePreset): { fromDate: string; toDate: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (preset) {
    case "today":
      return { fromDate: toYMD(now), toDate: toYMD(now) };
    case "this_week": {
      // Senin sbg awal minggu (konvensi Indonesia).
      const dow = (now.getDay() + 6) % 7; // Senin=0 ... Minggu=6
      const monday = new Date(now);
      monday.setDate(now.getDate() - dow);
      return { fromDate: toYMD(monday), toDate: toYMD(now) };
    }
    case "this_month":
      return { fromDate: toYMD(new Date(y, m, 1)), toDate: toYMD(now) };
    case "last_month": {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return { fromDate: toYMD(start), toDate: toYMD(end) };
    }
    case "this_quarter": {
      const qStartMonth = Math.floor(m / 3) * 3;
      return { fromDate: toYMD(new Date(y, qStartMonth, 1)), toDate: toYMD(now) };
    }
    case "this_year":
      return { fromDate: toYMD(new Date(y, 0, 1)), toDate: toYMD(now) };
    case "last_year":
      return { fromDate: toYMD(new Date(y - 1, 0, 1)), toDate: toYMD(new Date(y - 1, 11, 31)) };
    case "custom":
      return { fromDate: toYMD(new Date(y, m, 1)), toDate: toYMD(now) };
  }
}

export function DashboardDateFilter({
  preset,
  fromDate,
  toDate,
  onChange,
}: {
  preset: DatePreset;
  fromDate: string;
  toDate: string;
  onChange: (next: { preset: DatePreset; fromDate: string; toDate: string }) => void;
}) {
  function selectPreset(next: DatePreset) {
    if (next === "custom") {
      onChange({ preset: next, fromDate, toDate });
      return;
    }
    onChange({ preset: next, ...presetToRange(next) });
  }

  return (
    <Card className="flex flex-wrap items-center gap-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(PRESET_LABELS) as DatePreset[])
          .filter((p) => p !== "custom")
          .map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => selectPreset(p)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                preset === p ? "bg-accent text-white" : "bg-surface-2 text-ink/60 hover:bg-surface-2/70"
              }`}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
      </div>
      <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
        <input
          type="date"
          value={fromDate}
          onChange={(e) => onChange({ preset: "custom", fromDate: e.target.value, toDate })}
          className="bg-transparent text-sm font-medium text-heading outline-none"
        />
        <span className="text-ink/30">-</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => onChange({ preset: "custom", fromDate, toDate: e.target.value })}
          className="bg-transparent text-sm font-medium text-heading outline-none"
        />
      </div>
    </Card>
  );
}
