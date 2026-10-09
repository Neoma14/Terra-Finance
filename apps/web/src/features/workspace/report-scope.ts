import { useCallback, useEffect, useState } from "react";
import { ACTIVE_BRANCH_CHANGED_EVENT, getActiveBranch } from "../../lib/active-branch.js";

/**
 * Cakupan laporan (Phase 5A/5B) di sisi klien. HANYA kenyamanan: klien mengusulkan string `scope`; SERVER memvalidasi
 * tiap request (akses cabang, report.consolidated) dan menjawab dengan `scope` yang benar-benar dipakai. Yang ditampilkan
 * di layar adalah `scope` dari respons server, bukan pilihan lokal ini.
 *
 * Disimpan per tab (sessionStorage) dan dilepas saat cabang kerja berganti, sama seperti cabang aktif (BC-1).
 */

export type ReportScopeMode = "COMPANY" | "SINGLE" | "COMPARISON" | "COMBINED_SELECTED" | "COMBINED_ALL";

export interface ScopeBranch {
  id: string;
  code: string;
  name: string;
  status: string;
}
export interface ReportScopeInfo {
  mode: ReportScopeMode;
  branches: ScopeBranch[];
  companyWide: boolean;
  eliminationStatus: "NOT_APPLICABLE" | "NOT_ELIMINATED";
  label: { title: string; warnings: string[] };
}
export interface InterBranchPosition {
  eliminated: false;
  asOf: string;
  receivableGross: number;
  payableGross: number;
  netDifference: number;
}
export interface ScopedExtras {
  scope?: ReportScopeInfo;
  interBranch?: InterBranchPosition | null;
}
export interface ComparisonResponse<T> {
  scope: ReportScopeInfo;
  comparison: {
    columns: Array<{ branch: ScopeBranch; report: T }>;
    combined: T;
    reconciliation: { ok: true; checkedKeys: number };
  };
  interBranch: InterBranchPosition | null;
}
/** Respons endpoint ber-cakupan: laporan biasa (+ scope) atau komparasi. */
export type ScopedResponse<T> = (T & ScopedExtras) | ComparisonResponse<T>;

export function isComparisonResponse<T>(data: ScopedResponse<T> | undefined): data is ComparisonResponse<T> {
  return Boolean(data && typeof data === "object" && "comparison" in data && (data as ComparisonResponse<T>).comparison);
}

const STORAGE_KEY = (slug: string) => `terra.reportScope.${slug}`;
export const REPORT_SCOPE_CHANGED_EVENT = "terra:report-scope-changed";

export function getStoredScope(slug: string): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY(slug)) ?? "";
  } catch {
    return "";
  }
}
export function setStoredScope(slug: string, scope: string): void {
  try {
    if (scope) sessionStorage.setItem(STORAGE_KEY(slug), scope);
    else sessionStorage.removeItem(STORAGE_KEY(slug));
  } catch {
    /* penyimpanan tidak tersedia: pilihan hanya berlaku selama halaman terbuka */
  }
  window.dispatchEvent(new CustomEvent(REPORT_SCOPE_CHANGED_EVENT, { detail: { slug, scope } }));
}

/** Pilihan cakupan halaman ini ("" = bawaan server: cabang kerja aktif). */
export function useReportScope(slug: string): [string, (scope: string) => void] {
  const [scope, setScope] = useState(() => getStoredScope(slug));
  useEffect(() => {
    setScope(getStoredScope(slug));
    const onScope = (e: Event) => {
      if ((e as CustomEvent<{ slug: string }>).detail?.slug === slug) setScope(getStoredScope(slug));
    };
    const onBranch = (e: Event) => {
      // pindah cabang kerja => kembali ke bawaan (cabang kerja baru), agar tidak ada cakupan usang
      if ((e as CustomEvent<{ slug: string }>).detail?.slug === slug) setStoredScope(slug, "");
    };
    window.addEventListener(REPORT_SCOPE_CHANGED_EVENT, onScope);
    window.addEventListener(ACTIVE_BRANCH_CHANGED_EVENT, onBranch);
    return () => {
      window.removeEventListener(REPORT_SCOPE_CHANGED_EVENT, onScope);
      window.removeEventListener(ACTIVE_BRANCH_CHANGED_EVENT, onBranch);
    };
  }, [slug]);
  const update = useCallback((next: string) => setStoredScope(slug, next), [slug]);
  return [scope, update];
}

/** Potongan query-string `&scope=...` (kosong bila memakai bawaan server). */
export const scopeParam = (scope: string): string => (scope ? `&scope=${encodeURIComponent(scope)}` : "");
/** Bagian kunci cache: cakupan + cabang kerja aktif (header), supaya cache tidak pernah dipakai lintas cabang. */
export const scopeKeyParts = (slug: string, scope: string): [string, string] => [scope, getActiveBranch(slug) ?? ""];
export const isComparisonScope = (scope: string): boolean => scope.startsWith("branches:");
