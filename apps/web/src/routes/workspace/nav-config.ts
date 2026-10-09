/**
 * Struktur navigasi workspace baru -- persis urutan/pengelompokan di
 * `Style_Guide.md` §15 (Sidebar). SATU sumber dipakai dua tempat (sidebar
 * `workspace-shell.tsx` DAN generator <Route> di `App.tsx`) supaya tidak
 * ada dua daftar yang bisa diam-diam tidak sinkron.
 *
 * TASK-DB-ARCH-013 scope: HANYA navigation foundation -- setiap item
 * (selain Dashboard) merender placeholder generik (`workspace-placeholder-
 * page.tsx`), BUKAN modul bisnis sungguhan (jurnal/laporan/dst menyusul di
 * task terpisah, instruksi §9).
 */

export interface WorkspaceNavLeaf {
  /** "" khusus utk Dashboard -- dirender sbg index route. */
  key: string;
  label: string;
  /**
   * Item tampil bersyarat (UX saja). "inter-branch" = multi-cabang aktif DAN pengguna punya izin `interbranch.read` DAN
   * punya akses ke minimal satu cabang. Rute tetap terdaftar; URL langsung ditolak server (flag OFF => 404, tanpa izin => 403).
   */
  requires?: "inter-branch";
}

export interface WorkspaceNavGroup {
  /** undefined utk grup tanpa heading (Dashboard). */
  group?: string;
  items: WorkspaceNavLeaf[];
}

export const WORKSPACE_NAV: WorkspaceNavGroup[] = [
  { items: [{ key: "", label: "Dashboard" }] },
  {
    group: "PERUSAHAAN",
    items: [
      { key: "perusahaan", label: "Perusahaan" },
      { key: "accounts", label: "Chart of Accounts" },
      { key: "opening-balance", label: "Opening Balance" },
      { key: "data-awal", label: "Data Awal" },
    ],
  },
  {
    group: "AKUNTANSI",
    items: [
      { key: "jurnal", label: "Jurnal" },
      { key: "antar-cabang", label: "Antar Cabang", requires: "inter-branch" },
      { key: "ledger", label: "Ledger" },
      { key: "trial-balance", label: "Trial Balance" },
      { key: "buku", label: "Buku" },
      { key: "hutang-piutang", label: "Hutang & Piutang" },
    ],
  },
  { group: "PAJAK", items: [{ key: "pajak", label: "Pajak" }] },
  {
    group: "LAPORAN",
    items: [
      { key: "reports", label: "Financial Reports" },
      { key: "laporan-keuangan", label: "Laporan Keuangan" },
      { key: "laporan-buku", label: "Laporan Buku" },
      { key: "analisis", label: "Analisis" },
    ],
  },
  { group: "PROYEKSI", items: [{ key: "proyeksi", label: "Proyeksi" }] },
  {
    group: "SYSTEM",
    items: [
      { key: "pengguna", label: "Pengguna" },
      { key: "pengaturan", label: "Pengaturan" },
      { key: "audit-log", label: "Audit Log" },
    ],
  },
];

export const WORKSPACE_NAV_LEAVES: WorkspaceNavLeaf[] = WORKSPACE_NAV.flatMap((g) => g.items);
