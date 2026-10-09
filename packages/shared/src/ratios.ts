export type RatioFormat = "ratio" | "percent" | "currency" | "times";

export interface RatioValue {
  code: string;
  label: string;
  value: number;
  format: RatioFormat;
  /** Penjelasan singkat -- ditampilkan sebagai tooltip di UI, penting untuk
   * rasio yang formulanya disederhanakan (mis. proksi CAR bank). */
  note?: string;
}

export interface RatioResult {
  periodId: string;
  periodLabel: string;
  ratios: RatioValue[];
  generatedAt: string;
}

export interface RatioTrendPoint {
  periodId: string;
  periodLabel: string;
  periodEndDate: string;
  ratios: Record<string, number>;
}
