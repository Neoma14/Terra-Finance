import type { CashFlowDetailResult, CashFlowResult, EquityStatementResult, IndustryTemplate, StatementLineValue, StatementResult } from "@konsultan/shared";
import { Fragment } from "react";
import { PrintReportHeader } from "./print-report-chrome.js";
import { formatIDR } from "../lib/format.js";

/**
 * Tampilan KHUSUS cetak/PDF (window.print()) untuk tab Laporan Dashboard --
 * layout sidebar info + tabel comparative (tahun-ini/tahun-lalu/%perubahan)
 * -- sama persis logikanya dgn versi online (components/print-statement-report.tsx),
 * warna disesuaikan brand charcoal/green TERRA.
 *
 * SENGAJA pakai warna literal (bukan token adaptif text-ink/heading) --
 * hasil cetak harus selalu terang & konsisten seperti dokumen resmi,
 * terlepas dari dark mode sedang aktif di layar atau tidak.
 */
const NAVY = "#1C2B3A";
const BAND = "#EAF1F7";
const BAND_STRONG = "#CFE3F0";
const MUTED = "#6B7280";
const GREEN = "#3CB371";

function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

function formatPct(v: number | null): string {
  if (v === null) return "-";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

function splitBalanceSheet(lines: StatementLineValue[]) {
  const assetLines = lines.filter((l) => l.lineCode.startsWith("a_") || l.lineCode.startsWith("ca_") || l.lineCode.startsWith("fa_"));
  const liabEquityLines = lines.filter((l) => !assetLines.includes(l));
  return { assetLines, liabEquityLines, totalAssets: assetLines.reduce((s, l) => s + l.amount, 0), totalLiabEquity: liabEquityLines.reduce((s, l) => s + l.amount, 0) };
}

interface BsLineGroup {
  label: string;
  lines: StatementLineValue[];
}

function groupAssetLines(lines: StatementLineValue[]): BsLineGroup[] {
  const current = lines.filter((l) => l.lineCode.startsWith("ca_"));
  const fixed = lines.filter((l) => l.lineCode.startsWith("fa_"));
  const other = lines.filter((l) => !current.includes(l) && !fixed.includes(l));
  const groups: BsLineGroup[] = [];
  if (current.length > 0) groups.push({ label: "Aset Lancar", lines: current });
  if (fixed.length > 0) groups.push({ label: "Aset Tetap", lines: fixed });
  if (other.length > 0) groups.push({ label: "Aset Lainnya", lines: other });
  return groups;
}

function groupLiabEquityLines(lines: StatementLineValue[]): BsLineGroup[] {
  const equity = lines.filter((l) => l.lineCode.startsWith("eq_"));
  const nonEquity = lines.filter((l) => !equity.includes(l));
  const current = nonEquity.filter((l) => l.lineCode.startsWith("cl_"));
  const longTerm = nonEquity.filter((l) => l.lineCode.startsWith("ll_"));
  const otherLiab = nonEquity.filter((l) => !current.includes(l) && !longTerm.includes(l));
  const groups: BsLineGroup[] = [];
  if (current.length > 0) groups.push({ label: "Liabilitas Lancar", lines: current });
  if (longTerm.length > 0) groups.push({ label: "Liabilitas Jangka Panjang", lines: longTerm });
  if (otherLiab.length > 0) groups.push({ label: "Liabilitas Lainnya", lines: otherLiab });
  if (equity.length > 0) groups.push({ label: "Modal", lines: equity });
  return groups;
}

function splitIncomeStatement(lines: StatementLineValue[]) {
  const revenueLines = lines.filter((l) => l.lineCode.startsWith("is_revenue"));
  const expenseLines = lines.filter((l) => !revenueLines.includes(l));
  return { revenueLines, expenseLines, totalRevenue: revenueLines.reduce((s, l) => s + l.amount, 0), totalExpense: expenseLines.reduce((s, l) => s + l.amount, 0) };
}

function amountByCode(lines: StatementLineValue[] | undefined, code: string): number | undefined {
  return lines?.find((l) => l.lineCode === code)?.amount;
}

function shouldShowBreakdown(line: StatementLineValue): boolean {
  if (line.accounts.length > 1) return true;
  if (line.accounts.length === 1 && line.accounts[0].name !== line.lineLabel) return true;
  return false;
}

function CompareRow({ label, current, prior, bold }: { label: string; current: number; prior?: number; bold?: boolean }) {
  const change = prior !== undefined ? pctChange(current, prior) : null;
  return (
    <tr>
      <td style={{ padding: bold ? "6px 8px" : "3px 0", fontWeight: bold ? 700 : 400 }}>{label}</td>
      <td style={{ padding: bold ? "6px 8px" : "3px 0", textAlign: "right", fontWeight: bold ? 700 : 400, fontVariantNumeric: "tabular-nums" }}>
        {formatIDR(current)}
      </td>
      {prior !== undefined && (
        <>
          <td style={{ padding: bold ? "6px 8px" : "3px 0", textAlign: "right", fontWeight: bold ? 700 : 400, fontVariantNumeric: "tabular-nums" }}>
            {formatIDR(prior)}
          </td>
          <td style={{ padding: bold ? "6px 8px" : "3px 0", textAlign: "right", fontWeight: bold ? 700 : 400, color: change !== null && change < 0 ? "#B91C1C" : undefined }}>
            {formatPct(change)}
          </td>
        </>
      )}
    </tr>
  );
}

function Section({
  title,
  lines,
  priorLines,
  subtotalLabel,
  subtotal,
  priorSubtotal,
  hasComparison,
}: {
  title: string;
  lines: StatementLineValue[];
  priorLines?: StatementLineValue[];
  subtotalLabel: string;
  subtotal: number;
  priorSubtotal?: number;
  hasComparison: boolean;
}) {
  return (
    <>
      <tr style={{ background: NAVY }}>
        <td colSpan={hasComparison ? 4 : 2} style={{ padding: "5px 8px", fontWeight: 700, color: "white", fontSize: 10.5, letterSpacing: 0.4 }}>
          {title}
        </td>
      </tr>
      {lines.map((l) => (
        <Fragment key={l.lineCode}>
          <CompareRow label={l.lineLabel} current={l.amount} prior={hasComparison ? amountByCode(priorLines, l.lineCode) : undefined} />
          {shouldShowBreakdown(l) &&
            l.accounts.map((a) => (
              <tr key={`${l.lineCode}-${a.code}`}>
                <td style={{ padding: "1px 0 1px 18px", fontSize: 10, color: MUTED }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{a.code}</span> {a.name}
                </td>
                <td style={{ padding: "1px 0", textAlign: "right", fontSize: 10, color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                  {formatIDR(a.amount)}
                </td>
                {hasComparison && (
                  <>
                    <td />
                    <td />
                  </>
                )}
              </tr>
            ))}
        </Fragment>
      ))}
      <tr style={{ background: BAND }}>
        <CompareRowCells label={subtotalLabel} current={subtotal} prior={hasComparison ? priorSubtotal : undefined} />
      </tr>
      <tr>
        <td colSpan={hasComparison ? 4 : 2} style={{ height: 10 }} />
      </tr>
    </>
  );
}

function GroupedSection({
  title,
  groups,
  priorLines,
  grandTotalLabel,
  grandTotal,
  priorGrandTotal,
  hasComparison,
}: {
  title: string;
  groups: BsLineGroup[];
  priorLines?: StatementLineValue[];
  grandTotalLabel: string;
  grandTotal: number;
  priorGrandTotal?: number;
  hasComparison: boolean;
}) {
  return (
    <>
      <tr style={{ background: NAVY }}>
        <td colSpan={hasComparison ? 4 : 2} style={{ padding: "5px 8px", fontWeight: 700, color: "white", fontSize: 10.5, letterSpacing: 0.4 }}>
          {title}
        </td>
      </tr>
      {groups.map((g) => {
        const groupSubtotal = g.lines.reduce((s, l) => s + l.amount, 0);
        const priorGroupSubtotal = hasComparison
          ? g.lines.reduce((s, l) => s + (amountByCode(priorLines, l.lineCode) ?? 0), 0)
          : undefined;
        return (
          <Fragment key={g.label}>
            <tr>
              <td colSpan={hasComparison ? 4 : 2} style={{ padding: "6px 8px 1px", fontWeight: 700, fontSize: 9, color: NAVY, textTransform: "uppercase", letterSpacing: 0.3 }}>
                {g.label}
              </td>
            </tr>
            {g.lines.map((l) => (
              <Fragment key={l.lineCode}>
                <CompareRow label={l.lineLabel} current={l.amount} prior={hasComparison ? amountByCode(priorLines, l.lineCode) : undefined} />
                {shouldShowBreakdown(l) &&
                  l.accounts.map((a) => (
                    <tr key={`${l.lineCode}-${a.code}`}>
                      <td style={{ padding: "1px 0 1px 18px", fontSize: 10, color: MUTED }}>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{a.code}</span> {a.name}
                      </td>
                      <td style={{ padding: "1px 0", textAlign: "right", fontSize: 10, color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                        {formatIDR(a.amount)}
                      </td>
                      {hasComparison && (
                        <>
                          <td />
                          <td />
                        </>
                      )}
                    </tr>
                  ))}
              </Fragment>
            ))}
            <tr style={{ background: BAND_STRONG }}>
              <CompareRowCells label={`Total ${g.label}`} current={groupSubtotal} prior={priorGroupSubtotal} />
            </tr>
          </Fragment>
        );
      })}
      <tr style={{ background: NAVY }}>
        <CompareRowCells label={grandTotalLabel} current={grandTotal} prior={hasComparison ? priorGrandTotal : undefined} color="white" />
      </tr>
      <tr>
        <td colSpan={hasComparison ? 4 : 2} style={{ height: 10 }} />
      </tr>
    </>
  );
}

function CompareRowCells({ label, current, prior, color }: { label: string; current: number; prior?: number; color?: string }) {
  const change = prior !== undefined ? pctChange(current, prior) : null;
  return (
    <>
      <td style={{ padding: "6px 8px", fontWeight: 700, color }}>{label}</td>
      <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color }}>{formatIDR(current)}</td>
      {prior !== undefined && (
        <>
          <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color }}>{formatIDR(prior)}</td>
          <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color }}>{formatPct(change)}</td>
        </>
      )}
    </>
  );
}

function growthHighlight(label: string, current: number, prior: number): string | null {
  const change = pctChange(current, prior);
  if (change === null) return null;
  return `${label} ${change >= 0 ? "Naik" : "Turun"} ${Math.abs(change * 100).toFixed(1)}%`;
}

/** Laporan Arus Kas metode tidak langsung RINCI per-akun (bukan cuma 3
 * angka lump-sum) -- daftar akunnya otomatis MENYESUAIKAN jenis usaha
 * karena diambil langsung dari akun cash_flow_activity milik masing-masing
 * perusahaan (bukan baris template tetap), lihat getCashFlowDetailForRange
 * di backend. Baris akun tanpa mutasi (delta 0) disembunyikan. */
function CashFlowDetailSection({ cashFlow, detail }: { cashFlow: CashFlowResult; detail?: CashFlowDetailResult }) {
  const operating = (detail?.operating ?? []).filter((a) => a.delta !== 0);
  const investing = (detail?.investing ?? []).filter((a) => a.delta !== 0);
  const financing = (detail?.financing ?? []).filter((a) => a.delta !== 0);

  const sectionHeader = (label: string) => (
    <tr style={{ background: NAVY }}>
      <td colSpan={2} style={{ padding: "6px 8px", fontWeight: 700, color: "white", fontSize: 11 }}>{label}</td>
    </tr>
  );
  const itemRow = (label: string, amount: number, key: string) => (
    <tr key={key}>
      <td style={{ padding: "3px 0 3px 16px" }}>{label}</td>
      <td style={{ padding: "3px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatIDR(amount)}</td>
    </tr>
  );
  const subtotalRow = (label: string, amount: number) => (
    <tr style={{ background: BAND }}>
      <td style={{ padding: "6px 8px", fontWeight: 700 }}>{label}</td>
      <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatIDR(amount)}</td>
    </tr>
  );

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {sectionHeader("Arus Kas dari Aktivitas Operasi")}
        {itemRow("Laba Bersih", cashFlow.netIncome, "net-income")}
        {operating.length > 0 && (
          <tr>
            <td colSpan={2} style={{ padding: "6px 0 2px", fontSize: 9, fontWeight: 700, color: MUTED, letterSpacing: 0.3 }}>
              PENYESUAIAN UNTUK:
            </td>
          </tr>
        )}
        {operating.map((a) => itemRow(a.name, a.contribution, a.accountId))}
        {subtotalRow("Arus Kas Neto dari Aktivitas Operasi", cashFlow.operatingActivities)}

        {sectionHeader("Arus Kas dari Aktivitas Investasi")}
        {investing.length === 0
          ? itemRow("Tidak ada mutasi", 0, "investing-empty")
          : investing.map((a) => itemRow(a.name, a.contribution, a.accountId))}
        {subtotalRow("Arus Kas Neto dari Aktivitas Investasi", cashFlow.investingActivities)}

        {sectionHeader("Arus Kas dari Aktivitas Pendanaan")}
        {financing.length === 0
          ? itemRow("Tidak ada mutasi", 0, "financing-empty")
          : financing.map((a) => itemRow(a.name, a.contribution, a.accountId))}
        {subtotalRow("Arus Kas Neto dari Aktivitas Pendanaan", cashFlow.financingActivities)}

        <tr style={{ background: BAND, borderTop: `2px solid ${NAVY}` }}>
          <td style={{ padding: "6px 8px", fontWeight: 700 }}>Kenaikan (Penurunan) Bersih Kas dan Setara Kas</td>
          <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatIDR(cashFlow.netChangeInCash)}</td>
        </tr>
        <tr style={{ background: BAND }}>
          <td style={{ padding: "6px 8px" }}>Kas dan Setara Kas pada Awal Periode</td>
          <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatIDR(cashFlow.beginningCash)}</td>
        </tr>
        <tr style={{ background: NAVY }}>
          <td style={{ padding: "6px 8px", fontWeight: 700, color: "white" }}>Kas dan Setara Kas pada Akhir Periode</td>
          <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "white", fontVariantNumeric: "tabular-nums" }}>{formatIDR(cashFlow.endingCash)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function ReportPage({
  reportTitle,
  companyName,
  companyLogoUrl,
  industryTemplate,
  periodLabel,
  priorPeriodLabel,
  preparedBy,
  highlights,
  children,
}: {
  reportTitle: string;
  companyName: string;
  companyLogoUrl?: string | null;
  industryTemplate?: IndustryTemplate;
  periodLabel: string;
  priorPeriodLabel?: string;
  preparedBy: string;
  highlights: string[];
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid #E5E9EE", breakInside: "avoid" }}>
      <div style={{ padding: "0 14px" }}>
        <PrintReportHeader
          reportTitle={reportTitle.toUpperCase()}
          companyName={companyName}
          companyLogoUrl={companyLogoUrl}
          industryTemplate={industryTemplate ?? "general"}
          rangeLabel={priorPeriodLabel ? `${periodLabel} vs ${priorPeriodLabel}` : periodLabel}
        />
      </div>
      <div style={{ padding: "0 14px 10px", color: "#1a1a1a", fontSize: 10, lineHeight: 1.35 }}>
        {highlights.length > 0 && (
          <p style={{ margin: "0 0 6px", fontSize: 8.5, color: MUTED }}>
            {highlights.join("  •  ")}
          </p>
        )}
        {children}
      </div>
      <p style={{ margin: 0, padding: "5px 14px", borderTop: "1px solid #E5E9EE", fontSize: 7.5, color: MUTED, textAlign: "center" }}>
        Disusun oleh {preparedBy} melalui TERRA FINANCE -- Terra Teknologi Digital &copy; {new Date().getFullYear()}
      </p>
    </div>
  );
}

export function PrintStatementReport({
  companyName,
  companyLogoUrl,
  industryTemplate,
  preparedBy,
  periodLabel,
  priorPeriodLabel,
  balanceSheet,
  balanceSheetPrior,
  incomeStatement,
  incomeStatementPrior,
  equity,
  cashFlow,
  cashFlowDetail,
}: {
  companyName: string;
  companyLogoUrl?: string | null;
  industryTemplate?: IndustryTemplate;
  preparedBy: string;
  periodLabel: string;
  priorPeriodLabel?: string;
  balanceSheet?: StatementResult;
  balanceSheetPrior?: StatementResult;
  incomeStatement?: StatementResult;
  incomeStatementPrior?: StatementResult;
  equity?: EquityStatementResult;
  cashFlow?: CashFlowResult;
  cashFlowDetail?: CashFlowDetailResult;
}) {
  const bs = balanceSheet ? splitBalanceSheet(balanceSheet.lines) : null;
  const bsPrior = balanceSheetPrior ? splitBalanceSheet(balanceSheetPrior.lines) : null;
  const is = incomeStatement ? splitIncomeStatement(incomeStatement.lines) : null;
  const isPrior = incomeStatementPrior ? splitIncomeStatement(incomeStatementPrior.lines) : null;
  const hasComparison = Boolean(priorPeriodLabel);

  const highlights = [
    bs && bsPrior && growthHighlight("Total Aset", bs.totalAssets, bsPrior.totalAssets),
    is && isPrior && growthHighlight("Pendapatan", is.totalRevenue, isPrior.totalRevenue),
    is && isPrior && growthHighlight("Laba Bersih", is.totalRevenue - is.totalExpense, isPrior.totalRevenue - isPrior.totalExpense),
  ].filter((x): x is string => Boolean(x));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {bs && (
        <div style={{ breakAfter: "page" }}>
          <ReportPage
            reportTitle="Neraca"
            companyName={companyName}
            companyLogoUrl={companyLogoUrl}
            industryTemplate={industryTemplate}
            periodLabel={periodLabel}
            priorPeriodLabel={priorPeriodLabel}
            preparedBy={preparedBy}
            highlights={highlights}
          >
            <div style={{ display: "flex", gap: 0 }}>
              <div style={{ width: "50%", paddingRight: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  {hasComparison && (
                    <thead>
                      <tr style={{ background: NAVY }}>
                        <th style={{ padding: "5px 6px", textAlign: "left", color: "white", fontSize: 8.5 }}>Pos</th>
                        <th style={{ padding: "5px 6px", textAlign: "right", color: "white", fontSize: 8.5 }}>{periodLabel}</th>
                        <th style={{ padding: "5px 6px", textAlign: "right", color: "white", fontSize: 8.5 }}>{priorPeriodLabel}</th>
                        <th style={{ padding: "5px 6px", textAlign: "right", color: "white", fontSize: 8.5 }}>%</th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    <GroupedSection
                      title="ASET"
                      groups={groupAssetLines(bs.assetLines)}
                      priorLines={bsPrior?.assetLines}
                      grandTotalLabel="Total Aset"
                      grandTotal={bs.totalAssets}
                      priorGrandTotal={bsPrior?.totalAssets}
                      hasComparison={hasComparison}
                    />
                  </tbody>
                </table>
              </div>
              <div style={{ width: 1, background: "#E5E9EE", flexShrink: 0 }} />
              <div style={{ width: "50%", paddingLeft: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  {hasComparison && (
                    <thead>
                      <tr style={{ background: NAVY }}>
                        <th style={{ padding: "5px 6px", textAlign: "left", color: "white", fontSize: 8.5 }}>Pos</th>
                        <th style={{ padding: "5px 6px", textAlign: "right", color: "white", fontSize: 8.5 }}>{periodLabel}</th>
                        <th style={{ padding: "5px 6px", textAlign: "right", color: "white", fontSize: 8.5 }}>{priorPeriodLabel}</th>
                        <th style={{ padding: "5px 6px", textAlign: "right", color: "white", fontSize: 8.5 }}>%</th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    <GroupedSection
                      title="LIABILITAS & EKUITAS"
                      groups={groupLiabEquityLines(bs.liabEquityLines)}
                      priorLines={bsPrior?.liabEquityLines}
                      grandTotalLabel="Total Liabilitas & Ekuitas"
                      grandTotal={bs.totalLiabEquity}
                      priorGrandTotal={bsPrior?.totalLiabEquity}
                      hasComparison={hasComparison}
                    />
                  </tbody>
                </table>
              </div>
            </div>
          </ReportPage>
        </div>
      )}

      {is && (
        <div style={{ breakAfter: "page" }}>
          <ReportPage
            reportTitle="Laba Rugi"
            companyName={companyName}
            companyLogoUrl={companyLogoUrl}
            industryTemplate={industryTemplate}
            periodLabel={periodLabel}
            priorPeriodLabel={priorPeriodLabel}
            preparedBy={preparedBy}
            highlights={highlights}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              {hasComparison && (
                <thead>
                  <tr style={{ background: NAVY }}>
                    <th style={{ padding: "5px 8px", textAlign: "left", color: "white", fontSize: 9 }}>Pos</th>
                    <th style={{ padding: "5px 8px", textAlign: "right", color: "white", fontSize: 9 }}>{periodLabel}</th>
                    <th style={{ padding: "5px 8px", textAlign: "right", color: "white", fontSize: 9 }}>{priorPeriodLabel}</th>
                    <th style={{ padding: "5px 8px", textAlign: "right", color: "white", fontSize: 9 }}>% Perubahan</th>
                  </tr>
                </thead>
              )}
              <tbody>
                <Section title="PENDAPATAN" lines={is.revenueLines} priorLines={isPrior?.revenueLines} subtotalLabel="Total Pendapatan" subtotal={is.totalRevenue} priorSubtotal={isPrior?.totalRevenue} hasComparison={hasComparison} />
                <Section title="BEBAN" lines={is.expenseLines} priorLines={isPrior?.expenseLines} subtotalLabel="Total Beban" subtotal={is.totalExpense} priorSubtotal={isPrior?.totalExpense} hasComparison={hasComparison} />
                <tr style={{ background: NAVY }}>
                  <CompareRowCells
                    label="LABA BERSIH"
                    current={is.totalRevenue - is.totalExpense}
                    prior={hasComparison && isPrior ? isPrior.totalRevenue - isPrior.totalExpense : undefined}
                    color="white"
                  />
                </tr>
              </tbody>
            </table>
          </ReportPage>
        </div>
      )}

      {equity && (
        <div style={{ breakAfter: "page" }}>
          <ReportPage
            reportTitle="Perubahan Ekuitas"
            companyName={companyName}
            companyLogoUrl={companyLogoUrl}
            industryTemplate={industryTemplate}
            periodLabel={periodLabel}
            preparedBy={preparedBy}
            highlights={highlights}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: NAVY }}>
                  <th style={{ padding: "5px 8px", textAlign: "left", color: "white", fontSize: 9 }}>Akun</th>
                  <th style={{ padding: "5px 8px", textAlign: "right", color: "white", fontSize: 9 }}>Saldo Awal</th>
                  <th style={{ padding: "5px 8px", textAlign: "right", color: "white", fontSize: 9 }}>Perubahan</th>
                  <th style={{ padding: "5px 8px", textAlign: "right", color: "white", fontSize: 9 }}>Saldo Akhir</th>
                </tr>
              </thead>
              <tbody>
                {equity.lines.map((l) => (
                  <tr key={l.accountId}>
                    <td style={{ padding: "3px 0" }}>{l.code} - {l.name}</td>
                    <td style={{ padding: "3px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatIDR(l.beginningBalance)}</td>
                    <td style={{ padding: "3px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatIDR(l.delta)}</td>
                    <td style={{ padding: "3px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatIDR(l.endingBalance)}</td>
                  </tr>
                ))}
                <tr style={{ background: NAVY }}>
                  <td style={{ padding: "8px", fontWeight: 700, color: "white" }}>Total Ekuitas</td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: "white", fontVariantNumeric: "tabular-nums" }}>{formatIDR(equity.totalBeginning)}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: "white", fontVariantNumeric: "tabular-nums" }}>{formatIDR(equity.totalEnding - equity.totalBeginning)}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: "white", fontVariantNumeric: "tabular-nums" }}>{formatIDR(equity.totalEnding)}</td>
                </tr>
              </tbody>
            </table>
          </ReportPage>
        </div>
      )}

      {cashFlow && (
        <div>
          <ReportPage
            reportTitle="Laporan Arus Kas"
            companyName={companyName}
            companyLogoUrl={companyLogoUrl}
            industryTemplate={industryTemplate}
            periodLabel={periodLabel}
            preparedBy={preparedBy}
            highlights={highlights}
          >
            <p style={{ margin: "-6px 0 8px", fontSize: 9, fontStyle: "italic", color: MUTED }}>Metode Tidak Langsung</p>
            <CashFlowDetailSection cashFlow={cashFlow} detail={cashFlowDetail} />
          </ReportPage>
        </div>
      )}
    </div>
  );
}
