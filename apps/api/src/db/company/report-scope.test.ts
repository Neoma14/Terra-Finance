import { describe, it, expect } from "vitest";
import { applyBranchScope, REPORT_COMPARISON_MAX_BRANCHES, ReportScopeError, resolveReportScope, scopeForBranch, scopePayload, type ResolveReportScopeInput, type ScopeBranchInput } from "./report-scope.js";

/** Keputusan cakupan laporan (murni): matriks akses × permission × parameter, tanpa DB/HTTP. */
const br = (id: string, name: string, isHeadOffice = false, status = "ACTIVE"): ScopeBranchInput => ({ id, code: id.toUpperCase(), name, status, isHeadOffice });
const HQ = br("hq", "Kantor Pusat", true), M = br("m", "Metro"), B = br("b", "Bandar Lampung"), K = br("k", "Kotabumi", false, "CLOSED");
const ALL = [HQ, M, B, K];

const input = (o: Partial<ResolveReportScopeInput> = {}): ResolveReportScopeInput => ({
  multiBranchEnabled: true, allBranches: ALL, accessible: ALL, context: M, canConsolidate: true, rawScope: undefined, allowComparison: true, ...o,
});
const fail = (o: Partial<ResolveReportScopeInput>) => { try { resolveReportScope(input(o)); } catch (e) { return e as ReportScopeError; } throw new Error("seharusnya ditolak"); };

describe("resolveReportScope", () => {
  it("flag OFF: seluruh perusahaan tanpa filter SQL; parameter selain kosong/all -> 400; LIMITED tanpa Kantor Pusat -> 404", () => {
    const s = resolveReportScope(input({ multiBranchEnabled: false, allBranches: [HQ], accessible: [HQ], context: HQ }));
    expect(s.mode).toBe("COMPANY");
    expect(s.filterBranchIds).toBeNull();
    expect(resolveReportScope(input({ multiBranchEnabled: false, allBranches: [HQ], accessible: [HQ], context: HQ, rawScope: "all" })).mode).toBe("COMPANY");
    for (const raw of ["branch:hq", "selected:a,b", "branches:a,b"]) expect(fail({ multiBranchEnabled: false, allBranches: [HQ], accessible: [HQ], rawScope: raw }).status).toBe(400);
    expect(fail({ multiBranchEnabled: false, allBranches: [HQ], accessible: [], context: null }).status).toBe(404);
  });

  it("tanpa parameter = cabang kerja aktif; tanpa konteks -> 403 REPORT_SCOPE_NO_BRANCH", () => {
    const s = resolveReportScope(input());
    expect(s.mode).toBe("SINGLE");
    expect(s.branchIds).toEqual(["m"]);
    expect(s.filterBranchIds).toEqual(["m"]);
    expect(fail({ context: null, accessible: [] }).code).toBe("REPORT_SCOPE_NO_BRANCH");
  });

  it("branch:X: hanya cabang dalam akses (INACTIVE/CLOSED boleh, historis); selain itu 404 dengan badan identik", () => {
    const a = fail({ accessible: [M], rawScope: "branch:b" }), b = fail({ accessible: [M], rawScope: "branch:tidak-ada" });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(a.message).toBe(b.message);
    const closed = resolveReportScope(input({ rawScope: "branch:k" }));
    expect(closed.label.warnings.join(" ")).toMatch(/historis/);
  });

  it("gabungan/komparasi: 403 tanpa report.consolidated TANPA bergantung pada id; id di luar akses -> 404 seragam", () => {
    const a = fail({ canConsolidate: false, rawScope: "selected:m,b" }), b = fail({ canConsolidate: false, rawScope: "selected:x1,x2" });
    expect([a.status, b.status, a.code]).toEqual([403, 403, "REPORT_SCOPE_FORBIDDEN"]);
    expect(a.message).toBe(b.message);
    expect(fail({ accessible: [M, B], rawScope: "selected:m,hq" }).status).toBe(404);
    expect(fail({ canConsolidate: false, rawScope: "all" }).status).toBe(403);
    expect(fail({ canConsolidate: false, rawScope: "branches:m,b" }).status).toBe(403);
  });

  it("all: butuh akses ke SELURUH cabang; label wajib 'belum dieliminasi' dan tidak menyebut konsolidasi final", () => {
    expect(fail({ accessible: [M, B], rawScope: "all" }).status).toBe(403);
    const s = resolveReportScope(input({ rawScope: "all" }));
    expect(s.mode).toBe("COMBINED_ALL");
    expect(s.companyWide).toBe(true);
    expect(s.filterBranchIds).toBeNull();
    expect(s.eliminationStatus).toBe("NOT_ELIMINATED");
    expect(s.label.title).toBe("Gabungan Seluruh Cabang: saldo antar-cabang belum dieliminasi");
    expect(s.label.warnings.join(" ")).toMatch(/bukan laporan konsolidasi final/);
  });

  it("selected: judul berlabel GABUNGAN CABANG TERPILIH; urutan mengikuti sort_order; duplikat dibuang; peringatan bila tidak mencakup semua cabang", () => {
    const s = resolveReportScope(input({ rawScope: "selected:b,m,m" }));
    expect(s.branchIds).toEqual(["m", "b"]);
    expect(s.filterBranchIds).toEqual(["m", "b"]);
    expect(s.label.title).toMatch(/^GABUNGAN CABANG TERPILIH: bukan laporan konsolidasi perusahaan/);
    expect(s.label.warnings.join(" ")).toMatch(/tidak mencakup seluruh cabang/);
  });

  it("komparasi: hanya bila endpoint mendukung; batas jumlah cabang; sintaks rusak -> 400", () => {
    expect(resolveReportScope(input({ rawScope: "branches:m,b" })).mode).toBe("COMPARISON");
    expect(fail({ rawScope: "branches:m,b", allowComparison: false }).code).toBe("REPORT_SCOPE_UNSUPPORTED");
    const many = Array.from({ length: REPORT_COMPARISON_MAX_BRANCHES + 1 }, (_, i) => br(`c${i}`, `C${i}`));
    expect(fail({ allBranches: many, accessible: many, rawScope: `branches:${many.map((x) => x.id).join(",")}` }).status).toBe(400);
    for (const raw of ["branch:", "branch:a,b", "selected:a", "xx", "branch:a b", "branch:';--", "selected:" + Array.from({ length: 51 }, (_, i) => `x${i}`).join(",")]) expect(fail({ rawScope: raw }).status, raw).toBe(400);
  });

  it("scopeForBranch tidak dapat keluar dari cakupan yang sudah diotorisasi; payload tidak memuat apa pun di luar cakupan", () => {
    const s = resolveReportScope(input({ accessible: [M, B], rawScope: "branches:m,b" }));
    expect(scopeForBranch(s, "m").filterBranchIds).toEqual(["m"]);
    expect(() => scopeForBranch(s, "hq")).toThrow(ReportScopeError);
    expect(JSON.stringify(scopePayload(s))).not.toMatch(/Kantor Pusat|Kotabumi/);
  });

  it("applyBranchScope: tanpa filter kueri tidak berubah; dengan filter menambah IN; filter kosong fail-closed", () => {
    const calls: unknown[][] = [];
    const qb = { whereIn: (...a: unknown[]) => (calls.push(["in", ...a]), qb), whereRaw: (...a: unknown[]) => (calls.push(["raw", ...a]), qb) };
    expect(applyBranchScope(qb as never, undefined)).toBe(qb);
    expect(applyBranchScope(qb as never, resolveReportScope(input({ rawScope: "all" })))).toBe(qb);
    expect(calls).toEqual([]);
    applyBranchScope(qb as never, resolveReportScope(input({ rawScope: "branch:m" })));
    expect(calls).toEqual([["in", "je.branch_id", ["m"]]]);
    const empty = { filterBranchIds: [] } as never;
    applyBranchScope(qb as never, empty);
    expect(calls[1]).toEqual(["raw", "1 = 0"]);
  });
});
