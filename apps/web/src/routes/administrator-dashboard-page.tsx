import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Bug,
  Gauge,
  LogOut,
  Monitor,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Badge, Card, CardHeader } from "../components/ui.js";
import {
  useAdministratorLogout,
  useAdministratorMe,
  useAnomalies,
  useApproveDevice,
  useAuditLog,
  useDevices,
  useDiagnostics,
  useErrorLog,
  useReviewAnomaly,
} from "../features/administrator/use-administrator.js";

type Tab = "audit" | "errors" | "diagnostics" | "anomalies" | "devices" | "license";

function formatDate(value: string): string {
  return new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z")).toLocaleString("id-ID");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const SEVERITY_TONE: Record<string, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

export function AdministratorDashboardPage() {
  const navigate = useNavigate();
  const { data: meData, isLoading, isError } = useAdministratorMe();
  const logout = useAdministratorLogout();
  const [tab, setTab] = useState<Tab>("audit");

  if (isLoading) return <p className="p-10 text-center text-ink/50">Memuat...</p>;
  if (isError || !meData) {
    navigate("/administrator/login", { replace: true });
    return null;
  }

  const license = meData.license;

  async function handleLogout() {
    await logout.mutateAsync();
    navigate("/administrator/login", { replace: true });
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="flex items-center justify-between border-b border-line bg-navy-700 px-6 py-4 text-white">
        <div className="flex items-center gap-2.5">
          <ShieldAlert size={20} className="text-amber-300" />
          <div>
            <h1 className="text-sm font-bold">Panel Administrator</h1>
            <p className="text-xs text-white/50">{license.clientName ?? "-"}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
        >
          <LogOut size={13} /> Keluar
        </button>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="mb-5 flex flex-wrap gap-1 rounded-full bg-surface-2 p-1 w-fit">
          {[
            { key: "audit" as const, label: "Audit Trail", icon: Activity },
            { key: "errors" as const, label: "Log Error", icon: Bug },
            { key: "diagnostics" as const, label: "Diagnostik", icon: Gauge },
            { key: "anomalies" as const, label: "Anomali", icon: AlertTriangle },
            { key: "devices" as const, label: "Perangkat", icon: Monitor },
            { key: "license" as const, label: "Lisensi", icon: ShieldCheck },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === key ? "bg-surface text-heading" : "text-ink/50 hover:text-ink"
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === "audit" && <AuditTrailTab />}
        {tab === "errors" && <ErrorLogTab />}
        {tab === "diagnostics" && <DiagnosticsTab />}
        {tab === "anomalies" && <AnomaliesTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "license" && <LicenseTab license={license} />}
      </div>
    </div>
  );
}

function AuditTrailTab() {
  const { data, isLoading } = useAuditLog();
  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader title="Audit Trail" icon={<Activity size={16} className="text-heading/60" />} />
      <p className="px-5 pt-3 text-sm text-ink/50">
        Riwayat lengkap aktivitas -- login/logout, perubahan data, dan aksi Administrator. Baris di sini bersifat
        permanen (tidak bisa diubah/dihapus oleh siapa pun).
      </p>
      {isLoading ? (
        <p className="p-5 text-ink/50">Memuat...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-navy-700 text-left text-xs uppercase tracking-wide text-white">
                <th className="px-5 py-2.5">Waktu</th>
                <th className="px-5 py-2.5">Aktor</th>
                <th className="px-5 py-2.5">Aksi</th>
                <th className="px-5 py-2.5">Entitas</th>
                <th className="px-5 py-2.5">Alasan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-2 tabular-nums text-ink/70">{formatDate(r.createdAt)}</td>
                  <td className="px-5 py-2">
                    <Badge tone={r.actorType === "administrator" ? "warning" : "neutral"}>{r.actorLabel}</Badge>
                  </td>
                  <td className="px-5 py-2 font-mono text-xs text-ink">{r.action}</td>
                  <td className="px-5 py-2 text-ink/60">{r.entityType ? `${r.entityType}${r.entityId ? ` #${r.entityId.slice(0, 8)}` : ""}` : "-"}</td>
                  <td className="px-5 py-2 text-ink/50">{r.reason ?? "-"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-center text-ink/40">
                    Belum ada aktivitas tercatat
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ErrorLogTab() {
  const { data, isLoading } = useErrorLog();
  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader title="Log Error" icon={<Bug size={16} className="text-heading/60" />} />
      {isLoading ? (
        <p className="p-5 text-ink/50">Memuat...</p>
      ) : rows.length === 0 ? (
        <p className="p-5 text-center text-ink/40">Tidak ada error tercatat -- aplikasi berjalan normal.</p>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.id} className="p-5">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone={r.level === "fatal" ? "danger" : r.level === "error" ? "warning" : "neutral"}>{r.level}</Badge>
                <span className="text-xs text-ink/40">{r.module}</span>
                <span className="text-xs text-ink/30">v{r.appVersion}</span>
                <span className="ml-auto text-xs text-ink/40">{formatDate(r.createdAt)}</span>
              </div>
              <p className="text-sm text-ink">{r.message}</p>
              {r.stackTrace && <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs text-ink/60">{r.stackTrace}</pre>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DiagnosticsTab() {
  const { data, isLoading } = useDiagnostics();
  const d = data?.diagnostics;

  if (isLoading || !d) return <p className="p-5 text-ink/50">Memuat...</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="p-5">
        <p className="text-xs uppercase tracking-wide text-ink/40">Versi Aplikasi</p>
        <p className="mt-1 text-lg font-bold text-heading">{d.appVersion}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs uppercase tracking-wide text-ink/40">Ukuran Database</p>
        <p className="mt-1 text-lg font-bold text-heading">{formatBytes(d.dbSizeBytes)}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs uppercase tracking-wide text-ink/40">Integritas Database</p>
        <p className={`mt-1 text-lg font-bold ${d.integrityOk ? "text-emerald-600" : "text-rose-600"}`}>
          {d.integrityOk ? "OK" : "Bermasalah"}
        </p>
      </Card>
      <Card className="p-5">
        <p className="text-xs uppercase tracking-wide text-ink/40">Anomali Belum Ditinjau</p>
        <p className="mt-1 text-lg font-bold text-heading">{d.unreviewedAnomalyCount}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs uppercase tracking-wide text-ink/40">Jumlah User</p>
        <p className="mt-1 text-lg font-bold text-heading">{d.userCount}</p>
      </Card>
      <Card className="p-5">
        <p className="text-xs uppercase tracking-wide text-ink/40">Sesi Login Aktif</p>
        <p className="mt-1 text-lg font-bold text-heading">{d.sessionCount}</p>
      </Card>
      <Card className="p-5 sm:col-span-2">
        <p className="text-xs uppercase tracking-wide text-ink/40">Lokasi File Database</p>
        <p className="mt-1 break-all font-mono text-xs text-ink/70">{d.dbFilePath}</p>
      </Card>
    </div>
  );
}

function AnomaliesTab() {
  const { data, isLoading } = useAnomalies();
  const reviewAnomaly = useReviewAnomaly();
  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader title="Deteksi Anomali" icon={<AlertTriangle size={16} className="text-heading/60" />} />
      <p className="px-5 pt-3 text-sm text-ink/50">
        Daftar transaksi/aktivitas yang ditandai tidak biasa -- murni informational, tidak ada yang diblokir otomatis.
      </p>
      {isLoading ? (
        <p className="p-5 text-ink/50">Memuat...</p>
      ) : rows.length === 0 ? (
        <p className="p-5 text-center text-ink/40">Tidak ada anomali terdeteksi.</p>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-4 p-5">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{r.severity}</Badge>
                  <span className="font-mono text-xs text-ink/40">{r.ruleCode}</span>
                  {r.reviewedAt && <Badge tone="success">Sudah ditinjau</Badge>}
                </div>
                <p className="text-sm text-ink">{r.description}</p>
                <p className="mt-1 text-xs text-ink/40">{formatDate(r.detectedAt)}</p>
              </div>
              {!r.reviewedAt && (
                <button
                  type="button"
                  onClick={() => reviewAnomaly.mutate(r.id)}
                  disabled={reviewAnomaly.isPending}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-heading hover:bg-surface-2"
                >
                  Tandai Ditinjau
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DevicesTab() {
  const { data, isLoading } = useDevices();
  const approveDevice = useApproveDevice();
  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader title="Perangkat Terhubung" icon={<Monitor size={16} className="text-heading/60" />} />
      {isLoading ? (
        <p className="p-5 text-ink/50">Memuat...</p>
      ) : rows.length === 0 ? (
        <p className="p-5 text-center text-ink/40">Belum ada perangkat lain yang terdeteksi terhubung.</p>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-4 p-5">
              <div>
                <p className="font-medium text-heading">{r.deviceName}</p>
                <p className="font-mono text-xs text-ink/40">{r.fingerprint}</p>
                <p className="mt-1 text-xs text-ink/40">Terakhir terlihat: {formatDate(r.lastSeenAt)}</p>
              </div>
              {r.approved ? (
                <Badge tone="success">Disetujui</Badge>
              ) : (
                <button
                  type="button"
                  onClick={() => approveDevice.mutate(r.id)}
                  disabled={approveDevice.isPending}
                  className="rounded-lg bg-navy-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-navy-900"
                >
                  Setujui
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function LicenseTab({ license }: { license: { clientName: string | null; status: string | null; expiresAt: string | null; fingerprintMatches: boolean | null } }) {
  return (
    <Card className="p-6">
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/40">Nama Klien</p>
          <p className="text-lg font-bold text-heading">{license.clientName}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/40">Status</p>
          <Badge tone={license.status === "active" ? "success" : license.status === "expired" ? "warning" : "danger"}>
            {license.status}
          </Badge>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/40">Masa Berlaku</p>
          <p className="text-sm text-ink">{license.expiresAt ? formatDate(license.expiresAt) : "Tidak ada batas waktu"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/40">Kecocokan Fingerprint Mesin</p>
          <Badge tone={license.fingerprintMatches ? "success" : "danger"}>
            {license.fingerprintMatches ? "Cocok" : "TIDAK COCOK -- kemungkinan dipindah ke komputer lain"}
          </Badge>
        </div>
      </div>
    </Card>
  );
}
