import { Badge, Card } from "../../../components/ui.js";
import { formatIDR } from "../../../lib/format.js";
import type { FinancialReportSection } from "../../../features/workspace/report-types.js";
import type { TrialBalanceResult } from "../../../features/workspace/trial-balance-types.js";
import type { ComparisonResponse } from "../../../features/workspace/report-scope.js";

/**
 * Tampilan komparasi per cabang (Phase 5B): satu kolom per cabang + kolom Gabungan. SEMUA angka berasal dari server
 * (kolom Gabungan dihitung server, dan server memverifikasi bahwa jumlah kolom cabang = Gabungan sebelum menjawab);
 * komponen ini tidak menghitung ulang. Kolom Gabungan selalu diberi catatan "belum dieliminasi".
 */

interface Column<T> {
  key: string;
  name: string;
  report: T;
}

function columnsOf<T>(res: ComparisonResponse<T>): Column<T>[] {
  return res.comparison.columns.map((c) => ({ key: c.branch.id, name: c.branch.name, report: c.report }));
}

function ReconciliationNote({ checkedKeys }: { checkedKeys: number }) {
  return (
    <p className="text-xs text-ink/60" data-testid="reconciliation-note">
      Rekonsiliasi server: jumlah kolom cabang sama dengan kolom Gabungan pada {checkedKeys} baris dan total.
    </p>
  );
}

function Head({ names }: { names: string[] }) {
  return (
    <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/50">
      <tr>
        <th className="px-3 py-2.5">Kode</th>
        <th className="px-3 py-2.5">Akun</th>
        {names.map((n) => (
          <th key={n} className="px-3 py-2.5 text-right">
            {n}
          </th>
        ))}
        <th className="px-3 py-2.5 text-right">Gabungan (belum dieliminasi)</th>
      </tr>
    </thead>
  );
}

/** Laporan bersusun bagian (Neraca, Laba Rugi) dengan baris per akun. */
export function SectionComparison<T>({
  res,
  sections,
  totals,
}: {
  res: ComparisonResponse<T>;
  sections: Array<{ label: string; pick: (r: T) => FinancialReportSection }>;
  totals: Array<{ label: string; pick: (r: T) => number }>;
}) {
  const cols = columnsOf(res);
  const names = cols.map((c) => c.name);
  const span = 2 + cols.length + 1;
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="comparison-table">
          <Head names={names} />
          <tbody>
            {sections.map((sec) => {
              const lineMap = new Map<string, { code: string; name: string }>();
              for (const c of [...cols.map((x) => x.report), res.comparison.combined]) for (const l of sec.pick(c).lines) lineMap.set(l.accountId, { code: l.accountCode, name: l.accountName });
              const amountOf = (r: T, id: string) => sec.pick(r).lines.find((l) => l.accountId === id)?.amount ?? 0;
              const ids = [...lineMap.keys()].sort((a, b) => lineMap.get(a)!.code.localeCompare(lineMap.get(b)!.code));
              const label = sec.pick(res.comparison.combined).label;
              return (
                <SectionRows key={label}>
                  <tr className="border-t border-line bg-surface-2/60">
                    <td colSpan={span} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink/60">
                      {label}
                    </td>
                  </tr>
                  {ids.map((id) => (
                    <tr key={id} className="border-t border-line/60">
                      <td className="px-3 py-1.5 tabular-nums text-ink/50">{lineMap.get(id)!.code}</td>
                      <td className="px-3 py-1.5">{lineMap.get(id)!.name}</td>
                      {cols.map((c) => (
                        <td key={c.key} className="px-3 py-1.5 text-right tabular-nums">
                          {amountOf(c.report, id) ? formatIDR(amountOf(c.report, id)) : ""}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{amountOf(res.comparison.combined, id) ? formatIDR(amountOf(res.comparison.combined, id)) : ""}</td>
                    </tr>
                  ))}
                  {ids.length === 0 && (
                    <tr className="border-t border-line/60">
                      <td colSpan={span} className="px-3 py-3 text-center text-xs text-ink/50">
                        Tidak ada saldo.
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-line bg-surface-2/40 font-semibold">
                    <td className="px-3 py-2" colSpan={2}>
                      Total {label}
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                        {formatIDR(sec.pick(c.report).total)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right tabular-nums">{formatIDR(sec.pick(res.comparison.combined).total)}</td>
                  </tr>
                </SectionRows>
              );
            })}
            {totals.map((t) => (
              <tr key={t.label} className="border-t border-line bg-surface-2/60 font-semibold">
                <td className="px-3 py-2" colSpan={2}>
                  {t.label}
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                    {formatIDR(t.pick(c.report))}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{formatIDR(t.pick(res.comparison.combined))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-3 py-2">
        <ReconciliationNote checkedKeys={res.comparison.reconciliation.checkedKeys} />
      </div>
    </Card>
  );
}

function SectionRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Laporan ringkas satu baris per angka (Ekuitas). */
export function ScalarComparison<T>({ res, rows }: { res: ComparisonResponse<T>; rows: Array<{ label: string; pick: (r: T) => number; strong?: boolean }> }) {
  const cols = columnsOf(res);
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="comparison-table">
          <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/50">
            <tr>
              <th className="px-3 py-2.5">Keterangan</th>
              {cols.map((c) => (
                <th key={c.key} className="px-3 py-2.5 text-right">
                  {c.name}
                </th>
              ))}
              <th className="px-3 py-2.5 text-right">Gabungan (belum dieliminasi)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={`border-t border-line/60 ${r.strong ? "bg-surface-2/60 font-semibold" : ""}`}>
                <td className="px-3 py-2">{r.label}</td>
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                    {formatIDR(r.pick(c.report))}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{formatIDR(r.pick(res.comparison.combined))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-3 py-2">
        <ReconciliationNote checkedKeys={res.comparison.reconciliation.checkedKeys} />
      </div>
    </Card>
  );
}

/** Neraca Saldo: saldo bersih per akun (D = debit, K = kredit) per cabang dan Gabungan. */
export function TrialBalanceComparison({ res }: { res: ComparisonResponse<TrialBalanceResult> }) {
  const cols = columnsOf(res);
  const rowMap = new Map<string, { code: string; name: string }>();
  for (const r of [...cols.map((c) => c.report), res.comparison.combined]) for (const row of r.rows) rowMap.set(row.accountId, { code: row.code, name: row.name });
  const net = (r: TrialBalanceResult, id: string) => {
    const row = r.rows.find((x) => x.accountId === id);
    return row ? row.debit - row.credit : 0;
  };
  const show = (n: number) => (n === 0 ? "" : `${formatIDR(Math.abs(n))} ${n > 0 ? "D" : "K"}`);
  const ids = [...rowMap.keys()].sort((a, b) => rowMap.get(a)!.code.localeCompare(rowMap.get(b)!.code));
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="comparison-table">
          <Head names={cols.map((c) => c.name)} />
          <tbody>
            {ids.map((id) => (
              <tr key={id} className="border-t border-line/60">
                <td className="px-3 py-1.5 tabular-nums text-ink/50">{rowMap.get(id)!.code}</td>
                <td className="px-3 py-1.5">{rowMap.get(id)!.name}</td>
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-1.5 text-right tabular-nums">
                    {show(net(c.report, id))}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-medium tabular-nums">{show(net(res.comparison.combined, id))}</td>
              </tr>
            ))}
            {ids.length === 0 && (
              <tr>
                <td colSpan={3 + cols.length} className="px-3 py-8 text-center text-sm text-ink/50">
                  Belum ada data accounting untuk periode ini.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-surface-2/60 font-semibold">
              <td className="px-3 py-2" colSpan={2}>
                Status
              </td>
              {cols.map((c) => (
                <td key={c.key} className="px-3 py-2 text-right">
                  <Badge tone={c.report.isBalanced ? "success" : "danger"}>{c.report.isBalanced ? "BALANCED" : "NOT BALANCED"}</Badge>
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <Badge tone={res.comparison.combined.isBalanced ? "success" : "danger"}>{res.comparison.combined.isBalanced ? "BALANCED" : "NOT BALANCED"}</Badge>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="border-t border-line px-3 py-2">
        <ReconciliationNote checkedKeys={res.comparison.reconciliation.checkedKeys} />
      </div>
    </Card>
  );
}
