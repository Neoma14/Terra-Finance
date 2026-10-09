export interface TaxSettings {
  id: string;
  umkmFacilityYears: number;
  legalFormNote: string;
  vatStatus: string;
  vatDescription: string;
  vatLegalBasis: string;
  withholdingNotes: string[];
  generalNotes: string[];
}

export type UpdateTaxSettingsInput = Partial<Omit<TaxSettings, "id">>;

export interface TaxSummary {
  settings: TaxSettings;
  period: { fromDate: string; toDate: string };
  revenue: number;
}
