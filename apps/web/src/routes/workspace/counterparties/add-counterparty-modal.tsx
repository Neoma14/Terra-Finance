import { X } from "lucide-react";
import { useState } from "react";
import { useCreateCounterparty } from "../../../features/workspace/use-counterparties.js";
import { useEscapeToClose } from "../../../lib/use-escape-to-close.js";
import type { CounterpartyType } from "../../../features/workspace/counterparty-types.js";

export function AddCounterpartyModal({ companySlug, type, onClose }: { companySlug: string; type: CounterpartyType; onClose: () => void }) {
  useEscapeToClose(onClose);
  const create = useCreateCounterparty(companySlug);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const canSubmit = code.trim() && name.trim();
  const label = type === "vendor" ? "Vendor" : "Customer";

  async function handleSubmit() {
    if (!canSubmit) return;
    await create.mutateAsync({ type, code: code.trim(), name: name.trim() });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-sm flex-col rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-heading">Tambah {label}</h2>
          <button type="button" onClick={onClose} className="text-ink/40 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Kode</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} className="input-base w-full" placeholder="mis. V001" autoFocus />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink/60">Nama {label}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input-base w-full" />
          </div>
          {create.isError && <p className="text-sm text-rose-600">{(create.error as Error).message}</p>}
        </div>

        <div className="flex gap-2 border-t border-line px-6 py-4">
          <button type="button" disabled={!canSubmit || create.isPending} onClick={handleSubmit} className="rounded-lg bg-navy-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-900 disabled:opacity-50">
            {create.isPending ? "Menyimpan..." : `Tambah ${label}`}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink/70 hover:bg-surface-2">
            Batal
          </button>
        </div>
      </div>
    </div>
  );
}
