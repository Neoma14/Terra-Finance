import { Badge } from "../../../components/ui.js";

export function AccountStatusBadge({ isActive, isLocked }: { isActive: boolean; isLocked?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={isActive ? "success" : "neutral"}>{isActive ? "Aktif" : "Nonaktif"}</Badge>
      {isLocked ? <Badge tone="danger">Terkunci</Badge> : null}
    </span>
  );
}
