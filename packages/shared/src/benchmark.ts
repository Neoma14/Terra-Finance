import type { IndustryTemplate } from "./company.js";
import type { RatioFormat } from "./ratios.js";

export interface BenchmarkMetric {
  code: string;
  label: string;
  format: RatioFormat;
  value: number;
}

export interface BenchmarkCompany {
  companyId: string;
  companyName: string;
  companySlug: string;
  industryTemplate: IndustryTemplate;
  periodLabel: string;
  periodEndDate: string;
  /** Metrik universal (Pendapatan, Laba Bersih, Total Aset, dst) -- selalu
   * ada & bisa dibandingkan lintas industri apapun. */
  universalMetrics: BenchmarkMetric[];
  /** Rasio spesifik sesuai template industri perusahaan ini -- HANYA
   * bermakna dibandingkan dengan perusahaan template yang sama. */
  industryMetrics: BenchmarkMetric[];
}
