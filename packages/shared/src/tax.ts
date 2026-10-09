export type VatStatus = "kena_pajak" | "dikecualikan" | "dibebaskan" | "campuran";

export interface TaxWithholdingNote {
  title: string;
  description: string;
  legalBasis: string;
}

export interface TaxReference {
  /** ID baris `tax_reference_settings` -- ada kalau referensi ini sudah
   * jadi milik satu perusahaan (bisa diedit lewat UI), tidak ada kalau
   * masih berupa default template industri (belum pernah di-provision/
   * di-seed, mis. dipanggil langsung tanpa konteks perusahaan). */
  id?: string;
  /** Bentuk badan tipikal & durasi fasilitas PPh Final UMKM (PP 55/2022) --
   * PT 3 tahun pajak, koperasi/CV/firma 4 tahun, OP 7 tahun. */
  umkmFacilityYears: number;
  legalFormNote: string;
  vat: {
    status: VatStatus;
    description: string;
    legalBasis: string;
  };
  withholdingNotes: TaxWithholdingNote[];
  generalNotes: string[];
}

export interface TaxReferenceUpdateInput {
  umkmFacilityYears: number;
  legalFormNote: string;
  vat: { status: VatStatus; description: string; legalBasis: string };
  withholdingNotes: TaxWithholdingNote[];
  generalNotes: string[];
}

export interface PphBracket {
  label: string;
  amount: number;
  rate: number;
}

export interface PphNormalEstimate {
  taxableIncome: number;
  effectiveRate: number;
  amountDue: number;
  brackets: PphBracket[];
  facilityApplied: "full" | "partial" | "none";
}

export interface PphUmkmFinalEstimate {
  eligible: boolean;
  grossRevenue: number;
  amountDue: number;
  facilityYears: number;
}

export interface TaxEstimateResult {
  periodId: string;
  periodLabel: string;
  netIncome: number;
  grossRevenue: number;
  pphNormal: PphNormalEstimate;
  pphUmkmFinal: PphUmkmFinalEstimate;
  recommendation: "normal" | "umkm_final";
  disclaimer: string;
  generatedAt: string;
}
