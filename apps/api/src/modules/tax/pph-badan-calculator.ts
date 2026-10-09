import type { PphBracket, PphNormalEstimate, PphUmkmFinalEstimate } from "@konsultan/shared";

/** Sama persis logikanya dgn versi online (modules/tax/pph-badan-calculator.ts). */
const NORMAL_RATE = 0.22;
const SMALL_TAXPAYER_THRESHOLD = 4_800_000_000; // Rp 4.8M/tahun
const MEDIUM_TAXPAYER_CEILING = 50_000_000_000; // Rp 50M/tahun
const UMKM_FINAL_RATE = 0.005; // PP 55/2022

/**
 * PPh Badan Normal + fasilitas Pasal 31E -- sama persis logikanya dgn versi
 * online. Omzet <= 4.8M: diskon 50% (tarif efektif 11%) atas SELURUH PKP.
 * 4.8M < Omzet <= 50M: proporsional -- porsi (4.8M/omzet) dari PKP dpt
 * diskon 50%, sisanya tarif penuh 22%. Omzet > 50M: tarif penuh 22%.
 */
export function calculatePphBadanNormal(taxableIncome: number, grossRevenue: number): PphNormalEstimate {
  const income = Math.max(taxableIncome, 0);

  if (grossRevenue <= 0 || income === 0) {
    return { taxableIncome: income, effectiveRate: NORMAL_RATE, amountDue: 0, brackets: [], facilityApplied: "none" };
  }

  if (grossRevenue <= SMALL_TAXPAYER_THRESHOLD) {
    const rate = NORMAL_RATE * 0.5;
    const amount = income * rate;
    const brackets: PphBracket[] = [{ label: "PKP dengan fasilitas Pasal 31E (diskon 50%)", amount: income, rate }];
    return { taxableIncome: income, effectiveRate: rate, amountDue: amount, facilityApplied: "full", brackets };
  }

  if (grossRevenue <= MEDIUM_TAXPAYER_CEILING) {
    const facilitatedPortion = (SMALL_TAXPAYER_THRESHOLD / grossRevenue) * income;
    const normalPortion = income - facilitatedPortion;
    const facilitatedTax = facilitatedPortion * (NORMAL_RATE * 0.5);
    const normalTax = normalPortion * NORMAL_RATE;
    const brackets: PphBracket[] = [
      { label: "PKP dengan fasilitas Pasal 31E (diskon 50%)", amount: facilitatedPortion, rate: NORMAL_RATE * 0.5 },
      { label: "PKP tarif penuh", amount: normalPortion, rate: NORMAL_RATE },
    ];
    return {
      taxableIncome: income,
      effectiveRate: (facilitatedTax + normalTax) / income,
      amountDue: facilitatedTax + normalTax,
      facilityApplied: "partial",
      brackets,
    };
  }

  return {
    taxableIncome: income,
    effectiveRate: NORMAL_RATE,
    amountDue: income * NORMAL_RATE,
    facilityApplied: "none",
    brackets: [{ label: "PKP tarif penuh (omzet > Rp50 miliar)", amount: income, rate: NORMAL_RATE }],
  };
}

/**
 * PPh Final UMKM (PP 55/2022) -- alternatif yang saling eksklusif dgn PPh
 * Badan Normal (bukan tambahan), sama persis logikanya dgn versi online.
 * Hanya cek ambang omzet, TIDAK cek apakah jendela tahun fasilitas sudah
 * habis (murni informational lewat `facilityYears`).
 */
export function calculatePphUmkmFinal(grossRevenue: number, facilityYears: number): PphUmkmFinalEstimate {
  const eligible = grossRevenue > 0 && grossRevenue <= SMALL_TAXPAYER_THRESHOLD;
  return { eligible, grossRevenue, amountDue: eligible ? grossRevenue * UMKM_FINAL_RATE : 0, facilityYears };
}
