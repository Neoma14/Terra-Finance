import { Badge } from "../../../components/ui.js";
import type { JournalStatus } from "../../../features/workspace/journal-types.js";

const STATUS_TONE: Record<JournalStatus, "neutral" | "accent" | "success" | "danger"> = {
  DRAFT: "neutral",
  POSTED: "success",
  REVERSED: "danger",
  VOID: "danger",
};

const STATUS_LABEL: Record<JournalStatus, string> = {
  DRAFT: "Draft",
  POSTED: "Posted",
  REVERSED: "Reversed",
  VOID: "Void",
};

export function JournalStatusBadge({ status }: { status: JournalStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}
