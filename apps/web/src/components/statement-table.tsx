import type { StatementLineValue } from "@konsultan/shared";
import { Fragment, type ReactNode } from "react";
import { formatIDR } from "../lib/format.js";
import { Card, CardHeader } from "./ui.js";

/** Rincian per line HANYA ditampilkan kalau memang ada >1 sub-akun, atau
 * satu akun tapi namanya beda dari label baris -- kalau cuma 1 akun dengan
 * nama SAMA PERSIS (kasus paling umum, akun template 1:1), breakdown-nya
 * redundan (bakal menampilkan baris yang sama dua kali) jadi disembunyikan. */
function shouldShowBreakdown(line: StatementLineValue): boolean {
  if (line.accounts.length > 1) return true;
  if (line.accounts.length === 1 && line.accounts[0].name !== line.lineLabel) return true;
  return false;
}

export function StatementTable({
  title,
  icon,
  lines,
  total,
}: {
  title: string;
  icon?: ReactNode;
  lines: StatementLineValue[];
  total?: number;
}) {
  return (
    <Card>
      <CardHeader title={title} icon={icon} />
      <table className="w-full text-sm">
        <tbody>
          {lines.map((line) => (
            <Fragment key={line.lineCode}>
              <tr className="border-b border-line/60 last:border-0">
                <td className="px-5 py-2 text-ink/70">{line.lineLabel}</td>
                <td className="px-5 py-2 text-right tabular-nums text-ink">{formatIDR(line.amount)}</td>
              </tr>
              {shouldShowBreakdown(line) &&
                line.accounts.map((a) => (
                  <tr key={`${line.lineCode}-${a.code}`} className="border-b border-line/60 last:border-0">
                    <td className="px-5 py-1 pl-9 text-xs text-ink/50">
                      <span className="tabular-nums text-ink/30">{a.code}</span> {a.name}
                    </td>
                    <td className="px-5 py-1 text-right text-xs tabular-nums text-ink/50">{formatIDR(a.amount)}</td>
                  </tr>
                ))}
            </Fragment>
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={2} className="px-5 py-6 text-center text-sm text-ink/40">
                Belum ada data untuk periode ini
              </td>
            </tr>
          )}
        </tbody>
        {total !== undefined && (
          <tfoot>
            <tr className="border-t-2 border-accent bg-accent-50 font-semibold text-heading">
              <td className="px-5 py-2.5">Total</td>
              <td className="px-5 py-2.5 text-right tabular-nums">{formatIDR(total)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </Card>
  );
}
