import { useEffect, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import { Card } from "../../../components/ui.js";
import type { AccessibleCompany } from "../../../features/workspace/types.js";
import { useCompanyProfile, useUpdateCompanyProfile } from "../../../features/workspace/use-company-profile.js";
import type { CompanyProfile } from "../../../features/workspace/company-profile-types.js";

type FormState = Pick<
  CompanyProfile,
  "name" | "tradeName" | "legalEntityType" | "industry" | "npwp" | "nib" | "address" | "city" | "province" | "postalCode" | "phone" | "email" | "website"
>;

function toFormState(p: CompanyProfile): FormState {
  return {
    name: p.name,
    tradeName: p.tradeName ?? "",
    legalEntityType: p.legalEntityType ?? "",
    industry: p.industry ?? "",
    npwp: p.npwp ?? "",
    nib: p.nib ?? "",
    address: p.address ?? "",
    city: p.city ?? "",
    province: p.province ?? "",
    postalCode: p.postalCode ?? "",
    phone: p.phone ?? "",
    email: p.email ?? "",
    website: p.website ?? "",
  };
}

/**
 * Profil Perusahaan (TASK-023 §3) -- CRUD penuh pakai field yang memang
 * ada di skema `company_profile` (C0001). Kolom yang skema-nya TIDAK
 * mendukung (mis. nomor registrasi lain selain NPWP/NIB) TIDAK ditambah
 * -- didokumentasikan sbg keterbatasan, bukan field database baru.
 */
export function CompanyProfilePage() {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();
  const { data, isLoading, isError, error } = useCompanyProfile(company.slug);
  const update = useUpdateCompanyProfile(company.slug);
  const canEdit = company.role === "OWNER" || company.role === "ADMIN";

  const [form, setForm] = useState<FormState | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data?.profile) setForm(toFormState(data.profile));
  }, [data?.profile]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function handleSave() {
    if (!form) return;
    await update.mutateAsync({
      ...form,
      tradeName: form.tradeName || null,
      legalEntityType: form.legalEntityType || null,
      industry: form.industry || null,
      npwp: form.npwp || null,
      nib: form.nib || null,
      address: form.address || null,
      city: form.city || null,
      province: form.province || null,
      postalCode: form.postalCode || null,
      phone: form.phone || null,
      email: form.email || null,
      website: form.website || null,
    });
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 2500);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Profil Perusahaan</h1>
        <p className="text-sm text-ink/50">Identitas dan data kontak {company.name}.</p>
      </div>

      {isLoading && <Card className="p-6 text-sm text-ink/40">Memuat...</Card>}
      {isError && <Card className="p-6 text-sm text-rose-600">{(error as Error).message}</Card>}

      {!isLoading && !isError && form && (
        <Card className="max-w-3xl p-6">
          <Section title="Identitas">
            <Field label="Nama Perusahaan">
              <input value={form.name} onChange={(e) => set("name", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Nama Dagang (opsional)">
              <input value={form.tradeName ?? ""} onChange={(e) => set("tradeName", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Bentuk Badan Usaha">
              <input value={form.legalEntityType ?? ""} onChange={(e) => set("legalEntityType", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" placeholder="mis. PT, CV, Perorangan" />
            </Field>
            <Field label="Industri">
              <input value={form.industry ?? ""} onChange={(e) => set("industry", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
          </Section>

          <Section title="Legalitas">
            <Field label="NPWP">
              <input value={form.npwp ?? ""} onChange={(e) => set("npwp", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="NIB">
              <input value={form.nib ?? ""} onChange={(e) => set("nib", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
          </Section>

          <Section title="Alamat & Kontak">
            <Field label="Alamat" span2>
              <input value={form.address ?? ""} onChange={(e) => set("address", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Kota">
              <input value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Provinsi">
              <input value={form.province ?? ""} onChange={(e) => set("province", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Kode Pos">
              <input value={form.postalCode ?? ""} onChange={(e) => set("postalCode", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Telepon">
              <input value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Email">
              <input value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
            <Field label="Website">
              <input value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} disabled={!canEdit} className="input-base w-full disabled:opacity-60" />
            </Field>
          </Section>

          {update.isError && <p className="mb-3 text-sm text-rose-600">{(update.error as Error).message}</p>}
          {savedAt && <p className="mb-3 text-sm text-emerald-600">✓ Perubahan disimpan.</p>}

          {canEdit ? (
            <button
              type="button"
              disabled={!form.name.trim() || update.isPending}
              onClick={handleSave}
              className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
            >
              {update.isPending ? "Menyimpan..." : "Simpan Perubahan"}
            </button>
          ) : (
            <p className="text-xs text-ink/40">Hanya OWNER/ADMIN yang dapat mengubah profil perusahaan.</p>
          )}
        </Card>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6 border-b border-line pb-6 last:mb-5 last:border-b-0 last:pb-0">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink/40">{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({ label, children, span2 }: { label: string; children: ReactNode; span2?: boolean }) {
  return (
    <div className={span2 ? "sm:col-span-2" : ""}>
      <label className="mb-1.5 block text-xs font-medium text-ink/60">{label}</label>
      {children}
    </div>
  );
}
