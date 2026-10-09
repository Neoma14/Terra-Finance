import type { PropsWithChildren } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AdministratorDashboardPage } from "./routes/administrator-dashboard-page.js";
import { AdministratorLoginPage } from "./routes/administrator-login-page.js";
import { AccountsPage } from "./routes/accounts-page.js";
import { AppShell } from "./routes/app-shell.js";
import { CompaniesPage } from "./routes/companies-page.js";
import { JournalPage } from "./routes/journal-page.js";
import { LedgerPage } from "./routes/ledger-page.js";
import { RatiosPage } from "./routes/ratios-page.js";
import { TaxPage } from "./routes/tax-page.js";
import { BenchmarkPage } from "./routes/benchmark-page.js";
import { CompanyDetailPage } from "./routes/company-detail-page.js";
import { HomePage } from "./routes/home-page.js";
import { LicensePage } from "./routes/license-page.js";
import { LoginPage } from "./routes/login-page.js";
import { RequireAuth } from "./routes/require-auth.js";
import { SettingsPage } from "./routes/settings-page.js";
import { SetupWizardPage } from "./routes/setup-wizard-page.js";
import { UsersPage } from "./routes/users-page.js";
import { useSetupStatus } from "./features/setup/use-setup.js";
import { CompanySelectorPage } from "./routes/workspace/company-selector-page.js";
import { WorkspaceShell } from "./routes/workspace/workspace-shell.js";
import { WorkspacePlaceholderPage } from "./routes/workspace/workspace-placeholder-page.js";
import { JournalPage as WorkspaceJournalPage } from "./routes/workspace/journal/journal-page.js";
import { AccountsPage as WorkspaceAccountsPage } from "./routes/workspace/accounts/accounts-page.js";
import { OpeningBalancePage as WorkspaceOpeningBalancePage } from "./routes/workspace/opening-balance/opening-balance-page.js";
import { LedgerPage as WorkspaceLedgerPage } from "./routes/workspace/ledger/ledger-page.js";
import { TrialBalancePage as WorkspaceTrialBalancePage } from "./routes/workspace/trial-balance/trial-balance-page.js";
import { ReportsPage as WorkspaceReportsPage } from "./routes/workspace/reports/reports-page.js";
import { DashboardPage as WorkspaceDashboardPage } from "./routes/workspace/dashboard/dashboard-page.js";
import { UsersPage as WorkspaceUsersPage } from "./routes/workspace/users/users-page.js";
import { CompanyProfilePage } from "./routes/workspace/company-profile/company-profile-page.js";
import { CompanySettingsPage } from "./routes/workspace/company-settings/company-settings-page.js";
import { DataAwalPage } from "./routes/workspace/data-awal/data-awal-page.js";
import { BooksHubPage } from "./routes/workspace/books/books-hub-page.js";
import { AnalysisPage } from "./routes/workspace/analysis/analysis-page.js";
import { CounterpartiesPage } from "./routes/workspace/counterparties/counterparties-page.js";
import { TaxPage as WorkspaceTaxPage } from "./routes/workspace/tax/tax-page.js";
import { ProjectionPage } from "./routes/workspace/projection/projection-page.js";
import { AuditLogPage } from "./routes/workspace/audit-log/audit-log-page.js";
import { InterBranchPage } from "./routes/workspace/inter-branch/inter-branch-page.js";
import { WORKSPACE_NAV_LEAVES } from "./routes/workspace/nav-config.js";

/** Nav leaf yang SUDAH punya modul nyata (bukan placeholder lagi) --
 * TASK-DB-ARCH-014/015/016/017 (jurnal/accounts/opening-balance/ledger/
 * trial-balance/reports), TASK-022 (pengguna), TASK-023 (sisanya, lihat
 * Change_Log.md utk pemetaan menu mana reuse komponen apa -- beberapa
 * key SENGAJA mengarah ke komponen yang SAMA dgn key lain, bukan
 * duplikasi tak sengaja, lihat komentar di tiap halaman terkait). Daftar
 * ini dicocokkan ke `WORKSPACE_NAV_LEAVES` (nav-config.ts). */
const WORKSPACE_REAL_MODULES: Partial<Record<string, () => JSX.Element>> = {
  "": () => <WorkspaceDashboardPage />,
  jurnal: () => <WorkspaceJournalPage />,
  "antar-cabang": () => <InterBranchPage />,
  accounts: () => <WorkspaceAccountsPage />,
  "opening-balance": () => <WorkspaceOpeningBalancePage />,
  ledger: () => <WorkspaceLedgerPage />,
  "trial-balance": () => <WorkspaceTrialBalancePage />,
  reports: () => <WorkspaceReportsPage />,
  pengguna: () => <WorkspaceUsersPage />,
  perusahaan: () => <CompanyProfilePage />,
  pengaturan: () => <CompanySettingsPage />,
  "data-awal": () => <DataAwalPage />,
  buku: () => <BooksHubPage />,
  "laporan-buku": () => <BooksHubPage includeTrialBalance />,
  "laporan-keuangan": () => <WorkspaceReportsPage />,
  analisis: () => <AnalysisPage />,
  "hutang-piutang": () => <CounterpartiesPage />,
  pajak: () => <WorkspaceTaxPage />,
  proyeksi: () => <ProjectionPage />,
  "audit-log": () => <AuditLogPage />,
};

/** Gerbang first-run -- kalau instalasi ini belum di-setup (`users`/
 * `company_profile` masih kosong), paksa ke wizard setup TERLEPAS dari
 * route yang diminta (kecuali /administrator/*, supaya TTD tetap bisa
 * masuk memeriksa instalasi yang gagal setup di tengah jalan). */
function SetupGate({ children }: PropsWithChildren) {
  const { data, isLoading } = useSetupStatus();

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-ink/50">Memuat...</div>;
  }
  if (data?.needsSetup) {
    return <Navigate to="/setup" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupWizardPage />} />

      <Route path="/administrator/login" element={<AdministratorLoginPage />} />
      <Route path="/administrator" element={<AdministratorDashboardPage />} />

      <Route
        path="/login"
        element={
          <SetupGate>
            <LoginPage />
          </SetupGate>
        }
      />

      <Route
        path="/"
        element={
          <SetupGate>
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          </SetupGate>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="benchmark" element={<BenchmarkPage />} />
        <Route path="c/:companySlug" element={<CompanyDetailPage />} />
        <Route path="c/:companySlug/accounts" element={<AccountsPage />} />
        <Route path="c/:companySlug/journal" element={<JournalPage />} />
        <Route path="c/:companySlug/ledger" element={<LedgerPage />} />
        {/* Laporan Keuangan sekarang ada langsung di CompanyDetailPage (tab
            "Laporan") -- redirect utk URL lama yg mungkin masih ke-bookmark. */}
        <Route path="c/:companySlug/statements" element={<Navigate to=".." relative="path" replace />} />
        <Route path="c/:companySlug/ratios" element={<RatiosPage />} />
        <Route path="c/:companySlug/tax" element={<TaxPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="lisensi" element={<LicensePage />} />
      </Route>

      {/* TASK-DB-ARCH-013: fondasi UI BARU, company-scoped
          (`/api/company-db/:slug/...`, ADR-001) -- PARALEL dgn tree "/"
          legacy di atas (shared single-DB), bukan penggantinya. Lihat
          Change_Log.md utk konteks keputusan ini. */}
      <Route
        path="/workspace"
        element={
          <SetupGate>
            <RequireAuth>
              <CompanySelectorPage />
            </RequireAuth>
          </SetupGate>
        }
      />
      <Route
        path="/workspace/:companySlug"
        element={
          <SetupGate>
            <RequireAuth>
              <WorkspaceShell />
            </RequireAuth>
          </SetupGate>
        }
      >
        {WORKSPACE_NAV_LEAVES.map((item) => {
          const RealModule = WORKSPACE_REAL_MODULES[item.key];
          const element = RealModule ? <RealModule /> : <WorkspacePlaceholderPage label={item.label} />;
          return item.key === "" ? (
            <Route key="dashboard" index element={element} />
          ) : (
            <Route key={item.key} path={item.key} element={element} />
          );
        })}
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
