import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ON_DARK_CHART, useCategoricalPalette, useChartColors } from "../theme/chart-colors.js";
import { formatIDR, formatIDRCompact } from "../lib/format.js";

/**
 * Kartu gelap ala "Balance" di dashboard fintech referensi: angka besar +
 * sparkline tren mini. SENGAJA selalu gelap (bg-navy-700) terlepas dari
 * tema situs -- identitas visual, sama seperti sidebar/header.
 */
export function DarkStatCard({
  label,
  value,
  fullValue,
  deltaLabel,
  deltaPositive,
  icon,
  sparkline,
}: {
  label: string;
  value: string;
  /** Nilai lengkap (belum diringkas) utk tooltip hover -- kartu ini sempit,
   * jadi `value` yang ditampilkan sebaiknya sudah diringkas (mis.
   * formatIDRCompact) supaya tidak overflow/terpotong; angka pastinya tetap
   * bisa dilihat lewat hover. Kalau tidak diisi, `value` dipakai juga utk
   * tooltip. */
  fullValue?: string;
  deltaLabel?: string;
  deltaPositive?: boolean;
  icon?: ReactNode;
  sparkline?: { label: string; value: number }[];
}) {
  return (
    <div className="flex flex-col justify-between overflow-hidden rounded-2xl bg-navy-700 p-5 text-white">
      <div className="mb-4">
        {/* Label + lencana perubahan di satu baris; angka mendapat LEBAR PENUH
            kartu di bawahnya. Dulu lencana ada di samping angka sehingga angka
            penuh (mis. "Rp 63.500.000") terpotong di tengah ("Rp 63.500.0 / 00"). */}
        <div className="mb-1 flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium uppercase tracking-wide text-white/50">
            {icon}
            {label}
          </p>
          {deltaLabel && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                deltaPositive ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300"
              }`}
            >
              {deltaLabel}
            </span>
          )}
        </div>
        <p className="break-words text-2xl font-bold leading-tight tabular-nums" title={fullValue ?? value}>
          {value}
        </p>
      </div>

      {sparkline && sparkline.length >= 2 && (
        <div className="-mx-1 h-14">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkline} margin={{ top: 0, right: 4, left: 4, bottom: 0 }}>
              <Area
                type="monotone"
                dataKey="value"
                stroke={ON_DARK_CHART.accentSoft}
                strokeWidth={2}
                fill={ON_DARK_CHART.accentSoft}
                fillOpacity={0.18}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** Kartu donut chart komposisi (mis. Neraca per baris) -- ikut tema situs. */
export function DonutCard({
  title,
  icon,
  centerValue,
  centerLabel,
  data,
}: {
  title: string;
  icon?: ReactNode;
  centerValue: string;
  centerLabel: string;
  data: { label: string; value: number }[];
}) {
  const colors = useChartColors();
  const palette = useCategoricalPalette();
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <h3 className="font-semibold text-heading">{title}</h3>
      </div>
      <div className="flex items-center gap-6">
        <div className="relative h-36 w-36 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius="70%"
                outerRadius="100%"
                paddingAngle={2}
                stroke="none"
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={palette[i % palette.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number) => formatIDR(value)}
                contentStyle={{ borderRadius: 8, borderColor: colors.gridline, background: colors.surface, fontSize: 12 }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-base font-bold tabular-nums text-heading">{centerValue}</span>
            <span className="text-[11px] text-ink/50">{centerLabel}</span>
          </div>
        </div>
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          {data.map((d, i) => (
            <li key={d.label} className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ink/70" title={d.label}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette[i % palette.length] }} />
                <span className="truncate">{d.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-ink/50">
                {total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : "0%"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Kartu tren multi-garis gelap ala "Compare Costs" di referensi. Tiap seri
 * BOLEH ditandai `axis: "right"` untuk dapat sumbu-Y sendiri di kanan --
 * penting kalau skalanya jauh beda dari seri lain (mis. Laba Bersih yang
 * cuma beberapa persen dari Pendapatan akan tampak RATA DI NOL kalau
 * dipaksa berbagi satu sumbu linear dengan Pendapatan yang jauh lebih
 * besar -- bukan bug data, murni keterbatasan satu sumbu bersama). */
export function DarkTrendCard({
  title,
  icon,
  series,
  data,
}: {
  title: string;
  icon?: ReactNode;
  series: { key: string; label: string; color: string; axis?: "left" | "right" }[];
  data: Record<string, number | string>[];
}) {
  const hasRightAxis = series.some((s) => s.axis === "right");
  return (
    <div className="rounded-2xl bg-navy-700 p-5 text-white">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-semibold">{title}</h3>
        </div>
        <div className="flex items-center gap-3 text-xs text-white/60">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={ON_DARK_CHART.gridline} />
            <XAxis
              dataKey="periodLabel"
              tick={{ fill: ON_DARK_CHART.muted, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="left"
              tick={{ fill: ON_DARK_CHART.muted, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(v) => formatIDRCompact(v)}
            />
            {hasRightAxis && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: ON_DARK_CHART.muted, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={64}
                tickFormatter={(v) => formatIDRCompact(v)}
              />
            )}
            <Tooltip
              formatter={(value: number) => formatIDR(value)}
              contentStyle={{
                borderRadius: 8,
                border: "none",
                background: "#173860",
                color: "#fff",
                fontSize: 12,
              }}
              labelStyle={{ color: ON_DARK_CHART.muted }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                yAxisId={s.axis === "right" ? "right" : "left"}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2.5}
                dot={{ r: 4, fill: s.color, stroke: "#1C2B3A", strokeWidth: 2 }}
                activeDot={{ r: 6 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
