import type { Period } from "@konsultan/shared";
import { isBalancedExact } from "../lib/money.js";
import { CheckCircle2, Download, History, PenLine, RotateCcw, UploadCloud, XCircle } from "lucide-react";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { BackToCompanyLink, Card, CardHeader } from "../components/ui.js";
import { useAccounts } from "../features/accounts/use-accounts.js";
import { useCounterparties, useCreateCounterparty } from "../features/counterparties/use-counterparties.js";
import {
  useCommitJournal,
  useDownloadJournalHistory,
  useDownloadJournalTemplate,
  useJournalHistory,
  useManualJournalEntry,
  usePreviewJournal,
  useReverseJournalEntry,
} from "../features/journal/use-journal.js";
import { usePeriods } from "../features/statements/use-statements.js";
import { formatIDR } from "../lib/format.js";
import { detectPeriod } from "../lib/period-utils.js";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function previewNewPeriodLabel(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

type Tab = "manual" | "upload" | "reversal" | "history";

const TABS: { key: Tab; label: string; icon: typeof PenLine }[] = [
  { key: "manual", label: "Entry Manual", icon: PenLine },
  { key: "upload", label: "Upload Excel", icon: UploadCloud },
  { key: "reversal", label: "Reversal", icon: RotateCcw },
  { key: "history", label: "Riwayat", icon: History },
];

/** Sama persis dgn JournalPage versi online, termasuk tab "Upload Excel". */
export function JournalPage() {
  const { companySlug = "" } = useParams();
  const [tab, setTab] = useState<Tab>("manual");
  const { data: periodsData } = usePeriods(companySlug);
  const periods = periodsData?.periods ?? [];

  return (
    <div className="flex flex-col gap-6">
      <BackToCompanyLink companySlug={companySlug} />
      <div>
        <h1 className="vt-page-title text-xl font-bold text-heading">Jurnal</h1>
        <p className="text-sm text-ink/50">Entry manual, upload Excel, reversal, dan riwayat jurnal.</p>
      </div>

      <div className="flex w-fit gap-1 rounded-full bg-surface-2 p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
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

      {tab === "manual" && <ManualEntryTab companySlug={companySlug} periods={periods} />}
      {tab === "upload" && <UploadTab companySlug={companySlug} periods={periods} />}
      {tab === "reversal" && <ReversalTab companySlug={companySlug} />}
      {tab === "history" && <HistoryTab companySlug={companySlug} periods={periods} />}
    </div>
  );
}

function ManualEntryTab({ companySlug, periods }: { companySlug: string; periods: Period[] }) {
  const { data: accountsData } = useAccounts(companySlug);
  const { data: counterpartiesData } = useCounterparties(companySlug);
  const createCounterparty = useCreateCounterparty(companySlug);
  const manual = useManualJournalEntry(companySlug);

  const accounts = accountsData?.accounts ?? [];
  const counterparties = counterpartiesData?.counterparties ?? [];

  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const detectedPeriod = detectPeriod(periods, entryDate);
  const [referenceNo, setReferenceNo] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState([
    { accountId: "", debit: "", credit: "", counterpartyId: "" },
    { accountId: "", debit: "", credit: "", counterpartyId: "" },
  ]);
  const [newVendorName, setNewVendorName] = useState("");
  const [showNewVendor, setShowNewVendor] = useState(false);

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isBalanced = isBalancedExact(totalDebit, totalCredit);

  function updateLine(i: number, patch: Partial<(typeof lines)[0]>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function handleSubmit() {
    if (!isBalanced) return;
    await manual.mutateAsync({
      entryDate,
      referenceNo: referenceNo || undefined,
      description: description || undefined,
      lines: lines
        .filter((l) => l.accountId)
        .map((l) => ({
          accountId: l.accountId,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          counterpartyId: l.counterpartyId || undefined,
        })),
    });
    setLines([
      { accountId: "", debit: "", credit: "", counterpartyId: "" },
      { accountId: "", debit: "", credit: "", counterpartyId: "" },
    ]);
    setDescription("");
    setReferenceNo("");
  }

  return (
    <Card className="p-6">
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Field label="Tanggal">
          <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="input-base" />
        </Field>
        <Field label="Periode (otomatis)">
          <div className="input-base flex items-center text-heading">
            {detectedPeriod ? detectedPeriod.label : `${previewNewPeriodLabel(entryDate)} (baru)`}
          </div>
        </Field>
        <Field label="Nomor Jurnal (opsional)">
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Auto kalau kosong" className="input-base" />
        </Field>
        <Field label="Keterangan">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input-base" />
        </Field>
      </div>

      <div className="mb-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-ink/40">
            <tr>
              <th className="px-3 py-2">Akun</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Kredit</th>
              <th className="px-3 py-2">Vendor/Pelanggan</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="border-t border-line/60">
                <td className="px-3 py-1.5">
                  <select value={line.accountId} onChange={(e) => updateLine(i, { accountId: e.target.value })} className="input-base w-full">
                    <option value="">Pilih akun</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-1.5">
                  <input
                    type="number"
                    value={line.debit}
                    onChange={(e) => updateLine(i, { debit: e.target.value, credit: "" })}
                    className="input-base w-28 text-right"
                  />
                </td>
                <td className="px-3 py-1.5">
                  <input
                    type="number"
                    value={line.credit}
                    onChange={(e) => updateLine(i, { credit: e.target.value, debit: "" })}
                    className="input-base w-28 text-right"
                  />
                </td>
                <td className="px-3 py-1.5">
                  <select value={line.counterpartyId} onChange={(e) => updateLine(i, { counterpartyId: e.target.value })} className="input-base w-full">
                    <option value="">-</option>
                    {counterparties.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} - {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-1.5">
                  {lines.length > 2 && (
                    <button onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))} className="text-ink/30 hover:text-rose-500">
                      <XCircle size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, { accountId: "", debit: "", credit: "", counterpartyId: "" }])}
          className="text-sm font-medium text-accent hover:underline"
        >
          + Tambah Baris
        </button>
        <button type="button" onClick={() => setShowNewVendor((v) => !v)} className="text-sm font-medium text-accent hover:underline">
          + Vendor/Pelanggan Baru
        </button>
      </div>

      {showNewVendor && (
        <div className="mb-4 flex items-end gap-2 rounded-lg border border-line p-3">
          <Field label="Nama">
            <input value={newVendorName} onChange={(e) => setNewVendorName(e.target.value)} className="input-base" />
          </Field>
          <button
            type="button"
            onClick={async () => {
              if (!newVendorName) return;
              const code = `V${Date.now().toString().slice(-6)}`;
              await createCounterparty.mutateAsync({ type: "vendor", code, name: newVendorName });
              setNewVendorName("");
              setShowNewVendor(false);
            }}
            className="rounded-lg bg-navy-700 px-3 py-2 text-sm text-white hover:bg-navy-900"
          >
            Simpan
          </button>
        </div>
      )}

      <div
        className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
          isBalanced ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"
        }`}
      >
        {isBalanced ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        Total Debit {formatIDR(totalDebit)}, Total Kredit {formatIDR(totalCredit)} {isBalanced ? "(balance)" : "(belum balance)"}
      </div>

      {manual.isError && <p className="mb-3 text-sm text-rose-600">{(manual.error as Error).message}</p>}

      <button
        type="button"
        disabled={!isBalanced || manual.isPending}
        onClick={handleSubmit}
        className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
      >
        {manual.isPending ? "Menyimpan..." : "Posting Jurnal"}
      </button>
    </Card>
  );
}

function UploadTab({ companySlug, periods }: { companySlug: string; periods: Period[] }) {
  const preview = usePreviewJournal(companySlug);
  const commit = useCommitJournal(companySlug);
  const downloadTemplate = useDownloadJournalTemplate(companySlug);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) preview.mutate(file);
  }

  // Periode TIDAK dipilih manual -- tiap entry otomatis masuk periode sesuai
  // tanggalnya sendiri (satu file boleh mencakup beberapa periode sekaligus),
  // dan kalau belum ada periode yang cocok, backend akan BUAT OTOMATIS
  // (periode bulanan) -- jadi ini bukan syarat blocking commit lagi, cuma info.
  const entriesWithPeriod = (preview.data?.entries ?? []).map((e) => ({ entry: e, period: detectPeriod(periods, e.date) }));
  const newCount = entriesWithPeriod.filter(({ entry }) => !entry.alreadyExists).length;
  const alreadyExistsCount = entriesWithPeriod.filter(({ entry }) => entry.alreadyExists).length;
  const problemCount = entriesWithPeriod.filter(
    ({ entry }) => !entry.alreadyExists && (!entry.isBalanced || entry.unknownAccountCodes.length > 0),
  ).length;
  const canCommit = Boolean(preview.data?.allBalanced) && newCount > 0;

  async function handleCommit() {
    if (!preview.data || !canCommit) return;
    await commit.mutateAsync({
      entries: preview.data.entries.map((e) => ({
        referenceNo: e.referenceNo,
        date: e.date,
        lines: e.lines.map((l) => ({
          code: l.code,
          debit: l.debit,
          credit: l.credit,
          memo: l.keterangan,
          counterpartyName: l.counterpartyName || undefined,
        })),
      })),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => downloadTemplate.mutate()}
          disabled={downloadTemplate.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-heading hover:border-accent disabled:opacity-50"
        >
          <Download size={14} />
          {downloadTemplate.isPending ? "Menyiapkan..." : "Download Template"}
        </button>
      </div>

      <Card className="p-6">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-6 py-10 text-center hover:border-accent hover:bg-accent-50/40">
          <UploadCloud size={28} className="text-heading/40" />
          <span className="text-sm font-medium text-heading">Klik untuk pilih file .xlsx (sheet "Jurnal")</span>
          <span className="text-xs text-ink/50">
            Header: <strong>Kode Akun</strong>, <strong>Tgl</strong>, <strong>Akun Buku Besar</strong>, <strong>Keterangan</strong>,{" "}
            <strong>Debet</strong>, <strong>Kredit</strong> -- kolom <strong>No Jurnal</strong> dan{" "}
            <strong>Vendor/Pelanggan</strong> opsional (Vendor/Pelanggan otomatis mengisi Kartu Hutang/Piutang). Atau pakai
            tombol "Download Template" di atas, sudah berisi daftar kode akun perusahaan ini.
          </span>
          <input type="file" accept=".xlsx" onChange={handleFile} className="hidden" />
        </label>
        {preview.isPending && <p className="mt-3 text-sm text-ink/50">Membaca file...</p>}
        {preview.isError && <p className="mt-3 text-sm text-rose-600">{(preview.error as Error).message}</p>}
        {downloadTemplate.isError && <p className="mt-3 text-sm text-rose-600">{(downloadTemplate.error as Error).message}</p>}
      </Card>

      {preview.data && (
        <Card>
          <CardHeader title={`Preview (${preview.data.entries.length} transaksi)`} />
          <div className="flex flex-col gap-3 p-5 pt-0">
            {preview.data.fileErrors.map((e, i) => (
              <p key={i} className="text-sm text-rose-600">
                {e}
              </p>
            ))}

            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2/60 px-4 py-2.5 text-sm">
              <span className="flex items-center gap-1.5 text-emerald-600">
                <CheckCircle2 size={14} /> {newCount} baru & siap
              </span>
              {alreadyExistsCount > 0 && (
                <span className="flex items-center gap-1.5 text-ink/50">• {alreadyExistsCount} sudah pernah diinput (dilewati)</span>
              )}
              {problemCount > 0 && <span className="flex items-center gap-1.5 text-rose-600">• {problemCount} bermasalah</span>}
            </div>

            {entriesWithPeriod.map(({ entry, period }, i) => {
              const hasProblem = !entry.isBalanced || entry.unknownAccountCodes.length > 0;
              return (
                <div
                  key={i}
                  className={`rounded-lg border p-3 ${
                    entry.alreadyExists
                      ? "border-line bg-surface-2/40 opacity-70"
                      : hasProblem
                        ? "border-rose-300 bg-rose-50/50 dark:bg-rose-500/10"
                        : "border-line"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium text-heading">
                      {entry.date} {entry.referenceNo && `- ${entry.referenceNo}`}
                      <span className="ml-2 font-normal text-ink/40">→ {period ? period.label : `${previewNewPeriodLabel(entry.date)} (baru)`}</span>
                    </span>
                    {entry.alreadyExists ? (
                      <span className="flex items-center gap-1 text-ink/50">Sudah Diinput</span>
                    ) : !hasProblem ? (
                      <span className="flex items-center gap-1 text-emerald-600">
                        <CheckCircle2 size={14} /> Balance
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-rose-600">
                        <XCircle size={14} /> Bermasalah
                      </span>
                    )}
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {entry.lines.map((l) => (
                        <tr key={l.rowNumber} className={entry.unknownAccountCodes.includes(l.code) ? "text-rose-600" : ""}>
                          <td className="py-0.5 pr-2 tabular-nums">{l.code}</td>
                          <td className="py-0.5 pr-2">{l.accountName}</td>
                          <td className="py-0.5 pr-2 text-right tabular-nums">{l.debit ? formatIDR(l.debit) : ""}</td>
                          <td className="py-0.5 pr-2 text-right tabular-nums">{l.credit ? formatIDR(l.credit) : ""}</td>
                          <td className="py-0.5 pl-2 text-ink/50">{l.counterpartyName || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!entry.alreadyExists && !entry.isBalanced && (
                    <p className="mt-1 text-xs text-rose-600">
                      Tidak balance: debit {formatIDR(entry.totalDebit)} vs kredit {formatIDR(entry.totalCredit)} (baris{" "}
                      {entry.lines.map((l) => l.rowNumber).join(", ")})
                    </p>
                  )}
                  {!entry.alreadyExists && entry.unknownAccountCodes.length > 0 && (
                    <p className="mt-1 text-xs text-rose-600">Kode akun tidak dikenal: {entry.unknownAccountCodes.join(", ")}</p>
                  )}
                  {!entry.alreadyExists && !period && (
                    <p className="mt-1 text-xs text-ink/40">Periode "{previewNewPeriodLabel(entry.date)}" belum ada -- akan dibuat otomatis saat commit.</p>
                  )}
                </div>
              );
            })}

            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={!canCommit || commit.isPending}
                onClick={handleCommit}
                className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
              >
                {commit.isPending ? "Menyimpan..." : `Commit ${newCount} Transaksi Baru`}
              </button>
              <p className="text-xs text-ink/40">Periode ditentukan otomatis per transaksi dari tanggalnya masing-masing.</p>
            </div>
            {!preview.data.allBalanced && <p className="text-xs text-rose-600">Perbaiki dulu transaksi yang tidak balance / kode akun tidak dikenal sebelum commit.</p>}
            {preview.data.allBalanced && newCount === 0 && (
              <p className="text-xs text-ink/40">Semua transaksi di file ini sudah pernah diinput sebelumnya -- tidak ada yang baru untuk di-commit.</p>
            )}
            {commit.isError && <p className="text-sm text-rose-600">{(commit.error as Error).message}</p>}
            {commit.isSuccess && (
              <p className="text-sm text-emerald-600">
                {commit.data.createdCount} jurnal berhasil diposting.
                {commit.data.skippedCount > 0 && ` ${commit.data.skippedCount} dilewati (sudah pernah diinput).`}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function ReversalTab({ companySlug }: { companySlug: string }) {
  const reversal = useReverseJournalEntry(companySlug);
  const [reversalDate, setReversalDate] = useState("");
  const [referenceNo, setReferenceNo] = useState("");

  return (
    <Card className="max-w-lg p-6">
      <p className="mb-4 text-sm text-ink/60">
        Reversal membuat jurnal BARU dengan debit/kredit ditukar dari jurnal asli (bukan menghapus) -- riwayat tetap utuh.
        Sebagai verifikasi, tanggal yang diinput harus persis sama dengan tanggal transaksi jurnal aslinya.
      </p>
      <div className="mb-4 flex flex-col gap-3">
        <Field label="Nomor Referensi Jurnal Asli">
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="mis. JRN-000001" className="input-base" />
        </Field>
        <Field label="Tanggal Transaksi Jurnal Asli">
          <input type="date" value={reversalDate} onChange={(e) => setReversalDate(e.target.value)} className="input-base" />
        </Field>
      </div>
      {reversal.isError && <p className="mb-3 text-sm text-rose-600">{(reversal.error as Error).message}</p>}
      {reversal.isSuccess && <p className="mb-3 text-sm text-emerald-600">Reversal berhasil: {reversal.data.referenceNo}</p>}
      <button
        type="button"
        disabled={!referenceNo || !reversalDate || reversal.isPending}
        onClick={() => reversal.mutate({ reversalDate, referenceNo })}
        className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50"
      >
        {reversal.isPending ? "Memproses..." : "Reversal Jurnal"}
      </button>
    </Card>
  );
}

function HistoryTab({ companySlug, periods }: { companySlug: string; periods: Period[] }) {
  const [from, setFrom] = useState(() => periods[0]?.startDate.slice(0, 10) ?? "");
  const [to, setTo] = useState(() => periods[0]?.endDate.slice(0, 10) ?? "");
  const { data, isLoading } = useJournalHistory(companySlug, from, to);
  const downloadHistory = useDownloadJournalHistory(companySlug);

  return (
    <Card>
      <CardHeader
        title="Riwayat Jurnal"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
              <label className="text-xs font-medium text-ink/50">Dari</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
              <span className="text-ink/30">-</span>
              <label className="text-xs font-medium text-ink/50">Sampai</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-sm font-medium text-heading outline-none" />
            </div>
            <button
              type="button"
              onClick={() => from && to && downloadHistory.mutate({ from, to })}
              disabled={!from || !to || downloadHistory.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
            >
              <Download size={14} /> {downloadHistory.isPending ? "Menyiapkan..." : "Download Excel"}
            </button>
          </div>
        }
      />
      <div className="overflow-x-auto p-5 pt-0">
        {isLoading ? (
          <p className="text-sm text-ink/50">Memuat...</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-navy-700 text-left text-xs uppercase tracking-wide text-white">
              <tr>
                <th className="py-2 pl-3 pr-3">Kode Akun</th>
                <th className="py-2 pr-3">Tgl</th>
                <th className="py-2 pr-3">No Jurnal</th>
                <th className="py-2 pr-3">Akun Buku Besar</th>
                <th className="py-2 pr-3">Keterangan</th>
                <th className="py-2 pr-3 text-right">Debet</th>
                <th className="py-2 pr-3 text-right">Kredit</th>
              </tr>
            </thead>
            <tbody>
              {data?.lines.map((l, i) => (
                <tr key={`${l.journalEntryId}-${i}`} className={`border-t border-line/60 ${l.isReversed ? "opacity-50 line-through" : ""}`}>
                  <td className="py-1.5 pr-3 tabular-nums">{l.accountCode}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{l.entryDate.slice(0, 10)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{l.referenceNo}</td>
                  <td className="py-1.5 pr-3">{l.accountName}</td>
                  <td className="py-1.5 pr-3">
                    {l.description}
                    {l.isReversed && (
                      <span className="ml-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-600 no-underline dark:bg-rose-500/15 dark:text-rose-300">
                        Di-reversal
                      </span>
                    )}
                    {l.reversalOfId && <span className="ml-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink/60 no-underline">Reversal</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{l.debit ? formatIDR(l.debit) : ""}</td>
                  <td className="py-1.5 text-right tabular-nums">{l.credit ? formatIDR(l.credit) : ""}</td>
                </tr>
              ))}
              {(!data || data.lines.length === 0) && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-sm text-ink/40">
                    Data Kosong
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex-1">
      <label className="mb-1 block text-xs font-medium text-ink/60">{label}</label>
      {children}
    </div>
  );
}
