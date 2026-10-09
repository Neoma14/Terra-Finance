import type { IndustryTemplate } from "@konsultan/shared";
import { ArrowLeft, Building2, HandCoins, HeartPulse, Landmark, type LucideIcon } from "lucide-react";
import type { PropsWithChildren, ReactNode } from "react";
import { Link } from "react-router-dom";

/** Link "Kembali" ke halaman overview perusahaan (tab Chart of
 * Accounts/Jurnal/dst) -- dipakai di semua halaman sub-perusahaan supaya
 * user tidak terjebak tanpa cara balik selain tombol back browser. */
export function BackToCompanyLink({ companySlug }: { companySlug: string }) {
  return (
    <Link to={`/c/${companySlug}`} className="flex w-fit items-center gap-1.5 text-sm text-ink/50 hover:text-ink">
      <ArrowLeft size={14} /> Kembali ke Perusahaan
    </Link>
  );
}

export function Card({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`rounded-xl border border-line bg-surface transition-colors duration-200 ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ title, icon, action }: { title: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-5 py-3.5 transition-colors duration-200">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="font-semibold text-heading">{title}</h3>
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: PropsWithChildren<{ tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info" }>) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-heading",
    accent: "bg-accent-50 text-accent-600",
    success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    warning: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    danger: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
    info: "bg-cyan-500/10 text-cyan-600 dark:bg-cyan-400/15 dark:text-cyan-300",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors duration-200 ${tones[tone]}`}>
      {children}
    </span>
  );
}

export const INDUSTRY_ICONS: Record<IndustryTemplate, LucideIcon> = {
  general: Building2,
  hospital: HeartPulse,
  banking: Landmark,
  cooperative: HandCoins,
};

export const INDUSTRY_COLORS: Record<IndustryTemplate, string> = {
  general: "bg-surface-2 text-heading",
  hospital: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  banking: "bg-accent-50 text-accent-600",
  cooperative: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
};

export function IndustryBadge({ template }: { template: IndustryTemplate }) {
  const Icon = INDUSTRY_ICONS[template];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${INDUSTRY_COLORS[template]}`}>
      <Icon size={12} strokeWidth={2.5} />
      {INDUSTRY_LABELS_SHORT[template]}
    </span>
  );
}

const INDUSTRY_LABELS_SHORT: Record<IndustryTemplate, string> = {
  general: "Korporat",
  hospital: "Rumah Sakit",
  banking: "Perbankan",
  cooperative: "Koperasi",
};

export function KpiCard({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: "neutral" | "positive" | "negative";
}) {
  const valueTone = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-rose-600" : "text-heading";
  return (
    <Card className="min-w-0 overflow-hidden p-5">
      <div className="mb-2 flex items-center gap-2 text-ink/50">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      {/* SENGAJA dibiarkan wrap ke baris berikutnya (bukan truncate/ellipsis)
          -- ini angka keuangan, harus SELALU kelihatan utuh tanpa perlu
          hover, biarpun kartunya jadi lebih tinggi utk angka yang panjang. */}
      <p className={`break-words text-xl font-bold leading-tight tabular-nums ${valueTone}`}>{value}</p>
    </Card>
  );
}
