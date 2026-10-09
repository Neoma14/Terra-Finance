/** Jurnal seimbang bila total debit = total kredit PERSIS (dalam sen), tanpa toleransi. */
export function isBalancedExact(totalDebit: number, totalCredit: number): boolean {
  return Math.round(totalDebit * 100) === Math.round(totalCredit * 100) && totalDebit > 0;
}
