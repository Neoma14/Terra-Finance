import type { Knex } from "knex";

/**
 * Cakupan laporan (Phase 5A/5B). Satu-satunya tempat keputusan "cabang mana yang boleh dibaca laporan ini".
 *
 * Prinsip (PHASE-5-ARCHITECTURE §2, disetujui D1-D10): cakupan DIHITUNG SERVER dari akses perusahaan, akses cabang
 * SAAT INI, permission efektif, dan parameter yang divalidasi -- klien hanya mengusulkan. `AuthorizedScope` bermerek:
 * hanya `resolveReportScope` (di bawah) yang dapat membuatnya, sehingga layanan data tidak dapat menerima daftar id
 * mentah dari query string. Fungsi ini MURNI (tanpa DB/HTTP) agar seluruh matriks keputusan dapat diuji langsung;
 * integrasi request ada di `middleware/report-scope.ts`.
 *
 * Aturan (ringkas, lihat PHASE-5-IMPLEMENTATION-REPORT.md):
 *  - Flag multi-cabang OFF: cakupan = seluruh perusahaan (SQL identik dengan sebelum Phase 5); parameter selain kosong/`all` ditolak 400.
 *  - `branch:X`: X harus dalam akses user (INACTIVE/CLOSED boleh, historis) -> selain itu 404 seragam.
 *  - `branches:`/`selected:`/`all`: butuh `report.consolidated` efektif (403 bila tidak) DAN seluruh id dalam akses (404 seragam bila ada yang tidak).
 *  - Tanpa parameter: cabang kerja aktif tervalidasi (D1).
 *  - Gabungan SELALU berlabel "saldo antar-kantor belum dieliminasi"; tidak pernah disebut "konsolidasi".
 */

export type ReportScopeMode = "COMPANY" | "SINGLE" | "COMPARISON" | "COMBINED_SELECTED" | "COMBINED_ALL";
export type EliminationStatus = "NOT_APPLICABLE" | "NOT_ELIMINATED";

export interface ScopeBranch {
  id: string;
  code: string;
  name: string;
  status: string;
}
export interface ScopeLabel {
  title: string;
  warnings: string[];
}

declare const authorizedScopeBrand: unique symbol;

export interface AuthorizedScope {
  readonly [authorizedScopeBrand]: true;
  readonly mode: ReportScopeMode;
  /** Cabang yang tercakup (urut `sort_order`). */
  readonly branchIds: readonly string[];
  readonly branches: readonly ScopeBranch[];
  /** Filter SQL `je.branch_id IN (...)`; null = tanpa filter (SQL identik dengan sebelum Phase 5). */
  readonly filterBranchIds: readonly string[] | null;
  /** true bila seluruh cabang perusahaan (non-terhapus) tercakup. */
  readonly companyWide: boolean;
  /** Apakah akun antar-kantor sudah dieliminasi. Phase 7 belum ada: gabungan selalu NOT_ELIMINATED. */
  readonly eliminationStatus: EliminationStatus;
  readonly label: ScopeLabel;
}

export type ReportScopeErrorCode =
  | "REPORT_SCOPE_INVALID"
  | "REPORT_SCOPE_NOT_FOUND"
  | "REPORT_SCOPE_FORBIDDEN"
  | "REPORT_SCOPE_UNSUPPORTED"
  | "REPORT_SCOPE_NO_BRANCH";

export class ReportScopeError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    public readonly code: ReportScopeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const REPORT_SCOPE_MAX_BRANCHES = 50;
/** Komparasi menghitung satu laporan per cabang (belum set-based); dibatasi agar waktu respons wajar. */
export const REPORT_COMPARISON_MAX_BRANCHES = 12;

const NOT_FOUND = () => new ReportScopeError(404, "REPORT_SCOPE_NOT_FOUND", "Cabang tidak ditemukan atau Anda tidak memiliki akses.");
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ScopeBranchInput extends ScopeBranch {
  isHeadOffice: boolean;
}

export interface ResolveReportScopeInput {
  multiBranchEnabled: boolean;
  /** Seluruh cabang non-terhapus, urut sort_order. */
  allBranches: readonly ScopeBranchInput[];
  /** Cabang dalam akses user SAAT INI (dibaca server, bukan dari klien). */
  accessible: readonly ScopeBranchInput[];
  /** Cabang kerja aktif tervalidasi (ACTIVE & dalam akses) atau null. */
  context: ScopeBranchInput | null;
  /** `report.consolidated` efektif (role + GRANT - DENY). */
  canConsolidate: boolean;
  /** Nilai mentah query `scope` (tidak dipercaya). */
  rawScope?: string | null;
  /** Endpoint mendukung kolom per cabang (`branches:`). */
  allowComparison?: boolean;
}

const ELIMINATION_WARNING = "Saldo antar-kantor (akun antar-cabang) belum dieliminasi: nilai aset dan liabilitas ditampilkan bruto.";
const NOT_FINAL_WARNING = "Ini bukan laporan konsolidasi final; eliminasi akun antar-kantor belum tersedia.";

function make(
  mode: ReportScopeMode,
  branches: readonly ScopeBranchInput[],
  allCount: number,
  label: ScopeLabel,
  forceUnfiltered: boolean,
): AuthorizedScope {
  const companyWide = branches.length === allCount;
  const scope = {
    mode,
    branchIds: branches.map((b) => b.id),
    branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, status: b.status })),
    filterBranchIds: forceUnfiltered || companyWide ? null : branches.map((b) => b.id),
    companyWide,
    eliminationStatus: mode === "COMBINED_SELECTED" || mode === "COMBINED_ALL" || mode === "COMPARISON" ? ("NOT_ELIMINATED" as const) : ("NOT_APPLICABLE" as const),
    label,
  };
  return scope as unknown as AuthorizedScope;
}

function singleLabel(branch: ScopeBranchInput, multiBranchEnabled: boolean): ScopeLabel {
  const warnings: string[] = [];
  if (branch.status !== "ACTIVE") warnings.push(`Cabang berstatus ${branch.status}: laporan ini bersifat historis.`);
  if (multiBranchEnabled && !branch.isHeadOffice) {
    warnings.push("Akun yang hanya dikelola Kantor Pusat (mis. Modal) tidak tercatat di cabang ini, sehingga Neraca cabang tidak memuat akun tersebut.");
  }
  if (multiBranchEnabled) warnings.push("Akun antar-cabang menampilkan sisi cabang ini saja; pasangannya tercatat di cabang lain.");
  return { title: branch.name, warnings };
}

type Parsed = { kind: "none" } | { kind: "all" } | { kind: "branch" | "branches" | "selected"; ids: string[] };

function parseRaw(raw: string | null | undefined): Parsed {
  const text = (raw ?? "").trim();
  if (text === "") return { kind: "none" };
  if (text === "all") return { kind: "all" };
  const m = /^(branch|branches|selected):(.*)$/.exec(text);
  if (!m) throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", "Parameter cakupan tidak valid.");
  const kind = m[1] as "branch" | "branches" | "selected";
  const parts = m[2].split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((p) => !ID_PATTERN.test(p))) throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", "Parameter cakupan tidak valid.");
  const ids = [...new Set(parts)];
  if (ids.length > REPORT_SCOPE_MAX_BRANCHES) throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", `Maksimal ${REPORT_SCOPE_MAX_BRANCHES} cabang per permintaan.`);
  if (kind === "branch" && ids.length !== 1) throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", "Parameter cakupan tidak valid.");
  if (kind !== "branch" && ids.length < 2) throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", "Cakupan gabungan atau komparasi memerlukan minimal dua cabang.");
  return { kind, ids };
}

/** Keputusan cakupan (murni). Melempar `ReportScopeError` (400/403/404); tidak pernah mengembalikan cakupan di luar akses. */
export function resolveReportScope(input: ResolveReportScopeInput): AuthorizedScope {
  const parsed = parseRaw(input.rawScope);
  const { allBranches, accessible } = input;
  const order = new Map(allBranches.map((b, i) => [b.id, i]));
  const byOrder = (list: readonly ScopeBranchInput[]) => [...list].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // ----- flag OFF: satu cabang (Pusat), perilaku lama; SQL tanpa filter
  if (!input.multiBranchEnabled) {
    if (parsed.kind !== "none" && parsed.kind !== "all") {
      throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", "Fitur multi-cabang belum diaktifkan untuk perusahaan ini.");
    }
    const head = allBranches.find((b) => b.isHeadOffice) ?? allBranches[0];
    // Akun LIMITED yang tidak memegang Kantor Pusat tidak boleh membaca satu-satunya cabang perusahaan ini.
    if (!head || !accessible.some((b) => b.id === head.id)) throw NOT_FOUND();
    return make("COMPANY", [head], 1, { title: "Seluruh perusahaan", warnings: [] }, true);
  }

  const accessibleIds = new Set(accessible.map((b) => b.id));
  const byId = new Map(allBranches.map((b) => [b.id, b]));
  const pick = (ids: readonly string[]): ScopeBranchInput[] => {
    const rows = ids.map((id) => (accessibleIds.has(id) ? byId.get(id) : undefined));
    if (rows.some((r) => !r)) throw NOT_FOUND(); // satu id di luar akses/tidak ada => 404 seragam (tanpa oracle per id)
    return byOrder(rows as ScopeBranchInput[]);
  };

  // ----- tanpa parameter: cabang kerja aktif (D1)
  if (parsed.kind === "none") {
    if (!input.context) {
      throw new ReportScopeError(403, "REPORT_SCOPE_NO_BRANCH", "Anda belum memiliki cabang aktif yang dapat dipakai bekerja. Hubungi pemilik perusahaan.");
    }
    return make("SINGLE", [input.context], allBranches.length, singleLabel(input.context, true), false);
  }

  if (parsed.kind === "branch") {
    const [branch] = pick(parsed.ids);
    return make("SINGLE", [branch], allBranches.length, singleLabel(branch, true), false);
  }

  // ----- gabungan / komparasi: butuh report.consolidated. Dicek SEBELUM id agar respons tidak bergantung pada id (tanpa oracle).
  if (!input.canConsolidate) {
    throw new ReportScopeError(403, "REPORT_SCOPE_FORBIDDEN", "Anda tidak memiliki izin untuk laporan gabungan atau komparasi cabang.");
  }

  if (parsed.kind === "all") {
    if (allBranches.length <= 1) {
      const only = allBranches[0];
      if (!only || !accessibleIds.has(only.id)) throw NOT_FOUND();
      return make("SINGLE", [only], allBranches.length, singleLabel(only, true), false);
    }
    if (!allBranches.every((b) => accessibleIds.has(b.id))) {
      throw new ReportScopeError(403, "REPORT_SCOPE_FORBIDDEN", "Gabungan seluruh cabang memerlukan akses ke seluruh cabang perusahaan.");
    }
    return make("COMBINED_ALL", allBranches, allBranches.length, { title: "Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi", warnings: [ELIMINATION_WARNING, NOT_FINAL_WARNING] }, false);
  }

  const chosen = pick(parsed.ids);
  if (parsed.kind === "selected") {
    const warnings = [ELIMINATION_WARNING, NOT_FINAL_WARNING];
    if (chosen.length !== allBranches.length) warnings.push("Laporan ini tidak mencakup seluruh cabang perusahaan.");
    return make("COMBINED_SELECTED", chosen, allBranches.length, { title: `GABUNGAN CABANG TERPILIH: bukan laporan konsolidasi perusahaan (${chosen.map((b) => b.name).join(", ")})`, warnings }, false);
  }

  // parsed.kind === "branches" (komparasi)
  if (!input.allowComparison) throw new ReportScopeError(400, "REPORT_SCOPE_UNSUPPORTED", "Laporan ini belum mendukung komparasi per cabang.");
  if (chosen.length > REPORT_COMPARISON_MAX_BRANCHES) {
    throw new ReportScopeError(400, "REPORT_SCOPE_INVALID", `Komparasi maksimal ${REPORT_COMPARISON_MAX_BRANCHES} cabang.`);
  }
  return make("COMPARISON", chosen, allBranches.length, { title: `Komparasi Cabang (${chosen.map((b) => b.name).join(", ")})`, warnings: [`Kolom Gabungan: ${ELIMINATION_WARNING}`, NOT_FINAL_WARNING] }, false);
}

/** Cakupan satu cabang di dalam sebuah cakupan yang SUDAH diotorisasi (dipakai komparasi per kolom). */
export function scopeForBranch(scope: AuthorizedScope, branchId: string): AuthorizedScope {
  const branch = scope.branches.find((b) => b.id === branchId);
  if (!branch) throw NOT_FOUND();
  const single = { mode: "SINGLE", branchIds: [branch.id], branches: [branch], filterBranchIds: [branch.id], companyWide: false, eliminationStatus: "NOT_APPLICABLE", label: { title: branch.name, warnings: [] } };
  return single as unknown as AuthorizedScope;
}

/** Versi gabungan (satu kolom) dari cakupan komparasi -- dipakai kolom "Gabungan"; label tetap menyatakan belum dieliminasi. */
export function combinedScopeOf(scope: AuthorizedScope): AuthorizedScope {
  const combined = {
    mode: "COMBINED_SELECTED",
    branchIds: scope.branchIds,
    branches: scope.branches,
    filterBranchIds: scope.filterBranchIds,
    companyWide: scope.companyWide,
    eliminationStatus: "NOT_ELIMINATED",
    label: scope.label,
  };
  return combined as unknown as AuthorizedScope;
}

/** Representasi JSON untuk respons (`scope` pada tiap respons S): UI menampilkan ini, bukan keyakinannya sendiri. */
export interface ScopePayload {
  mode: ReportScopeMode;
  branches: ScopeBranch[];
  companyWide: boolean;
  eliminationStatus: EliminationStatus;
  label: ScopeLabel;
}
export function scopePayload(scope: AuthorizedScope): ScopePayload {
  return {
    mode: scope.mode,
    branches: scope.branches.map((b) => ({ ...b })),
    companyWide: scope.companyWide,
    eliminationStatus: scope.eliminationStatus,
    label: { title: scope.label.title, warnings: [...scope.label.warnings] },
  };
}

/** Menambahkan `je.branch_id IN (...)` bila cakupan memfilter; bila tidak, kueri TIDAK berubah (identik dengan sebelum Phase 5). */
export function applyBranchScope<T extends Knex.QueryBuilder>(qb: T, scope: AuthorizedScope | undefined, column = "je.branch_id"): T {
  if (!scope || scope.filterBranchIds === null) return qb;
  if (scope.filterBranchIds.length === 0) return qb.whereRaw("1 = 0") as T;
  return qb.whereIn(column, [...scope.filterBranchIds]) as T;
}
