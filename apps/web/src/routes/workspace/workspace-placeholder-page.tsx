import { useOutletContext } from "react-router-dom";
import { Card } from "../../components/ui.js";
import type { AccessibleCompany } from "../../features/workspace/types.js";

/** Placeholder generik utk SELURUH item nav (selain nanti modul bisnis
 * sungguhan dibangun task terpisah, instruksi TASK-DB-ARCH-013 §9).
 * Membuktikan company context (dari `WorkspaceShell`, lewat
 * `<Outlet context={{ company }} />`) sampai ke halaman turunan. */
export function WorkspacePlaceholderPage({ label }: { label: string }) {
  const { company } = useOutletContext<{ company: AccessibleCompany }>();

  return (
    <Card className="flex flex-col items-center justify-center gap-2 p-16 text-center">
      <h1 className="vt-page-title text-lg font-bold text-heading">{label}</h1>
      <p className="max-w-sm text-sm text-ink/50">
        Modul &quot;{label}&quot; untuk <span className="font-medium text-ink/70">{company.name}</span> (role Anda:{" "}
        <span className="font-medium text-ink/70">{company.role}</span>) akan dibangun pada task berikutnya.
      </p>
    </Card>
  );
}
