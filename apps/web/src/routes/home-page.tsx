import { Building2, LayoutGrid } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardHeader } from "../components/ui.js";
import { useMe } from "../features/auth/use-auth.js";
import { useAccessibleCompanies } from "../features/workspace/use-workspace.js";

/** Beranda -- SEBELUMNYA placeholder sisa dari fondasi Administrator
 * (sebelum pivot ke Konsultan multi-perusahaan), isinya salah/usang
 * ("fitur Kasir/Backoffice akan dibangun terpisah" -- padahal proyek ini
 * sudah dipivot total ke laporan keuangan multi-perusahaan, bukan
 * Kasir/POS). Diganti jadi ringkasan portofolio + jalan pintas ke
 * Perusahaan, supaya tidak lagi menampilkan info yang menyesatkan.
 *
 * TASK-021: SEBELUMNYA memakai `useCompanies()` (hook legacy, hit
 * `/api/companies` -- TANPA filter `company_access`) & link ke
 * `/companies` (rute legacy) -- satu-satunya pintu masuk UI yang masih
 * diam-diam mengarah ke arsitektur lama setelah TASK-020 memindah nav
 * "Perusahaan" ke `/workspace`. Diganti ke `useAccessibleCompanies()` +
 * link `/workspace` supaya Beranda juga konsisten memakai jalur baru yang
 * sudah py kontrol akses benar (sama dgn Company Selector), DAN supaya
 * jumlah "Perusahaan Dikelola" mencerminkan company yang BENAR boleh
 * dilihat user ybs, bukan seluruh company di instalasi ini. */
export function HomePage() {
  const { data: me } = useMe();
  const { data: companiesData, isLoading } = useAccessibleCompanies();
  const companies = companiesData?.companies ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Selamat Datang, {me?.user.fullName}</h1>
        <p className="text-sm text-ink/50">Ringkasan singkat instalasi TERRA FINANCE Anda.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Perusahaan Dikelola" icon={<Building2 size={16} className="text-heading/60" />} />
          <div className="p-5">
            <p className="text-3xl font-bold text-heading">{isLoading ? "…" : companies.length}</p>
            <p className="mt-1 text-sm text-ink/50">Total perusahaan klien terdaftar di instalasi ini.</p>
            <Link to="/workspace" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
              Lihat Daftar Perusahaan →
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader title="Mulai Cepat" icon={<LayoutGrid size={16} className="text-heading/60" />} />
          <div className="p-5 text-sm text-ink/60">
            <p>
              Pilih perusahaan di menu <strong className="text-heading">Perusahaan</strong> untuk melihat Dashboard KPI,
              Chart of Accounts, Jurnal, Buku Besar, Rasio Keuangan, & Estimasi Pajak. Bandingkan beberapa perusahaan
              sekaligus lewat menu <strong className="text-heading">Benchmarking</strong>.
            </p>
          </div>
        </Card>
      </div>

      {!isLoading && companies.length === 0 && (
        <Card className="flex flex-col items-center gap-2 border-dashed p-10 text-center">
          <p className="text-sm text-ink/60">Belum ada perusahaan. Tambahkan klien pertama Anda lewat menu Perusahaan.</p>
        </Card>
      )}
    </div>
  );
}
